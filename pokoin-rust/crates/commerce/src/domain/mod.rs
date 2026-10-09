//! Pure domain logic ported from the Node handlers. No I/O lives here so it can
//! be exercised by fast, hermetic tests.

pub mod address;
pub mod cart;
pub mod country;
pub mod crypto;
pub mod media;
pub mod money;
/// Seller sale notifications (`_marketplace_sale_notifications.js`).
pub mod notify;
pub mod money_request;
pub mod order_refund;
pub mod shipping;
pub mod stock_csv;
pub mod wpkn;

/// `Math.trunc(Number(value))` with a fallback, matching the JS helpers.
pub fn js_trunc(value: impl Into<f64>, fallback: i64) -> i64 {
    let value = value.into();
    if value.is_finite() {
        value.trunc() as i64
    } else {
        fallback
    }
}

/// `Math.round` for the non-negative ranges these handlers use.
pub fn js_round(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    value.round() as i64
}

/// `String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)`.
pub fn squash_text(value: &str, max: usize) -> String {
    let squashed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    squashed.chars().take(max).collect()
}

/// `String(value ?? '').trim().slice(0, max)`.
pub fn trim_text(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

/// JS `Number(value)` for form fields: `''` and `null` are not numbers.
pub fn js_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            trimmed.replace(',', ".").parse::<f64>().ok()
        }
        serde_json::Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        serde_json::Value::Null => None,
        _ => None,
    }
}

/// JS truthiness for the CSV flag columns (`true`, `1`, `yes`, `y`, `x`).
pub fn truthy_flag(value: Option<&serde_json::Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let text = match value {
        serde_json::Value::String(text) => text.trim().to_ascii_lowercase(),
        serde_json::Value::Bool(flag) => return *flag,
        serde_json::Value::Number(number) => number.to_string(),
        _ => return false,
    };
    matches!(text.as_str(), "true" | "1" | "yes" | "y" | "x")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squash_text_matches_js_whitespace_collapse() {
        assert_eq!(squash_text("  a \n b\tc ", 40), "a b c");
        assert_eq!(squash_text("abcdef", 3), "abc");
    }

    #[test]
    fn js_number_rejects_empty_strings() {
        assert_eq!(js_number(Some(&serde_json::json!(""))), None);
        assert_eq!(js_number(Some(&serde_json::json!(null))), None);
        assert_eq!(js_number(Some(&serde_json::json!("1,5"))), Some(1.5));
        assert_eq!(js_number(Some(&serde_json::json!(2))), Some(2.0));
    }

    #[test]
    fn truthy_flag_matches_csv_spec() {
        for value in ["true", "1", "yes", "Y", "x"] {
            assert!(truthy_flag(Some(&serde_json::json!(value))), "{value}");
        }
        for value in ["", "0", "no", "n", "false"] {
            assert!(!truthy_flag(Some(&serde_json::json!(value))), "{value}");
        }
    }
}
