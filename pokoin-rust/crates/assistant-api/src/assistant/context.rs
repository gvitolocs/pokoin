//! Page-context cleaning of `pokoin-assistant.js`: `cleanPageContext`,
//! `cleanCardContext`, `cleanArtistContext`, `cleanVisibleCards`,
//! `safePageUrl`, `cleanInternalPath`, `pageContextForPrompt`,
//! `pageCardContext`, `enrichedPageCardContext`,
//! `marketplaceLanguageFromPage`, `pageUrlFromContext`, `cardSearchPath`.
//!
//! Cleaned contexts stay ordered JSON maps so the response echoes the exact
//! field order Node produced.

use std::sync::OnceLock;

use regex::Regex;
use reqwest::Url;
use serde_json::{json, Map, Value};

use crate::assistant::text::{clean_object, clean_text, is_sensitive_context_key};

fn parse_base_url() -> &'static Url {
    static BASE: OnceLock<Url> = OnceLock::new();
    BASE.get_or_init(|| Url::parse("https://pokoin.com").expect("static base url"))
}

/// `new URL(raw, 'https://pokoin.com')` — `None` mirrors the JS throw.
pub fn url_with_base(raw: &str) -> Option<Url> {
    Url::options()
        .base_url(Some(parse_base_url()))
        .parse(raw)
        .ok()
}

fn decode_query_component(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if bytes.len() >= index + 3 => {
                let hex = bytes
                    .get(index + 1..index + 3)
                    .and_then(|hex| std::str::from_utf8(hex).ok())
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                if let Some(byte) = hex {
                    out.push(byte);
                    index += 3;
                } else {
                    out.push(b'%');
                    index += 1;
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode_query_component(value: &str) -> String {
    // `URLSearchParams.toString` form-urlencoded encoding: space becomes '+'.
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn query_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (decode_query_component(key), decode_query_component(value)),
            None => (decode_query_component(part), String::new()),
        })
        .collect()
}

/// `safePageUrl`.
pub fn safe_page_url(value: &Value) -> String {
    let raw = clean_text(value, 500);
    if raw.is_empty() || raw.contains('\r') || raw.contains('\n') {
        return String::new();
    }
    let Some(mut url) = url_with_base(&raw) else {
        return String::new();
    };
    let host = url.host_str().unwrap_or_default().to_lowercase();
    let scheme_ok = url.scheme() == "https" || url.scheme() == "http";
    if !scheme_ok || (host != "pokoin.com" && host != "www.pokoin.com") {
        return String::new();
    }
    // `url.searchParams.delete(key)` for sensitive keys, preserving the rest.
    if let Some(query) = url.query() {
        let kept: Vec<(String, String)> = query_pairs(query)
            .into_iter()
            .filter(|(key, _)| !is_sensitive_context_key(key))
            .collect();
        let rebuilt = kept
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}={}",
                    encode_query_component(key),
                    encode_query_component(value)
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        url.set_query(if rebuilt.is_empty() {
            None
        } else {
            Some(&rebuilt)
        });
    }
    url.to_string()
}

/// `cleanInternalPath`.
pub fn clean_internal_path(value: &Value) -> String {
    let raw = clean_text(value, 500);
    if raw.is_empty() || raw.contains('\r') || raw.contains('\n') {
        return String::new();
    }
    if !raw.starts_with('/') || raw.starts_with("//") || raw.contains('\\') {
        return String::new();
    }
    raw
}

fn or_of(left: &Value, right: &Value) -> Value {
    if js_truthy(left) {
        left.clone()
    } else {
        right.clone()
    }
}

fn nullish_of(left: &Value, right: &Value) -> Value {
    if left.is_null() {
        right.clone()
    } else {
        left.clone()
    }
}

fn js_truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
        && !matches!(value, Value::String(text) if text.is_empty())
        && !matches!(value, Value::Number(number) if number.as_f64() == Some(0.0))
}

fn js_number_of(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => pokoin_api_common::http::js_number(text).unwrap_or(f64::NAN),
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

fn get_or_null(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn map_get_or_null(map: &Map<String, Value>, key: &str) -> Value {
    map.get(key).cloned().unwrap_or(Value::Null)
}

/// `cleanCardContext`.
pub fn clean_card_context(value: &Value) -> Map<String, Value> {
    let mut context = Map::new();
    if !value.is_object() {
        return context;
    }
    // `Number(value.pricePkn ?? value.price_pkn ?? value.price ?? 0)`
    let price_raw = nullish_of(
        &nullish_of(
            &get_or_null(value, "pricePkn"),
            &get_or_null(value, "price_pkn"),
        ),
        &nullish_of(&get_or_null(value, "price"), &json!(0)),
    );
    let stock_raw = nullish_of(
        &nullish_of(
            &get_or_null(value, "stock"),
            &get_or_null(value, "quantity"),
        ),
        &json!(0),
    );
    let price_pkn = js_number_of(&price_raw);
    let stock = js_number_of(&stock_raw);
    context.insert(
        "cardId".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "id"),
                &or_of(
                    &get_or_null(value, "cardId"),
                    &get_or_null(value, "blueprintId")
                )
            ),
            80
        )),
    );
    context.insert(
        "name".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "name"),
                &or_of(
                    &get_or_null(value, "cardTitle"),
                    &get_or_null(value, "cardName")
                )
            ),
            180
        )),
    );
    context.insert(
        "setName".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "set"),
                &or_of(
                    &get_or_null(value, "setName"),
                    &get_or_null(value, "cardSet")
                )
            ),
            180
        )),
    );
    context.insert(
        "collectorNumber".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "number"),
                &or_of(
                    &get_or_null(value, "collectorNumber"),
                    &get_or_null(value, "cardNumber")
                )
            ),
            80
        )),
    );
    context.insert(
        "rarity".into(),
        json!(clean_text(&get_or_null(value, "rarity"), 100)),
    );
    context.insert(
        "artist".into(),
        json!(clean_text(&get_or_null(value, "artist"), 180)),
    );
    context.insert(
        "condition".into(),
        json!(clean_text(&get_or_null(value, "condition"), 80)),
    );
    context.insert(
        "pricePkn".into(),
        if price_pkn.is_finite() && price_pkn > 0.0 {
            json!(price_pkn)
        } else {
            Value::Null
        },
    );
    context.insert(
        "stock".into(),
        if stock.is_finite() && stock > 0.0 {
            json!(stock)
        } else {
            Value::Null
        },
    );
    context.insert(
        "canonicalPath".into(),
        json!(clean_internal_path(&or_of(
            &get_or_null(value, "canonicalPath"),
            &get_or_null(value, "path")
        ))),
    );
    context
}

/// `cleanArtistContext`.
pub fn clean_artist_context(value: &Value) -> Map<String, Value> {
    let mut context = Map::new();
    if !value.is_object() {
        return context;
    }
    context.insert(
        "slug".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "slug"),
                &get_or_null(value, "artistSlug")
            ),
            120
        )),
    );
    context.insert(
        "name".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "name"),
                &or_of(
                    &get_or_null(value, "artistName"),
                    &get_or_null(value, "artist")
                )
            ),
            180
        )),
    );
    context
}

/// `cleanVisibleCards`: first 5 entries with a cardId or name.
pub fn clean_visible_cards(value: &Value) -> Vec<Map<String, Value>> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .take(5)
        .map(clean_card_context)
        .filter(|card| {
            let id = card.get("cardId").and_then(Value::as_str).unwrap_or("");
            let name = card.get("name").and_then(Value::as_str).unwrap_or("");
            !id.is_empty() || !name.is_empty()
        })
        .collect()
}

/// `cleanPageContext`. Every base key is present (possibly `''`), exactly like
/// the JS object literal; optional blocks are appended when non-empty.
pub fn clean_page_context(value: &Value) -> Map<String, Value> {
    let mut context = Map::new();
    if !value.is_object() {
        return context;
    }

    context.insert(
        "url".into(),
        json!(safe_page_url(&get_or_null(value, "url"))),
    );
    context.insert(
        "internalUri".into(),
        json!(clean_internal_path(&or_of(
            &get_or_null(value, "internalUri"),
            &or_of(
                &get_or_null(value, "internal_uri"),
                &get_or_null(value, "path")
            )
        ))),
    );
    context.insert(
        "path".into(),
        json!(clean_internal_path(&get_or_null(value, "path"))),
    );
    context.insert(
        "kind".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "kind"),
                &or_of(
                    &get_or_null(value, "pageKind"),
                    &get_or_null(value, "page_kind")
                )
            ),
            80
        )),
    );
    context.insert(
        "title".into(),
        json!(clean_text(&get_or_null(value, "title"), 180)),
    );
    context.insert(
        "searchQuery".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "searchQuery"),
                &or_of(
                    &get_or_null(value, "search_query"),
                    &get_or_null(value, "query")
                )
            ),
            160
        )),
    );
    context.insert(
        "filters".into(),
        Value::Object(clean_object(&get_or_null(value, "filters"), 12, 60, 160)),
    );
    context.insert(
        "queryParameters".into(),
        Value::Object(clean_object(
            &or_of(
                &get_or_null(value, "queryParameters"),
                &or_of(
                    &get_or_null(value, "query"),
                    &get_or_null(value, "query_parameters"),
                ),
            ),
            12,
            60,
            240,
        )),
    );
    context.insert(
        "cardId".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "cardId"),
                &get_or_null(value, "blueprintId")
            ),
            80
        )),
    );
    context.insert(
        "cardTitle".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "cardTitle"),
                &get_or_null(value, "cardName")
            ),
            180
        )),
    );
    context.insert(
        "cardSet".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "cardSet"),
                &or_of(&get_or_null(value, "setName"), &get_or_null(value, "set"))
            ),
            180
        )),
    );
    context.insert(
        "cardNumber".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "cardNumber"),
                &or_of(
                    &get_or_null(value, "collectorNumber"),
                    &get_or_null(value, "number")
                )
            ),
            80
        )),
    );
    context.insert(
        "canonicalPath".into(),
        json!(clean_internal_path(&or_of(
            &get_or_null(value, "canonicalPath"),
            &get_or_null(value, "path")
        ))),
    );
    context.insert(
        "artistSlug".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(value, "artistSlug"),
                &get_or_null(value, "artist_slug")
            ),
            120
        )),
    );
    let artist_name_value = or_of(
        &get_or_null(value, "artistName"),
        &get_or_null(value, "artist")
            .as_object()
            .and_then(|artist| artist.get("name").cloned())
            .unwrap_or(Value::Null),
    );
    context.insert(
        "artistName".into(),
        json!(clean_text(&artist_name_value, 180)),
    );

    let active_card = clean_card_context(&or_of(
        &get_or_null(value, "activeCard"),
        &get_or_null(value, "card"),
    ));
    let active_id = active_card
        .get("cardId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let active_name = active_card
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !active_id.is_empty() || !active_name.is_empty() {
        context.insert("activeCard".into(), Value::Object(active_card.clone()));
        set_if_empty(&mut context, "cardId", active_id);
        set_if_empty(&mut context, "cardTitle", active_name);
        set_if_empty(
            &mut context,
            "cardSet",
            active_card
                .get("setName")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        set_if_empty(
            &mut context,
            "cardNumber",
            active_card
                .get("collectorNumber")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        set_if_empty(
            &mut context,
            "canonicalPath",
            active_card
                .get("canonicalPath")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
    }
    let artist_context = clean_artist_context(&get_or_null(value, "artist"));
    let artist_slug = artist_context
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or("");
    let artist_name = artist_context
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !artist_slug.is_empty() || !artist_name.is_empty() {
        context.insert("artist".into(), Value::Object(artist_context.clone()));
        set_if_empty(&mut context, "artistSlug", artist_slug);
        set_if_empty(&mut context, "artistName", artist_name);
    }
    let visible = clean_visible_cards(&or_of(
        &get_or_null(value, "visibleCards"),
        &or_of(&get_or_null(value, "cards"), &get_or_null(value, "results")),
    ));
    if !visible.is_empty() {
        context.insert(
            "visibleCards".into(),
            Value::Array(visible.iter().cloned().map(Value::Object).collect()),
        );
        let reported = js_number_of(&or_of(
            &get_or_null(value, "visibleCardCount"),
            &get_or_null(value, "resultCount"),
        ));
        // `Number(x) || visibleCards.length`
        let reported = if reported.is_finite() && reported != 0.0 {
            reported
        } else {
            visible.len() as f64
        };
        let count = (visible.len() as f64).max(reported.min(1000.0));
        context.insert("visibleCardCount".into(), json!(count));
    }
    context
}

fn set_if_empty(context: &mut Map<String, Value>, key: &str, value: &str) {
    let current = context.get(key).and_then(Value::as_str).unwrap_or("");
    if current.is_empty() && !value.is_empty() {
        context.insert(key.into(), json!(value));
    }
}

fn context_text(context: &Map<String, Value>, key: &str) -> String {
    context
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// `pageUrlFromContext`.
pub fn page_url_from_context(page: &Value, page_context: &Map<String, Value>) -> String {
    let url = map_get_or_null(page_context, "url");
    let internal_uri = map_get_or_null(page_context, "internalUri");
    let chosen = if js_truthy(&url) {
        url
    } else if js_truthy(&internal_uri) {
        internal_uri
    } else {
        page.clone()
    };
    clean_text(&chosen, 500)
}

/// `pageCardContext`.
pub fn page_card_context(page: &Value, page_context: &Map<String, Value>) -> Map<String, Value> {
    let context_value = Value::Object(page_context.clone());
    let active_card = map_get_or_null(page_context, "activeCard");
    let empty = clean_card_context(&Value::Null);
    let active_card = if active_card.is_object() {
        active_card
    } else {
        Value::Object(empty.clone())
    };
    let build =
        |card_id: &str, set_name: String, collector_number: String, canonical_path: String| {
            let mut context = Map::new();
            context.insert("cardId".into(), json!(card_id));
            context.insert(
                "title".into(),
                json!(clean_text(
                    &or_of(
                        &or_of(
                            &get_or_null(&context_value, "cardTitle"),
                            &get_or_null(&active_card, "name")
                        ),
                        &get_or_null(&context_value, "title")
                    ),
                    180
                )),
            );
            context.insert("setName".into(), json!(set_name));
            context.insert("collectorNumber".into(), json!(collector_number));
            context.insert("canonicalPath".into(), json!(canonical_path));
            context
        };
    let context_value = Value::Object(page_context.clone());
    let explicit_card_id = clean_text(
        &or_of(
            &get_or_null(&context_value, "cardId"),
            &get_or_null(&active_card, "cardId"),
        ),
        80,
    );
    if !explicit_card_id.is_empty() && explicit_card_id.bytes().all(|b| b.is_ascii_digit()) {
        return build(
            &explicit_card_id,
            clean_text(
                &or_of(
                    &get_or_null(&context_value, "cardSet"),
                    &get_or_null(&active_card, "setName"),
                ),
                180,
            ),
            clean_text(
                &or_of(
                    &get_or_null(&context_value, "cardNumber"),
                    &get_or_null(&active_card, "collectorNumber"),
                ),
                80,
            ),
            clean_internal_path(&or_of(
                &get_or_null(&context_value, "canonicalPath"),
                &get_or_null(&active_card, "canonicalPath"),
            )),
        );
    }
    let raw = or_of(
        &json!(page_url_from_context(page, page_context)),
        &get_or_null(&context_value, "path"),
    );
    let raw = clean_text(&raw, 500);
    let fallback_title = clean_text(&get_or_null(&context_value, "title"), 180);
    let Some(url) = url_with_base(&raw) else {
        return build("", fallback_title, String::new(), String::new());
    };
    let pathname = url.path();
    static MARKETPLACE: OnceLock<Regex> = OnceLock::new();
    let marketplace = MARKETPLACE.get_or_init(|| {
        Regex::new(r"(?i)/marketplace/[a-z]{2}/cards/([0-9]+)(?:/|$)").expect("static regex")
    });
    if let Some(captures) = marketplace.captures(pathname) {
        let card_id = captures.get(1).map(|part| part.as_str()).unwrap_or("");
        return build(
            card_id,
            String::new(),
            String::new(),
            clean_internal_path(&json!(pathname)),
        );
    }
    static ROOT: OnceLock<Regex> = OnceLock::new();
    let root = ROOT.get_or_init(|| Regex::new("^/([0-9]+)(?:/|$)").expect("static regex"));
    if let Some(captures) = root.captures(pathname) {
        let card_id = captures.get(1).map(|part| part.as_str()).unwrap_or("");
        return build(
            card_id,
            String::new(),
            String::new(),
            clean_internal_path(&json!(pathname)),
        );
    }
    build("", fallback_title, String::new(), String::new())
}

/// `enrichedPageCardContext`.
pub fn enriched_page_card_context(
    page: &Value,
    page_context: &Map<String, Value>,
) -> Map<String, Value> {
    let current_card = page_card_context(page, page_context);
    let current_card_value = Value::Object(current_card.clone());
    let context_value = Value::Object(page_context.clone());
    let active_card = get_or_null(&context_value, "activeCard");
    let active = if active_card.is_object() {
        active_card
    } else {
        Value::Object(Map::new())
    };
    let mut context = Map::new();
    context.insert(
        "cardId".into(),
        json!(context_text(&current_card, "cardId")),
    );
    context.insert(
        "title".into(),
        json!(clean_text(
            &or_of(
                &or_of(
                    &get_or_null(&current_card_value, "title"),
                    &get_or_null(&active, "name")
                ),
                &get_or_null(&context_value, "cardTitle")
            ),
            180
        )),
    );
    context.insert(
        "setName".into(),
        json!(clean_text(
            &or_of(
                &or_of(
                    &get_or_null(&current_card_value, "setName"),
                    &get_or_null(&active, "setName")
                ),
                &get_or_null(&context_value, "cardSet")
            ),
            180
        )),
    );
    context.insert(
        "collectorNumber".into(),
        json!(clean_text(
            &or_of(
                &or_of(
                    &get_or_null(&current_card_value, "collectorNumber"),
                    &get_or_null(&active, "collectorNumber")
                ),
                &get_or_null(&context_value, "cardNumber")
            ),
            80
        )),
    );
    context.insert(
        "rarity".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(&active, "rarity"),
                &get_or_null(&context_value, "rarity")
            ),
            100
        )),
    );
    context.insert(
        "artist".into(),
        json!(clean_text(
            &or_of(
                &get_or_null(&active, "artist"),
                &get_or_null(&context_value, "artistName")
            ),
            180
        )),
    );
    context.insert(
        "condition".into(),
        json!(clean_text(&get_or_null(&active, "condition"), 80)),
    );
    let price = js_number_of(&get_or_null(&active, "pricePkn"));
    context.insert(
        "pricePkn".into(),
        if price > 0.0 {
            json!(price)
        } else {
            Value::Null
        },
    );
    let stock = js_number_of(&get_or_null(&active, "stock"));
    context.insert(
        "stock".into(),
        if stock > 0.0 {
            json!(stock)
        } else {
            Value::Null
        },
    );
    context.insert(
        "canonicalPath".into(),
        json!(clean_internal_path(&or_of(
            &get_or_null(&current_card_value, "canonicalPath"),
            &get_or_null(&active, "canonicalPath")
        ))),
    );
    context
}

/// `pageContextForPrompt`.
pub fn page_context_for_prompt(page_context: &Map<String, Value>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let text = |key: &str| map_get_or_null(page_context, key);
    let mut add = |label: &str, value: Value| {
        let line = clean_text(&value, 500);
        if !line.is_empty() {
            lines.push(format!("{label}: {line}"));
        }
    };
    add("Current page kind", text("kind"));
    add(
        "Current internal URI",
        or_of(&text("internalUri"), &text("path")),
    );
    add("Current page title", text("title"));
    add("Current search query", text("searchQuery"));
    let filters = text("filters");
    if filters.as_object().is_some_and(|map| !map.is_empty()) {
        add("Current filters", Value::String(filters.to_string()));
    }
    let active_card = text("activeCard");
    if active_card.is_object() {
        add("Active card", Value::String(active_card.to_string()));
    }
    let artist = text("artist");
    if artist.is_object() {
        add("Artist page", Value::String(artist.to_string()));
    }
    let visible = text("visibleCards");
    if visible.as_array().is_some_and(|items| !items.is_empty()) {
        add("Visible cards", Value::String(visible.to_string()));
    }
    lines.join("\n")
}

/// `cardSearchPath`.
pub fn card_search_path(query: &str) -> String {
    format!("/marketplace/search?q={}", form_encode(query.trim()))
}

/// JS `encodeURIComponent` (RFC 3926 URI reserved set, space becomes %20).
pub fn form_encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn form_encode(value: &str) -> String {
    form_encode_component(value)
}

/// `marketplaceCardPath` for a raw row object (`row.card_id`, `row.card_name`,
/// ...): `/marketplace/{language}/cards/{id}/{slug}`.
pub fn marketplace_card_path(row: &Map<String, Value>, language: &str) -> String {
    let text = |key: &str| row.get(key).map(js_row_string).unwrap_or_default();
    let public_id = text("card_id");
    let clean_language = {
        let part = crate::assistant::text::slug_part(language);
        if part.is_empty() {
            "en".to_owned()
        } else {
            part
        }
    };
    let parts = [
        js_or(&text("rarity"), "Card"),
        js_or(&text("card_name"), &text("name")),
        js_or(&text("collector_number"), &text("card_number")),
        text("set_name"),
    ];
    let slug_value = parts
        .iter()
        .map(|part| crate::assistant::text::slug_part(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let digits = !public_id.is_empty() && public_id.bytes().all(|b| b.is_ascii_digit());
    if digits && !slug_value.is_empty() {
        format!("/marketplace/{clean_language}/cards/{public_id}/{slug_value}")
    } else {
        String::new()
    }
}

/// `String(row.field || '')` for row fields that may be numbers.
fn js_row_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn js_or(left: &str, right: &str) -> String {
    if left.is_empty() {
        right.to_owned()
    } else {
        left.to_owned()
    }
}

/// `marketplaceLanguageFromPage`.
pub fn marketplace_language_from_page(page: &str) -> String {
    let url = match Url::parse(if page.is_empty() {
        "https://pokoin.com/marketplace/en"
    } else {
        page
    }) {
        Ok(url) => url,
        Err(_) => return "en".to_owned(),
    };
    static RE: OnceLock<Regex> = OnceLock::new();
    let re =
        RE.get_or_init(|| Regex::new(r"(?i)/marketplace/([a-z]{2})(?:/|$)").expect("static regex"));
    re.captures(url.path())
        .and_then(|captures| captures.get(1))
        .map(|part| part.as_str().to_lowercase())
        .unwrap_or_else(|| "en".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_page_url_allows_only_pokoin_hosts() {
        assert_eq!(
            safe_page_url(&json!("https://pokoin.com/marketplace/en?a=1")),
            "https://pokoin.com/marketplace/en?a=1"
        );
        assert_eq!(safe_page_url(&json!("https://evil.com/x")), "");
        assert_eq!(safe_page_url(&json!("javascript:alert(1)")), "");
        assert_eq!(
            safe_page_url(&json!("/marketplace/en/cards/1/x?token=abc&ok=1")),
            "https://pokoin.com/marketplace/en/cards/1/x?ok=1"
        );
        assert_eq!(
            safe_page_url(&json!("https://pokoin.com/x?state=zzz")),
            "https://pokoin.com/x"
        );
        // WHATWG parsing keeps junk paths on the base host.
        assert_eq!(
            safe_page_url(&json!("bad url\r\n")),
            "https://pokoin.com/bad%20url"
        );
    }

    #[test]
    fn internal_paths_are_strict() {
        assert_eq!(
            clean_internal_path(&json!("/marketplace/en")),
            "/marketplace/en"
        );
        assert_eq!(clean_internal_path(&json!("//evil.com")), "");
        assert_eq!(clean_internal_path(&json!("marketplace/en")), "");
        assert_eq!(clean_internal_path(&json!("/a\\b")), "");
    }

    #[test]
    fn clean_page_context_key_order_and_fallbacks() {
        let context = clean_page_context(&json!({
            "url": "https://pokoin.com/marketplace/it/cards/248856/charizard",
            "kind": "card-desk",
            "title": "Charizard",
            "activeCard": {"id": "248856", "name": "Charizard", "set": "Base Set", "price": 12.5},
            "filters": {"rarity": "Rare"},
            "queryParameters": {"q": "charizard", "state": "dropped"}
        }));
        let keys: Vec<&str> = context.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "url",
                "internalUri",
                "path",
                "kind",
                "title",
                "searchQuery",
                "filters",
                "queryParameters",
                "cardId",
                "cardTitle",
                "cardSet",
                "cardNumber",
                "canonicalPath",
                "artistSlug",
                "artistName",
                "activeCard"
            ]
        );
        assert_eq!(context["cardId"], json!("248856"));
        assert_eq!(context["cardTitle"], json!("Charizard"));
        assert_eq!(context["cardSet"], json!("Base Set"));
        assert_eq!(context["activeCard"]["pricePkn"], json!(12.5));
        assert_eq!(context["queryParameters"]["q"], json!("charizard"));
        assert!(context["queryParameters"].get("state").is_none());
        assert_eq!(context["path"], json!(""));
        assert_eq!(context.get("visibleCardCount"), None);
    }

    #[test]
    fn empty_page_context_is_empty_object() {
        assert_eq!(clean_page_context(&Value::Null), Map::new());
        assert_eq!(clean_page_context(&json!("nope")), Map::new());
    }

    #[test]
    fn card_context_price_uses_nullish_chain() {
        // `pricePkn ?? price_pkn ?? price ?? 0`: 0 is NOT nullish.
        let context = clean_card_context(&json!({"pricePkn": 0, "price": 5, "stock": 2}));
        assert_eq!(context["pricePkn"], Value::Null);
        assert_eq!(context["stock"], json!(2.0));
    }

    #[test]
    fn visible_cards_are_limited_to_five() {
        let items: Vec<Value> = (0..8)
            .map(|index| json!({"id": format!("{index}"), "name": format!("Card {index}")}))
            .collect();
        let cards = clean_visible_cards(&Value::Array(items));
        assert_eq!(cards.len(), 5);
        assert_eq!(cards[0]["cardId"], json!("0"));
    }

    #[test]
    fn language_from_page() {
        assert_eq!(
            marketplace_language_from_page("https://pokoin.com/marketplace/it/x"),
            "it"
        );
        assert_eq!(
            marketplace_language_from_page("https://pokoin.com/marketplace/EN/cards/1/y"),
            "en"
        );
        assert_eq!(marketplace_language_from_page(""), "en");
        assert_eq!(
            marketplace_language_from_page("https://pokoin.com/docs"),
            "en"
        );
        assert_eq!(marketplace_language_from_page("not a url"), "en");
        assert_eq!(marketplace_language_from_page("/marketplace/it"), "en");
    }

    #[test]
    fn page_card_context_from_url() {
        let context = clean_page_context(&json!({"title": "Desk"}));
        let card = page_card_context(
            &json!("https://pokoin.com/marketplace/it/cards/248856/charizard"),
            &context,
        );
        assert_eq!(card["cardId"], json!("248856"));
        assert_eq!(card["title"], json!("Desk"));
        let root = page_card_context(&json!("/248856/slug"), &context);
        assert_eq!(root["cardId"], json!("248856"));
        let none = page_card_context(&json!("https://pokoin.com/docs"), &context);
        assert_eq!(none["cardId"], json!(""));
        assert_eq!(none["title"], json!("Desk"));
    }

    #[test]
    fn prompt_lines() {
        let context = clean_page_context(&json!({
            "kind": "card-desk",
            "internalUri": "/marketplace/en/cards/1/x",
            "filters": {"rarity": "rare"}
        }));
        let prompt = page_context_for_prompt(&context);
        assert!(prompt.contains("Current page kind: card-desk"));
        assert!(prompt.contains("Current internal URI: /marketplace/en/cards/1/x"));
        assert!(prompt.contains("Current filters: {\"rarity\":\"rare\"}"));
    }

    #[test]
    fn search_path_encoding() {
        assert_eq!(
            card_search_path(" charizard ex "),
            "/marketplace/search?q=charizard%20ex"
        );
        assert_eq!(
            card_search_path("mew & me"),
            "/marketplace/search?q=mew%20%26%20me"
        );
    }

    #[test]
    fn card_path_from_row() {
        let row = json!({
            "card_id": "248856",
            "card_name": "Charizard",
            "collector_number": "4/102",
            "set_name": "Base Set",
            "rarity": "Rare Holo"
        });
        let row = row.as_object().cloned().expect("object");
        assert_eq!(
            marketplace_card_path(&row, "en"),
            "/marketplace/en/cards/248856/rare-holo-charizard-4-102-base-set"
        );
        assert_eq!(
            marketplace_card_path(&row, "it"),
            "/marketplace/it/cards/248856/rare-holo-charizard-4-102-base-set"
        );
        let empty = Map::new();
        assert_eq!(marketplace_card_path(&empty, "en"), "");
    }

    #[test]
    fn query_pairs_decode() {
        assert_eq!(
            query_pairs("a=1&b=x+y&flag"),
            vec![
                ("a".to_owned(), "1".to_owned()),
                ("b".to_owned(), "x y".to_owned()),
                ("flag".to_owned(), String::new())
            ]
        );
        assert_eq!(encode_query_component("x y&z"), "x+y%26z");
    }
}
