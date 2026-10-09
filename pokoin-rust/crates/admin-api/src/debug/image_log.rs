//! Port of `api/_marketplace_image_log.js` (per-process ring buffer of served
//! or failed marketplace image URLs) and `api/marketplace-image-log.js`
//! (GET list behind the search-debug gate, POST with the shared best-effort
//! image-log limiter, OPTIONS preflight).

use std::sync::Mutex;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Value};

use pokoin_api_common::{http, RouteState};

use super::{
    add_headers, clean_text_value, empty_response, js_truthy_string, rate_limit::limit_best_effort,
    request_query, value_get,
};

const RING_LIMIT: usize = 250;

const CORS_HEADERS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, POST, OPTIONS"),
    (
        "access-control-allow-headers",
        "Content-Type, Authorization",
    ),
    ("access-control-max-age", "86400"),
];

fn ring() -> &'static Mutex<Vec<Value>> {
    static RING: std::sync::OnceLock<Mutex<Vec<Value>>> = std::sync::OnceLock::new();
    RING.get_or_init(|| Mutex::new(Vec::new()))
}

/// `imagePrefix(url)`: leading digits of the basename (`/previews/123_...`).
pub(crate) fn image_prefix(url: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"/(?:previews/)?(\d+)_").unwrap());
    re.captures(url)
        .and_then(|caps| caps.get(1))
        .map(|found| found.as_str().to_owned())
        .unwrap_or_default()
}

/// `prefixKind(cardId, ctId, url)`.
pub(crate) fn prefix_kind(card_id: &str, ct_id: &str, url: &str) -> &'static str {
    let prefix = image_prefix(url);
    if prefix.is_empty() {
        return "none";
    }
    let card = card_id.trim();
    let ct = ct_id.trim();
    if !ct.is_empty() && prefix == ct {
        return "ct_id";
    }
    if !card.is_empty() && prefix == card {
        return "public_id";
    }
    if let Ok(number) = card.parse::<i64>() {
        if number % 2 == 0 && prefix == format!("{}", number / 2) {
            return "ct_id";
        }
    }
    "other"
}

fn record_entry(input: &Value) -> Value {
    let source = clean_text_value(value_get(input, "source"), 80);
    let status = clean_text_value(value_get(input, "status"), 40);
    let url = clean_text_value(value_get(input, "url"), 300);
    let card_id = clean_text_value(value_get(input, "cardId"), 32);
    let ct_id = clean_text_value(value_get(input, "ctId"), 32);
    let prefix = image_prefix(&url);
    let kind = prefix_kind(&card_id, &ct_id, &url);
    let entry = super::json_object(vec![
        ("at", Value::String(super::now_iso())),
        (
            "source",
            Value::String(if source.is_empty() {
                "unknown".to_owned()
            } else {
                source
            }),
        ),
        (
            "status",
            Value::String(if status.is_empty() {
                "served".to_owned()
            } else {
                status
            }),
        ),
        (
            "route",
            Value::String(clean_text_value(value_get(input, "route"), 240)),
        ),
        ("cardId", Value::String(card_id)),
        ("ctId", Value::String(ct_id)),
        (
            "name",
            Value::String(clean_text_value(value_get(input, "name"), 80)),
        ),
        ("url", Value::String(url)),
        (
            "fallbackUrl",
            Value::String(clean_text_value(value_get(input, "fallbackUrl"), 300)),
        ),
        ("prefix", Value::String(prefix)),
        ("prefixKind", Value::String(kind.to_owned())),
        (
            "error",
            Value::String(clean_text_value(value_get(input, "error"), 200)),
        ),
        (
            "sessionId",
            Value::String(clean_text_value(value_get(input, "sessionId"), 80)),
        ),
    ]);
    let mut ring = match ring().lock() {
        Ok(ring) => ring,
        Err(poisoned) => poisoned.into_inner(),
    };
    ring.push(entry.clone());
    if ring.len() > RING_LIMIT {
        ring.remove(0);
    }
    tracing::info!(entry = %entry, "marketplace-image");
    entry
}

/// `listMarketplaceImages(limit)`: newest first, 80 default, 250 max.
/// `Number(limit) || 80` — NaN and 0 both take the 80 default, negatives
/// clamp up to 1.
pub(crate) fn list_marketplace_images(limit: &str) -> Vec<Value> {
    let parsed = http::js_number(limit).filter(|value| value.is_finite());
    let value = match parsed {
        Some(value) if value != 0.0 => value,
        _ => 80.0,
    };
    let size = (value.max(1.0).min(RING_LIMIT as f64)) as usize;
    let ring = match ring().lock() {
        Ok(ring) => ring,
        Err(poisoned) => poisoned.into_inner(),
    };
    let start = ring.len().saturating_sub(size);
    ring[start..].iter().rev().cloned().collect()
}

/// `clientIp(req)`: forwarded first hop, then the real-ip header. The Node
/// `socket.remoteAddress` fallback is not observable behind the edge proxy,
/// which always sends `x-forwarded-for`.
fn client_ip(headers: &HeaderMap) -> String {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !forwarded.is_empty() {
        return forwarded;
    }
    headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

fn cors_json(status: StatusCode, body: Value, extra: &[(&str, &str)]) -> Response {
    let mut headers: Vec<(&str, &str)> = CORS_HEADERS.to_vec();
    headers.extend_from_slice(extra);
    http::json_with(status, body, &headers)
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if method == Method::OPTIONS {
        return empty_response(StatusCode::NO_CONTENT, &CORS_HEADERS);
    }
    if method == Method::GET {
        if let Err(error) = state.require_debug_admin(&headers).await {
            return add_headers(error, &CORS_HEADERS);
        }
        let query = request_query(&uri);
        let rows = list_marketplace_images(&query.text("limit"));
        return cors_json(
            StatusCode::OK,
            json!({ "count": rows.len(), "rows": rows }),
            &[("cache-control", "no-store")],
        );
    }
    if method != Method::POST {
        return cors_json(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET, POST, OPTIONS")],
        );
    }

    let verdict = limit_best_effort(&state.api, "image-log", &client_ip(&headers), 40, 60).await;
    if !verdict.allowed {
        return cors_json(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": "Too many image logs." }),
            &[],
        );
    }

    // `req.body && typeof req.body === 'object' ? req.body : {}` — raw buffers
    // are not objects in Node. Invalid JSON is the runtime's 400, which the
    // Node server answers before the handler runs.
    let parsed = match http::parse_body(&headers, &body) {
        Ok(parsed) => parsed.json(),
        Err(error) => return error,
    };
    let input = if parsed.is_object() {
        parsed
    } else {
        json!({})
    };

    // `body.source || 'client'`, `body.status || 'error'`,
    // `body.route || body.routePath`, ... (first truthy wins).
    let shaped = json!({
        "source": or_alt(&input, &["source"]),
        "status": or_alt(&input, &["status"]),
        "route": or_alt(&input, &["route", "routePath"]),
        "cardId": or_alt(&input, &["cardId", "card_id"]),
        "ctId": or_alt(&input, &["ctId", "ct_id"]),
        "name": value_get(&input, "name").clone(),
        "url": or_alt(&input, &["url", "imageUrl"]),
        "fallbackUrl": value_get(&input, "fallbackUrl").clone(),
        "error": value_get(&input, "error").clone(),
        "sessionId": value_get(&input, "sessionId").clone(),
    });
    let entry = record_entry(&shaped);
    cors_json(
        StatusCode::CREATED,
        json!({
            "ok": true,
            "prefixKind": value_get(&entry, "prefixKind").clone(),
            "prefix": value_get(&entry, "prefix").clone(),
        }),
        &[],
    )
}

/// `body.x || fallback` for JSON values: the JS string of the first truthy
/// value, else `''`.
fn or_alt(input: &Value, keys: &[&str]) -> Value {
    for key in keys {
        let text = js_truthy_string(value_get(input, key));
        if !text.is_empty() {
            return Value::String(text);
        }
    }
    Value::String(String::new())
}
