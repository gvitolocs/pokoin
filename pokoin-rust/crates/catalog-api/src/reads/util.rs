//! Handler plumbing of the catalog read routes (Node `res.status().json()` shapes).

use axum::http::StatusCode;
use axum::response::Response;
use pokoin_api_common::http;
use serde_json::{json, Value};

/// `Math.min(Math.max(Math.trunc(Number(value)), 1), max)` with `NaN -> fallback`.
/// `searchParams.get()` returns `null` for an absent key and `Number(null)` is 0,
/// so an absent limit is 1 — exactly what production answers.
pub fn js_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    let n = match raw {
        None => 0.0,
        Some(text) => match http::js_number(text) {
            Some(n) => n,
            None => return fallback,
        },
    };
    if !n.is_finite() {
        return fallback;
    }
    (n.trunc() as i64).clamp(1, max)
}

/// JS `String(value || '').trim()` of a search param.
pub fn param(q: &http::Query, key: &str) -> String {
    q.search_param(key).unwrap_or("").trim().to_owned()
}

/// First non-empty search param (`a || b || c`), untrimmed like the JS.
pub fn first_of<'a>(q: &'a http::Query, keys: &[&str]) -> Option<&'a str> {
    keys.iter().filter_map(|k| q.search_param(k)).find(|v| !v.is_empty())
}

pub fn json_cache(status: StatusCode, body: Value, cache_control: &str) -> Response {
    if cache_control.is_empty() {
        return http::json(status, body);
    }
    http::json_with(status, body, &[("cache-control", cache_control)])
}

/// `res.setHeader('Allow', allow); res.status(405).json({ error: 'Method not allowed.' })`.
pub fn method_not_allowed(allow: &str) -> Response {
    http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &[("allow", allow)])
}

/// The Node catch: `res.status(error.statusCode || 500).json({ error: error.message || fallback })`.
/// Postgres errors surface their message like node-pg; pipeline failures are
/// rewritten to the 503 working message by the global sanitizer.
pub fn db_error(route: &str, error: &sqlx::Error, fallback: &str) -> Response {
    tracing::error!(route, %error, "catalog read failed");
    let message = match error {
        sqlx::Error::Database(db) => db.message().to_owned(),
        sqlx::Error::PoolTimedOut => "timeout exceeded when trying to connect".to_owned(),
        other => other.to_string(),
    };
    let message = if message.is_empty() { fallback.to_owned() } else { message };
    http::json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": message }))
}

/// `new URL(text, 'https://pokoin.com').pathname` for card paths.
pub fn url_pathname(text: &str) -> String {
    let text = text.trim();
    let without_origin = match text.find("://") {
        Some(i) => {
            let rest = &text[i + 3..];
            rest.find('/').map(|j| &rest[j..]).unwrap_or("/")
        }
        None => text,
    };
    let path = without_origin.split(['?', '#']).next().unwrap_or("");
    if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    }
}

/// `decodeURIComponent` that keeps the input when it is malformed.
pub fn decode_component(text: &str) -> String {
    percent_decode(text).unwrap_or_else(|| text.to_owned())
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_follow_number_semantics() {
        assert_eq!(js_limit(None, 240, 1000), 1);
        assert_eq!(js_limit(Some(""), 240, 1000), 1);
        assert_eq!(js_limit(Some("abc"), 240, 1000), 240);
        assert_eq!(js_limit(Some("4.9"), 240, 1000), 4);
        assert_eq!(js_limit(Some("5000"), 240, 1000), 1000);
    }

    #[test]
    fn pathnames() {
        assert_eq!(url_pathname("https://pokoin.com/marketplace/en/cards/1/x?y=1"), "/marketplace/en/cards/1/x");
        assert_eq!(url_pathname("/239324/slug#a"), "/239324/slug");
        assert_eq!(decode_component("a%20b"), "a b");
        assert_eq!(decode_component("bad%zz"), "bad%zz");
    }
}
