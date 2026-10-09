//! Port of `api/_public_error.js`: infrastructure failures never leak to clients.

use std::sync::OnceLock;

use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use regex::Regex;
use serde_json::{json, Value};

pub const WORKING_MESSAGE: &str = "We are working on a solution.";

fn pipeline_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|EPIPE|EAI_AGAIN|connect E[A-Z]+|127\.0\.0\.1:\d+|connection refused|too many clients|remaining connection slots|the database system is (starting|shutting)|could not connect to server")
            .expect("valid regex")
    })
}

pub fn is_pipeline_failure(text: &str) -> bool {
    pipeline_re().is_match(text)
}

/// `sanitizePublicJson(statusCode, payload)` for object payloads.
pub fn sanitize_public_json(status: StatusCode, payload: Value) -> (StatusCode, Value) {
    let Value::Object(map) = &payload else {
        return (status, payload);
    };
    if map.contains_key("checks") && map.contains_key("service") {
        return (status, payload);
    }
    let text = map
        .get("error")
        .or_else(|| map.get("message"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    if is_pipeline_failure(&text) {
        return (StatusCode::SERVICE_UNAVAILABLE, json!({ "error": WORKING_MESSAGE }));
    }
    (status, payload)
}

/// Middleware: applies `sanitize_public_json` to JSON error responses (>= 400)
/// produced by any handler, the way Node's `res.json` did for every route.
pub async fn sanitize_layer(req: Request, next: Next) -> Response {
    let response = next.run(req).await;
    if response.status().as_u16() < 400 {
        return response;
    }
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("json"));
    if !is_json {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 256 * 1024).await else {
        parts.status = StatusCode::SERVICE_UNAVAILABLE;
        parts.headers.remove(header::CONTENT_LENGTH);
        return Response::from_parts(parts, Body::from(json!({ "error": WORKING_MESSAGE }).to_string()));
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    let (status, value) = sanitize_public_json(parts.status, value);
    if status == parts.status {
        return Response::from_parts(parts, Body::from(bytes));
    }
    parts.status = status;
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    Response::from_parts(parts, Body::from(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_pipeline_failures() {
        let (status, body) = sanitize_public_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": "connect ECONNREFUSED 127.0.0.1:5432"}),
        );
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, json!({"error": WORKING_MESSAGE}));
    }

    #[test]
    fn keeps_domain_errors_and_health() {
        let (status, body) = sanitize_public_json(StatusCode::BAD_REQUEST, json!({"error": "cardId is required."}));
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "cardId is required.");
        let health = json!({"service": "x", "checks": {"postgres": {"error": "ECONNREFUSED"}}});
        assert_eq!(sanitize_public_json(StatusCode::SERVICE_UNAVAILABLE, health.clone()).1, health);
    }
}
