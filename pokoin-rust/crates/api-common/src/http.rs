//! Request/response conventions of the retired Node runtime
//! (`server/oracle-api-server.js` + `api/_marketplace_react_card.js`).

use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use serde_json::{json, Map, Value};

use crate::public_error::sanitize_public_json;

/// `req.query` of the Node runtime: ordered pairs, `+` decoded as space.
#[derive(Clone, Debug, Default)]
pub struct Query {
    pairs: Vec<(String, String)>,
}

impl Query {
    pub fn from_uri(uri: &Uri) -> Self {
        Self::parse(uri.query().unwrap_or(""))
    }

    pub fn parse(raw: &str) -> Self {
        Self { pairs: serde_urlencoded::from_str(raw).unwrap_or_default() }
    }

    /// `String(req.query[key] || '')`: a repeated key becomes `"a,b"` (JS array
    /// stringification); a missing key is `None`.
    pub fn get(&self, key: &str) -> Option<String> {
        let values = self.all(key);
        if values.is_empty() {
            None
        } else {
            Some(values.join(","))
        }
    }

    /// `get` with `''` for a missing key.
    pub fn text(&self, key: &str) -> String {
        self.get(key).unwrap_or_default()
    }

    /// First non-empty of several aliases (`req.query.a || req.query.b`).
    pub fn any(&self, keys: &[&str]) -> String {
        keys.iter()
            .filter_map(|k| self.get(k))
            .find(|v| !v.is_empty())
            .unwrap_or_default()
    }

    pub fn first(&self, key: &str) -> Option<&str> {
        self.pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// `URLSearchParams.get` returns the first; Node handlers that read
    /// `new URL(req.url).searchParams.get(k)` use this.
    pub fn search_param(&self, key: &str) -> Option<&str> {
        self.first(key)
    }

    pub fn last(&self, key: &str) -> Option<&str> {
        self.pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn all(&self, key: &str) -> Vec<&str> {
        self.pairs.iter().filter(|(k, _)| k == key).map(|(_, v)| v.as_str()).collect()
    }

    pub fn has(&self, key: &str) -> bool {
        self.pairs.iter().any(|(k, _)| k == key)
    }

    pub fn pairs(&self) -> &[(String, String)] {
        &self.pairs
    }

    /// `req.query` as a JSON object (repeated keys become arrays).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        for (k, v) in &self.pairs {
            match map.get_mut(k) {
                Some(Value::Array(items)) => items.push(Value::String(v.clone())),
                Some(existing) => {
                    let first = existing.take();
                    *existing = Value::Array(vec![first, Value::String(v.clone())]);
                }
                None => {
                    map.insert(k.clone(), Value::String(v.clone()));
                }
            }
        }
        Value::Object(map)
    }
}

/// `bodyFromBuffer(buffer, contentType)`.
#[derive(Clone, Debug)]
pub enum NodeBody {
    /// Empty body: Node handlers see `{}`.
    Empty,
    Json(Value),
    Form(Value),
    /// Any other content type: Node handlers see the raw Buffer.
    Raw(Bytes),
}

impl NodeBody {
    /// `req.body` as JSON; raw buffers become `Value::Null` (field reads are
    /// `undefined` in Node).
    pub fn json(&self) -> Value {
        match self {
            NodeBody::Empty => Value::Object(Map::new()),
            NodeBody::Json(v) | NodeBody::Form(v) => v.clone(),
            NodeBody::Raw(_) => Value::Null,
        }
    }
}

/// Max JSON body accepted by the Node runtime (`ORACLE_API_JSON_LIMIT_BYTES`).
pub const JSON_LIMIT_BYTES: usize = 10 * 1024 * 1024;

/// Decode a body like the Node runtime. Invalid JSON is the runtime's 400.
pub fn parse_body(headers: &HeaderMap, bytes: &Bytes) -> Result<NodeBody, Response> {
    if bytes.is_empty() {
        return Ok(NodeBody::Empty);
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("application/json") || content_type.contains("+json") {
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim();
        if text.is_empty() {
            return Ok(NodeBody::Empty);
        }
        return serde_json::from_str(text)
            .map(NodeBody::Json)
            .map_err(|_| json(StatusCode::BAD_REQUEST, json!({ "error": "Invalid JSON request body." })));
    }
    if content_type.contains("application/x-www-form-urlencoded") {
        let pairs: Vec<(String, String)> =
            serde_urlencoded::from_bytes(bytes).unwrap_or_default();
        let mut map = Map::new();
        for (k, v) in pairs {
            // Object.fromEntries keeps the last duplicate.
            map.insert(k, Value::String(v));
        }
        return Ok(NodeBody::Form(Value::Object(map)));
    }
    Ok(NodeBody::Raw(bytes.clone()))
}

/// `res.status(code).json(payload)` with `sanitizePublicJson`.
pub fn json(status: StatusCode, body: Value) -> Response {
    json_with(status, body, &[])
}

/// JSON response plus explicit headers (`res.setHeader` calls of the handler).
pub fn json_with(status: StatusCode, body: Value, headers: &[(&str, &str)]) -> Response {
    let (status, body) = sanitize_public_json(status, body);
    let mut response = (status, Body::from(body.to_string())).into_response();
    let map = response.headers_mut();
    map.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(*name), HeaderValue::try_from(*value)) {
            map.insert(name, value);
        }
    }
    response
}

/// Any body with an explicit content type and headers.
pub fn raw(status: StatusCode, content_type: &str, body: impl Into<Body>, headers: &[(&str, &str)]) -> Response {
    let mut response = (status, body.into()).into_response();
    let map = response.headers_mut();
    if let Ok(value) = HeaderValue::try_from(content_type) {
        map.insert(header::CONTENT_TYPE, value);
    }
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(*name), HeaderValue::try_from(*value)) {
            map.insert(name, value);
        }
    }
    response
}

/// `setCorsHeaders(res)` of `_marketplace_react_card.js`.
pub const READ_CORS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, OPTIONS"),
    ("access-control-allow-headers", "Content-Type, Authorization"),
    ("access-control-max-age", "86400"),
];

/// `jsonOk(res, body, cacheControl)`.
pub fn json_ok(body: Value, cache_control: &str) -> Response {
    let mut headers: Vec<(&str, &str)> = READ_CORS.to_vec();
    if !cache_control.is_empty() {
        headers.push(("cache-control", cache_control));
    }
    json_with(StatusCode::OK, body, &headers)
}

/// 204 preflight with the read CORS headers.
pub fn read_preflight() -> Response {
    raw(StatusCode::NO_CONTENT, "text/plain; charset=utf-8", Body::empty(), &READ_CORS)
}

/// JavaScript `Number(text)` for request strings: trims, `''` is 0, hex/binary/octal
/// prefixes, otherwise a decimal float. `None` is `NaN`.
pub fn js_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    let (neg, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let lower = body.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            // JS rejects signed radix literals.
            if neg || t.starts_with('+') {
                return None;
            }
            return u64::from_str_radix(digits, radix).ok().map(|v| v as f64);
        }
    }
    if lower == "infinity" {
        return Some(if neg { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if lower.contains("inf") || lower.contains("nan") || lower.starts_with('_') {
        return None;
    }
    let v: f64 = body.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// `parsePublicCardId(value)`.
pub fn parse_public_card_id(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return String::new();
    }
    match text.parse::<u64>() {
        Ok(id) if id > 0 && id <= 9_007_199_254_740_991 => id.to_string(),
        _ => String::new(),
    }
}

/// `parseIdList(value, max)`.
pub fn parse_id_list(value: &str, max: usize) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for part in value.split(',') {
        let id = parse_public_card_id(part);
        if id.is_empty() || ids.contains(&id) {
            continue;
        }
        ids.push(id);
        if ids.len() >= max {
            break;
        }
    }
    ids
}

/// `parseLimit(value, fallback, max)` (`value` absent or `''` -> fallback).
pub fn parse_limit(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    let Some(raw) = value.filter(|v| !v.is_empty()) else {
        return fallback;
    };
    match js_number(raw) {
        Some(n) if n.is_finite() => (n.trunc() as i64).clamp(1, max),
        _ => fallback,
    }
}

/// `parseOffset(value)`.
pub fn parse_offset(value: Option<&str>) -> i64 {
    match value.and_then(js_number) {
        Some(n) if n.is_finite() && n >= 0.0 => n.trunc() as i64,
        // Number(undefined) is NaN -> 0.
        _ => 0,
    }
}

/// Request headers as `(lowercase name, value)` pairs for `game::parse_game_from_request`.
pub fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_ascii_lowercase(), v.to_owned())))
        .collect()
}

/// Bearer token of `Authorization: Bearer <token>`.
pub fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_matches_node() {
        let q = Query::parse("a=1&b=x+y&a=2&c=");
        assert_eq!(q.get("a").as_deref(), Some("1,2"));
        assert_eq!(q.get("b").as_deref(), Some("x y"));
        assert_eq!(q.get("c").as_deref(), Some(""));
        assert_eq!(q.get("d"), None);
        assert_eq!(q.any(&["c", "b"]), "x y");
        assert_eq!(q.to_json()["a"], json!(["1", "2"]));
    }

    #[test]
    fn numbers_match_js() {
        assert_eq!(js_number(" 12 "), Some(12.0));
        assert_eq!(js_number("1e2"), Some(100.0));
        assert_eq!(js_number("0x10"), Some(16.0));
        assert_eq!(js_number("12abc"), None);
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(parse_limit(Some("500"), 24, 100), 100);
        assert_eq!(parse_limit(Some("0"), 24, 100), 1);
        assert_eq!(parse_limit(Some("abc"), 24, 100), 24);
        assert_eq!(parse_limit(None, 24, 100), 24);
        assert_eq!(parse_offset(Some("-3")), 0);
        assert_eq!(parse_offset(Some("7.9")), 7);
        assert_eq!(parse_id_list("3, 3,x,4,0", 24), vec!["3", "4"]);
    }

    #[test]
    fn body_decoding() {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert!(parse_body(&h, &Bytes::from_static(b"{bad")).is_err());
        assert_eq!(parse_body(&h, &Bytes::from_static(b"{\"a\":1}")).unwrap().json()["a"], 1);
        assert_eq!(parse_body(&h, &Bytes::new()).unwrap().json(), json!({}));
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-www-form-urlencoded"));
        assert_eq!(parse_body(&h, &Bytes::from_static(b"a=1&a=2")).unwrap().json()["a"], "2");
    }
}
