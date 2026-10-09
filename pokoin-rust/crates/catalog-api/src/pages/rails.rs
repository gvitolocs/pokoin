//! `GET /api/marketplace-rails` — port of `marketplace-rails.js`: Pi browse
//! rails, public card ids only.

use axum::extract::State;
use axum::http::Uri;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use pokoin_api_common::http::Query;
use pokoin_api_common::RouteState;
use serde_json::{json, Value};

use super::support;
use crate::shared::{js, rails, react_card};

/// Route handler (GET; OPTIONS is answered by the preflight route).
pub async fn handler(method: Method, State(state): State<RouteState>, uri: Uri) -> Response {
    if method != Method::GET {
        return support::method_not_allowed_get_options().await;
    }
    support::timing_scope("/api/marketplace-rails", "GET", handle(state, uri)).await
}

async fn handle(state: RouteState, uri: Uri) -> Response {
    let q = Query::from_uri(&uri);
    let pool = match support::game_pool(&state, "pokemon").await {
        Ok(pool) => pool,
        Err(response) => return response,
    };

    let ids = react_card::parse_id_list(q.search_param("ids").unwrap_or(""), 80);
    if !ids.is_empty() {
        let tiles = match rails::read_tiles(&pool, &ids).await {
            Ok(tiles) => tiles,
            Err(error) => {
                return rails_error_response(&error, "Marketplace rails failed.");
            }
        };
        let cards = rails::publicize_cards(&tiles);
        let by_id: std::collections::HashMap<String, &Value> = cards
            .iter()
            .map(|card| (rails::card_id(card), card))
            .collect();
        let ordered: Vec<Value> = ids
            .iter()
            .filter_map(|id| by_id.get(id).cloned().cloned())
            .collect();
        return support::json_with_cache_control(
            StatusCode::OK,
            tiles_body(ordered),
            "public, max-age=30, s-maxage=120",
        );
    }

    let id_value = q.search_param("id").map(|v| Value::String(v.to_string()));
    let id = js::clean_text(id_value.as_ref(), 180);
    if id.is_empty() {
        return support::json_with_cors(
            StatusCode::BAD_REQUEST,
            json!({ "error": "id or ids required." }),
        );
    }
    let rows = match rails::read_rails(&pool, &[id.clone()]).await {
        Ok(rows) => rows,
        Err(error) => {
            return rails_error_response(&error, "Marketplace rails failed.");
        }
    };
    let Some(row) = rows.into_iter().next() else {
        return support::json_with_cors(
            StatusCode::NOT_FOUND,
            json!({ "error": "Rail not found.", "id": id }),
        );
    };
    let cards = rails::publicize_cards(&rails::as_cards(row.cards.as_ref()));
    let updated_at = match row.updated_at {
        Some(at) => Value::String(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        None => Value::Null,
    };
    support::json_with_cache_control(
        StatusCode::OK,
        rail_body(&row.id, cards, row.meta.clone(), updated_at),
        "public, max-age=30, s-maxage=120",
    )
}

/// The `ids=` success body.
pub fn tiles_body(cards: Vec<Value>) -> Value {
    json!({ "source": "pi", "cards": cards })
}

/// The single-rail success body.
pub fn rail_body(id: &str, cards: Vec<Value>, meta: Option<Value>, updated_at: Value) -> Value {
    json!({
        "id": id,
        "cards": cards,
        "meta": meta.unwrap_or(Value::Object(serde_json::Map::new())),
        "updated_at": updated_at,
        "source": "pi",
    })
}

/// The catch uses `publicErrorStatus`/`publicErrorBody` here: pipeline
/// failures become 503 `We are working on a solution.`.
fn rails_error_response(error: &sqlx::Error, fallback: &str) -> Response {
    let message = match error {
        sqlx::Error::Database(db) => db.message().to_string(),
        sqlx::Error::PoolTimedOut => "could not connect to server".to_string(),
        other if other.to_string().contains("error communicating") => {
            "connection refused".to_string()
        }
        other => other.to_string(),
    };
    let status = if pokoin_api_common::public_error::is_pipeline_failure(&message) {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    } else {
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    };
    if status == axum::http::StatusCode::SERVICE_UNAVAILABLE {
        // sanitizePublicJson rewrites the body for pipeline failures.
        return support::json_with_cors(
            status,
            json!({ "error": pokoin_api_common::public_error::WORKING_MESSAGE }),
        );
    }
    support::json_with_cors(
        status,
        json!({ "error": if message.is_empty() { fallback.to_string() } else { message } }),
    )
}

/// 405 for every method the reference rejects.
pub async fn method_not_allowed() -> Response {
    support::method_not_allowed_get_options().await
}
