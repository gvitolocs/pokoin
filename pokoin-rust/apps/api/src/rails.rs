//! Three homepage rail endpoints. Each rail is its own URL so the SPA can
//! fetch New cards / Best sellers / Spotlight in parallel and paint as each
//! arrives — instead of waiting on the monolithic marketplace-home vector.
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    catalog_api::{failure, game_pool, response, response_c1},
    suggest::{cors, game_from},
    AppState,
};

const CACHE: &str = "public, max-age=30, s-maxage=120, stale-while-revalidate=600";

struct RailSpec {
    db_id: &'static str,
    section: &'static str,
    limit: usize,
}

const NEW_CARDS: RailSpec = RailSpec {
    db_id: "new_cards",
    section: "newArrivalIds",
    limit: 20,
};
const BEST_SELLERS: RailSpec = RailSpec {
    db_id: "best_sellers",
    section: "bestSellerIds",
    limit: 12,
};
/// UI title is Spotlight; the stored rail id is still `featured`.
const SPOTLIGHT: RailSpec = RailSpec {
    db_id: "featured",
    section: "featuredIds",
    limit: 30,
};

pub async fn options() -> Response {
    cors(StatusCode::NO_CONTENT, None, None, "").into_response()
}

pub async fn new_cards(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    rail_response(&state, &headers, &uri, &NEW_CARDS).await
}

pub async fn best_sellers(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    rail_response(&state, &headers, &uri, &BEST_SELLERS).await
}

pub async fn spotlight(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    rail_response(&state, &headers, &uri, &SPOTLIGHT).await
}

async fn rail_response(
    state: &AppState,
    headers: &HeaderMap,
    uri: &Uri,
    spec: &RailSpec,
) -> Response {
    // Opt-in compact encoding; the default representation is unchanged.
    let wanted = crate::catalog_api::wanted(headers, uri);
    let game = game_from(headers, None);
    if game != "pokemon" {
        return response(
            StatusCode::BAD_REQUEST,
            json!({"error": "Homepage rails are Pokemon-only.", "game": game}),
            "no-store",
        );
    }
    let Some(pool) = game_pool(state, &game).await else {
        return response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "Marketplace database unavailable."}),
            "no-store",
        );
    };
    match read_rail(&pool, spec).await {
        Ok(Some(body)) => response_c1(wanted, StatusCode::OK, body, CACHE),
        Ok(None) => response(
            StatusCode::NOT_FOUND,
            json!({"error": "Rail not found.", "id": spec.db_id}),
            "no-store",
        ),
        Err(error) => failure(&error),
    }
}

async fn read_rail(pool: &PgPool, spec: &RailSpec) -> Result<Option<Value>, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, sqlx::types::Json<Value>, sqlx::types::Json<Value>, Option<String>)>(
        r#"
        select id, cards, meta, updated_at::text
        from public.marketplace_rails
        where id = $1
        "#,
    )
    .bind(spec.db_id)
    .fetch_optional(pool)
    .await?;
    let Some((id, cards_json, meta_json, updated_at)) = row else {
        return Ok(None);
    };
    let raw = cards_json.0.as_array().cloned().unwrap_or_default();
    let mut cards = Vec::with_capacity(raw.len().min(spec.limit));
    let mut section_ids = Vec::with_capacity(spec.limit);
    for item in raw.into_iter().take(spec.limit) {
        let mut card = pokoin_catalog::react_record(&item);
        // Sales-day fields on best-sellers stay on the public tile.
        if let Some(day) = item
            .get("salesDay")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            card["salesDay"] = json!(day);
            for key in ["dailySoldQty", "dailySaleSamples"] {
                card[key] = item.get(key).cloned().unwrap_or(Value::Null);
            }
            for key in ["dailyMedianPkn", "dailyMinPkn", "dailyMaxPkn"] {
                card[key] = item.get(key).cloned().unwrap_or(Value::Null);
            }
        }
        let cid = card
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if cid.is_empty() {
            continue;
        }
        section_ids.push(json!(cid));
        cards.push(card);
    }
    let meta = if meta_json.0.is_object() {
        meta_json.0
    } else {
        json!({})
    };
    let pkn_usdt = meta
        .get("pknUsdt")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.005);
    Ok(Some(json!({
        "id": id,
        "source": "pi",
        "cards": cards,
        "meta": meta,
        "updated_at": updated_at.unwrap_or_default(),
        "pknUsdt": pkn_usdt,
        "sections": { spec.section: section_ids },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_match_homepage_carousels() {
        assert_eq!(NEW_CARDS.db_id, "new_cards");
        assert_eq!(NEW_CARDS.limit, 20);
        assert_eq!(BEST_SELLERS.db_id, "best_sellers");
        assert_eq!(BEST_SELLERS.limit, 12);
        assert_eq!(SPOTLIGHT.db_id, "featured");
        assert_eq!(SPOTLIGHT.limit, 30);
        assert_eq!(SPOTLIGHT.section, "featuredIds");
    }
}
