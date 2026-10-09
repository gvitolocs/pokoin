//! Shared API plumbing: error shape, text cleaning, CORS, client IP.
//!
//! Every Node handler in the reference answers with
//! `res.status(error.statusCode || 500).json({ error, code? })`; `ApiError`
//! is that convention as a type.

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

/// Mirror of the Node `error.statusCode` / `error.code` convention.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    pub code: Option<String>,
    /// `problems` travels on submit validation failures (scan batch).
    pub problems: Option<Value>,
    /// Seconds for a `Retry-After` header (rate limits).
    pub retry_after_sec: Option<u64>,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), code: None, problems: None, retry_after_sec: None }
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }

    pub fn upstream(message: impl Into<String>) -> Self {
        Self::new(502, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, message)
    }

    /// SQL "relation does not exist" (Postgres 42P01) — the Node code treats
    /// these as optional-table misses, not crashes.
    pub fn is_table_missing(&self) -> bool {
        self.message.contains("does not exist")
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        let message = error.to_string();
        let status = if message.contains("does not exist") { 503 } else { 500 };
        Self::new(status, message)
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(error: reqwest::Error) -> Self {
        Self::new(502, error.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(500, error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut payload = json!({
            "error": self.message.clone(),
        });
        let obj = payload.as_object_mut().unwrap();
        if let Some(code) = &self.code {
            obj.insert("code".into(), Value::String(code.clone()));
        }
        if let Some(problems) = &self.problems {
            obj.insert("problems".into(), problems.clone());
        }
        let mut response = (status, axum::Json(payload)).into_response();
        if let Some(retry) = self.retry_after_sec {
            if let Ok(value) = HeaderValue::from_str(&retry.to_string()) {
                response.headers_mut().insert("Retry-After", value);
            }
        }
        no_store(response)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// Convenience mutations on `serde_json::Value` used by reconcile counters.
pub trait ValueExt {
    /// Add `delta` to the integer value (0 when absent/not a number).
    fn incr(&mut self, delta: i64);
    /// Replace with an integer.
    fn set_i64(&mut self, value: i64);
}

impl ValueExt for Value {
    fn incr(&mut self, delta: i64) {
        let next = self.as_i64().unwrap_or(0) + delta;
        *self = Value::from(next);
    }

    fn set_i64(&mut self, value: i64) {
        *self = Value::from(value);
    }
}


/// `cleanText(value, maxLength)` — trim then hard-cut. The reference default.
pub fn clean_text(value: Option<&str>, max: usize) -> String {
    value.unwrap_or_default().trim().chars().take(max).collect()
}

/// cleanText over a serde value's string form (JS coerces everything).
pub fn clean_text_value(value: &Value, max: usize) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => clean_text(Some(text), max),
        other => clean_text(Some(&other.to_string()), max),
    }
}

pub fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => s == "true" || s == "1",
        _ => false,
    }
}

pub fn f64_field(value: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(found) = value.get(*key) {
            match found {
                Value::Null => continue,
                Value::Number(n) => return n.as_f64(),
                Value::String(s) => {
                    if let Ok(parsed) = s.trim().parse::<f64>() {
                        return Some(parsed);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

pub fn i64_field(value: &Value, keys: &[&str]) -> Option<i64> {
    f64_field(value, keys).map(|f| f.trunc() as i64)
}

/// CORS allowlist shared by the scan-connect family (`_scan_http.js`).
pub const SCAN_ALLOWED_ORIGINS: [&str; 5] = [
    "https://pokoin.com",
    "https://www.pokoin.com",
    "https://dashboard.pokoin.com",
    "https://scan.pokoin.com",
    "https://cardscan.pokoin.com",
];

pub fn header_value(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// `clientIp(req)` from `_scan_http.js`: CF first, then XFF first hop, then peer.
pub fn scan_client_ip(headers: &HeaderMap) -> String {
    header_value(headers, "x-pokoin-client-ip").chars().take(64).collect::<String>()
}

/// Only the trusted global middleware may interpret forwarding headers.
pub fn xff_client_ip(headers: &HeaderMap) -> String {
    header_value(headers, "x-pokoin-client-ip")
}

pub fn set_cors_open(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, Authorization"),
    );
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
}

pub fn json_response(status: u16, payload: Value) -> Response {
    let mut response = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        axum::Json(payload),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn method_not_allowed(allow: &str) -> Response {
    let mut response = json_response(405, json!({ "error": "Method not allowed." }));
    if let Ok(value) = HeaderValue::from_str(allow) {
        response.headers_mut().insert(header::ALLOW, value);
    }
    response
}
