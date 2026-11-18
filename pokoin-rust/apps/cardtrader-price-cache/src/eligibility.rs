//! CardTrader product eligibility.
//!
//! Port of `api/_cardtrader_blueprint_listing_cache_refresh.js`: Zero flags,
//! the 1-day-ready name, then EUR, quantity and a positive price.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::money::{parse_rat, price_to_pkn, Rat};
use crate::rank::{Offer, Provider};

pub fn flag_is_true(value: &Value) -> bool {
    let text = match value {
        Value::Null => String::new(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        _ => String::new(),
    };
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "y"
    )
}

pub fn is_one_day_ready(text: &str) -> bool {
    ready_pattern().is_match(text)
}

fn ready_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(^|[^a-z0-9])((1|one)[\s-]*day[\s-]*ready)([^a-z0-9]|$)")
            .expect("one-day-ready pattern")
    })
}

/// Label: `one_day_ready` when the name matches (even with Zero flags), else `zero`, else not eligible.
pub fn shipping_mode(product: &Value) -> Option<&'static str> {
    if is_one_day_ready(&ready_text(product)) {
        return Some("one_day_ready");
    }
    if flag_is_true_at(raw_flag(product, "can_sell_via_hub"))
        || flag_is_true_at(raw_flag(product, "can_sell_sealed_with_ct_zero"))
    {
        return Some("zero");
    }
    None
}

pub fn eligible_cardtrader(product: &Value, blueprint_key: &str, rate: Rat) -> Option<Offer> {
    let shipping_mode = shipping_mode(product)?;
    let quantity = quantity_of(product);
    if quantity <= 0 || currency_of(product) != "EUR" {
        return None;
    }
    let price_eur = eur_price(product)?;
    if !price_eur.is_positive() {
        return None;
    }
    let listing_id = first_text(
        product,
        &["id", "product_id", "productId", "listing_id", "listingId"],
        160,
    );
    if listing_id.is_empty() {
        return None;
    }
    let blueprint_id = product
        .get("blueprint_id")
        .and_then(json_i64)
        .or_else(|| product.get("blueprintId").and_then(json_i64))
        .or_else(|| blueprint_key.trim().parse().ok())
        .filter(|id| *id > 0)?;
    let price_pkn = price_to_pkn(price_eur, rate)?;
    let product_id = {
        let text = first_text(product, &["product_id", "productId", "id"], 160);
        if text.is_empty() {
            listing_id.clone()
        } else {
            text
        }
    };
    Some(Offer {
        blueprint_id,
        provider: Provider::CardTrader,
        price_pkn,
        price_eur: Some(price_eur),
        listing_id,
        product_id,
        quantity,
        country: seller_country(product),
        shipping_mode,
        source_snapshot_at: None,
    })
}

fn flag_is_true_at(value: Option<&Value>) -> bool {
    value.is_some_and(flag_is_true)
}

/// `user[key]` when it is present and not null, otherwise the product field.
fn raw_flag<'a>(product: &'a Value, key: &str) -> Option<&'a Value> {
    if let Some(user) = product.get("user").and_then(Value::as_object) {
        if let Some(value) = user.get(key) {
            if !value.is_null() {
                return Some(value);
            }
        }
    }
    product.get(key).filter(|value| !value.is_null())
}

fn ready_text(product: &Value) -> String {
    let user = match product.get("user") {
        Some(value) if js_truthy(value) => value.as_object(),
        _ => product.get("seller").and_then(Value::as_object),
    };
    let mut parts = Vec::with_capacity(9);
    for key in ["username", "name", "display_name", "public_name"] {
        parts.push(loose_string(user.and_then(|map| map.get(key))));
    }
    for key in [
        "seller_name",
        "seller_display_name",
        "name",
        "name_en",
        "description",
    ] {
        parts.push(loose_string(product.get(key)));
    }
    parts.join(" ")
}

fn seller_country(product: &Value) -> String {
    let user = match product.get("user") {
        Some(value) if js_truthy(value) => value.as_object(),
        _ => product.get("seller").and_then(Value::as_object),
    };
    let raw = user
        .and_then(|map| map.get("country_code").filter(|value| !value.is_null()))
        .or_else(|| user.and_then(|map| map.get("country").filter(|value| !value.is_null())))
        .or_else(|| product.get("seller_country"));
    truncate(&clean_text(raw), 40)
}

fn currency_of(product: &Value) -> String {
    let raw = product
        .get("price_currency")
        .filter(|value| !value.is_null())
        .or_else(|| product.get("currency").filter(|value| !value.is_null()))
        .or_else(|| product.get("price").and_then(|price| price.get("currency")));
    let text = clean_text(raw);
    if text.is_empty() {
        "EUR".to_string()
    } else {
        text.to_ascii_uppercase()
    }
}

fn eur_price(product: &Value) -> Option<Rat> {
    if let Some(price) = product.get("price").and_then(plain_number) {
        return Some(price);
    }
    if let Some(price) = product.get("price_amount").and_then(plain_number) {
        return Some(price);
    }
    let cents = product.get("price_cents").and_then(json_i64).or_else(|| {
        product
            .get("price")
            .and_then(|price| price.get("cents"))
            .and_then(json_i64)
    })?;
    Rat::new(i128::from(cents), 100)
}

fn quantity_of(product: &Value) -> i64 {
    let raw = match product.get("quantity") {
        Some(value) if !value.is_null() => Some(value),
        _ => product.get("qty"),
    };
    raw.and_then(json_i64).unwrap_or(0).max(0)
}

fn plain_number(value: &Value) -> Option<Rat> {
    match value {
        Value::Number(number) => parse_rat(&number.to_string()),
        Value::String(text) => parse_rat(text.trim()),
        _ => None,
    }
}

pub fn json_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| {
                let float = number.as_f64()?;
                if float.fract() == 0.0 && (i64::MIN as f64..=i64::MAX as f64).contains(&float) {
                    Some(float as i64)
                } else {
                    None
                }
            }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn first_text(product: &Value, keys: &[&str], max: usize) -> String {
    let Some(map) = product.as_object() else {
        return String::new();
    };
    for key in keys {
        if let Some(value) = map.get(*key) {
            if value.is_null() {
                continue;
            }
            return truncate(&clean_text(Some(value)), max);
        }
    }
    String::new()
}

fn clean_text(value: Option<&Value>) -> String {
    loose_string(value).trim().to_string()
}

/// `String(value || '')` from the Oracle job: null, false and 0 become empty.
fn loose_string(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::Bool(true) => "true".to_string(),
        Value::Number(number) if number.as_i64() == Some(0) || number.as_f64() == Some(0.0) => {
            String::new()
        }
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        _ => String::new(),
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_i64() != Some(0) && number.as_f64() != Some(0.0),
        Value::Array(items) => !items.is_empty(),
        Value::Object(_) => true,
        Value::Bool(true) => true,
    }
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
