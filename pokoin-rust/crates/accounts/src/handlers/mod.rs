//! Shared handler helpers: CORS, bearer extraction, JSON bodies and responses.

pub mod associate;
pub mod auth;
pub mod chat;
pub mod collection;
pub mod forum;
pub mod news;
pub mod partner;
pub mod poko;
pub mod portfolio;
pub mod poko_bets;
pub mod poko_chat;
pub mod poko_market;
pub mod referral;
pub mod user;
pub mod wallet;

use axum::body::Bytes;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Map, Value as JsonValue};

use crate::error::{ApiError, Result};
use crate::firebase::{bearer, Claims};
use crate::state::DomainState;

/// The exact CORS header set the Node handlers emitted.
pub const CORS_ALLOW_ORIGIN: &str = "*";
pub const CORS_ALLOW_METHODS: &str = "POST, OPTIONS";
pub const CORS_ALLOW_HEADERS: &str = "Content-Type, Authorization";
pub const CORS_MAX_AGE: &str = "86400";

pub fn apply_cors(headers: &mut HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static(CORS_ALLOW_ORIGIN),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(CORS_ALLOW_METHODS),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(CORS_ALLOW_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static(CORS_MAX_AGE),
    );
}

/// `OPTIONS` preflight: 204 with the CORS headers, like the Node handlers.
pub async fn preflight() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors(response.headers_mut());
    response
}

/// A JSON response with the CORS headers applied.
pub fn json_with_cors(status: StatusCode, body: JsonValue) -> Response {
    let mut response = (status, Json(body)).into_response();
    apply_cors(response.headers_mut());
    response
}

/// A JSON response with `Cache-Control`.
pub fn json_cached(status: StatusCode, body: JsonValue, cache_control: &str) -> Response {
    let mut response = json_with_cors(status, body);
    if let Ok(value) = HeaderValue::from_str(cache_control) {
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    response
}

/// Parse a request body the way `req.body || {}` did.
pub fn parse_body(body: &Bytes) -> JsonValue {
    if body.is_empty() {
        return JsonValue::Object(Map::new());
    }
    serde_json::from_slice(body).unwrap_or_else(|_| JsonValue::Object(Map::new()))
}

pub fn object(body: &JsonValue) -> Map<String, JsonValue> {
    body.as_object().cloned().unwrap_or_default()
}

pub fn string_field(body: &JsonValue, key: &str) -> String {
    body.get(key)
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string()
}

pub fn bool_field(body: &JsonValue, key: &str) -> bool {
    body.get(key).and_then(JsonValue::as_bool).unwrap_or(false)
}

pub fn number_field(body: &JsonValue, key: &str) -> Option<f64> {
    body.get(key).and_then(JsonValue::as_f64)
}

pub fn authorization(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
}

/// `verifyBearerToken(req)`: a missing token is a 401, a bad one a 401, and the
/// password-email gate is applied exactly as `assertActivePasswordAccount`.
pub async fn require_claims(state: &DomainState, headers: &HeaderMap) -> Result<Claims> {
    let token = bearer(authorization(headers)).map_err(ApiError::from)?;
    let claims = state
        .verifier()
        .verify(token)
        .await
        .map_err(ApiError::from)?;
    claims.assert_active_password_account(state.config().require_verified_password)?;
    Ok(claims)
}

/// Optional auth: a broken or absent token yields `None` (news-comments GET).
pub async fn optional_claims(state: &DomainState, headers: &HeaderMap) -> Option<Claims> {
    let raw = authorization(headers)?;
    if !raw.starts_with("Bearer ") {
        return None;
    }
    let token = bearer(Some(raw)).ok()?;
    let claims = state.verifier().verify(token).await.ok()?;
    claims
        .assert_active_password_account(state.config().require_verified_password)
        .ok()?;
    Some(claims)
}

/// 405 with the `Allow` header, like the Node handlers.
pub fn method_not_allowed(allow: &str) -> Response {
    let mut response = ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.")
        .into_response();
    if let Ok(value) = HeaderValue::from_str(allow) {
        response.headers_mut().insert(header::ALLOW, value);
    }
    apply_cors(response.headers_mut());
    response
}

/// 202/200 JSON helper for the account routes.
pub fn ok(body: JsonValue) -> Response {
    json_with_cors(StatusCode::OK, body)
}

pub fn accepted(body: JsonValue) -> Response {
    json_with_cors(StatusCode::ACCEPTED, body)
}

/// Milliseconds since epoch -> ISO 8601 (Node `new Date(ms).toISOString()`).
pub fn iso_from_millis(millis: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Seconds since epoch -> ISO 8601, for Firebase `exp` / `auth_time`.
pub fn iso_from_seconds(seconds: i64) -> Option<String> {
    if seconds == 0 {
        return None;
    }
    iso_from_millis(seconds.saturating_mul(1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_parsing_defaults_to_an_empty_object() {
        assert_eq!(parse_body(&Bytes::new()), JsonValue::Object(Map::new()));
        assert_eq!(
            parse_body(&Bytes::from_static(b"not json")),
            JsonValue::Object(Map::new())
        );
        let parsed = parse_body(&Bytes::from_static(br#"{"a":1}"#));
        assert_eq!(parsed["a"], serde_json::json!(1));
    }

    #[test]
    fn field_helpers_match_javascript_coercion() {
        let body = serde_json::json!({ "s": "x", "b": true, "n": 2.5, "nil": JsonValue::Null });
        assert_eq!(string_field(&body, "s"), "x");
        assert_eq!(string_field(&body, "missing"), "");
        assert_eq!(string_field(&body, "n"), "");
        assert!(bool_field(&body, "b"));
        assert!(!bool_field(&body, "missing"));
        assert_eq!(number_field(&body, "n"), Some(2.5));
        assert_eq!(number_field(&body, "s"), None);
    }

    #[test]
    fn iso_helpers_match_toisostring() {
        assert_eq!(
            iso_from_millis(0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_seconds(1_700_000_000).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        // Node produced `null` when the claim was absent (0 falsy).
        assert_eq!(iso_from_seconds(0), None);
    }

    #[test]
    fn cors_headers_match_the_node_set() {
        let mut headers = HeaderMap::new();
        apply_cors(&mut headers);
        assert_eq!(headers["access-control-allow-origin"], "*");
        assert_eq!(headers["access-control-allow-methods"], "POST, OPTIONS");
        assert_eq!(
            headers["access-control-allow-headers"],
            "Content-Type, Authorization"
        );
        assert_eq!(headers["access-control-max-age"], "86400");
    }
}
