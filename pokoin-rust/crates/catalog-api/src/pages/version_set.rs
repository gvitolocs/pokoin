//! `GET /api/marketplace-version-set` — port of
//! `marketplace-version-set.js`: the `pokoin_version_sets` key,
//! `member_count` and printings for one public card id.

use axum::extract::State;
use axum::http::Uri;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use pokoin_api_common::http::Query;
use pokoin_api_common::RouteState;
use serde_json::{json, Value};

use super::support;
use crate::shared::{js, page_snapshot, react_card, react_sql, sql_json};

/// `PRINTING_SQL` — verbatim.
pub const PRINTING_SQL: &str = "
  select
    c.card_id,
    c.ct_id,
    c.name,
    c.set_name,
    c.card_number,
    c.rarity,
    c.cdn_image_url,
    c.image_url,
    c.preview_image_url,
    c.homepage_image_url,
    c.version,
    e.nationality,
    s.member_count,
    u.canonical_path
  from public.marketplace_search_candidates c
  join public.pokoin_version_sets s on s.version = c.version
  left join public.pokoin_pokemon_expansions e on e.name = c.set_name
  left join public.marketplace_card_urls u
    on u.card_id = c.card_id and u.language = 'en'
  where c.item_kind = 'single'
    and c.product_type = 'card'
    and c.version is not null
    and c.version = (
      select version
      from public.marketplace_search_candidates
      where card_id = $1::bigint
    )
  order by
    case e.nationality
      when 'japanese' then 0
      when 'western' then 1
      when 'chinese' then 2
      else 3
    end,
    c.card_id
  limit 128
";

/// Route handler — the route is registered with `any()` and dispatches
/// itself so the 405 has no `Allow` header, exactly like the reference
/// (`setCorsHeaders`, OPTIONS 204, GET/HEAD, everything else 405).
pub async fn handler(
    method: Method,
    State(state): State<RouteState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
) -> Response {
    if method == Method::OPTIONS {
        return pokoin_api_common::http::read_preflight();
    }
    if method != Method::GET && method != Method::HEAD {
        return support::method_not_allowed_get_only().await;
    }
    support::timing_scope("/api/marketplace-version-set", "GET", handle(state, headers, uri)).await
}

/// Version sets are rebuilt hourly (`build-lists-versions`).
const VERSION_CACHE: &str = "public, max-age=60, s-maxage=600, stale-while-revalidate=3600";

/// [`success_body`] from a `version` snapshot, byte for byte.
fn version_bytes(card_id: &str, page: &page_snapshot::Page) -> Option<Vec<u8>> {
    Some(
        page_snapshot::Body::with_capacity(&page.rows)
            .value("cardId", &json!(card_id))
            .value("version", page.head.get("version")?)
            .value("versionCount", page.head.get("versionCount")?)
            .rows("printings", &page.rows)
            .finish(),
    )
}

async fn handle(state: RouteState, headers: axum::http::HeaderMap, uri: Uri) -> Response {
    let q = Query::from_uri(&uri);
    // Opt-in compact encoding; the default representation is unchanged.
    let wanted = support::wanted(&headers, &q);
    let card_id = react_card::parse_public_card_id(q.search_param("cardId").unwrap_or(""));
    if card_id.is_empty() {
        return support::json_with_cors(
            StatusCode::BAD_REQUEST,
            json!({ "error": "cardId is required (public marketplace id)." }),
        );
    }
    let game = "pokemon";
    // PRINTING_SQL joins the pokemon catalog tables; the pool is the request
    // game's (satellites fail their SQL exactly like the reference).
    let pool = match support::game_pool(&state, game).await {
        Ok(pool) => pool,
        Err(response) => return response,
    };
    let id: i64 = match card_id.parse() {
        Ok(id) => id,
        Err(_) => {
            return support::json_with_cors(
                StatusCode::BAD_REQUEST,
                json!({ "error": "cardId is required (public marketplace id)." }),
            )
        }
    };

    if !headers.contains_key(page_snapshot::BUILD_HEADER) {
        if let Some(page) = page_snapshot::read_version_of_card(&pool, id).await {
            if let Some(bytes) = version_bytes(&card_id, &page).filter(|_| !page.rows.is_empty()) {
                return support::prebuilt(wanted, bytes, None, VERSION_CACHE);
            }
        }
    }

    let rows = match sql_json::rows_json(&pool, PRINTING_SQL, &[sql_json::SqlBind::Int(id)]).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "marketplace-version-set failed");
            return support::node_error_response(&error, "Version set failed.");
        }
    };
    let rows = react_sql::overlay_cheapest_on_rows(&pool, true, &rows).await;
    if rows.is_empty() {
        return support::json_with_cors(
            StatusCode::NOT_FOUND,
            json!({ "error": "Card not found.", "cardId": card_id }),
        );
    }

    let printings: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut card = react_card::to_react_card(row);
            if let Some(map) = card.as_object_mut() {
                map.insert(
                    "nationality".into(),
                    Value::String(
                        js::string_or_empty(js::get(row, "nationality"))
                            .trim()
                            .to_lowercase(),
                    ),
                );
                map.insert(
                    "version".into(),
                    Value::String(js::string_or_empty(js::get(row, "version"))),
                );
            }
            card
        })
        .collect();
    let member_count = js::number(js::get(&rows[0], "member_count"));
    let version_count = if member_count.is_finite() && member_count != 0.0 {
        js::js_json_number(member_count)
    } else {
        json!(printings.len())
    };
    let version = js::string_or_empty(js::get(&rows[0], "version"));
    support::json_with_cache_control_c1(
        wanted,
        StatusCode::OK,
        success_body(&card_id, &version, version_count, printings),
        VERSION_CACHE,
    )
}

/// The `jsonOk` payload of the reference.
pub fn success_body(
    card_id: &str,
    version: &str,
    version_count: Value,
    printings: Vec<Value>,
) -> Value {
    json!({
        "cardId": card_id,
        "version": version,
        "versionCount": version_count,
        "printings": printings,
    })
}

/// 405 (`GET only.`).
pub async fn method_not_allowed() -> Response {
    support::method_not_allowed_get_only().await
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    #[test]
    fn a_snapshot_version_set_is_the_live_body() {
        let printings = vec![json!({"id": "2", "nationality": "japanese", "version": "v1"}), json!({"id": "4", "nationality": "western", "version": "v1"})];
        let page = page_snapshot::Page {
            head: json!({"version": "v1", "versionCount": 2}),
            rows: printings.iter().map(page_snapshot::text).collect(),
            row_count: 2,
            c1: None,
        };
        let live = success_body("4", "v1", json!(2), printings);
        assert_eq!(String::from_utf8(version_bytes("4", &page).unwrap()).unwrap(), live.to_string());
    }
}
