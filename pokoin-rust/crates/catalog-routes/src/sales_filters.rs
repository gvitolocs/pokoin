//! `buildSalesFilters` — facet lists for the sold graph, mirrored from the
//! deployed reference (`marketplace-card-sales.js`).

use std::collections::BTreeSet;

use serde_json::Value;

use crate::sales_slice::{clean_sold_flag, SoldSlice, sold_slice_payload};
use crate::sales_sql::{SOLD_CONDITION_ORDER, SOLD_LANGUAGE_ORDER};

fn facet_match(row: &Value, flags: &SoldSlice, omit: &str) -> bool {
    if omit != "condition" {
        let want = &flags.condition;
        if !want.is_empty()
            && row.get("condition").and_then(|v| v.as_str()).unwrap_or("") != want
        {
            return false;
        }
    }
    if omit != "language" {
        let want = &flags.language;
        if !want.is_empty()
            && row
                .get("language")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_uppercase()
                != *want
        {
            return false;
        }
    }
    if omit != "reverse" && flags.reverse.is_some() && flag_of(row, "reverse") != flags.reverse {
        return false;
    }
    if omit != "firstEdition" && flags.first_edition.is_some() {
        let row_flag = row
            .get("first_edition")
            .or(row.get("firstEdition"))
            .unwrap_or(&Value::Null);
        if flag_of(row_flag, "") != flags.first_edition {
            return false;
        }
    }
    if omit != "graded" && flags.graded.is_some() && flag_of(row, "graded") != flags.graded {
        return false;
    }
    true
}

fn flag_of(row: &Value, key: &str) -> Option<bool> {
    let value = if key.is_empty() { row } else { row.get(key).unwrap_or(&Value::Null) };
    if let Some(flag) = value.as_bool() {
        return Some(flag);
    }
    clean_sold_flag(value.as_str().unwrap_or(""))
}

/// `uniqueOrdered` — order-ranked keys, then the rest sorted lexicographically.
pub fn unique_ordered(values: &[String], order: &[&str]) -> Vec<String> {
    let seen: BTreeSet<String> = values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    let mut ranked: Vec<String> = order
        .iter()
        .filter(|key| seen.contains(*key))
        .map(|key| key.to_string())
        .collect();
    let rest: Vec<String> = seen
        .into_iter()
        .filter(|key| !order.contains(&key.as_str()))
        .collect();
    ranked.extend(rest);
    ranked
}

/// `uniqueFlags` — `[false, true]` filtered to the flags actually seen.
pub fn unique_flags(values: &[Option<bool>]) -> Vec<bool> {
    let seen: BTreeSet<bool> = values.iter().filter_map(|v| *v).collect();
    [false, true].into_iter().filter(|flag| seen.contains(flag)).collect()
}

pub fn build_sales_filters(rows: &[Value], slice: &SoldSlice) -> Value {
    let flags = sold_slice_payload(slice);
    let collect = |omit: &str, key: &str| -> Vec<String> {
        rows
            .iter()
            .filter(|row| facet_match(row, &flags, omit))
            .map(|row| row.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string())
            .collect()
    };
    let collect_flags = |omit: &str, key: &str| -> Vec<Option<bool>> {
        rows
            .iter()
            .filter(|row| facet_match(row, &flags, omit))
            .map(|row| flag_of(row.get(key).unwrap_or(&Value::Null), key))
            .collect()
    };

    serde_json::json!({
        "conditions": Value::Array(unique_ordered(&collect("condition", "condition"), &SOLD_CONDITION_ORDER)),
        "languages": Value::Array(unique_ordered(&collect("language", "language"), &SOLD_LANGUAGE_ORDER)),
        "reverse": Value::Array(unique_flags(&collect_flags("reverse", "reverse")).into_iter().map(Value::Bool).collect()),
        "firstEdition": Value::Array(unique_flags(&collect_flags("firstEdition", "first_edition")).into_iter().map(Value::Bool).collect()),
        "graded": Value::Array(unique_flags(&collect_flags("graded", "graded")).into_iter().map(Value::Bool).collect()),
    })
}
