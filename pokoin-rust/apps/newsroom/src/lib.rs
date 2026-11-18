pub mod cadence;
pub mod editorial;
pub mod handover;
pub mod model;
pub mod moderation;
pub mod sources;
pub mod store;
pub mod templates;
pub mod website;

use serde_json::Value;

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
/// JS truthiness of a JSON value: null, false, "" and 0 are falsy.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}
/// The first truthy value among `keys`, like JS `value.a || value.b`.
pub fn or<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| value.get(key))
        .find(|candidate| truthy(candidate))
}
/// JS `String(value)`: null prints "null", objects their class, arrays join
/// with commas and skip their own nulls.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => value.to_string(),
    }
}
/// RFC 3339 plus the date-only form JS Date.parse reads as UTC midnight.
/// Everything else is unparseable, and callers fail closed on that.
pub fn timestamp(value: &str) -> Option<i64> {
    if let Ok(at) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(at.timestamp_millis());
    }
    if value.len() != "2026-10-05".len() {
        return None;
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|day| day.and_hms_opt(0, 0, 0))
        .map(|moment| moment.and_utc().timestamp_millis())
}
pub fn game(value: &Value) -> &str {
    let g = text(value, "game");
    if g.is_empty() {
        "pokemon"
    } else {
        g
    }
}
pub fn iso(now: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
