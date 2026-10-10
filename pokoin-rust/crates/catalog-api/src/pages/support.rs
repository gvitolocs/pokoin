//! Handler plumbing shared by the page BFFs: game scoping, the CORS-wrapped
//! JSON responses (`setCorsHeaders` runs before any status), the Node error
//! shapes, and the 405 bodies.

use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use pokoin_api_common::{compact, http, RouteState};
use serde_json::{json, Value};
use sqlx::PgPool;

/// `parseGameFromRequest(req)` — query aliases with JS `||` semantics
/// (empty strings fall through), then headers.
pub fn resolve_game(
    headers: &HeaderMap,
    game: Option<&str>,
    marketplace_game: Option<&str>,
) -> String {
    let non_empty_game = game.filter(|v| !v.is_empty());
    let non_empty_marketplace = marketplace_game.filter(|v| !v.is_empty());
    pokoin_api_common::game::parse_game_from_request(
        &http::header_pairs(headers),
        non_empty_game,
        non_empty_marketplace,
    )
}

/// The catalog pool of a resolved game; a satellite without a configured
/// database URL is the Node `createPool` 500.
pub async fn game_pool(state: &RouteState, game: &str) -> Result<PgPool, Response> {
    state
        .api
        .game_pool(game)
        .await
        .ok_or_else(|| missing_database_error(game))
}

fn missing_database_error(game: &str) -> Response {
    http::json_with(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": format!("{game} marketplace database URL is not configured.") }),
        &http::READ_CORS,
    )
}

/// JSON response with the read CORS headers (every handler calls
/// `setCorsHeaders(res)` first).
pub fn json_with_cors(status: StatusCode, body: Value) -> Response {
    http::json_with(status, body, &http::READ_CORS)
}

/// JSON response with CORS plus a `Cache-Control` header.
pub fn json_with_cache_control(status: StatusCode, body: Value, cache_control: &str) -> Response {
    let mut headers: Vec<(&str, &str)> = http::READ_CORS.to_vec();
    headers.push(("cache-control", cache_control));
    http::json_with(status, body, &headers)
}

/// [`json_with_cache_control`] in whichever representation the request asked
/// for. The default representation is byte-identical to
/// [`json_with_cache_control`], plus `Vary: Accept`.
pub fn json_with_cache_control_c1(
    wanted: compact::Wanted,
    status: StatusCode,
    body: Value,
    cache_control: &str,
) -> Response {
    compact::json_with_cors(wanted, status, body, cache_control)
}

/// A prebuilt (snapshot) 200 body with the read CORS headers and its cache
/// policy, in the requested representation.
pub fn prebuilt(wanted: compact::Wanted, json: Vec<u8>, c1: Option<Vec<u8>>, cache_control: &str) -> Response {
    let mut headers: Vec<(&str, &str)> = http::READ_CORS.to_vec();
    headers.push(("cache-control", cache_control));
    compact::prebuilt(wanted, json, c1, &headers)
}

/// What the request asked for, from its `Accept` header and `?format=`.
pub fn wanted(headers: &HeaderMap, q: &http::Query) -> compact::Wanted {
    compact::Wanted::from_request(headers, q)
}

/// `error.statusCode || 500` + `error.message || fallback` — the Node catch
/// bodies. sqlx database errors carry the raw Postgres message; connection
/// failures map to the pipeline text the Node pg driver produced (the global
/// sanitizer then answers 503 `We are working on a solution.`).
pub fn node_error_response(error: &sqlx::Error, fallback: &str) -> Response {
    json_with_cors(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": sql_error_message(error, fallback) }),
    )
}

fn sql_error_message(error: &sqlx::Error, fallback: &str) -> String {
    match error {
        sqlx::Error::Database(db) => db.message().to_string(),
        sqlx::Error::PoolTimedOut => "could not connect to server".to_string(),
        sqlx::Error::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
            "connect ECONNREFUSED".to_string()
        }
        other if other.to_string().contains("error communicating") => {
            "connection refused".to_string()
        }
        other => {
            let text = other.to_string();
            if text.is_empty() {
                fallback.to_string()
            } else {
                text
            }
        }
    }
}

/// 405 of the expansion/rails/home/sales-pulse handlers:
/// `Allow: GET, OPTIONS` + CORS + `{ error: 'Method not allowed.' }`.
pub async fn method_not_allowed_get_options() -> Response {
    let mut headers: Vec<(&str, &str)> = http::READ_CORS.to_vec();
    headers.push(("allow", "GET, OPTIONS"));
    http::json_with(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({ "error": "Method not allowed." }),
        &headers,
    )
}

/// 405 of marketplace-version-set: CORS + `{ error: 'GET only.' }` (no
/// `Allow` header in the reference handler; axum's method router would add
/// one, so it is stripped).
pub async fn method_not_allowed_get_only() -> Response {
    let mut response = json_with_cors(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({ "error": "GET only." }),
    );
    response.headers_mut().remove(axum::http::header::ALLOW);
    response
}

/// Wrap a handler future in the request timing span of
/// `shared::timing` (`beginRequest` + `finishRequest`).
pub async fn timing_scope<F>(route: &'static str, method: &'static str, fut: F) -> Response
where
    F: std::future::Future<Output = Response>,
{
    crate::shared::timing::with_span(route, method, async {
        let response = fut.await;
        crate::shared::timing::finish_request();
        response
    })
    .await
}
