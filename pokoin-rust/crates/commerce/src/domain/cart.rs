//! Account cart cleaning + revision rules, ported from `_cart_store.js`.
//!
//! Rows are cleaned to a fixed field list so the table never stores arbitrary
//! client blobs, and `card_ids` is derived for the "customers also carried"
//! overlap index.

use serde_json::{json, Map, Value};

use crate::domain::{js_number, squash_text};

pub const CART_MAX: usize = 400;
pub const SAVED_MAX: usize = 200;

/// JS `String(value ?? '')` for the scalar shapes the SPA sends.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(_) => String::new(),
    }
}

fn text(value: Option<&Value>, max: usize) -> String {
    squash_text(&js_string(value), max)
}

fn bool_field(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => text == "true",
        Some(Value::Number(number)) => number.as_i64() == Some(1),
        _ => false,
    }
}

fn count(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    match js_number(value) {
        Some(number) if number.is_finite() => (number.trunc() as i64).clamp(min, max),
        _ => fallback,
    }
}

fn money(value: Option<&Value>) -> f64 {
    match js_number(value) {
        Some(number) if number.is_finite() && number >= 0.0 => {
            (number * 100.0).round() / 100.0
        }
        _ => 0.0,
    }
    .min(1e9)
}

fn digits(value: Option<&Value>, max: usize) -> String {
    let id = text(value, max);
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
        id
    } else {
        String::new()
    }
}

/// Only app paths: no protocol-relative or scheme links survive.
fn app_path(value: Option<&Value>) -> String {
    let path = text(value, 800);
    if path.starts_with('/')
        && !path.starts_with("//")
        && !path.chars().any(|c| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\''))
    {
        path
    } else {
        String::new()
    }
}

/// App path or https URL for a card scan.
fn image_url(value: Option<&Value>) -> String {
    let url = text(value, 800);
    if url.is_empty() {
        return url;
    }
    let has_bad_char = |text: &str| {
        text.chars()
            .any(|c| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\''))
    };
    if url.starts_with('/') && !url.starts_with("//") {
        return if has_bad_char(&url) { String::new() } else { url };
    }
    if let Some(rest) = url.strip_prefix("https://") {
        if !rest.is_empty() && !has_bad_char(rest) {
            return url;
        }
    }
    String::new()
}

/// One cart line as the SPA stores it, minus anything it does not need.
pub fn clean_cart_row(raw: &Value) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    let id = text(raw.get("id"), 80);
    let card_id = {
        let direct = digits(raw.get("cardId"), 20);
        if direct.is_empty() {
            digits(raw.get("card").and_then(|card| card.get("id")), 20)
        } else {
            direct
        }
    };
    if id.is_empty() || card_id.is_empty() {
        return None;
    }
    let price_pkn = money(raw.get("pricePkn"));
    let name = {
        let direct = text(raw.get("name"), 240);
        if direct.is_empty() {
            let nested = text(raw.get("card").and_then(|card| card.get("name")), 240);
            if nested.is_empty() {
                "Card".to_string()
            } else {
                nested
            }
        } else {
            direct
        }
    };
    let added_price = money(raw.get("addedPricePkn"));

    let mut row = Map::new();
    row.insert("id".into(), json!(id));
    row.insert("listingId".into(), json!(text(raw.get("listingId"), 80)));
    row.insert("sellerUid".into(), json!(text(raw.get("sellerUid"), 160)));
    row.insert("cardId".into(), json!(card_id));
    row.insert("name".into(), json!(name));
    row.insert("image".into(), json!(image_url(raw.get("image"))));
    row.insert("href".into(), json!(app_path(raw.get("href"))));
    row.insert("pricePkn".into(), json!(price_pkn));
    row.insert(
        "addedPricePkn".into(),
        json!(if added_price == 0.0 { price_pkn } else { added_price }),
    );
    row.insert(
        "addedAt".into(),
        json!(count(raw.get("addedAt"), 0, 4_102_444_800_000, 0)),
    );
    row.insert(
        "sellerAcceptsPkn".into(),
        json!(!matches!(raw.get("sellerAcceptsPkn"), Some(Value::Bool(false)))),
    );
    row.insert("qty".into(), json!(count(raw.get("qty"), 1, 99, 1)));
    row.insert("stock".into(), json!(count(raw.get("stock"), 1, 99, 1)));
    row.insert(
        "selected".into(),
        json!(!matches!(raw.get("selected"), Some(Value::Bool(false)))),
    );
    row.insert("unavailable".into(), json!(bool_field(raw.get("unavailable"))));
    row.insert("condition".into(), json!(text(raw.get("condition"), 40)));
    row.insert("language".into(), json!(text(raw.get("language"), 16)));
    row.insert("reverse".into(), json!(bool_field(raw.get("reverse"))));
    row.insert("firstEdition".into(), json!(bool_field(raw.get("firstEdition"))));
    row.insert("graded".into(), json!(bool_field(raw.get("graded"))));
    row.insert("gradingCompany".into(), json!(text(raw.get("gradingCompany"), 40)));
    row.insert("grade".into(), json!(text(raw.get("grade"), 20)));
    row.insert("signed".into(), json!(bool_field(raw.get("signed"))));
    row.insert("sealed".into(), json!(bool_field(raw.get("sealed"))));
    row.insert("setName".into(), json!(text(raw.get("setName"), 240)));
    row.insert(
        "collectorNumber".into(),
        json!(text(raw.get("collectorNumber"), 80)),
    );
    row.insert("sellerName".into(), json!(text(raw.get("sellerName"), 120)));
    row.insert(
        "sellerUsername".into(),
        json!(text(raw.get("sellerUsername"), 64).trim_start_matches('@').to_string()),
    );
    row.insert(
        "sellerCountry".into(),
        json!(text(raw.get("sellerCountry"), 8).to_ascii_uppercase()),
    );
    row.insert("nftAvailable".into(), json!(bool_field(raw.get("nftAvailable"))));
    row.insert(
        "reserveAvailable".into(),
        json!(bool_field(raw.get("reserveAvailable"))),
    );
    row.insert("game".into(), json!(text(raw.get("game"), 40)));
    Some(Value::Object(row))
}

fn clean_rows(list: Option<&Value>, max: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    if let Some(Value::Array(rows)) = list {
        for raw in rows {
            let Some(row) = clean_cart_row(raw) else {
                continue;
            };
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            out.push(row);
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

/// Whole account cart from a PUT body or a stored row.
pub fn clean_cart_state(raw: &Value) -> Value {
    json!({
        "items": clean_rows(raw.get("items"), CART_MAX),
        "saved": clean_rows(raw.get("saved"), SAVED_MAX),
        "gift": bool_field(raw.get("gift")),
    })
}

/// Distinct numeric card ids across cart and saved, for the overlap index.
pub fn cart_card_ids(state: &Value) -> Vec<i64> {
    let mut ids: Vec<i64> = Vec::new();
    for key in ["items", "saved"] {
        if let Some(Value::Array(rows)) = state.get(key) {
            for row in rows {
                if let Some(id) = row.get("cardId").and_then(Value::as_str) {
                    if let Ok(parsed) = id.parse::<i64>() {
                        if !ids.contains(&parsed) {
                            ids.push(parsed);
                        }
                    }
                }
            }
        }
    }
    ids.truncate(CART_MAX + SAVED_MAX);
    ids
}

pub fn empty_cart() -> Value {
    json!({ "items": [], "saved": [], "gift": false, "rev": 0, "updatedAt": null })
}

/// Project a stored row (as returned by Postgres) into the public cart shape.
pub fn cart_from_row(row: Option<&Value>) -> Value {
    let Some(row) = row else {
        return empty_cart();
    };
    let state = clean_cart_state(row);
    let rev = row
        .get("rev")
        .and_then(Value::as_i64)
        .map(|value| value.max(0))
        .unwrap_or(0);
    let updated_at = row
        .get("updated_at")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    json!({
        "items": state.get("items").cloned().unwrap_or_else(|| json!([])),
        "saved": state.get("saved").cloned().unwrap_or_else(|| json!([])),
        "gift": state.get("gift").cloned().unwrap_or_else(|| json!(false)),
        "rev": rev,
        "updatedAt": updated_at,
    })
}

/// `Math.max(0, Math.trunc(Number(baseRev) || 0))`.
pub fn base_rev(value: Option<&Value>) -> i64 {
    js_number(value)
        .filter(|number| number.is_finite())
        .map(|number| number.trunc() as i64)
        .unwrap_or(0)
        .max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_rows_without_id_or_card_id() {
        assert!(clean_cart_row(&json!({ "id": "a" })).is_none());
        assert!(clean_cart_row(&json!({ "cardId": "12" })).is_none());
        assert!(clean_cart_row(&json!("nope")).is_none());
        let row = clean_cart_row(&json!({ "id": "a", "cardId": 12 })).unwrap();
        assert_eq!(row["cardId"], json!("12"));
    }

    #[test]
    fn sanitizes_links_and_names() {
        let row = clean_cart_row(&json!({
            "id": "line-1",
            "cardId": "693360",
            "name": "  Charizard   ex ",
            "image": "https://cdn.pokoin.com/a.webp",
            "href": "//evil.example",
            "pricePkn": 12.345,
            "qty": 500,
            "sellerUsername": "@redshakkio",
        }))
        .unwrap();
        assert_eq!(row["name"], json!("Charizard ex"));
        assert_eq!(row["href"], json!(""));
        assert_eq!(row["pricePkn"], json!(12.35));
        assert_eq!(row["qty"], json!(99));
        assert_eq!(row["sellerUsername"], json!("redshakkio"));
        assert_eq!(row["addedPricePkn"], json!(12.35));
    }

    #[test]
    fn rejects_dangerous_image_urls() {
        let base = json!({ "id": "x", "cardId": "1" });
        for bad in ["javascript:alert(1)", "http://x/y", "/a b.png", "//cdn/x.png"] {
            let mut raw = base.clone();
            raw["image"] = json!(bad);
            assert_eq!(clean_cart_row(&raw).unwrap()["image"], json!(""), "{bad}");
        }
        for good in ["/img/a.webp", "https://cdn.pokoin.com/a.webp"] {
            let mut raw = base.clone();
            raw["image"] = json!(good);
            assert_eq!(clean_cart_row(&raw).unwrap()["image"], json!(good));
        }
    }

    #[test]
    fn dedupes_and_caps_rows() {
        let state = clean_cart_state(&json!({
            "items": [
                { "id": "a", "cardId": "1" },
                { "id": "a", "cardId": "2" },
                { "id": "b", "cardId": "3" },
            ],
            "gift": "true",
        }));
        assert_eq!(state["items"].as_array().unwrap().len(), 2);
        assert_eq!(state["gift"], json!(true));
        assert_eq!(cart_card_ids(&state), vec![1, 3]);
    }

    #[test]
    fn defaults_follow_the_spa_contract() {
        let row = clean_cart_row(&json!({ "id": "a", "cardId": "1" })).unwrap();
        assert_eq!(row["selected"], json!(true));
        assert_eq!(row["sellerAcceptsPkn"], json!(true));
        assert_eq!(row["qty"], json!(1));
        assert_eq!(row["name"], json!("Card"));

        // Explicit false must survive.
        let row = clean_cart_row(&json!({
            "id": "a", "cardId": "1", "selected": false, "sellerAcceptsPkn": false,
        }))
        .unwrap();
        assert_eq!(row["selected"], json!(false));
        assert_eq!(row["sellerAcceptsPkn"], json!(false));
    }

    #[test]
    fn empty_cart_shape_matches_the_api() {
        assert_eq!(
            empty_cart(),
            json!({ "items": [], "saved": [], "gift": false, "rev": 0, "updatedAt": null })
        );
        let projected = cart_from_row(Some(&json!({
            "items": [{ "id": "a", "cardId": "1" }],
            "saved": [],
            "gift": false,
            "rev": 7,
            "updated_at": "2026-10-08T10:00:00Z",
        })));
        assert_eq!(projected["rev"], json!(7));
        assert_eq!(projected["updatedAt"], json!("2026-10-08T10:00:00Z"));
    }
}
