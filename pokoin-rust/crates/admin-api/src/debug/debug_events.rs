//! Port of `api/marketplace-debug-events.js` — GET only, behind the
//! search-debug gate; reads `public.marketplace_card_events` joined to the
//! search candidates and CardTrader blueprints.

use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Map, Value};
use sqlx::Row;

use pokoin_api_common::{http, RouteState};

use super::{
    db_error_message, internal_error, iso_millis, json_object, request_query, truncate_utf16,
    DebugUser,
};

const EVENT_TYPES: [&str; 6] = ["view", "search", "click", "reserve", "cart_add", "sale"];
const WINDOW_INTERVALS: [(&str, &str); 4] = [
    ("15m", "15 minutes"),
    ("1h", "1 hour"),
    ("24h", "24 hours"),
    ("7d", "7 days"),
];

/// `cleanLimit(value, fallback = 200)`.
pub(crate) fn clean_limit(value: Option<&str>, fallback: i64) -> i64 {
    match value.and_then(http::js_number) {
        Some(limit) if limit.is_finite() => (limit.trunc() as i64).clamp(1, 500),
        _ => fallback,
    }
}

/// `cleanWindow(value)`.
pub(crate) fn clean_window(value: Option<&str>) -> &'static str {
    let window = value.unwrap_or("24h").trim().to_lowercase();
    WINDOW_INTERVALS
        .iter()
        .find(|(key, _)| *key == window)
        .map(|(key, _)| *key)
        .unwrap_or("24h")
}

/// `cleanEventType(value)`.
pub(crate) fn clean_event_type(value: Option<&str>) -> String {
    let event_type = value.unwrap_or("").trim().to_lowercase();
    if EVENT_TYPES.contains(&event_type.as_str()) {
        event_type
    } else {
        String::new()
    }
}

/// `cleanCardId(value)`.
pub(crate) fn clean_card_id(value: Option<&str>) -> i64 {
    match value.and_then(http::js_number) {
        Some(id)
            if id.is_finite() && id.trunc() == id && id > 0.0 && id <= 9_007_199_254_740_991.0 =>
        {
            id as i64
        }
        _ => 0,
    }
}

/// `cleanUserUid(value)`.
pub(crate) fn clean_user_uid(value: Option<&str>) -> String {
    truncate_utf16(value.unwrap_or("").trim(), 128)
}

pub(crate) struct EventRow {
    pub(crate) id: i64,
    pub(crate) card_id: i64,
    pub(crate) user_uid: String,
    pub(crate) event_type: String,
    pub(crate) weight: f64,
    pub(crate) occurred_at: Option<chrono::DateTime<chrono::Utc>>,
    pub(crate) metadata: Value,
    pub(crate) name: String,
    pub(crate) set_name: String,
    pub(crate) collector_number: String,
    pub(crate) image_url: String,
}

impl EventRow {
    fn from_db(row: &sqlx::postgres::PgRow) -> Self {
        let metadata: Option<Value> = row.try_get("metadata").unwrap_or(None);
        let weight: Option<sqlx::types::BigDecimal> = row.try_get("weight").unwrap_or(None);
        let text = |column: &str| -> String {
            row.try_get::<Option<String>, _>(column)
                .unwrap_or_default()
                .unwrap_or_default()
        };
        Self {
            id: row.try_get("id").unwrap_or(0),
            card_id: row.try_get("card_id").unwrap_or(0),
            user_uid: text("user_uid"),
            event_type: text("event_type"),
            weight: weight
                .and_then(|value| value.to_string().parse::<f64>().ok())
                .unwrap_or(0.0),
            occurred_at: row.try_get("occurred_at").unwrap_or(None),
            metadata: metadata.unwrap_or(Value::Null),
            name: text("name"),
            set_name: text("set_name"),
            collector_number: text("collector_number"),
            image_url: text("image_url"),
        }
    }
}

/// `eventRow(row)`.
pub(crate) fn event_row(row: &EventRow) -> Value {
    json_object(vec![
        ("id", Value::String(row.id.to_string())),
        ("cardId", Value::String(row.card_id.to_string())),
        ("userUid", Value::String(row.user_uid.clone())),
        ("eventType", Value::String(row.event_type.clone())),
        ("weight", json!(row.weight)),
        ("occurredAt", iso_millis(&row.occurred_at)),
        (
            "metadata",
            if row.metadata.is_null() {
                json!({})
            } else {
                row.metadata.clone()
            },
        ),
        (
            "card",
            json!({
                "name": row.name,
                "setName": row.set_name,
                "collectorNumber": row.collector_number,
                "imageUrl": row.image_url,
            }),
        ),
    ])
}

/// SQL of `readMarketplaceEvents` up to the dynamic `where` clause (the
/// Node code appends `addFilter` clauses and the limit placeholder).
const EVENTS_SQL_HEAD: &str = r#"
      select
        e.id,
        e.card_id,
        coalesce(e.user_uid, '') as user_uid,
        e.event_type,
        e.weight,
        e.metadata,
        e.occurred_at,
        coalesce(nullif(c.display_name, ''), nullif(c.name, ''), b.name, '') as name,
        coalesce(nullif(c.set_name, ''), nullif(b.expansion->>'name', ''), '') as set_name,
        coalesce(
          nullif(c.card_number, ''),
          nullif(b.blueprint->>'number', ''),
          nullif(b.blueprint->>'collector_number', ''),
          nullif(b.blueprint->>'card_number', ''),
          b.version,
          ''
        ) as collector_number,
        coalesce(
          nullif(c.preview_image_url, ''),
          nullif(c.cdn_image_url, ''),
          nullif(c.image_url, ''),
          nullif(b.preview_image_url, ''),
          nullif(b.cdn_image_url, ''),
          nullif(b.image_url, ''),
          ''
        ) as image_url
      from public.marketplace_card_events e
      left join public.marketplace_search_candidates c
        on c.card_id = e.card_id
      left join public.cardtrader_pokemon_blueprints b
        on b.id = e.card_id
      where "#;

fn window_interval(window_key: &str) -> &'static str {
    WINDOW_INTERVALS
        .iter()
        .find(|(key, _)| *key == window_key)
        .map(|(_, interval)| *interval)
        .unwrap_or("24 hours")
}

/// `readMarketplaceEvents(queryParams)` against the read pool.
async fn read_marketplace_events(
    state: &RouteState,
    query: &http::Query,
) -> Result<Value, Response> {
    let limit = clean_limit(query.first("limit"), 200);
    let window_key = clean_window(query.first("window"));
    let event_type = clean_event_type(query.first("eventType"));
    let card_id = clean_card_id(query.first("cardId"));
    let user_uid = clean_user_uid(query.first("userUid"));

    // `addFilter`: values are bound in push order, the first being the window
    // interval, so each clause placeholder is `$n` with n = bind position.
    let mut indexed: Vec<String> = vec!["e.occurred_at >= now() - $1::interval".to_owned()];
    if !event_type.is_empty() {
        indexed.push(format!("e.event_type = ${}", indexed.len() + 1));
    }
    if card_id > 0 {
        indexed.push(format!("e.card_id = ${}", indexed.len() + 1));
    }
    if !user_uid.is_empty() {
        indexed.push(format!("e.user_uid = ${}", indexed.len() + 1));
    }
    let limit_param = indexed.len() + 1;
    let sql_text = format!(
        "{}{}\n      order by e.occurred_at desc, e.id desc\n      limit ${}",
        EVENTS_SQL_HEAD,
        indexed.join("\n        and "),
        limit_param,
    );

    let mut statement = sqlx::query(&sql_text).bind(window_interval(window_key));
    if !event_type.is_empty() {
        statement = statement.bind(&event_type);
    }
    if card_id > 0 {
        statement = statement.bind(card_id);
    }
    if !user_uid.is_empty() {
        statement = statement.bind(&user_uid);
    }
    statement = statement.bind(limit);

    let rows = statement
        .fetch_all(state.api.read())
        .await
        .map_err(|error| internal_error(&db_error_message(&error)))?;

    let parsed: Vec<EventRow> = rows.iter().map(EventRow::from_db).collect();

    // Summary keyed by event type in first-seen order.
    let mut summary = Map::new();
    for row in &parsed {
        let key = if row.event_type.is_empty() {
            "unknown".to_owned()
        } else {
            row.event_type.clone()
        };
        let count = summary.get(&key).and_then(Value::as_i64).unwrap_or(0);
        summary.insert(key, json!(count + 1));
    }

    Ok(json_object(vec![
        ("rows", Value::Array(parsed.iter().map(event_row).collect())),
        ("summary", Value::Object(summary)),
        (
            "filters",
            json!({
                "limit": limit,
                "window": window_key,
                "interval": window_interval(window_key),
                "eventType": event_type,
                "cardId": if card_id > 0 { card_id.to_string() } else { String::new() },
                "userUid": user_uid,
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
) -> Response {
    if method != Method::GET {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET")],
        );
    }

    let user = match state.require_debug_admin(&headers).await {
        Ok(claims) => DebugUser::from_claims(&claims),
        Err(error) => return error,
    };
    let _ = &user;
    let query = request_query(&uri);
    match read_marketplace_events(&state, &query).await {
        Ok(payload) => http::json_with(StatusCode::OK, payload, &[("cache-control", "no-store")]),
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_limit_matches_node() {
        assert_eq!(clean_limit(Some("50"), 200), 50);
        assert_eq!(clean_limit(Some("abc"), 200), 200);
        assert_eq!(clean_limit(Some("0"), 200), 1);
        assert_eq!(clean_limit(Some("-5"), 200), 1);
        assert_eq!(clean_limit(Some("9999"), 200), 500);
        assert_eq!(clean_limit(Some("7.9"), 200), 7);
        assert_eq!(clean_limit(None, 200), 200);
        assert_eq!(clean_limit(Some(""), 100), 1, "Number('') is 0");
    }

    #[test]
    fn clean_window_and_event_type_whitelist() {
        assert_eq!(clean_window(None), "24h");
        assert_eq!(clean_window(Some("15M")), "15m");
        assert_eq!(clean_window(Some("bogus")), "24h");
        assert_eq!(window_interval("7d"), "7 days");
        assert_eq!(clean_event_type(Some("CART_ADD")), "cart_add");
        assert_eq!(clean_event_type(Some("hover")), "");
        assert_eq!(clean_event_type(None), "");
    }

    #[test]
    fn clean_card_id_and_user_uid() {
        assert_eq!(clean_card_id(Some("123")), 123);
        assert_eq!(clean_card_id(Some("12.9")), 0, "not a safe integer");
        assert_eq!(clean_card_id(Some("0")), 0);
        assert_eq!(clean_card_id(Some("-2")), 0);
        assert_eq!(clean_card_id(Some("abc")), 0);
        assert_eq!(clean_card_id(None), 0);
        assert_eq!(clean_user_uid(Some("  abc ")), "abc");
        assert_eq!(clean_user_uid(Some(&"x".repeat(300))), "x".repeat(128));
    }

    #[test]
    fn event_row_shapes_the_columns() {
        let row = EventRow {
            id: 42,
            card_id: 123456,
            user_uid: "uid-1".to_owned(),
            event_type: "view".to_owned(),
            weight: 2.0,
            occurred_at: chrono::DateTime::parse_from_rfc3339("2026-10-08T12:00:00.500Z")
                .ok()
                .map(|value| value.with_timezone(&chrono::Utc)),
            metadata: json!({"tab": "hidden"}),
            name: "Pikachu".to_owned(),
            set_name: "Base Set".to_owned(),
            collector_number: "58/102".to_owned(),
            image_url: "https://cdn.pokoin.com/x.jpg".to_owned(),
        };
        let value = event_row(&row);
        assert_eq!(value["id"], "42");
        assert_eq!(value["cardId"], "123456");
        assert_eq!(value["userUid"], "uid-1");
        assert_eq!(value["eventType"], "view");
        assert_eq!(value["weight"], 2.0);
        assert_eq!(value["occurredAt"], "2026-10-08T12:00:00.500Z");
        assert_eq!(value["metadata"]["tab"], "hidden");
        assert_eq!(value["card"]["name"], "Pikachu");
        assert_eq!(value["card"]["setName"], "Base Set");
        assert_eq!(value["card"]["collectorNumber"], "58/102");
        assert_eq!(value["card"]["imageUrl"], "https://cdn.pokoin.com/x.jpg");
        let null_time = EventRow {
            occurred_at: None,
            metadata: Value::Null,
            ..row
        };
        let value = event_row(&null_time);
        assert_eq!(value["occurredAt"], Value::Null);
        assert_eq!(value["metadata"], json!({}));
    }
}
