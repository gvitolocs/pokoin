//! JavaScript value semantics over `serde_json::Value` rows (`Number`,
//! `String`, `||`, `??`, `.slice`), shared by every helper port.
//!
//! Postgres rows arrive as JSON objects (`to_jsonb(row)`), exactly the shape
//! the Node handlers saw from `pg`. Every `Value::Number` in such a row was a
//! JS double at request time, so integers that Postgres wrote as `22.0`
//! stringify as `22` — [`js_json_number`] and [`js_normalize`] reproduce that.

use serde_json::{Map, Number, Value};

/// `Boolean(value)`; `None` is an absent key (`undefined`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(v) => v != 0.0 && !v.is_nan(),
            None => false,
        },
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `Number(value)`: absent key -> NaN, `null` -> 0, strings follow
/// [`pokoin_api_common::http::js_number`].
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => pokoin_api_common::http::js_number(s).unwrap_or(f64::NAN),
        // Number(object) / Number(array) is NaN except for exotic valueOf;
        // JSON rows never carry those for the fields the helpers read.
        Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
    }
}

/// `value ?? fallback` (only `null`/absent fall through, `0` does not).
pub fn nullish_or<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        Some(v) => Some(v),
    }
}

/// `value || fallback` over raw values (empty string / 0 / null fall through).
pub fn or<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    if truthy(value) {
        value.unwrap()
    } else {
        fallback
    }
}

/// `a || b || c || …` over raw row values — the first truthy, if any. Use
/// this instead of nested [`or`] calls so literal fallbacks never create
/// reference gymnastics.
pub fn truthy_chain<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values
        .iter()
        .flatten()
        .copied()
        .find(|value| truthy(Some(value)))
}

/// `String(a || b || …)` — the first truthy rendered, `''` when all falsy.
pub fn string_chain(values: &[Option<&Value>]) -> String {
    string_or_empty(truthy_chain(values))
}

/// `a || b || fallback` as an owned value (literal fallbacks included).
pub fn value_chain(values: &[Option<&Value>], fallback: Value) -> Value {
    truthy_chain(values).cloned().unwrap_or(fallback)
}

/// `Number(a || b || … || 0)` — 0 when every value is falsy (the trailing
/// `|| 0` of the Node helpers).
pub fn number_chain(values: &[Option<&Value>]) -> f64 {
    match truthy_chain(values) {
        Some(value) => number(Some(value)),
        None => 0.0,
    }
}

/// JS `Number::toString` for the doubles JSON rows carry (66.0 -> "66").
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_string()
    } else if n.is_infinite() {
        if n > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        }
    } else if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        let s = format!("{n}");
        s
    }
}

/// JSON value for a JS double: integer-valued floats collapse to integers
/// the way `JSON.stringify` does after `Number()`.
pub fn js_json_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Value::Number(Number::from(n as i64))
    } else {
        Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// `Math.round(x * 1000) / 1000` as a JSON value.
pub fn round3(v: f64) -> Value {
    js_json_number((v * 1000.0).round() / 1000.0)
}

/// `String(value)` — the JSON rendering of a row value.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `String(value || '')`.
pub fn string_or_empty(value: Option<&Value>) -> String {
    if truthy(value) {
        js_string(value.unwrap())
    } else {
        String::new()
    }
}

/// `.slice(0, max)` in UTF-16 code units, like JS.
pub fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        if units >= max {
            break;
        }
        let len = ch.len_utf16();
        if units + len > max {
            break;
        }
        out.push(ch);
        units += len;
    }
    out
}

/// `String(value || '').trim().slice(0, maxLength)` (`cleanText`).
pub fn clean_text(value: Option<&Value>, max_length: usize) -> String {
    let text = string_or_empty(value);
    slice_utf16(text.trim(), max_length)
}

/// `String(text || '').trim().slice(0, maxLength)` for plain `&str` input.
pub fn clean_text_str(text: &str, max_length: usize) -> String {
    slice_utf16(text.trim(), max_length)
}

/// `Number.isSafeInteger(n)`.
pub fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.trunc() == n && n.abs() <= 9_007_199_254_740_991.0
}

/// Row object access (`row[key]`, `None` = absent key).
pub fn get<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.as_object().and_then(|map| map.get(key))
}

/// Insert/replace a key on a row object, preserving key order like
/// `row[key] = value` does.
pub fn set(row: &mut Map<String, Value>, key: &str, value: Value) {
    row.insert(key.to_string(), value);
}

/// Spread `{ ...row, key: value }` onto a fresh object.
pub fn spread_with(row: &Value, key: &str, value: Value) -> Value {
    let mut map = row.as_object().cloned().unwrap_or_default();
    set(&mut map, key, value);
    Value::Object(map)
}

/// pg returns every JSON number as a JS double; mirror the
/// `JSON.parse` -> `JSON.stringify` round trip (`22.0` -> `22`).
pub fn js_normalize(value: &Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(v) => js_json_number(v),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(js_normalize).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), js_normalize(item));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_js() {
        assert!(!truthy(Some(&Value::Null)));
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(!truthy(Some(&json!(false))));
        assert!(truthy(Some(&json!([]))));
        assert!(truthy(Some(&json!({}))));
        assert!(truthy(Some(&json!("0"))));
        assert!(truthy(Some(&json!(-1))));
    }

    #[test]
    fn numbers_match_js_coercion() {
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert!(number(None).is_nan());
        assert_eq!(number(Some(&json!("12.5"))), 12.5);
        assert_eq!(number(Some(&json!(""))), 0.0);
        assert!(number(Some(&json!("12abc"))).is_nan());
        assert_eq!(number(Some(&json!(true))), 1.0);
    }

    #[test]
    fn strings_match_js_stringify() {
        assert_eq!(js_string(&json!(66.0)), "66");
        assert_eq!(js_string(&json!(22.5)), "22.5");
        assert_eq!(js_string(&json!("x")), "x");
        assert_eq!(js_string(&json!(null)), "null");
        assert_eq!(string_or_empty(Some(&json!(0))), "");
        assert_eq!(string_or_empty(Some(&json!(66.0))), "66");
        assert_eq!(string_or_empty(Some(&json!("a b"))), "a b");
    }

    #[test]
    fn clean_text_slices_by_utf16_units() {
        assert_eq!(clean_text(Some(&json!("  hello  ")), 3), "hel");
        assert_eq!(clean_text(Some(&json!(null)), 8), "");
        // 🏆 is 2 UTF-16 units; a 3-unit cap keeps it plus one ASCII char.
        assert_eq!(clean_text(Some(&json!("🏆ab")), 3), "🏆a");
    }

    #[test]
    fn json_numbers_collapse_integer_floats() {
        assert_eq!(js_json_number(66.0), json!(66));
        assert_eq!(js_json_number(0.005), json!(0.005));
        assert_eq!(js_json_number(-2.0), json!(-2));
        assert_eq!(
            js_normalize(&json!({"a": 22.0, "b": [1.0, "x"]})),
            json!({"a": 22, "b": [1, "x"]})
        );
    }

    #[test]
    fn spread_keeps_position_and_appends() {
        let row = json!({"a": 1, "c": 3});
        let next = spread_with(&row, "b", json!(2));
        let keys: Vec<&str> = next
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["a", "c", "b"]);
    }
}
