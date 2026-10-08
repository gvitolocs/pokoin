use std::collections::BTreeMap;

use serde_json::Value;

use crate::sales_slice::{opt_string, SoldSlice};
use crate::util::*;

pub struct DailyRow(pub Value);
pub struct ObservationRow(pub Value);

pub fn normalize_oracle_sale(row: &Value, card_id: &str) -> Value {
    let observed_at = row.get("observed_at").unwrap_or(&Value::Null);
    let created_at = row.get("created_at").unwrap_or(&Value::Null);
    let observed = timestamp_to_iso(observed_at);
    let sold_at = if observed.is_empty() {
        timestamp_to_iso(created_at)
    } else {
        observed
    };
    let source_item_id = row.get("source_item_id").and_then(|v| v.as_str()).unwrap_or("");
    let order_id = if !source_item_id.is_empty() {
        source_item_id.to_string()
    } else {
        format!("oracle-{}", row.get("id").and_then(|v| v.as_str()).unwrap_or(""))
    };
    let condition = row.get("condition").and_then(|v| v.as_str()).unwrap_or("").trim();
    let condition = if condition.is_empty() { "NM" } else { condition };
    serde_json::json!({
        "orderId": truncate_chars(&order_id, 160),
        "cardId": truncate_chars(&card_id, 80),
        "condition": condition,
        "language": row.get("language").and_then(|v| v.as_str()).unwrap_or("").trim().to_uppercase(),
        "pricePkn": round_to(number_value(row.get("price_pkn").unwrap_or(&Value::Null), 0.0), 6),
        "quantity": count_value(row.get("quantity").unwrap_or(&Value::Null)).max(1),
        "soldAt": sold_at,
        "graded": as_bool(row.get("graded")),
        "gradingCompany": truncate_chars(
            row.get("grading_company").and_then(|v| v.as_str()).unwrap_or("").trim(),
            80,
        ),
        "grade": truncate_chars(
            row.get("grade").and_then(|v| v.as_str()).unwrap_or("").trim(),
            40,
        ),
        "source": truncate_chars(
            row.get("source").and_then(|v| v.as_str()).unwrap_or("").trim(),
            80,
        ),
    })
}

fn timestamp_to_iso(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

pub fn sample_count_of(row: &Value) -> i64 {
    let samples = count_value(row.get("sample_count").unwrap_or(&Value::Null));
    if samples > 0 {
        return samples;
    }
    let listings = count_value(row.get("listings").unwrap_or(&Value::Null));
    if listings > 0 {
        return listings;
    }
    count_value(row.get("sold_qty").unwrap_or(&Value::Null))
}

pub fn comment_list(value: &Value) -> Vec<String> {
    comment_list_from_values(&values_of(value))
}

fn values_of(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(list) => list.clone(),
        _ => vec![],
    }
}

fn comments_of(row: &Value) -> Vec<Value> {
    values_of(row.get("graded_comments").unwrap_or(&Value::Null))
}

fn comment_list_from_values(rows: &[Value]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for row in rows {
        let text = row.as_str().unwrap_or("").trim().to_string();
        if !text.is_empty() && !seen.contains(&text) {
            seen.push(text);
        }
    }
    seen.truncate(8);
    seen
}

pub fn compact_sold_daily_slice(row: &Value) -> Value {
    serde_json::json!({
        "day": day_key(row.get("day").unwrap_or(&Value::Null)),
        "condition": row.get("condition").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
        "language": row.get("language").and_then(|v| v.as_str()).unwrap_or("").trim().to_uppercase(),
        "reverse": as_bool(row.get("reverse")),
        "firstEdition": as_bool(row.get("first_edition")),
        "graded": as_bool(row.get("graded")),
        "medianPkn": round_pkn(number_value(row.get("median_pkn").unwrap_or(&Value::Null), 0.0)),
        "minPkn": round_pkn(number_value(row.get("min_pkn").unwrap_or(&Value::Null), 0.0)),
        "maxPkn": round_pkn(number_value(row.get("max_pkn").unwrap_or(&Value::Null), 0.0)),
        "soldQty": count_value(row.get("sold_qty").unwrap_or(&Value::Null)),
        "listings": count_value(row.get("listings").unwrap_or(&Value::Null)),
        "sampleCount": sample_count_of(row),
        "comments": Value::Array(comment_list_from_values(&comments_of(row))),
    })
}

fn as_bool(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}

/// `mergeSoldDailyRows` — group by day, aggregate across slices.
pub fn merge_sold_daily_rows(rows: &[Value]) -> Vec<Value> {
    let mut by_day: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for row in rows {
        let day = day_key(
            row.get("day")
                .or(row.get("observed_day"))
                .or(row.get("observed_at"))
                .unwrap_or(&Value::Null),
        );
        if day.is_empty() {
            continue;
        }
        by_day.entry(day).or_default().push(row.clone());
    }

    by_day
        .into_iter()
        .map(|(day, slices)| {
            let mut prices: Vec<f64> = Vec::new();
            let mut comments: Vec<String> = Vec::new();
            let mut min_pkn = f64::INFINITY;
            let mut max_pkn = 0.0f64;
            let mut sold_qty = 0i64;
            let mut listings = 0i64;
            let mut sample_count = 0i64;
            for slice in &slices {
                let median = number_value(slice.get("median_pkn").unwrap_or(&Value::Null), 0.0);
                let qty = count_value(slice.get("sold_qty").unwrap_or(&Value::Null)).max(1);
                for _ in 0..qty {
                    prices.push(median);
                }
                let min_val = slice.get("min_pkn").and_then(|v| finite_positive(v));
                min_pkn = min_pkn.min(min_val.unwrap_or(median));
                let max_val = slice.get("max_pkn").and_then(|v| finite_positive(v));
                max_pkn = max_pkn.max(max_val.unwrap_or(median));
                sold_qty += count_value(slice.get("sold_qty").unwrap_or(&Value::Null));
                listings += count_value(slice.get("listings").unwrap_or(&Value::Null));
                sample_count += sample_count_of(slice);
                comments.extend(comment_list_from_values(&comments_of(slice)));
            }
            serde_json::json!({
                "day": day,
                "median_pkn": if slices.len() == 1 {
                    number_value(slices[0].get("median_pkn").unwrap_or(&Value::Null), 0.0)
                } else {
                    median_of(&prices)
                },
                "min_pkn": if min_pkn == f64::INFINITY { 0.0 } else { min_pkn },
                "max_pkn": max_pkn,
                "sold_qty": sold_qty,
                "listings": listings,
                "sample_count": if sample_count > 0 { sample_count } else { listings },
                "comments": Value::Array(comment_list_from_values(
                    &comments.iter().map(|c| Value::String(c.clone())).collect::<Vec<_>>(),
                )),
            })
        })
        .collect()
}

pub fn truncate_chars(value: &str, max_length: usize) -> String {
    if value.chars().count() <= max_length {
        return value.to_string();
    }
    value.chars().take(max_length).collect()
}

pub fn build_sales_series(day_rows: &[Value]) -> Value {
    let mut days: Vec<Value> = day_rows
        .iter()
        .map(|row| {
            let day = day_key(
                row.get("day")
                    .or(row.get("observed_day"))
                    .or(row.get("observed_at"))
                    .unwrap_or(&Value::Null),
            );
            serde_json::json!({
                "day": day,
                "medianPkn": round_pkn(number_value(row.get("median_pkn").unwrap_or(&Value::Null), 0.0)),
                "minPkn": round_pkn(number_value(row.get("min_pkn").unwrap_or(&Value::Null), 0.0)),
                "maxPkn": round_pkn(number_value(row.get("max_pkn").unwrap_or(&Value::Null), 0.0)),
                "soldQty": count_value(row.get("sold_qty").unwrap_or(&Value::Null)),
                "listings": count_value(row.get("listings").unwrap_or(&Value::Null)),
                "sampleCount": sample_count_of(row),
                "comments": Value::Array(comment_list_from_values(&comments_of(row))),
            })
        })
        .filter(|row| {
            row.get("day")
                .and_then(|v| v.as_str())
                .map(|d| !d.is_empty())
                .unwrap_or(false)
                && row.get("medianPkn").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0
        })
        .collect();
    days.sort_by(|a, b| {
        a.get("day")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("day").and_then(|v| v.as_str()).unwrap_or(""))
    });

    let mut change24h_pct = Value::Null;
    if days.len() >= 2 {
        let previous = days[days.len() - 2]
            .get("medianPkn")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let latest = days[days.len() - 1]
            .get("medianPkn")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if previous > 0.0 {
            change24h_pct = Value::from(round_to((latest - previous) / previous, 6));
        }
    }

    let sample_total: i64 = days
        .iter()
        .map(|row| row.get("sampleCount").and_then(|v| v.as_i64()).unwrap_or(0))
        .sum();

    serde_json::json!({
        "days": Value::Array(days.clone()),
        "sampleCount": sample_total,
        "change24hPct": change24h_pct,
        "firstDay": days.first().and_then(|r| r.get("day")).cloned().unwrap_or(Value::Null),
        "lastDay": days.last().and_then(|r| r.get("day")).cloned().unwrap_or(Value::Null),
        "lastMedianPkn": days.last().and_then(|r| r.get("medianPkn")).cloned().unwrap_or(Value::Null),
    })
}

pub fn last_median_payload(card_id: &str, row: &Value, slice: &SoldSlice) -> Value {
    let median = round_pkn(number_value(row.get("median_pkn").unwrap_or(&Value::Null), 0.0));
    let day = day_key(row.get("day").unwrap_or(&Value::Null));
    let flags = sold_slice_payload(slice);
    let samples = sample_count_of(row);
    let show = !day.is_empty() && median > 0.0;
    let mut payload = serde_json::Map::new();
    payload.insert("card_id".into(), Value::String(card_id.to_string()));
    payload.insert("day".into(), if show { Value::String(day) } else { Value::Null });
    payload.insert("median_pkn".into(), if show { Value::from(median) } else { Value::Null });
    payload.insert(
        "sample_count".into(),
        if show && samples > 0 {
            Value::from(samples)
        } else {
            Value::Null
        },
    );
    payload.insert("currency".into(), Value::String("PKN".to_string()));
    payload.insert(
        "source".into(),
        Value::String("cardtrader_removed_sale".to_string()),
    );
    payload.insert("condition".into(), opt_string(flags.condition));
    payload.insert("language".into(), opt_string(flags.language));
    payload.insert(
        "reverse".into(),
        flags.reverse.map(Value::Bool).unwrap_or(Value::Null),
    );
    Value::Object(payload)
}
