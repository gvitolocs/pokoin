//! Shared helpers for the catalog read routes.
//!
//! These mirror the semantics of the deployed Node references under
//! `.reference-node/api/` (read-only): `marketplace-card-sales.js`,
//! `marketplace-card-cheapest-price.js`, `_card_price_history.js`.
//! The point is byte-identical response semantics, not a re-derivation.

use serde_json::Value;
use axum::{http::StatusCode, response::IntoResponse};

/// Route error carrying the HTTP status the Node handler would return.
#[derive(Debug)]
pub struct RouteError {
    pub status: u16,
    pub message: String,
}

impl RouteError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        RouteError {
            status,
            message: message.into(),
        }
    }

    pub fn body(&self) -> Value {
        serde_json::json!({ "error": self.message })
    }
}

impl From<sqlx::Error> for RouteError {
    fn from(error: sqlx::Error) -> Self {
        RouteError::new(500, error.to_string())
    }
}

impl IntoResponse for RouteError {
    fn into_response(self) -> axum::response::Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            axum::Json(self.body()),
        )
            .into_response()
    }
}

/// `cleanText(value, maxLength)` — trim + collapse whitespace + clamp.
pub fn clean_text(value: &str, max_length: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().all(|c| !c.is_whitespace()) {
        return truncate_chars(trimmed, max_length);
    }
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, max_length)
}

fn truncate_chars(value: &str, max_length: usize) -> String {
    if value.chars().count() <= max_length {
        return value.to_string();
    }
    value.chars().take(max_length).collect()
}

/// `cleanLimit` for the sales route: 1..=500, fallback 200.
pub fn clean_limit(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    let raw = match value {
        Some(text) if !text.trim().is_empty() => text.trim(),
        _ => return fallback,
    };
    match raw.parse::<f64>() {
        Ok(number) if number.is_finite() => {
            let truncated = number.trunc();
            truncated.clamp(1.0, max as f64) as i64
        }
        _ => fallback,
    }
}

/// `numberValue(value, fallback)` — sqlx numerics arrive as `f64` or `Decimal`.
pub fn number_value(value: &Value, fallback: f64) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(fallback),
        Value::String(text) => text.parse::<f64>().unwrap_or(fallback),
        _ => fallback,
    }
}

/// `roundPkn` — two decimals, as the deployed JSON emits.
pub fn round_pkn(value: f64) -> f64 {
    round_to(value, 2)
}

fn round_to(value: f64, digits: u32) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let factor = 10f64.powi(digits as i32);
    (value * factor).round() / factor
}

/// `finitePositiveNumber` — null unless finite and > 0.
pub fn finite_positive(value: &Value) -> Option<f64> {
    let number = number_value(value, 0.0);
    if number.is_finite() && number > 0.0 {
        Some(number)
    } else {
        None
    }
}

/// `nullableNumber` — null unless finite.
pub fn nullable_number(value: &Value) -> Option<f64> {
    let number = number_value(value, f64::NAN);
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

/// `dayKey` — `YYYY-MM-DD` from a date, a timestamp string, or a prefix.
pub fn day_key(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => {
            if text.len() >= 10 && text.as_bytes()[4] == b'-' && text.as_bytes()[7] == b'-' {
                text[..10].to_string()
            } else {
                truncate_chars(text, 10)
            }
        }
        other => truncate_chars(&other.to_string(), 10),
    }
}

/// `medianOf` over positive finite values (JS `sort` on numbers).
pub fn median_of(values: &[f64]) -> f64 {
    let mut list: Vec<f64> = values.iter().copied().filter(|n| n.is_finite() && *n > 0.0).collect();
    if list.is_empty() {
        return 0.0;
    }
    list.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = (list.len() - 1) / 2;
    if list.len() % 2 == 1 {
        list[mid]
    } else {
        (list[mid] + list[mid + 1]) / 2.0
    }
}

/// `count` — non-negative truncated integer.
pub fn count_value(value: &Value) -> i64 {
    number_value(value, 0.0).trunc().max(0.0) as i64
}

/// `cleanCardId` — digits only, positive safe integer.
pub fn clean_card_id(value: &str) -> Option<i64> {
    let text = value.trim();
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    match text.parse::<i64>() {
        Ok(id) if id > 0 => Some(id),
        _ => None,
    }
}

/// `catchMissingRelation` — missing table/column (42P01 / 42703) yields an empty
/// result flagged `missing`, not an error.
pub fn is_missing_relation(error: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db) = error {
        let code = db.code().unwrap_or_default();
        return code == "42P01" || code == "42703";
    }
    false
}

pub fn pg_error_code(error: &sqlx::Error) -> String {
    if let sqlx::Error::Database(db) = error {
        return db.code().unwrap_or_default().to_string();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_collapses_whitespace_and_clamps() {
        assert_eq!(clean_text("  Charizard  ex ", 240), "Charizard ex");
        assert_eq!(clean_text("a\n b\t c", 240), "a b c");
        assert_eq!(clean_text("abcdefgh", 3), "abc");
    }

    #[test]
    fn sales_limit_bounds_match_reference() {
        assert_eq!(clean_limit(None, 120, 500), 120);
        assert_eq!(clean_limit(Some(""), 120, 500), 120);
        assert_eq!(clean_limit(Some("7"), 120, 500), 7);
        assert_eq!(clean_limit(Some("900"), 120, 500), 500);
        assert_eq!(clean_limit(Some("-3"), 120, 500), 1);
        assert_eq!(clean_limit(Some("abc"), 120, 500), 120);
        assert_eq!(clean_limit(Some("2.9"), 120, 500), 2);
    }

    #[test]
    fn rounding_and_median_match_reference() {
        assert_eq!(round_pkn(12.3456), 12.35);
        assert_eq!(round_pkn(0.004), 0.0);
        assert_eq!(median_of(&[1.0, 3.0, 2.0]), 2.0);
        assert_eq!(median_of(&[1.0, 2.0, 3.0, 4.0]), 2.5);
        assert_eq!(median_of(&[0.0, -1.0]), 0.0);
    }

    #[test]
    fn day_key_accepts_timestamps_and_prefixes() {
        assert_eq!(day_key(&serde_json::json!("2026-10-08")), "2026-10-08");
        assert_eq!(
            day_key(&serde_json::json!("2026-10-08T11:22:33.000Z")),
            "2026-10-08"
        );
        assert_eq!(day_key(&serde_json::json!("2026-1-2")), "2026-1-2");
        assert_eq!(day_key(&serde_json::Value::Null), "");
    }

    #[test]
    fn card_id_cleaning_matches_reference() {
        assert_eq!(clean_card_id("242572"), Some(242572));
        assert_eq!(clean_card_id(" 007 "), Some(7));
        assert_eq!(clean_card_id("abc"), None);
        assert_eq!(clean_card_id("0"), None);
    }
}
