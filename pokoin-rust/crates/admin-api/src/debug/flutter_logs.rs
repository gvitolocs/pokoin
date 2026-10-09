//! Port of `api/flutter-debug-logs.js` — protected Flutter client debug-log
//! writes and reads (`public.flutter_debug_logs`), authenticated either with
//! the shared search-debug account or a configured debug token
//! (`FLUTTER_DEBUG_LOG_TOKEN` / `POKOIN_DEBUG_LOG_TOKEN` /
//! `MARKETPLACE_DEBUG_LOG_TOKEN`).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Map, Value};

use pokoin_api_common::{http, RouteState};

use super::{
    clean_text_value, db_error, first_truthy, is_missing_table_error, iso_millis, json_object,
    request_query, truncate_utf16, value_get, DebugUser, HandlerError,
};
use sqlx::Row;

const MAX_PAYLOAD_DEPTH: usize = 4;
const MAX_PAYLOAD_KEYS: usize = 60;
const MAX_PAYLOAD_ARRAY: usize = 80;
const MIGRATION_PATH: &str = "oracle-postgres/schema/010_flutter_debug_logs.sql";
const DEFAULT_READ_LIMIT: i64 = 200;
const MAX_READ_LIMIT: i64 = 5000;

const DEBUG_TOKEN_ENVS: [&str; 3] = [
    "FLUTTER_DEBUG_LOG_TOKEN",
    "POKOIN_DEBUG_LOG_TOKEN",
    "MARKETPLACE_DEBUG_LOG_TOKEN",
];

const NO_STORE: [(&str, &str); 1] = [("cache-control", "no-store")];

fn secret_key_pattern() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)(authorization|cookie|credential|password|secret|token|api[_-]?key|private[_-]?key|session)")
            .unwrap()
    })
}

/// `configuredDebugToken()`.
pub(crate) fn configured_debug_token() -> String {
    for name in DEBUG_TOKEN_ENVS {
        if let Ok(token) = std::env::var(name) {
            let token = token.trim();
            if !token.is_empty() {
                return token.to_owned();
            }
        }
    }
    String::new()
}

/// `requestDebugToken(req)`: direct headers first, then the bearer token.
pub(crate) fn request_debug_token(headers: &HeaderMap) -> String {
    for name in [
        "x-flutter-debug-token",
        "x-pokoin-debug-token",
        "x-debug-token",
    ] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    match authorization.rsplit_once(' ') {
        Some((scheme, token))
            if scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty() =>
        {
            token.trim().to_owned()
        }
        _ => String::new(),
    }
}

/// `authorizeFlutterDebugRequest(req)`.
pub(crate) async fn authorize_flutter_debug_request(
    state: &RouteState,
    headers: &HeaderMap,
) -> Result<DebugUser, Response> {
    let configured = configured_debug_token();
    let supplied = request_debug_token(headers);
    if !configured.is_empty() && supplied == configured {
        return Ok(DebugUser {
            uid: "debug-token".to_owned(),
            email: String::new(),
            username: "debug-token".to_owned(),
        });
    }
    state
        .require_debug_admin(headers)
        .await
        .map(|claims| DebugUser::from_claims(&claims))
}

/// `cleanEventName(value)`.
pub(crate) fn clean_event_name(value: &Value) -> String {
    let cleaned = clean_text_value(value, 120).to_lowercase();
    let mut out = String::new();
    let mut last_was_separator = false;
    for ch in cleaned.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '.' | ':' | '-') {
            out.push(ch);
            last_was_separator = false;
        } else if !last_was_separator {
            out.push('_');
            last_was_separator = true;
        }
    }
    out.trim_matches('_').to_owned()
}

/// `cleanCategory(value)`.
pub(crate) fn clean_category(value: &Value) -> String {
    let cleaned = clean_event_name(value);
    if cleaned.is_empty() {
        "flutter".to_owned()
    } else {
        cleaned
    }
}

/// `cleanLimit(value, fallback = 200)`.
pub(crate) fn clean_limit(value: Option<&str>, fallback: i64) -> i64 {
    match value.and_then(http::js_number) {
        Some(limit) if limit.is_finite() => (limit.trunc() as i64).clamp(1, MAX_READ_LIMIT),
        _ => fallback,
    }
}

/// `cleanTimestamp(value)`: parse the common client shapes into an ISO string,
/// `None` for unparseable input.
pub(crate) fn clean_timestamp(value: &Value) -> Option<String> {
    let raw = clean_text_value(value, 80);
    if raw.is_empty() {
        return None;
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(&raw)
        .ok()
        .map(|value| value.with_timezone(&chrono::Utc))
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|naive| {
                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc)
                })
        })
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(&raw, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|naive| {
                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc)
                })
        })
        .or_else(|| {
            // `new Date(<numeric string>)`: epoch millis (or seconds).
            raw.parse::<i64>().ok().and_then(|value| {
                if raw.len() > 11 {
                    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(value)
                } else {
                    chrono::DateTime::<chrono::Utc>::from_timestamp(value, 0)
                }
            })
        })?;
    Some(parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// `cleanUrl(value)`: parse (relative against https://pokoin.com), drop
/// secret query params, and keep the absolute or path form.
pub(crate) fn clean_url(value: &Value) -> String {
    let raw = clean_text_value(value, 1000);
    if raw.is_empty() {
        return String::new();
    }
    let is_absolute = raw.len() > 2
        && raw
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic())
        && raw.contains("://");
    let parsed = if is_absolute {
        reqwest::Url::parse(&raw).ok()
    } else {
        reqwest::Url::parse("https://pokoin.com/")
            .ok()
            .and_then(|base| base.join(&raw).ok())
    };
    match parsed {
        Some(mut parsed) => {
            if parsed.query().is_some() {
                let pairs: Vec<(String, String)> = parsed
                    .query_pairs()
                    .filter(|(key, _)| !secret_key_pattern().is_match(key))
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect();
                {
                    let mut query = parsed.query_pairs_mut();
                    query.clear();
                    query.extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
                }
                // `searchParams.delete` on the last param leaves no `?`.
                if pairs.is_empty() {
                    parsed.set_query(None);
                }
            }
            if is_absolute {
                truncate_utf16(parsed.as_str(), 1000)
            } else {
                let mut out = parsed.path().to_owned();
                if let Some(search) = parsed.query() {
                    out.push('?');
                    out.push_str(search);
                }
                if let Some(hash) = parsed.fragment() {
                    out.push('#');
                    out.push_str(hash);
                }
                truncate_utf16(&out, 1000)
            }
        }
        None => {
            // `raw.replace(SECRET_KEY_PATTERN, '[redacted]')` — first match only.
            let redacted = secret_key_pattern().replace(&raw, "[redacted]").to_string();
            truncate_utf16(&redacted, 1000)
        }
    }
}

/// `sanitizeValue(value, depth = 0)`.
pub(crate) fn sanitize_value(value: &Value, depth: usize) -> Value {
    match value {
        Value::Null | Value::Bool(_) => value.clone(),
        Value::Number(number) => match number.as_f64() {
            Some(finite) if finite.is_finite() => value.clone(),
            _ => Value::Null,
        },
        Value::String(text) => Value::String(truncate_utf16(text, 1000)),
        _ if depth >= MAX_PAYLOAD_DEPTH => Value::String("[truncated]".to_owned()),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(MAX_PAYLOAD_ARRAY)
                .map(|entry| sanitize_value(entry, depth + 1))
                .collect(),
        ),
        Value::Object(entries) => {
            let mut out = Map::new();
            for (key, raw_entry) in entries.iter().take(MAX_PAYLOAD_KEYS) {
                let clean_key = truncate_utf16(key.trim(), 80);
                if clean_key.is_empty() || secret_key_pattern().is_match(&clean_key) {
                    continue;
                }
                out.insert(clean_key, sanitize_value(raw_entry, depth + 1));
            }
            Value::Object(out)
        }
    }
}

/// `eventInput(body, authorizedUser)`.
pub(crate) struct EventInput {
    pub client_timestamp: Option<String>,
    pub session_id: String,
    pub debug_user_uid: String,
    pub client_user_id: String,
    pub route_path: String,
    pub browser_url: String,
    pub event_name: String,
    pub category: String,
    pub payload: Value,
}

pub(crate) fn event_input(body: &Value, authorized_user: &DebugUser) -> EventInput {
    let event_name = clean_event_name(
        first_truthy(&[
            value_get(body, "eventName"),
            value_get(body, "name"),
            value_get(body, "event"),
            value_get(body, "type"),
        ])
        .unwrap_or(&Value::Null),
    );
    let category = clean_category(
        first_truthy(&[value_get(body, "category"), value_get(body, "source")])
            .unwrap_or(&Value::String("flutter".to_owned())),
    );
    let session_id = clean_text_value(
        first_truthy(&[value_get(body, "sessionId"), value_get(body, "session_id")])
            .unwrap_or(&Value::Null),
        160,
    );
    let client_user_id = clean_text_value(
        first_truthy(&[
            value_get(body, "userId"),
            value_get(body, "user_id"),
            value_get(body, "debugUserId"),
            value_get(body, "debug_user_id"),
            value_get(value_get(body, "user"), "uid"),
        ])
        .unwrap_or(&Value::Null),
        160,
    );
    let route_path = clean_text_value(
        first_truthy(&[
            value_get(body, "route"),
            value_get(body, "path"),
            value_get(body, "routePath"),
            value_get(body, "route_path"),
        ])
        .unwrap_or(&Value::Null),
        500,
    );
    let browser_url = clean_url(
        first_truthy(&[
            value_get(body, "url"),
            value_get(body, "browserUrl"),
            value_get(body, "browser_url"),
        ])
        .unwrap_or(&Value::Null),
    );
    let payload = sanitize_value(
        first_truthy(&[
            value_get(body, "payload"),
            value_get(body, "details"),
            value_get(body, "data"),
        ])
        .unwrap_or(&json!({})),
        0,
    );
    EventInput {
        client_timestamp: clean_timestamp(
            first_truthy(&[
                value_get(body, "clientTimestamp"),
                value_get(body, "clientTime"),
                value_get(body, "timestamp"),
                value_get(body, "at"),
            ])
            .unwrap_or(&Value::Null),
        ),
        session_id,
        debug_user_uid: truncate_utf16(authorized_user.uid.trim(), 160),
        client_user_id,
        route_path,
        browser_url,
        event_name,
        category,
        payload,
    }
}

/// `requireValidEvent(input)`.
fn require_valid_event(input: &EventInput) -> Result<(), HandlerError> {
    if input.event_name.is_empty() {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Flutter debug event name is required.",
        ));
    }
    if input.session_id.is_empty() {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Flutter debug session id is required.",
        ));
    }
    Ok(())
}

fn table_missing_error() -> HandlerError {
    HandlerError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        body: json!({
            "error": "Flutter debug log table is not installed yet.",
            "setupRequired": true,
            "migration": MIGRATION_PATH,
        }),
    }
}

fn map_db_error(error: sqlx::Error) -> HandlerError {
    if is_missing_table_error(&error) {
        table_missing_error()
    } else {
        db_error(error)
    }
}

/// `publicRow(row)`.
fn public_row(row: &sqlx::postgres::PgRow) -> Value {
    let text = |column: &str| -> String {
        row.try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    let stamp = |column: &str| -> Value {
        let value: Option<chrono::DateTime<chrono::Utc>> = row.try_get(column).unwrap_or(None);
        iso_millis(&value)
    };
    let payload: Option<Value> = row.try_get("payload").unwrap_or(None);
    json_object(vec![
        ("id", Value::String(text("id"))),
        ("receivedAt", stamp("received_at")),
        ("clientTimestamp", stamp("client_timestamp")),
        ("sessionId", Value::String(text("session_id"))),
        ("debugUserUid", Value::String(text("debug_user_uid"))),
        ("clientUserId", Value::String(text("client_user_id"))),
        ("routePath", Value::String(text("route_path"))),
        ("browserUrl", Value::String(text("browser_url"))),
        ("eventName", Value::String(text("event_name"))),
        ("category", Value::String(text("category"))),
        (
            "payload",
            payload
                .filter(|value| !value.is_null())
                .unwrap_or_else(|| json!({})),
        ),
    ])
}

async fn write_flutter_debug_log(
    state: &RouteState,
    input: &EventInput,
) -> Result<(String, Value), HandlerError> {
    let row = sqlx::query(
        r#"
      insert into public.flutter_debug_logs (
        client_timestamp,
        session_id,
        debug_user_uid,
        client_user_id,
        route_path,
        browser_url,
        event_name,
        category,
        payload
      )
      values ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      returning id, received_at
    "#,
    )
    .bind(&input.client_timestamp)
    .bind(&input.session_id)
    .bind(&input.debug_user_uid)
    .bind(&input.client_user_id)
    .bind(&input.route_path)
    .bind(&input.browser_url)
    .bind(&input.event_name)
    .bind(&input.category)
    .bind(input.payload.to_string())
    .fetch_one(state.api.read())
    .await
    .map_err(map_db_error)?;
    let id: Option<i64> = row.try_get("id").unwrap_or(None);
    let received_at: Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("received_at").unwrap_or(None);
    Ok((
        id.map(|id| id.to_string()).unwrap_or_default(),
        iso_millis(&received_at),
    ))
}

async fn read_flutter_debug_logs(
    state: &RouteState,
    query: &http::Query,
) -> Result<Value, HandlerError> {
    let limit = clean_limit(query.first("limit"), DEFAULT_READ_LIMIT);
    let session_id = truncate_utf16(
        query
            .get("sessionId")
            .or_else(|| query.get("session_id"))
            .unwrap_or_default()
            .trim(),
        160,
    );
    let user_id = truncate_utf16(
        query
            .get("userId")
            .or_else(|| query.get("user"))
            .or_else(|| query.get("debugUserUid"))
            .unwrap_or_default()
            .trim(),
        160,
    );
    let path = truncate_utf16(
        query
            .get("path")
            .or_else(|| query.get("routePath"))
            .unwrap_or_default()
            .trim(),
        500,
    );
    let raw_category = query.first("category").unwrap_or("").to_owned();
    let category = clean_category(&Value::String(raw_category.clone()));
    let event_name = clean_event_name(&Value::String(
        query
            .get("eventName")
            .or_else(|| query.get("event"))
            .unwrap_or_default()
            .to_owned(),
    ));

    let mut indexed: Vec<String> = Vec::new();
    if !session_id.is_empty() {
        indexed.push(format!("session_id = ${}", indexed.len() + 1));
    }
    if !user_id.is_empty() {
        indexed.push(format!(
            "(debug_user_uid = ${n} or client_user_id = ${n})",
            n = indexed.len() + 1
        ));
    }
    if !path.is_empty() {
        indexed.push(format!("route_path = ${}", indexed.len() + 1));
    }
    if !category.is_empty() && !raw_category.is_empty() {
        indexed.push(format!("category = ${}", indexed.len() + 1));
    }
    if !event_name.is_empty() {
        indexed.push(format!("event_name = ${}", indexed.len() + 1));
    }
    let limit_param = indexed.len() + 1;
    let where_clause = if indexed.is_empty() {
        String::new()
    } else {
        format!("where {}", indexed.join("\n        and "))
    };
    let sql_text = format!(
        r#"
      select
        id,
        received_at,
        client_timestamp,
        session_id,
        debug_user_uid,
        client_user_id,
        route_path,
        browser_url,
        event_name,
        category,
        payload
      from public.flutter_debug_logs
      {}
      order by received_at desc, id desc
      limit ${}
    "#,
        where_clause, limit_param,
    );

    let mut statement = sqlx::query(&sql_text);
    if !session_id.is_empty() {
        statement = statement.bind(&session_id);
    }
    if !user_id.is_empty() {
        statement = statement.bind(&user_id);
    }
    if !path.is_empty() {
        statement = statement.bind(&path);
    }
    if !category.is_empty() && !raw_category.is_empty() {
        statement = statement.bind(&category);
    }
    if !event_name.is_empty() {
        statement = statement.bind(&event_name);
    }
    statement = statement.bind(limit);

    let rows = statement
        .fetch_all(state.api.read())
        .await
        .map_err(map_db_error)?;

    Ok(json_object(vec![
        ("rows", Value::Array(rows.iter().map(public_row).collect())),
        (
            "filters",
            json!({
                "limit": limit,
                "sessionId": session_id,
                "userId": user_id,
                "path": path,
                "category": if raw_category.is_empty() { String::new() } else { category },
                "eventName": event_name,
            }),
        ),
        ("generatedAt", Value::String(super::now_iso())),
    ]))
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if method != Method::POST && method != Method::GET {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET, POST")],
        );
    }

    let authorized_user = match authorize_flutter_debug_request(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error,
    };
    if method == Method::POST {
        let parsed = match http::parse_body(&headers, &body) {
            Ok(parsed) => parsed.json(),
            Err(error) => return error,
        };
        let input = event_input(&parsed, &authorized_user);
        if let Err(error) = require_valid_event(&input) {
            return error.into_response_with(&NO_STORE);
        }
        return match write_flutter_debug_log(&state, &input).await {
            Ok((id, received_at)) => http::json_with(
                StatusCode::CREATED,
                json!({ "ok": true, "id": id, "receivedAt": received_at }),
                &NO_STORE,
            ),
            Err(error) => error.into_response_with(&NO_STORE),
        };
    }

    let query = request_query(&uri);
    match read_flutter_debug_logs(&state, &query).await {
        Ok(payload) => http::json_with(StatusCode::OK, payload, &NO_STORE),
        Err(error) => error.into_response_with(&NO_STORE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_limit_clamps() {
        assert_eq!(clean_limit(Some("50"), 200), 50);
        assert_eq!(clean_limit(Some("abc"), 200), 200);
        assert_eq!(clean_limit(None, 200), 200);
        assert_eq!(clean_limit(Some("999999"), 200), 5000);
        assert_eq!(clean_limit(Some("0"), 200), 1);
    }

    #[test]
    fn clean_url_redacts_secret_query_params() {
        assert_eq!(
            clean_url(&json!("https://pokoin.com/marketplace?token=abc&x=1")),
            "https://pokoin.com/marketplace?x=1"
        );
        assert_eq!(
            clean_url(&json!("/marketplace/search?q=pika&session_id=s")),
            "/marketplace/search?q=pika"
        );
        assert_eq!(clean_url(&json!("")), "");
        assert_eq!(
            clean_url(&json!("https://pokoin.com/plain")),
            "https://pokoin.com/plain"
        );
    }

    #[test]
    fn sanitize_value_strips_secrets_and_caps_depth() {
        let value = json!({
            "token": "x",
            "keep": {"nested": [1, "two", null]},
            "nestedSecret": {"password": "p", "ok": true},
            "deep": {"l1": {"l2": {"l3": {"l4": "cut"}}}},
        });
        let clean = sanitize_value(&value, 0);
        assert!(clean.get("token").is_none());
        assert_eq!(clean["keep"]["nested"][1], "two");
        assert!(
            clean.get("nestedSecret").is_none(),
            "secret-named keys are stripped"
        );
        assert_eq!(
            clean["deep"]["l1"]["l2"]["l3"], "[truncated]",
            "the depth-4 object itself is cut"
        );
        assert_eq!(sanitize_value(&json!(f64::NAN), 0), Value::Null);
        assert_eq!(sanitize_value(&json!("ok"), 0), json!("ok"));
    }

    #[test]
    fn event_input_maps_aliases() {
        let body = json!({
            "name": "Card Scan",
            "session_id": "s-1",
            "debug_user_id": "u-9",
            "path": "/marketplace",
            "browser_url": "https://pokoin.com/x?secret=1",
            "details": {"step": 2},
            "timestamp": "2026-10-08T12:00:00Z",
        });
        let user = DebugUser {
            uid: "op-1".to_owned(),
            email: "op@pokoin.com".to_owned(),
            username: "op".to_owned(),
        };
        let input = event_input(&body, &user);
        assert_eq!(input.event_name, "card_scan");
        assert_eq!(input.category, "flutter");
        assert_eq!(input.session_id, "s-1");
        assert_eq!(input.debug_user_uid, "op-1");
        assert_eq!(input.client_user_id, "u-9");
        assert_eq!(input.route_path, "/marketplace");
        assert_eq!(input.browser_url, "https://pokoin.com/x");
        assert_eq!(input.payload["step"], 2);
        assert_eq!(
            input.client_timestamp.as_deref(),
            Some("2026-10-08T12:00:00.000Z")
        );

        let missing = event_input(&json!({}), &user);
        assert_eq!(missing.event_name, "");
        assert_eq!(missing.session_id, "");
        assert!(require_valid_event(&missing).is_err());
        assert!(require_valid_event(&input).is_ok());
    }

    #[test]
    fn debug_token_header_fallbacks() {
        let mut headers = HeaderMap::new();
        headers.insert("x-debug-token", "tok-1".parse().unwrap());
        assert_eq!(request_debug_token(&headers), "tok-1");
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer jwt-token".parse().unwrap());
        assert_eq!(request_debug_token(&headers), "jwt-token");
    }
}
