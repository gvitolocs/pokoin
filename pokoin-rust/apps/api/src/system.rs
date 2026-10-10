//! System paths of the retired Node runtime (`oracle-api-server.js`):
//! liveness/readiness (`api/_pipeline_health.js`), the staging page, the
//! opt-in route manifest (`api-route-families.js`), the client contract, the
//! JSON 404, and Node's path normalisation (trailing slash, `/api/x.js`, path
//! params mirrored into the query).

use std::time::Duration;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::AppState;

const MANIFEST: &str = include_str!("../fixtures/route-manifest.json");
const CONTRACT: &str = include_str!("../fixtures/client-contract.json");
const STAGING_HTML: &str = include_str!("../fixtures/staging.html");
const TIMEOUT: Duration = Duration::from_millis(800);

const FAMILIES: [(&str, &str); 14] = [
    ("page-bff", "React page BFFs"),
    ("search", "Search"),
    ("card", "Card identity"),
    ("catalog", "Catalog / sets"),
    ("commerce", "Listings / cart / orders"),
    ("scan", "Scan Connect"),
    ("cardtrader", "CardTrader"),
    ("cardmarket", "Cardmarket"),
    ("auth", "Auth"),
    ("payments", "PKN / Stripe"),
    ("assistant", "Assistant"),
    ("social", "Social"),
    ("debug", "Debug / ops"),
    ("other", "Other"),
];

fn manifest() -> Vec<Value> {
    serde_json::from_str(MANIFEST).unwrap_or_default()
}

/// Number of routes the runtime hosts (`routeDefinitions.length`).
pub(crate) fn route_count() -> usize {
    manifest().len()
}

fn json(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Body::from(body.to_string())).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    response
}

fn service_name() -> String {
    std::env::var("POKOIN_API_SERVICE_NAME").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "pokoin-oracle-api".into())
}

/// `liveness()`.
pub(crate) async fn liveness() -> Response {
    json(StatusCode::OK, json!({"ok": true, "live": true, "service": service_name()}))
}

/// `sanitizeCheckError(text)`.
fn sanitize_check_error(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return "down".into();
    }
    let lower = raw.to_ascii_lowercase();
    if lower.contains("econnrefused") || lower.contains("connection refused") {
        return "econnrefused".into();
    }
    if lower.contains("etimedout") || lower.contains("timeout") || lower.contains("timed out") {
        return "timeout".into();
    }
    if lower.contains("enotfound") || lower.contains("eai_again") || lower.contains("failed to lookup") {
        return "unresolved".into();
    }
    if pokoin_api_common::public_error::is_pipeline_failure(raw) {
        return "down".into();
    }
    raw.chars().take(80).collect()
}

fn fail(text: impl std::fmt::Display) -> Value {
    json!({"ok": false, "error": sanitize_check_error(&text.to_string())})
}

async fn probe_postgres(state: &AppState) -> Value {
    if state.config.database_url.is_none() {
        return json!({"ok": false, "error": "not_configured"});
    }
    let Some(pool) = state.db.read().await.clone() else {
        return fail("connection refused");
    };
    match tokio::time::timeout(TIMEOUT, sqlx::query_scalar::<_, i32>("SELECT 1 AS ok").fetch_one(&pool)).await {
        Ok(Ok(v)) => json!({"ok": v == 1}),
        Ok(Err(error)) => fail(error),
        Err(_) => json!({"ok": false, "error": "timeout"}),
    }
}

fn redis_target() -> (String, u16) {
    let host = std::env::var("REDIS_HOST").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    let port = std::env::var("REDIS_PORT")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("POKOIN_REDIS_PORT").ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(6380);
    (host, port)
}

/// Dedicated `PING` on its own socket, like `probeRedis()`.
async fn probe_redis() -> Value {
    let (host, port) = redis_target();
    let probe = async {
        let mut socket = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| e.to_string())?;
        socket.write_all(b"*1\r\n$4\r\nPING\r\n").await.map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 64];
        while !buf.contains(&b'\n') {
            let n = socket.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("closed".to_string());
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok::<_, String>(String::from_utf8_lossy(&buf).split("\r\n").next().unwrap_or("").to_owned())
    };
    match tokio::time::timeout(TIMEOUT, probe).await {
        Ok(Ok(line)) if line == "+PONG" => json!({"ok": true}),
        Ok(Ok(_)) => json!({"ok": false, "error": "unexpected"}),
        Ok(Err(error)) => fail(error),
        Err(_) => json!({"ok": false, "error": "timeout"}),
    }
}

async fn probe_cdn(state: &AppState) -> Value {
    let url = std::env::var("POKOIN_CDN_HEALTH_URL").unwrap_or_else(|_| "http://127.0.0.1:18081/health".into());
    match tokio::time::timeout(TIMEOUT, state.http.get(&url).send()).await {
        Ok(Ok(response)) if response.status().is_success() => json!({"ok": true}),
        Ok(Ok(response)) => json!({"ok": false, "error": format!("http_{}", response.status().as_u16())}),
        Ok(Err(error)) => fail(if error.is_connect() { "ECONNREFUSED".to_string() } else { error.to_string() }),
        Err(_) => json!({"ok": false, "error": "timeout"}),
    }
}

fn with(mut row: Value, extra: Value) -> Value {
    if let (Some(map), Value::Object(add)) = (row.as_object_mut(), extra) {
        for (k, v) in add {
            map.insert(k, v);
        }
    }
    row
}

/// `readiness()` + `routes` count, 200 when Postgres and Redis (unless skipped) are ok.
pub(crate) async fn readiness(State(state): State<AppState>) -> Response {
    let (postgres, redis, cdn) = tokio::join!(probe_postgres(&state), probe_redis(), probe_cdn(&state));
    let skip: Vec<String> = std::env::var("PIPELINE_HEALTH_SKIP")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    let ok_of = |row: &Value| row.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let ok = (skip.iter().any(|s| s == "postgres") || ok_of(&postgres)) && (skip.iter().any(|s| s == "redis") || ok_of(&redis));
    let (host, port) = redis_target();
    let body = json!({
        "ok": ok,
        "ready": ok,
        "service": service_name(),
        "checks": {
            "postgres": with(postgres, json!({"role": "required"})),
            // Node reported its Redis cache counters here; the native runtime has none.
            "redis": with(redis, json!({"role": "required", "host": host, "port": port, "cache": null})),
            "cdn": with(cdn, json!({"role": "degraded"})),
        },
        "retired": ["meili"],
        "routes": route_count(),
    });
    json(if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }, body)
}

/// `stagingMarketplaceHtml(host)`.
fn staging_html(host: &str) -> String {
    let safe: String = host.chars().filter(|c| !matches!(c, '<' | '>' | '"' | '\'' | '&')).collect();
    let safe = if safe.is_empty() { "api.pokoin.com".to_owned() } else { safe };
    let families = FAMILIES
        .iter()
        .map(|(id, title)| format!("<li><code>{id}</code> — {title}</li>"))
        .collect::<Vec<_>>()
        .join("\n      ");
    STAGING_HTML.replace("__FAMILIES__", &families).replace("__HOST__", &safe)
}

async fn staging(headers: HeaderMap) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("api.pokoin.com");
    let mut response = (StatusCode::OK, Body::from(staging_html(host))).into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `familyForPath(path)`.
pub(crate) fn family_for_path(path: &str) -> &'static str {
    static RULES: std::sync::OnceLock<Vec<(Regex, &'static str)>> = std::sync::OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r"/api/marketplace-(home|search|card|expansion)-page(?:\.js)?$|/api/marketplace-portfolio(?:\.js)?$", "page-bff"),
            (r"suggest|autocomplete|searchbar|search-candidates|extension-card-search|/api/marketplace-cards(?:\.js)?$", "search"),
            (r"marketplace-card-(url|shortlink|seo|sales|last-median|cheapest|versions)|marketplace-version-set", "card"),
            (r"/api/scan-(session|pair|phone|batch|stream)(?:\.js)?$", "scan"),
            (r"cardtrader|/api/ingest", "cardtrader"),
            (r"cardmarket", "cardmarket"),
            (r"listings|marketplace-cart|marketplace-orders|watchlist|marketplace-recents|marketplace-event", "commerce"),
            (r"auth-login|user-current-page|cache-google|ensure-username", "auth"),
            (r"stripe|create-pkn|crypto-pkn|earn-pkn|top-up|wpkn|bitcoin", "payments"),
            (r"pokoin-assistant|trainingai", "assistant"),
            (r"social", "social"),
            (r"debug|flutter-debug|image-log", "debug"),
            (r"expansion|artist|hot-blueprint|limitless|competitive", "catalog"),
        ]
        .into_iter()
        .map(|(re, id)| (Regex::new(re).expect("valid family regex"), id))
        .collect()
    });
    rules.iter().find(|(re, _)| re.is_match(path)).map(|(_, id)| *id).unwrap_or("other")
}

fn route_rows(family_filter: &str) -> Vec<Value> {
    manifest()
        .into_iter()
        .map(|row| {
            let path = row.get("path").and_then(Value::as_str).unwrap_or("").to_owned();
            let mut out = Map::new();
            for key in ["path", "methods", "file", "purpose"] {
                out.insert(key.into(), row.get(key).cloned().unwrap_or(Value::Null));
            }
            out.insert("family".into(), json!(family_for_path(&path)));
            Value::Object(out)
        })
        .filter(|row| family_filter.is_empty() || row["family"] == family_filter)
        .collect()
}

fn families_value() -> Value {
    Value::Array(FAMILIES.iter().map(|(id, title)| json!({"id": id, "title": title})).collect())
}

/// `groupRoutes(routes)`.
fn group_routes(routes: &[Value]) -> Value {
    Value::Array(
        FAMILIES
            .iter()
            .filter_map(|(id, title)| {
                let members: Vec<Value> = routes.iter().filter(|r| r["family"] == *id).cloned().collect();
                (!members.is_empty()).then(|| json!({"id": id, "title": title, "routes": members}))
            })
            .collect(),
    )
}

/// `/api/__routes` — only when `POKOIN_EXPOSE_ROUTE_MANIFEST=1`, else the plain 404.
async fn routes(uri: Uri) -> Response {
    if !pokoin_api_common::security::route_manifest_enabled() {
        return not_found().await;
    }
    let q = pokoin_api_common::http::Query::from_uri(&uri);
    let family = q.search_param("family").unwrap_or("").trim().to_owned();
    let rows = route_rows(&family);
    if q.search_param("group") == Some("1") || q.search_param("grouped") == Some("1") {
        return json(StatusCode::OK, json!({"count": rows.len(), "families": group_routes(&rows)}));
    }
    json(StatusCode::OK, json!({"count": rows.len(), "families": families_value(), "routes": rows}))
}

async fn contract() -> Response {
    json(StatusCode::OK, serde_json::from_str(CONTRACT).unwrap_or_else(|_| json!({})))
}

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(staging))
        .route("/marketplace", get(staging))
        .route("/livez", get(liveness))
        .route("/api/livez", get(liveness))
        .route("/readyz", get(readiness))
        .route("/api/readyz", get(readiness))
        .route("/healthz", get(readiness))
        .route("/api/healthz", get(readiness))
        .route("/api/__routes", get(routes))
        .route("/api/__contract", get(contract))
        .with_state(state)
}

/// Node: `sendJson(res, 404, { error: 'API route not found.' })`.
pub(crate) async fn fallback(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") || uri.path()=="/api" { return not_found().await; }
    let mut response=Response::new(axum::body::Body::empty());
    *response.status_mut()=StatusCode::NOT_FOUND;
    response.headers_mut().insert("cache-control",axum::http::HeaderValue::from_static("private, no-store"));
    response
}

pub(crate) async fn not_found() -> Response {
    json(StatusCode::NOT_FOUND, json!({"error": "API route not found."}))
}

/// `normalizePathname` + the `.js` alias of `routeForPathname`.
fn normalize_path(path: &str) -> String {
    let mut out = if path.len() > 1 && path.ends_with('/') { path[..path.len() - 1].to_owned() } else { path.to_owned() };
    if out.starts_with("/api/") && out.ends_with(".js") && manifest_match(&out[..out.len() - 3]).is_some() && manifest_match(&out).is_none() {
        out.truncate(out.len() - 3);
    }
    out
}

/// The manifest route matching `path` and its `:param` values (decoded).
fn manifest_match(path: &str) -> Option<Vec<(String, String)>> {
    let actual: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    for row in manifest() {
        let Some(pattern) = row.get("path").and_then(Value::as_str) else { continue };
        let expected: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
        if expected.len() != actual.len() {
            continue;
        }
        let mut params = Vec::new();
        let mut matched = true;
        for (want, got) in expected.iter().zip(&actual) {
            if let Some(name) = want.strip_prefix(':') {
                let value = percent_encoding::percent_decode_str(got).decode_utf8_lossy().into_owned();
                params.push((name.to_owned(), value));
            } else if want != got {
                matched = false;
                break;
            }
        }
        if matched {
            return Some(params);
        }
    }
    None
}

/// Applied around the whole router (before routing).
pub(crate) async fn normalize_request(mut request: Request, next: Next) -> Response {
    let original = request.uri().clone();
    let path = normalize_path(original.path());
    let mut query = original.query().unwrap_or("").to_owned();
    if let Some(params) = manifest_match(&path) {
        let existing = pokoin_api_common::http::Query::parse(&query);
        let mut extra: Vec<(String, String)> = params.into_iter().filter(|(k, v)| !v.is_empty() && !existing.has(k)).collect();
        // addLegacyActionQuery: `action` is already one of the params when the route has it.
        extra.dedup_by(|a, b| a.0 == b.0);
        if !extra.is_empty() {
            let encoded = serde_urlencoded::to_string(&extra).unwrap_or_default();
            query = if query.is_empty() { encoded } else { format!("{query}&{encoded}") };
        }
    }
    if path != original.path() || query != original.query().unwrap_or("") {
        let target = if query.is_empty() { path } else { format!("{path}?{query}") };
        if let Ok(uri) = target.parse() {
            *request.uri_mut() = uri;
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_and_families() {
        assert_eq!(route_count(), 146);
        assert_eq!(route_rows("page-bff").len(), 5);
        assert_eq!(family_for_path("/api/marketplace-card-page"), "page-bff");
        assert_eq!(family_for_path("/api/searchbar-cards"), "search");
        assert_eq!(family_for_path("/api/cardtrader-webhook/:uid"), "cardtrader");
        assert_eq!(family_for_path("/api/forum"), "other");
        let grouped = group_routes(&route_rows(""));
        assert_eq!(grouped[0]["id"], "page-bff");
    }

    #[test]
    fn normalisation() {
        assert_eq!(normalize_path("/api/marketplace-card-url.js"), "/api/marketplace-card-url");
        assert_eq!(normalize_path("/api/marketplace-card-url/"), "/api/marketplace-card-url");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(manifest_match("/api/cardtrader-webhook/a%2Fb"), Some(vec![("uid".into(), "a/b".into())]));
        assert_eq!(manifest_match("/api/crypto-pkn-sale/quote"), Some(vec![("action".into(), "quote".into())]));
        assert!(manifest_match("/api/nope").is_none());
    }

    #[test]
    fn staging_page() {
        let html = staging_html("api.pokoin.com<x>");
        assert!(html.contains("curl https://api.pokoin.comx/healthz"));
        assert!(html.contains("<li><code>page-bff</code> — React page BFFs</li>"));
        assert!(!html.contains("__routes"));
    }

    #[test]
    fn check_errors() {
        assert_eq!(sanitize_check_error("connect ECONNREFUSED 127.0.0.1:5432"), "econnrefused");
        assert_eq!(sanitize_check_error("pool timed out while waiting"), "timeout");
        assert_eq!(sanitize_check_error("28P01"), "28P01");
    }
}
