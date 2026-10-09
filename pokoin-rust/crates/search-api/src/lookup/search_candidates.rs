//! `POST /api/marketplace-search-candidates` — handler of `marketplace-search-candidates.js`
//! on top of the autocomplete engine (`rowsForSearchTerm`).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use pokoin_api_common::{http, RouteState};
use serde_json::{json, Value};

use crate::autocomplete::engine::{self, Ctx, EngineError};
use crate::autocomplete::{handler, normalize, row};

fn get_first<'a>(body: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| body.get(*k)).find(|v| !v.is_null())
}

/// `req.body?.debug === true || req.body?.debug === '1'` (strict).
pub fn strict_debug(body: &Value) -> bool {
    matches!(body.get("debug"), Some(Value::Bool(true))) || matches!(body.get("debug"), Some(Value::String(s)) if s == "1")
}

pub fn engine_error(error: &EngineError, fallback: &str) -> Response {
    tracing::error!(message = %error.message, "search route failed");
    let status = error.status.and_then(|s| StatusCode::from_u16(s).ok()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let message = if error.message.is_empty() { fallback.to_owned() } else { error.message.clone() };
    http::json(status, json!({ "error": message }))
}

/// `authorizeSearchDebugRequest(req)` — throws the auth error to the catch.
pub async fn authorize_debug(state: &RouteState, headers: &HeaderMap) -> Result<Value, Response> {
    let (user, error) = handler::debug_user(state, headers, true).await;
    if let Some(user) = user {
        return Ok(user);
    }
    let error = error.unwrap_or_else(|| json!({ "message": "Search debug is not enabled for this account.", "statusCode": 403 }));
    let status = error.get("statusCode").and_then(Value::as_u64).and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    Err(http::json(status, json!({ "error": error.get("message").cloned().unwrap_or(Value::Null) })))
}

pub async fn handler(State(state): State<RouteState>, method: Method, headers: HeaderMap, raw: Bytes) -> Response {
    if method != Method::POST {
        return http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &[("allow", "POST")]);
    }
    let body = match http::parse_body(&headers, &raw) {
        Ok(body) => body.json(),
        Err(response) => return response,
    };
    let search_term = normalize::clean_search_term(get_first(&body, &["search_term", "searchTerm"]));
    let result_limit = normalize::clean_limit(get_first(&body, &["result_limit", "limit"]));
    let result_offset = normalize::clean_offset(get_first(&body, &["result_offset", "offset"]));
    let search_language = normalize::clean_language(get_first(&body, &["search_language", "language"]));
    let wants_debug = strict_debug(&body);
    let debug_user = if wants_debug {
        match authorize_debug(&state, &headers).await {
            Ok(user) => Some(user),
            Err(response) => return response,
        }
    } else {
        None
    };
    let debug = debug_user.map(|user| {
        json!({
            "sessionId": normalize::clean_search_term(body.get("debug_session_id")),
            "user": user,
            "searchTerm": search_term,
            "resultLimit": result_limit,
            "resultOffset": result_offset,
            "searchLanguage": search_language,
            "steps": [],
        })
    });
    if search_term.is_empty() {
        return http::json(StatusCode::OK, match debug {
            Some(debug) => json!({ "rows": [], "debug": debug }),
            None => json!([]),
        });
    }
    let started = std::time::Instant::now();
    let redis = state.api.redis().await;
    let mut ctx = Ctx::new(state.api.read().clone(), redis.clone());
    ctx.debug = debug;
    let rows = match engine::rows_for_search_term(&mut ctx, redis, &search_term, result_limit, result_offset, &search_language, false).await {
        Ok(rows) => rows.iter().map(row::with_card_emoji_fields).collect::<Vec<_>>(),
        Err(error) => return engine_error(&error, "Marketplace search candidate fetch failed."),
    };
    let duration_ms = started.elapsed().as_millis();
    let timing = format!("search;dur={duration_ms}");
    let payload = match ctx.debug.take() {
        Some(Value::Object(mut debug)) => {
            debug.insert("durationMs".into(), json!(duration_ms as u64));
            debug.insert("topRows".into(), Value::Array(rows.iter().take(10).map(engine::row_summary).collect()));
            json!({ "rows": rows, "debug": debug })
        }
        _ => Value::Array(rows),
    };
    http::json_with(StatusCode::OK, payload, &[("cache-control", "public, max-age=5, s-maxage=20"), ("server-timing", &timing)])
}
