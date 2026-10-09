//! Small Node-semantics helpers shared by the market routes.

use axum::http::{HeaderName, HeaderValue};
use axum::response::Response;
use pokoin_api_common::http;
use serde_json::{json, Value};

use crate::shared::js;

/// `row[key] || ''` (the raw value when truthy).
pub fn or_empty(row: &Value, key: &str) -> Value {
    row.get(key).filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!(""))
}

/// `a || b || ''` over several keys.
pub fn or_chain(row: &Value, keys: &[&str], fallback: Value) -> Value {
    keys.iter().filter_map(|k| row.get(*k)).find(|v| js::truthy(Some(v))).cloned().unwrap_or(fallback)
}

/// `Number(row[key] || 0)`.
pub fn num0(row: &Value, key: &str) -> Value {
    let v = row.get(key);
    if js::truthy(v) { js::js_json_number(js::number(v)) } else { json!(0) }
}

/// `row[key]` (undefined/null -> null).
pub fn raw(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `row[key] == null ? null : Number(row[key])`.
pub fn num_or_null(row: &Value, key: &str) -> Value {
    match row.get(key) {
        None | Some(Value::Null) => Value::Null,
        v => js::js_json_number(js::number(v)),
    }
}

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn with_headers(mut response: Response, headers: &[(&str, &str)]) -> Response {
    let map = response.headers_mut();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(*name), HeaderValue::try_from(*value)) {
            map.insert(name, value);
        }
    }
    response
}

pub fn db_message(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(db) => db.message().to_owned(),
        sqlx::Error::PoolTimedOut => "timeout exceeded when trying to connect".to_owned(),
        other => other.to_string(),
    }
}

/// The Node catch: `res.status(500).json({ error: error.message || fallback })`.
pub fn failed(route: &str, error: &sqlx::Error, fallback: &str) -> Response {
    tracing::error!(route, %error, "market route failed");
    let message = db_message(error);
    http::json(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": if message.is_empty() { fallback.to_owned() } else { message } }),
    )
}
