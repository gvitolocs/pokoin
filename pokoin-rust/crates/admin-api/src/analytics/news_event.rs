//! Port of `api/news-event.js` — POST /api/news-event reading beacons into
//! `public.news_events` on the writer. No cookies: the visitor is a daily
//! salted hash of ip + user agent. Answers 204 before writing.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use pokoin_api_common::{http, RouteState};

use super::rate_limit_client_ip;

const TYPES: [&str; 5] = ["impression", "click", "view", "read", "leave"];
const MILESTONES: [i64; 4] = [25, 50, 75, 100];
const MAX_EVENTS: usize = 40;
const MAX_SECONDS: i64 = 7200;
const COLUMNS: [&str; 9] = [
    "event_type",
    "article_id",
    "article_path",
    "pv",
    "visitor",
    "source",
    "position",
    "depth",
    "seconds",
];

fn bot_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit",
        )
        .unwrap()
    })
}

fn article_id_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^art_[A-Za-z0-9_-]{4,120}$").unwrap())
}

fn article_path_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"^/(?:[a-z0-9-]+/)?news/[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap()
    })
}

fn pv_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[A-Za-z0-9]{8,32}$").unwrap())
}

/// `intOrNull(value)`; a missing key (`None`) is `undefined` -> NaN -> null.
pub(crate) fn int_or_null(value: Option<&Value>) -> Option<i64> {
    match value {
        None => None,
        Some(value) => match crate::debug::js_number_of(value) {
            Some(number) if number.is_finite() => Some(number.trunc() as i64),
            _ => None,
        },
    }
}

/// `cleanEvent(raw)`: validate one beacon; `None` drops it.
pub(crate) fn clean_event(raw: &Value) -> Option<CleanEvent> {
    if !raw.is_object() {
        return None;
    }
    let get = |key: &str| raw.get(key).cloned().unwrap_or(Value::Null);
    let event_type = text_of(&get("type"));
    let article_id = text_of(&get("articleId"));
    let article_path = text_of(&get("articlePath"));
    let pv = text_of(&get("pv"));
    if !TYPES.contains(&event_type.as_str())
        || !article_id_re().is_match(&article_id)
        || !article_path_re().is_match(&article_path)
        || !pv_re().is_match(&pv)
    {
        return None;
    }
    let source_raw = get("source");
    let source = match source_raw.as_str() {
        Some(text) => {
            let trimmed = text.trim().chars().take(120).collect::<String>();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        None => None,
    };
    let mut position: Option<i64> = None;
    let mut depth: Option<i64> = None;
    let mut seconds: Option<i64> = None;
    if event_type == "impression" || event_type == "click" {
        let value = int_or_null(raw.get("position"));
        position = value.filter(|value| (1..=200).contains(value));
    }
    if event_type == "read" {
        depth = int_or_null(raw.get("depth"));
        let milestone = depth
            .map(|value| MILESTONES.contains(&value))
            .unwrap_or(false);
        if !milestone {
            return None;
        }
    }
    if event_type == "leave" {
        // `intOrNull(raw.seconds)` — a missing key is undefined (NaN -> null ->
        // event dropped), an explicit null is 0 (kept).
        let raw_seconds = int_or_null(raw.get("seconds"))?;
        seconds = Some(raw_seconds.clamp(0, MAX_SECONDS));
        depth = int_or_null(raw.get("depth")).map(|value| value.clamp(0, 100));
    }
    Some(CleanEvent {
        event_type,
        article_id,
        article_path,
        pv,
        source,
        position,
        depth,
        seconds,
    })
}

pub(crate) struct CleanEvent {
    pub event_type: String,
    pub article_id: String,
    pub article_path: String,
    pub pv: String,
    pub source: Option<String>,
    pub position: Option<i64>,
    pub depth: Option<i64>,
    pub seconds: Option<i64>,
}

fn text_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().trim().to_owned()
}

/// `cleanEvents(list)`.
pub(crate) fn clean_events(list: &Value) -> Vec<CleanEvent> {
    match list {
        Value::Array(items) => items
            .iter()
            .take(MAX_EVENTS)
            .filter_map(clean_event)
            .collect(),
        _ => vec![],
    }
}

/// `visitorHash({ ip, ua, day, salt })`: 24 hex chars of sha256.
pub(crate) fn visitor_hash(ip: &str, ua: &str, day: &str, salt: &str) -> String {
    let digest = Sha256::digest(format!("{day}|{ip}|{ua}|{salt}").as_bytes());
    hex::encode(digest)[..24].to_owned()
}

fn news_event_salt() -> String {
    std::env::var("NEWS_EVENT_SALT").unwrap_or_else(|_| "pokoin-news".to_owned())
}

/// One warning per minute at most: a writer outage must not flood the log.
fn log_failure(message: &str) {
    static LAST: std::sync::OnceLock<Mutex<(i64, u64)>> = std::sync::OnceLock::new();
    let state = LAST.get_or_init(|| Mutex::new((0, 0)));
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    guard.1 += 1;
    if now - guard.0 < 60_000 {
        return;
    }
    guard.0 = now;
    let failures = guard.1;
    guard.1 = 0;
    tracing::warn!(message = %message, failures, "news-event failed");
}

/// The multi-row insert of `insert(events, visitor)`; returns (sql, params).
pub(crate) fn build_insert_sql(events: &[CleanEvent], visitor: &str) -> (String, Vec<Value>) {
    let mut params: Vec<Value> = Vec::new();
    let mut row_groups: Vec<String> = Vec::new();
    for event in events {
        let values: Vec<Value> = vec![
            Value::String(event.event_type.clone()),
            Value::String(event.article_id.clone()),
            Value::String(event.article_path.clone()),
            Value::String(event.pv.clone()),
            Value::String(visitor.to_owned()),
            event
                .source
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
            event.position.map(Value::from).unwrap_or(Value::Null),
            event.depth.map(Value::from).unwrap_or(Value::Null),
            event.seconds.map(Value::from).unwrap_or(Value::Null),
        ];
        let placeholders: Vec<String> = values
            .iter()
            .map(|value| {
                params.push(value.clone());
                format!("${}", params.len())
            })
            .collect();
        row_groups.push(format!("({})", placeholders.join(", ")));
    }
    (
        format!(
            "insert into public.news_events ({}) values {}",
            COLUMNS.join(", "),
            row_groups.join(", ")
        ),
        params,
    )
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if method != Method::POST {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "POST")],
        );
    }

    // `parseBody(req.body)`: object bodies pass through; raw buffers (and JS
    // strings) are JSON-parsed, and a parse failure is the 400.
    let body_value: Value = match http::parse_body(&headers, &body) {
        Ok(http::NodeBody::Json(value)) | Ok(http::NodeBody::Form(value)) => value,
        Ok(http::NodeBody::Empty) => json!({}),
        Ok(http::NodeBody::Raw(bytes)) => match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                return http::json(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "Invalid news event." }),
                )
            }
        },
        Err(error) => return error,
    };

    let events = clean_events(body_value.get("events").unwrap_or(&Value::Null));
    if events.is_empty() {
        return http::json(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid news event." }),
        );
    }

    let ua = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    if bot_re().is_match(&ua) {
        return empty_204();
    }
    let day = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let ip = rate_limit_client_ip(&headers);
    let visitor = visitor_hash(&ip, &ua, &day, &news_event_salt());

    // 204 goes out before the write, like the Node handler.
    let response = empty_204();
    let verdict =
        crate::debug::rate_limit::limit_best_effort(&state.api, "news-event", &visitor, 120, 600)
            .await;
    if verdict.allowed {
        let (sql, params) = build_insert_sql(&events, &visitor);
        let mut statement = sqlx::query(&sql);
        for param in &params {
            statement = match param {
                Value::Null => statement.bind(Option::<String>::None),
                Value::String(text) => statement.bind(text.clone()),
                Value::Number(number) => match number.as_i64() {
                    Some(value) => statement.bind(value),
                    None => statement.bind(number.as_f64().unwrap_or(0.0)),
                },
                _ => statement.bind(Option::<String>::None),
            };
        }
        if let Err(error) = statement.execute(state.api.write()).await {
            log_failure(&error.to_string());
        }
    }
    response
}

/// `res.status(204).end()`.
fn empty_204() -> Response {
    use axum::response::IntoResponse;
    (StatusCode::NO_CONTENT, axum::body::Body::empty()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_event() -> Value {
        json!({
            "articleId": "art_story-abc_en",
            "articlePath": "/news/delta-reign-prerelease-promos-revealed",
            "pv": "abcdEFGH12345678",
        })
    }

    #[test]
    fn invalid_events_are_dropped() {
        let events = clean_events(&json!([
            { "type": "read", "depth": 30, "articleId": "art_story-abc_en", "articlePath": "/news/delta-reign-prerelease-promos-revealed", "pv": "abcdEFGH12345678" },
            { "type": "read", "depth": 75, "articleId": "art_story-abc_en", "articlePath": "/news/delta-reign-prerelease-promos-revealed", "pv": "abcdEFGH12345678" },
            { "type": "leave", "seconds": 99999, "depth": 140, "articleId": "art_story-abc_en", "articlePath": "/news/delta-reign-prerelease-promos-revealed", "pv": "abcdEFGH12345678" },
            { "type": "leave", "articleId": "art_story-abc_en", "articlePath": "/news/delta-reign-prerelease-promos-revealed", "pv": "abcdEFGH12345678" },
            { "type": "view", "pv": "x", "articleId": "art_story-abc_en", "articlePath": "/news/delta-reign-prerelease-promos-revealed" },
            { "type": "click", "articlePath": "/marketplace/x", "articleId": "art_story-abc_en", "pv": "abcdEFGH12345678" },
        ]));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].depth, Some(75));
        assert_eq!(events[1].seconds, Some(7200));
        assert_eq!(events[1].depth, Some(100));
    }

    #[test]
    fn batches_are_capped_at_forty() {
        let many: Vec<Value> = (0..60)
            .map(|_| json!({"type": "view", "articleId": "art_story-abc_en", "articlePath": "/news/delta-reign-prerelease-promos-revealed", "pv": "abcdEFGH12345678"}))
            .collect();
        assert_eq!(clean_events(&Value::Array(many)).len(), MAX_EVENTS);
    }

    #[test]
    fn position_is_only_kept_for_impression_and_click() {
        let click = clean_event(&json!({
            "type": "click",
            "position": 3,
            "articleId": "art_story-abc_en",
            "articlePath": "/news/delta-reign-prerelease-promos-revealed",
            "pv": "abcdEFGH12345678",
        }))
        .unwrap();
        assert_eq!(click.position, Some(3));
        let view = clean_event(&json!({
            "type": "view",
            "position": 3,
            "articleId": "art_story-abc_en",
            "articlePath": "/news/delta-reign-prerelease-promos-revealed",
            "pv": "abcdEFGH12345678",
        }))
        .unwrap();
        assert_eq!(view.position, None);
    }

    #[test]
    fn the_visitor_hash_is_stable_within_a_day_and_hides_the_ip() {
        let a = visitor_hash("203.0.113.9", "UA", "2026-10-08", "s");
        let b = visitor_hash("203.0.113.9", "UA", "2026-10-08", "s");
        let c = visitor_hash("203.0.113.9", "UA", "2026-10-09", "s");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 24);
        assert!(!a.contains("203"));
    }

    #[test]
    fn insert_sql_binds_nine_values_per_row() {
        let events = vec![
            clean_event(&json!({
                "type": "impression", "position": 3, "source": "/news",
                "articleId": "art_story-abc_en",
                "articlePath": "/news/delta-reign-prerelease-promos-revealed",
                "pv": "abcdEFGH12345678",
            }))
            .unwrap(),
            clean_event(&json!({
                "type": "view", "source": "google.com",
                "articleId": "art_story-abc_en",
                "articlePath": "/news/delta-reign-prerelease-promos-revealed",
                "pv": "abcdEFGH12345678",
            }))
            .unwrap(),
        ];
        let (sql, params) = build_insert_sql(&events, "visitorhash");
        assert!(sql.starts_with("insert into public.news_events ("));
        assert!(sql.contains("values ($1, $2, $3, $4, $5, $6, $7, $8, $9), ($10,"));
        assert_eq!(params.len(), 18);
        assert_eq!(params[0], json!("impression"));
        assert_eq!(params[6], json!(3));
        assert_eq!(params[9], json!("view"));
        assert_eq!(
            params[15],
            Value::Null,
            "position is only kept for impression/click"
        );
    }

    #[test]
    fn depth_must_be_a_milestone() {
        for milestone in [25, 50, 75, 100] {
            let event = clean_event(&json!({
                "type": "read", "depth": milestone,
                "articleId": "art_story-abc_en",
                "articlePath": "/news/delta-reign-prerelease-promos-revealed",
                "pv": "abcdEFGH12345678",
            }));
            assert!(event.is_some(), "depth {milestone} must pass");
        }
        assert!(clean_event(&json!({
            "type": "read", "depth": 30,
            "articleId": "art_story-abc_en",
            "articlePath": "/news/delta-reign-prerelease-promos-revealed",
            "pv": "abcdEFGH12345678",
        }))
        .is_none());
    }
}
