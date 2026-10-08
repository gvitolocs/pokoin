//! Shared route helpers: bearer auth, query/body parsing, CORS preflight and
//! the explicit "not implemented" response used for audited gaps.

use axum::body::Bytes;
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use serde_json::{json, Value};

use crate::error::{header_value, json_response, set_cors_open, ApiError, ApiResult};
use crate::firebase::DecodedToken;
use crate::state::DomainState;

/// Verify the Firebase bearer token and return the decoded identity. A missing
/// or invalid token is always the reference 401.
pub async fn require_token(state: &DomainState, headers: &HeaderMap) -> ApiResult<DecodedToken> {
    let authorization = header_value(headers, "authorization");
    state.verifier.verify(Some(authorization.as_str())).await
}

/// Parsed JSON body; an empty body is `{}` so "no required fields" handlers work.
pub async fn body_json(body: &Bytes) -> ApiResult<Value> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|_| ApiError::bad_request("Invalid JSON body."))
}

/// Percent-decoded query pairs in order.
pub fn query_pairs(uri: &Uri) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(raw) = uri.query() else {
        return out;
    };
    for pair in raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        out.push((decode(key), decode(value)));
    }
    out
}

/// First value for a query key.
pub fn query_first(uri: &Uri, key: &str) -> Option<String> {
    query_pairs(uri)
        .into_iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

/// Bounded integer query parameter with a default and clamp.
pub fn query_i64(uri: &Uri, key: &str, default: i64, min: i64, max: i64) -> i64 {
    query_first(uri, key)
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn decode(value: &str) -> String {
    let plus_free = value.replace('+', " ");
    percent_encoding::percent_decode_str(&plus_free)
        .decode_utf8_lossy()
        .to_string()
}

/// `OPTIONS` preflight for the public scan/system surfaces.
pub async fn preflight() -> Response {
    let mut response = json_response(204, json!({}));
    set_cors_open(&mut response);
    response
}

/// Explicit, honest 501 for an audited gap. Never a fake success.
pub fn not_implemented(route: &str, reason: &str) -> ApiResult<Response> {
    let _ = route;
    Err(ApiError::new(501, reason).with_code("not_implemented"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(raw: &str) -> Uri {
        raw.parse().unwrap()
    }

    #[test]
    fn query_pairs_decode_and_bound() {
        let pairs = query_pairs(&uri("/api/x?a=1&b=hello%20world&c=%2C"));
        assert_eq!(pairs[0], ("a".to_string(), "1".to_string()));
        assert_eq!(pairs[1], ("b".to_string(), "hello world".to_string()));
        assert_eq!(pairs[2], ("c".to_string(), ",".to_string()));
        assert_eq!(query_first(&uri("/api/x?a=1"), "a").as_deref(), Some("1"));
        assert_eq!(query_first(&uri("/api/x?a=1"), "z"), None);
    }

    #[test]
    fn query_int_clamps() {
        assert_eq!(query_i64(&uri("/api/x?n=999"), "n", 10, 0, 100), 100);
        assert_eq!(query_i64(&uri("/api/x?n=-5"), "n", 10, 0, 100), 0);
        assert_eq!(query_i64(&uri("/api/x"), "n", 10, 0, 100), 10);
        assert_eq!(query_i64(&uri("/api/x?n=abc"), "n", 10, 0, 100), 10);
    }
}
