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
pub fn timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.timestamp_millis())
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
