use serde_json::Value;

use crate::sales_sql::*;
use crate::util::*;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SoldSlice {
    pub condition: String,
    pub language: String,
    pub reverse: Option<bool>,
    pub first_edition: Option<bool>,
    pub graded: Option<bool>,
}

/// `cleanSoldCondition` — desk condition keys.
pub fn clean_sold_condition(value: &str) -> String {
    let text = value.trim();
    if SOLD_CONDITION_ORDER.contains(&text) {
        return text.to_string();
    }
    let lowered = text
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    match lowered.as_str() {
        "nm" | "mint" | "near mint" => "NM",
        "sp" | "slightly played" | "lightly played" | "lp" => "SP",
        "mp" | "moderately played" | "good" | "gd" => "MP",
        "pl" | "played" => "PL",
        "poor" | "po" | "damaged" => "Poor",
        _ => "",
    }
    .to_string()
}

/// `cleanSoldLanguage` — two/three-letter desk language keys.
pub fn clean_sold_language(value: &str) -> String {
    let text = value.trim().to_uppercase();
    if text.is_empty() {
        return String::new();
    }
    if text == "JA" {
        return "JP".to_string();
    }
    if text == "KR" {
        return "KO".to_string();
    }
    if text == "ZH-CN" || text == "ZH_HANS" {
        return "ZH".to_string();
    }
    if text == "ZH-TW" || text == "ZH_HANT" {
        return "ZHT".to_string();
    }
    if text == "ZHT" {
        return text;
    }
    let is_code = text.len() >= 2
        && text.len() <= 3
        && text.chars().all(|c| c.is_ascii_alphabetic());
    if is_code {
        return text;
    }
    String::new()
}

/// `cleanSoldFlag` — tri-state (None == JS null).
pub fn clean_sold_flag(value: &str) -> Option<bool> {
    let text = value.trim().to_lowercase();
    if text.is_empty() {
        return None;
    }
    if ["1", "true", "yes", "reverse", "graded", "first", "1st", "first edition"]
        .contains(&text.as_str())
    {
        return Some(true);
    }
    if ["0", "false", "no", "standard", "unlimited", "raw", "ungraded"].contains(&text.as_str()) {
        return Some(false);
    }
    None
}

/// `soldSlicePayload` — the normalized slice used in responses and SQL binds.
pub fn sold_slice_payload(slice: &SoldSlice) -> SoldSlice {
    SoldSlice {
        condition: clean_sold_condition(&slice.condition),
        language: clean_sold_language(&slice.language),
        reverse: slice.reverse,
        first_edition: slice.first_edition,
        graded: slice.graded,
    }
}

pub fn sold_slice_values(slice: &SoldSlice) -> Vec<Value> {
    let flags = sold_slice_payload(slice);
    vec![
        Value::String(flags.condition),
        Value::String(flags.language),
        flag_value(flags.reverse),
        flag_value(flags.first_edition),
        flag_value(flags.graded),
    ]
}

fn flag_value(flag: Option<bool>) -> Value {
    match flag {
        Some(v) => Value::Bool(v),
        None => Value::Null,
    }
}

pub fn sold_slice_json(slice: &SoldSlice) -> Value {
    let flags = sold_slice_payload(slice);
    serde_json::json!({
        "condition": opt_string(flags.condition),
        "language": opt_string(flags.language),
        "reverse": flags.reverse.map(Value::Bool).unwrap_or(Value::Null),
        "firstEdition": flags.first_edition.map(Value::Bool).unwrap_or(Value::Null),
        "graded": flags.graded.map(Value::Bool).unwrap_or(Value::Null),
    })
}

pub fn opt_string(value: String) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value)
    }
}
