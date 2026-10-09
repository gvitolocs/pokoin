//! Ports of the operator/debug route handlers (`api/marketplace-debug-*.js`,
//! `api/marketplace-image-log.js`, `api/flutter-debug-logs.js`,
//! `api/cardmarket-scrape-observation.js`).
//!
//! Pool discipline follows `_marketplace_db.js` exactly: every call the Node
//! code makes through `marketplaceQuery` runs on `state.api.read()` and every
//! `marketplaceWriteQuery` runs on `state.api.write()` — including the
//! `create table if not exists` guards, which the Node handlers also run
//! through `marketplaceQuery`.

pub mod cm_candidates;
pub mod debug_artists;
pub mod debug_blueprints;
pub mod debug_events;
pub mod debug_refinement;
pub mod expansion_symbols;
pub mod flutter_logs;
pub mod guess_review;
pub mod image_log;
pub mod rate_limit;
pub mod scrape_observation;

use axum::{
    body::Body,
    http::{HeaderName, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use pokoin_api_common::{http, RouteState};
use serde_json::{Map, Value};

/// Routes owned by this module (paths carry the full `/api` prefix).
pub fn routes() -> Router<RouteState> {
    Router::new()
        .route("/api/marketplace-debug-artists", any(debug_artists::handle))
        .route(
            "/api/marketplace-debug-cardtrader-blueprints",
            any(debug_blueprints::handle),
        )
        .route("/api/marketplace-debug-events", any(debug_events::handle))
        .route(
            "/api/marketplace-debug-refinement",
            any(debug_refinement::handle),
        )
        .route("/api/marketplace-image-log", any(image_log::handle))
        .route("/api/flutter-debug-logs", any(flutter_logs::handle))
        .route(
            "/api/marketplace-cardmarket-guess-review",
            any(guess_review::handle),
        )
        .route(
            "/api/cardmarket-scrape-observation",
            any(scrape_observation::handle),
        )
        .route(
            "/api/marketplace-expansion-symbols",
            any(expansion_symbols::handle),
        )
}

// --- JSON value helpers mirroring the JS coercions the handlers rely on -----

/// `body?.field` for object bodies; missing keys read as `Value::Null`
/// (undefined in Node).
pub(crate) fn value_get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// `String(value)`: the JS string conversion of a JSON value.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(number) => js_number_text(number),
            None => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String(value || '')`: JS falsy values (null, false, 0, '', empty array)
/// collapse to `''` before the conversion.
pub(crate) fn js_truthy_string(value: &Value) -> String {
    let falsy = match value {
        Value::Null => true,
        Value::Bool(b) => !*b,
        Value::String(s) => s.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::Object(_) => false,
    };
    if falsy {
        String::new()
    } else {
        js_string(value)
    }
}

/// `Number(x)` where the key may be absent: JS `undefined` converts to NaN,
/// while an explicit JSON `null` converts to 0.
pub(crate) fn js_number_of_optional(value: Option<&Value>) -> Option<f64> {
    match value {
        None => None,
        Some(value) => js_number_of(value),
    }
}

/// `Number(value)`; `None` is JS NaN.
pub(crate) fn js_number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(true) => Some(1.0),
        Value::Bool(false) => Some(0.0),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => http::js_number(s),
        Value::Array(items) => match items.len() {
            0 => Some(0.0),
            1 => js_number_of(&items[0]),
            _ => None,
        },
        Value::Object(_) => None,
    }
}

/// `String(number)` the way V8 prints doubles for the values these handlers
/// see (integers stay integers; exponents beyond 1e21 match V8's `e+21`).
pub(crate) fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == value.trunc() && value.abs() < 1e21 {
        let mut text = format!("{}", value as i128);
        if text == "0" && value.is_sign_negative() {
            text = "0".to_owned();
        }
        return text;
    }
    if value.abs() >= 1e21 {
        return format!("{value:e}");
    }
    format!("{value}")
}

/// `String.prototype.slice(0, maxLength)` — UTF-16 code units, like JS.
pub(crate) fn truncate_utf16(text: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        let len = ch.len_utf16();
        if units + len > max {
            break;
        }
        units += len;
        out.push(ch);
    }
    out
}

/// `cleanText(value, maxLength)` of the debug handlers: `String(v || '').trim().slice(0, max)`.
pub(crate) fn clean_text_value(value: &Value, max: usize) -> String {
    truncate_utf16(js_truthy_string(value).trim(), max)
}

/// `Number.isSafeInteger(id) && id > 0 ? id : 0`.
pub(crate) fn clean_blueprint_id_value(value: &Value) -> i64 {
    match js_number_of(value) {
        Some(n) if n.is_finite() && n.trunc() == n && n > 0.0 && n <= 9_007_199_254_740_991.0 => {
            n as i64
        }
        _ => 0,
    }
}

/// A response without a content type (Node `res.status(204).end()`).
pub(crate) fn empty_response(status: StatusCode, headers: &[(&str, &str)]) -> Response {
    let mut response = (status, Body::empty()).into_response();
    let map = response.headers_mut();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(*name), HeaderValue::try_from(*value))
        {
            map.insert(name, value);
        }
    }
    response
}

/// Append headers to an existing response (route CORS around the shared
/// auth-failure responses).
pub(crate) fn add_headers(response: Response, headers: &[(&str, &str)]) -> Response {
    let mut response = response;
    let map = response.headers_mut();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(*name), HeaderValue::try_from(*value))
        {
            map.insert(name, value);
        }
    }
    response
}

/// A handler error held as status + JSON body so callers can re-emit it with
/// route-specific headers (Node sets headers before `res.status(...).json`).
#[derive(Debug)]
pub(crate) struct HandlerError {
    pub status: StatusCode,
    pub body: Value,
}

impl HandlerError {
    pub fn new(status: StatusCode, message: &str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "error": message }),
        }
    }

    pub fn message(&self) -> String {
        self.body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    pub fn into_response_with(self, headers: &[(&str, &str)]) -> Response {
        http::json_with(self.status, self.body, headers)
    }
}

/// JS truthiness for `a || b || c` chains over JSON values.
pub(crate) fn first_truthy<'a>(values: &[&'a Value]) -> Option<&'a Value> {
    for value in values {
        let truthy = match value {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::String(text) => !text.is_empty(),
            Value::Array(items) => !items.is_empty(),
            Value::Number(number) => number.as_f64() != Some(0.0),
            Value::Object(_) => true,
        };
        if truthy {
            return Some(value);
        }
    }
    None
}

/// Infrastructure failure body; the shared sanitize layer turns connection
/// text into the public `503` like Node's `res.json`.
pub(crate) fn internal_error(message: &str) -> Response {
    http::json(
        StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({ "error": message }),
    )
}

/// `error.message` of a sqlx failure as a `HandlerError` (500).
pub(crate) fn db_error(error: sqlx::Error) -> HandlerError {
    HandlerError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        body: serde_json::json!({ "error": db_error_message(&error) }),
    }
}

/// `error.message` of a sqlx failure the way Node's pg driver surfaces it
/// (bare server message for database errors).
pub(crate) fn db_error_message(error: &sqlx::Error) -> String {
    match error.as_database_error() {
        Some(db) => db.message().to_owned(),
        None => error.to_string(),
    }
}

/// `error.code` of a sqlx failure (`42P01`, `23505`, ...).
pub(crate) fn db_error_code(error: &sqlx::Error) -> Option<String> {
    error
        .as_database_error()
        .and_then(|db| db.code())
        .map(|code| code.to_string())
}

/// Postgres `42P01` (relation does not exist).
pub(crate) fn is_missing_table_error(error: &sqlx::Error) -> bool {
    db_error_code(error).as_deref() == Some("42P01")
}

/// `new Date().toISOString()`.
pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `timestamp.toISOString()` for a row timestamp (`null` stays null).
pub(crate) fn iso_millis(value: &Option<chrono::DateTime<chrono::Utc>>) -> Value {
    match value {
        Some(value) => Value::String(value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        None => Value::Null,
    }
}

/// `{ uid, email, username }` returned by `authorizeSearchDebugRequest`:
/// email and username are normalized (trimmed, lowercase) off the verified
/// token claims.
#[derive(Clone, Debug)]
pub(crate) struct DebugUser {
    pub uid: String,
    pub email: String,
    pub username: String,
}

impl DebugUser {
    pub fn from_claims(claims: &pokoin_accounts::firebase::Claims) -> Self {
        Self {
            uid: claims.uid.clone(),
            email: claims.email.trim().to_ascii_lowercase(),
            username: claims.name.trim().to_ascii_lowercase(),
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "uid": self.uid,
            "email": self.email,
            "username": self.username,
        })
    }
}

/// Query string of the request with Node `req.query` semantics.
pub(crate) fn request_query(uri: &Uri) -> http::Query {
    http::Query::from_uri(uri)
}

/// Insertion-ordered JSON object helper (serde_json `preserve_order`).
pub(crate) fn json_object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

#[cfg(test)]
mod router_tests {
    use super::*;
    use axum::{body::to_bytes, http::Request};
    use pokoin_accounts::firebase::{AuthError, Claims};
    use pokoin_api_common::state::lazy_pool;
    use std::sync::Arc;
    use tower::ServiceExt;

    /// Accepts any non-empty bearer as the operator account (verified email
    /// on the `_search_debug_auth` allow list), so authed paths reach the
    /// handlers in tests.
    struct AdminVerifier;

    impl pokoin_accounts::firebase::TokenVerifier for AdminVerifier {
        fn verify<'life0, 'life1, 'async_trait>(
            &'life0 self,
            _token: &'life1 str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Claims, AuthError>> + Send + 'async_trait>,
        >
        where
            'life0: 'async_trait,
            'life1: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async {
                let mut claims = Claims::default();
                claims.uid = "test-op".to_owned();
                claims.email = "vitologiuseppe17@gmail.com".to_owned();
                claims.email_verified = true;
                claims.name = "Test Op".to_owned();
                Ok(claims)
            })
        }
    }

    fn test_state() -> RouteState {
        let pool = lazy_pool("postgres://x@127.0.0.1:1/x", 1).unwrap();
        let api = pokoin_api_common::ApiState::new(pool.clone(), pool, None, 1);
        let accounts =
            pokoin_accounts::DomainState::default().with_verifier(Arc::new(AdminVerifier));
        RouteState::new(api, accounts)
    }

    async fn call(request: Request<axum::body::Body>) -> (StatusCode, String) {
        let response = crate::debug::routes()
            .with_state(test_state())
            .oneshot(request)
            .await
            .unwrap_or_else(|error| panic!("router response: {error}"));
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    fn get(uri: &str) -> Request<axum::body::Body> {
        Request::builder()
            .uri(uri)
            .body(axum::body::Body::empty())
            .unwrap()
    }

    fn request(method: &str, uri: &str, body: &'static str) -> Request<axum::body::Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .unwrap()
    }

    /// Live read-path smoke check against the real replica:
    /// `MARKETPLACE_DATABASE_URL=... cargo test -p pokoin-admin-api -- --ignored --nocapture`
    /// Read-only; skipped unless the env var is set.
    #[tokio::test]
    #[ignore = "needs MARKETPLACE_DATABASE_URL"]
    async fn live_read_paths_answer_200_with_node_shapes() {
        let url = match std::env::var("MARKETPLACE_DATABASE_URL") {
            Ok(url) if !url.trim().is_empty() => url,
            _ => {
                eprintln!("MARKETPLACE_DATABASE_URL not set; skipping");
                return;
            }
        };
        let pool = lazy_pool(url.trim(), 2).unwrap();
        let api = pokoin_api_common::ApiState::new(pool.clone(), pool, None, 2);
        let accounts =
            pokoin_accounts::DomainState::default().with_verifier(Arc::new(AdminVerifier));
        let state = RouteState::new(api, accounts);

        // `/api/marketplace-debug-artists` is intentionally not in this smoke
        // list: its next-candidate query is the Node-identical correlated
        // count over every unresolved row and exceeds the tunnel budget here.
        // `/api/marketplace-debug-artists` is intentionally not in this smoke
        // list: its next-candidate query is the Node-identical correlated
        // count over every unresolved row and exceeds the tunnel budget here.
        for (uri, expected_keys) in [
            (
                "/api/marketplace-debug-events?limit=3",
                vec!["rows", "summary", "filters", "generatedAt"],
            ),
            (
                "/api/marketplace-cardmarket-guess-review?limit=5",
                vec![
                    "generatedAt",
                    "guesses",
                    "riskyGuesses",
                    "missingExpansions",
                ],
            ),
            (
                "/api/marketplace-expansion-symbols?limit=5",
                vec!["expansions"],
            ),
            (
                "/api/marketplace-debug-refinement?limit=3",
                vec!["rows", "user", "generatedAt"],
            ),
            (
                "/api/flutter-debug-logs?limit=3",
                vec!["rows", "filters", "generatedAt"],
            ),
            (
                "/api/marketplace-debug-cardtrader-blueprints?game=pokemon",
                vec!["ok", "game", "job", "oracleWorker"],
            ),
        ] {
            let request = Request::builder()
                .uri(uri)
                .header("authorization", "Bearer live-op")
                .body(axum::body::Body::empty())
                .unwrap();
            let response = crate::debug::routes()
                .with_state(state.clone())
                .oneshot(request)
                .await
                .unwrap_or_else(|error| panic!("router response: {error}"));
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
                .await
                .unwrap_or_default();
            let body: serde_json::Value =
                serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
            assert_eq!(status, StatusCode::OK, "{uri} -> {body}");
            for key in expected_keys {
                assert!(body.get(key).is_some(), "{uri} missing key {key}: {body}");
            }
            eprintln!("OK {uri}");
        }

        // news-stats SQL directly (the Firestore admin gate cannot run here).
        for (name, sql) in [
            ("articles", crate::analytics::news_stats::sql_articles()),
            ("depth", crate::analytics::news_stats::sql_depth()),
            ("time", crate::analytics::news_stats::sql_time()),
            ("daily", crate::analytics::news_stats::sql_daily()),
            ("positions", crate::analytics::news_stats::sql_positions()),
            ("overall", crate::analytics::news_stats::sql_overall()),
        ] {
            let rows = sqlx::query(&sql)
                .bind(7_i32)
                .fetch_all(state.api.read())
                .await
                .unwrap_or_else(|error| panic!("news-stats {name} failed: {error}"));
            eprintln!("OK news-stats {name}: {} rows", rows.len());
        }
    }

    #[tokio::test]
    async fn debug_routes_answer_their_methods_without_404() {
        // Mounted surface: authed GETs must not be 404/405. With the dead
        // pool the DB-backed handlers answer their DB-failure response.
        for uri in [
            "/api/marketplace-debug-artists",
            "/api/marketplace-debug-cardtrader-blueprints?game=pokemon",
            "/api/marketplace-debug-events",
            "/api/marketplace-debug-refinement?limit=3",
            "/api/marketplace-cardmarket-guess-review",
            "/api/marketplace-expansion-symbols",
            "/api/flutter-debug-logs",
        ] {
            let request = Request::builder()
                .uri(uri)
                .header("authorization", "Bearer test-op")
                .body(axum::body::Body::empty())
                .unwrap();
            let (status, _) = call(request).await;
            assert_ne!(status, StatusCode::NOT_FOUND, "{uri}");
            assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "{uri}");
            assert!(
                status.is_server_error(),
                "{uri} -> {status} (dead-pool failure expected)"
            );
        }
    }

    #[tokio::test]
    async fn unauthenticated_requests_answer_the_node_401_body() {
        for uri in [
            "/api/marketplace-debug-artists",
            "/api/marketplace-debug-cardtrader-blueprints",
            "/api/marketplace-debug-events",
            "/api/marketplace-debug-refinement",
            "/api/marketplace-image-log",
            "/api/flutter-debug-logs",
            "/api/marketplace-cardmarket-guess-review",
            "/api/marketplace-expansion-symbols",
        ] {
            let (status, body) = call(get(uri)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
            assert_eq!(body, r#"{"error":"Missing Pokoin bearer token."}"#, "{uri}");
        }
    }

    #[tokio::test]
    async fn unsupported_methods_answer_the_node_405_bodies() {
        let (status, body) = call(request("POST", "/api/marketplace-debug-events", "{}")).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body, r#"{"error":"Method not allowed."}"#);

        let (status, body) = call(request(
            "POST",
            "/api/marketplace-cardmarket-guess-review",
            "",
        ))
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body, r#"{"error":"Method not allowed."}"#);

        let (status, body) = call(get("/api/cardmarket-scrape-observation")).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body, r#"{"error":"Method not allowed."}"#);

        let (status, _) = call(request("PATCH", "/api/marketplace-debug-artists", "{}")).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        let (status, _) = call(request("DELETE", "/api/marketplace-debug-refinement", "")).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        let (status, _) = call(request(
            "PUT",
            "/api/marketplace-debug-cardtrader-blueprints",
            "{}",
        ))
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        let (status, _) = call(request("PUT", "/api/flutter-debug-logs", "{}")).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn expansion_symbols_authorizes_before_the_method_check() {
        // The Node handler runs requireDebugOrAdmin before dispatching, so an
        // unauthenticated DELETE is a 401, not a 405.
        let request = Request::builder()
            .method("DELETE")
            .uri("/api/marketplace-expansion-symbols")
            .body(axum::body::Body::empty())
            .unwrap();
        let (status, body) = call(request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, r#"{"error":"Missing Pokoin bearer token."}"#);
    }

    #[tokio::test]
    async fn image_log_options_posts_and_lists_without_a_database() {
        let options_request = Request::builder()
            .method("OPTIONS")
            .uri("/api/marketplace-image-log")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = crate::debug::routes()
            .with_state(test_state())
            .oneshot(options_request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(response
            .headers()
            .get("access-control-allow-origin")
            .is_some());

        let (status, body) = call(request("POST", "/api/marketplace-image-log", "{}")).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body, r#"{"ok":true,"prefixKind":"none","prefix":""}"#);

        let (status, body) = call(
            request(
                "POST",
                "/api/marketplace-image-log",
                r#"{"source":"test","status":"served","route":"/x","cardId":"10","ctId":"5","url":"https://cdn.pokoin.com/previews/5_card.webp"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert!(body.contains(r#""prefixKind":"ct_id""#), "{body}");
        assert!(body.contains(r#""prefix":"5""#), "{body}");

        let request = Request::builder()
            .uri("/api/marketplace-image-log?limit=2")
            .header("authorization", "Bearer test-op")
            .body(axum::body::Body::empty())
            .unwrap();
        let (status, body) = call(request).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#""count":"#), "{body}");
        assert!(body.contains(r#""prefix":"5""#), "{body}");
    }

    #[tokio::test]
    async fn image_log_put_is_405_with_cors_and_allow() {
        let put_request = Request::builder()
            .method("PUT")
            .uri("/api/marketplace-image-log")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = crate::debug::routes()
            .with_state(test_state())
            .oneshot(put_request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-methods")
                .and_then(|value| value.to_str().ok()),
            Some("GET, POST, OPTIONS")
        );
        assert_eq!(
            response
                .headers()
                .get("allow")
                .and_then(|value| value.to_str().ok()),
            Some("GET, POST, OPTIONS")
        );
    }

    #[tokio::test]
    async fn scrape_observation_validates_the_url_before_any_database() {
        let (status, body) =
            call(request("POST", "/api/cardmarket-scrape-observation", "{}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            r#"{"error":"A valid Cardmarket singles URL is required."}"#
        );

        let (status, body) = call(request(
            "POST",
            "/api/cardmarket-scrape-observation",
            r#"{"cardmarketUrl":"https://example.com/en/Pokemon/Products/Singles/X"}"#,
        ))
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            r#"{"error":"A valid Cardmarket singles URL is required."}"#
        );
    }

    fn authed_post(uri: &str, body: &'static str) -> Request<axum::body::Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .header("authorization", "Bearer test-op")
            .body(axum::body::Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn flutter_logs_validation_errors_carry_no_store() {
        let (status, body) = call(authed_post("/api/flutter-debug-logs", "{}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"error":"Flutter debug event name is required."}"#);

        let (status, body) = call(authed_post(
            "/api/flutter-debug-logs",
            r#"{"eventName":"card_scan"}"#,
        ))
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"error":"Flutter debug session id is required."}"#);

        // Without the header the shared debug gate 401s like Node.
        let (status, _) = call(request("POST", "/api/flutter-debug-logs", "{}")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
