//! Port of `_marketplace_row.js` — row normalization shared by every
//! marketplace card mapper.

use serde_json::{Map, Value};
use std::sync::OnceLock;

use super::js;

/// `hasCollectorNumber(value)`.
pub fn has_collector_number(value: Option<&Value>) -> bool {
    let text = js::string_or_empty(value).trim().to_lowercase();
    collector_re().is_match(&text)
}

/// `ctIdFromRow(row)` — the CardTrader id of a leftover row (`ct_id`, else
/// the halved public id).
pub fn ct_id_from_row(row: &Value) -> String {
    let ct = js::number(js::get(row, "ct_id").or_else(|| js::get(row, "ctId")));
    if js::is_safe_integer(ct) && ct > 0.0 {
        return super::js::number_to_string(ct);
    }
    let id = js::number(js::get(row, "card_id").or_else(|| js::get(row, "id")));
    if js::is_safe_integer(id) && id > 0.0 && id as i64 % 2 == 0 {
        return super::js::number_to_string(id / 2.0);
    }
    String::new()
}

/// `rewriteCdnKeyPrefix(url, fromId, toId)` — `(previews/)?{from}_` to
/// `(previews/)?{to}_` everywhere in the key.
pub fn rewrite_cdn_key_prefix(url: &str, from_id: &str, to_id: &str) -> String {
    let from = from_id.trim();
    let to = to_id.trim();
    if url.is_empty() || from.is_empty() || to.is_empty() || from == to {
        return url.to_string();
    }
    if !from.bytes().all(|b| b.is_ascii_digit()) || !to.bytes().all(|b| b.is_ascii_digit()) {
        return url.to_string();
    }
    let pattern = format!(r"(^|/)(previews/)?{from}_");
    let re = key_prefix_re(&pattern);
    re.replace_all(url, format!("${{1}}${{2}}{to}_"))
        .into_owned()
}

/// `rewriteCdnPokoinPrefix(url, row)` — prefixed multi-game keys stay raw
/// CardTrader ids; Pokemon leftover keys rewrite to the public card id.
pub fn rewrite_cdn_pokoin_prefix(url: Option<&Value>, row: &Value) -> String {
    let source = js::string_or_empty(url);
    if multigame_re().is_match(&source) {
        return source;
    }
    let pokoin = js::string_or_empty(js::get(row, "card_id").or_else(|| js::get(row, "id")));
    let mut scoped = row.clone();
    if let Some(map) = scoped.as_object_mut() {
        // ctIdFromRow({ ...row, card_id: pokoin || row.card_id })
        if !pokoin.is_empty() {
            map.insert("card_id".to_string(), Value::String(pokoin.clone()));
        }
    }
    let ct = ct_id_from_row(&scoped);
    rewrite_cdn_key_prefix(&source, &ct, &pokoin)
}

/// The image keys `_marketplace_row.js` rewrites.
pub const IMAGE_KEYS: [&str; 7] = [
    "image_url",
    "cdn_image_url",
    "preview_image_url",
    "homepage_image_url",
    "imageUrl",
    "previewImageUrl",
    "homepageImageUrl",
];

/// `isFragilePreviewWebp(url)`.
pub fn is_fragile_preview_webp(url: &str) -> bool {
    fragile_preview_webp_re().is_match(url)
}

/// `isRasterCardImage(url)`.
pub fn is_raster_card_image(url: &str) -> bool {
    raster_re().is_match(url)
}

/// `preferDecodableTileImage(row)` — in place.
pub fn prefer_decodable_tile_image(row: &mut Map<String, Value>) {
    let view = Value::Object(row.clone());
    let image = js::string_chain(&[
        js::get(&view, "image_url"),
        js::get(&view, "cdn_image_url"),
        js::get(&view, "imageUrl"),
    ]);
    let preview = js::string_chain(&[
        js::get(&view, "preview_image_url"),
        js::get(&view, "previewImageUrl"),
    ]);
    if is_fragile_preview_webp(&preview) && is_raster_card_image(&image) {
        row.insert(
            "preview_image_url".to_string(),
            Value::String(image.clone()),
        );
        if !matches!(row.get("previewImageUrl"), None | Some(Value::Null)) {
            row.insert("previewImageUrl".to_string(), Value::String(image));
        }
    }
}

/// `isMarketAvailable(row)`.
pub fn is_market_available(row: &Value) -> bool {
    let stock = js::number_chain(&[
        js::get(row, "stock"),
        js::get(row, "listed_quantity"),
        js::get(row, "cardtraderListedQuantity"),
        js::get(row, "cardtrader_listed_quantity"),
    ]);
    let listing_count = js::number_chain(&[
        js::get(row, "cardtraderEligibleListingCount"),
        js::get(row, "cardtrader_eligible_listing_count"),
    ]);
    let has_trader = js::get(row, "hasCardTraderListing") == Some(&Value::Bool(true))
        || js::get(row, "has_cardtrader_listing") == Some(&Value::Bool(true))
        || js::get(row, "cardtrader_available") == Some(&Value::Bool(true))
        || (listing_count.is_finite() && listing_count > 0.0);
    (stock.is_finite() && stock > 0.0) || has_trader
}

/// `normalizeMarketplaceRow(row)`.
pub fn normalize_marketplace_row(row: &Value) -> Value {
    let mut normalized = row.as_object().cloned().unwrap_or_default();

    let collector_number = js::or(
        js::get(row, "card_number"),
        js::or(
            js::get(row, "expansion_number"),
            js::get(row, "version").unwrap_or(&Value::Null),
        ),
    )
    .clone();
    if has_collector_number(Some(&collector_number)) {
        normalized.insert("item_kind".to_string(), Value::String("single".into()));
        normalized.insert("product_type".to_string(), Value::String("card".into()));
    }

    let ct = ct_id_from_row(row);
    let ct_id_value = js::get(row, "ct_id");
    let ct_id_blank = match ct_id_value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    };
    if !ct.is_empty() && ct_id_blank {
        if let Ok(n) = ct.parse::<f64>() {
            normalized.insert("ct_id".to_string(), js::js_json_number(n));
        }
    }

    let view = Value::Object(normalized.clone());
    for key in IMAGE_KEYS {
        if js::truthy(js::get(&view, key)) {
            let rewritten = rewrite_cdn_pokoin_prefix(js::get(&view, key), &view);
            normalized.insert(key.to_string(), Value::String(rewritten));
        }
    }

    let available = is_market_available(&Value::Object(normalized.clone()));
    normalized.insert("isMarketAvailable".to_string(), Value::Bool(available));
    normalized.insert("inStock".to_string(), Value::Bool(available));

    prefer_decodable_tile_image(&mut normalized);
    Value::Object(normalized)
}

/// `normalizeMarketplaceRows(rows)`.
pub fn normalize_marketplace_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter().map(normalize_marketplace_row).collect()
}

fn collector_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(^|[^0-9])[0-9]{1,4}[a-z]?/[0-9]{1,4}([^0-9]|$)").expect("valid regex")
    })
}

fn multigame_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(?:^|/)(?:one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery|palworld|cyberpunk|weiss-schwarz|final-fantasy|force-of-will|world-of-warcraft|battle-spirits-saga|star-wars-destiny|dragon-born|my-little-pony|the-spoils)/",
        )
        .expect("valid regex")
    })
}

fn key_prefix_re(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).expect("valid regex")
}

fn fragile_preview_webp_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)/previews/[^?\s]+\.webp(?:\?|$)").expect("valid regex")
    })
}

fn raster_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)\.(?:jpe?g|png)(?:\?|$)").expect("valid regex"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collector_numbers_detect_n_over_m() {
        assert!(has_collector_number(Some(&json!(
            "Gold Secret Rare | 244/182"
        ))));
        assert!(has_collector_number(Some(&json!("119/214"))));
        assert!(has_collector_number(Some(&json!("001/102 1st"))));
        assert!(!has_collector_number(Some(&json!("140704"))));
        assert!(!has_collector_number(Some(&json!(""))));
        assert!(!has_collector_number(None));
        assert!(!has_collector_number(Some(&json!("12345/182"))));
        // 5-digit numerator does not match {1,4}.
    }

    #[test]
    fn ct_ids_fall_back_to_halved_public_ids() {
        assert_eq!(ct_id_from_row(&json!({"ct_id": 334063})), "334063");
        assert_eq!(ct_id_from_row(&json!({"card_id": 668126})), "334063");
        assert_eq!(ct_id_from_row(&json!({"card_id": 668125})), "");
        assert_eq!(ct_id_from_row(&json!({})), "");
        assert_eq!(ct_id_from_row(&json!({"ctId": 7, "card_id": 14})), "7");
    }

    #[test]
    fn key_prefixes_rewrite_every_occurrence() {
        assert_eq!(
            rewrite_cdn_key_prefix(
                "https://cdn.pokoin.com/334063_levincia.jpg",
                "334063",
                "668126"
            ),
            "https://cdn.pokoin.com/668126_levincia.jpg"
        );
        assert_eq!(
            rewrite_cdn_key_prefix(
                "https://cdn.pokoin.com/previews/334063_levincia.jpg",
                "334063",
                "668126"
            ),
            "https://cdn.pokoin.com/previews/668126_levincia.jpg"
        );
        assert_eq!(
            rewrite_cdn_key_prefix("https://x/334063_a.jpg", "334063", "334063"),
            "https://x/334063_a.jpg"
        );
        assert_eq!(
            rewrite_cdn_key_prefix("https://x/a.jpg", "", "5"),
            "https://x/a.jpg"
        );
        assert_eq!(
            rewrite_cdn_key_prefix("https://x/334063_a.jpg", "abc", "5"),
            "https://x/334063_a.jpg"
        );
        assert_eq!(
            rewrite_cdn_key_prefix("https://x/1334063_a.jpg", "334063", "1"),
            "https://x/1334063_a.jpg"
        );
    }

    #[test]
    fn pokemon_keys_rewrite_but_multigame_keys_stay() {
        let row = json!({"card_id": 668126, "ct_id": 334063});
        assert_eq!(
            rewrite_cdn_pokoin_prefix(
                Some(&json!("https://cdn.pokoin.com/334063_levincia.jpg")),
                &row
            ),
            "https://cdn.pokoin.com/668126_levincia.jpg"
        );
        assert_eq!(
            rewrite_cdn_pokoin_prefix(
                Some(&json!(
                    "https://cdn.pokoin.com/previews/334063_levincia.jpg"
                )),
                &row
            ),
            "https://cdn.pokoin.com/previews/668126_levincia.jpg"
        );
        assert_eq!(
            rewrite_cdn_pokoin_prefix(
                Some(&json!("magic/12344_fire.jpg")),
                &json!({"card_id": 24688})
            ),
            "magic/12344_fire.jpg"
        );
        assert_eq!(
            rewrite_cdn_pokoin_prefix(Some(&json!("one-piece/99_luffy.jpg")), &json!({})),
            "one-piece/99_luffy.jpg"
        );
    }

    #[test]
    fn market_availability_follows_stock_or_trader_flags() {
        assert!(is_market_available(&json!({"stock": 3})));
        assert!(is_market_available(&json!({"listed_quantity": 1})));
        assert!(is_market_available(
            &json!({"has_cardtrader_listing": true})
        ));
        assert!(is_market_available(
            &json!({"cardtrader_eligible_listing_count": 2})
        ));
        assert!(!is_market_available(&json!({"stock": 0})));
        assert!(!is_market_available(
            &json!({"has_cardtrader_listing": false})
        ));
        assert!(!is_market_available(&json!({})));
        assert!(is_market_available(
            &json!({"stock": 0, "cardtrader_available": true})
        ));
    }

    #[test]
    fn normalize_stamps_singles_and_availability() {
        let row = json!({
            "card_id": 668126,
            "ct_id": 334063,
            "name": "Levincia",
            "card_number": "Gold Secret Rare | 244/182",
            "item_kind": "product",
            "image_url": "https://cdn.pokoin.com/334063_levincia.jpg",
            "preview_image_url": "https://cdn.pokoin.com/previews/334063_levincia.webp",
        });
        let normalized = normalize_marketplace_row(&row);
        assert_eq!(normalized["item_kind"], json!("single"));
        assert_eq!(normalized["product_type"], json!("card"));
        assert_eq!(
            normalized["image_url"],
            json!("https://cdn.pokoin.com/668126_levincia.jpg")
        );
        // preferDecodableTileImage swaps the fragile preview webp to the raster.
        assert_eq!(
            normalized["preview_image_url"],
            json!("https://cdn.pokoin.com/668126_levincia.jpg")
        );
        assert_eq!(normalized["isMarketAvailable"], json!(false));
        assert_eq!(normalized["inStock"], json!(false));
    }

    #[test]
    fn normalize_backfills_missing_ct_id() {
        let row = json!({"card_id": 668126, "name": "Levincia"});
        let normalized = normalize_marketplace_row(&row);
        assert_eq!(normalized["ct_id"], json!(334063));
        let present = normalize_marketplace_row(&json!({"card_id": 668126, "ct_id": null}));
        assert_eq!(present["ct_id"], json!(334063));
        let kept = normalize_marketplace_row(&json!({"card_id": 668126, "ct_id": 5}));
        assert_eq!(kept["ct_id"], json!(5));
    }

    #[test]
    fn fragile_previews_swap_to_raster() {
        let mut row = Map::new();
        row.insert(
            "image_url".into(),
            json!("https://cdn.pokoin.com/5_card.jpg"),
        );
        row.insert(
            "preview_image_url".into(),
            json!("https://cdn.pokoin.com/previews/5_card.webp"),
        );
        row.insert(
            "previewImageUrl".into(),
            json!("https://cdn.pokoin.com/previews/5_card.webp"),
        );
        prefer_decodable_tile_image(&mut row);
        assert_eq!(
            row["preview_image_url"],
            json!("https://cdn.pokoin.com/5_card.jpg")
        );
        assert_eq!(
            row["previewImageUrl"],
            json!("https://cdn.pokoin.com/5_card.jpg")
        );

        let mut row = Map::new();
        row.insert(
            "image_url".into(),
            json!("https://cdn.pokoin.com/5_card.webp"),
        );
        row.insert(
            "preview_image_url".into(),
            json!("https://cdn.pokoin.com/previews/5_card.webp"),
        );
        prefer_decodable_tile_image(&mut row);
        assert_eq!(
            row["preview_image_url"],
            json!("https://cdn.pokoin.com/previews/5_card.webp")
        );
    }
}
