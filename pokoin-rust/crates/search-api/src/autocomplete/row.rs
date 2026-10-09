//! Row shaping of `_marketplace_row.js`, `_marketplace_canonical_path.js`,
//! `_marketplace_card_emoji.js` and the `vt` theme packs of
//! `_marketplace_react_sql.js` / `_card_visual_theme.js`.
//!
//! Rows are `serde_json::Value` objects so the SQL column names pass through
//! exactly like the Node handler passing pg rows around.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

use super::normalize::{js_num_or, js_str_or};

pub fn get<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    match row {
        Value::Object(map) => match map.get(key) {
            Some(Value::Null) | None => None,
            Some(value) => Some(value),
        },
        _ => None,
    }
}

/// First present (non-null) key, JS `row.a ?? row.b`.
pub fn get_any<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| get(row, key))
}

/// `String(row[key] || '')` for the first key with a truthy value.
pub fn str_field(row: &Value, keys: &[&str]) -> String {
    js_str_or(get_any(row, keys))
}

/// `Number(row[key] || 0)` for the first key with a truthy value.
pub fn num_field(row: &Value, keys: &[&str]) -> f64 {
    js_num_or(get_any(row, keys), 0.0)
}

static COLLECTOR_ANY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^0-9])[0-9]{1,4}[a-z]?/[0-9]{1,4}([^0-9]|$)").unwrap());

/// `hasCollectorNumber(value)` of `_marketplace_row.js`.
pub fn has_collector_number(value: &str) -> bool {
    COLLECTOR_ANY.is_match(&value.trim().to_lowercase())
}

fn safe_positive(value: f64) -> Option<f64> {
    if value.is_finite() && value.fract() == 0.0 && value > 0.0 && value <= 9_007_199_254_740_991.0
    {
        Some(value)
    } else {
        None
    }
}

/// `ctIdFromRow(row)` — the CardTrader id, or the even public id halved.
pub fn ct_id_from_row(row: &Value) -> String {
    let ct = safe_positive(num_field(row, &["ct_id", "ctId"]));
    if let Some(ct) = ct {
        return format_number(ct);
    }
    let id = safe_positive(num_field(row, &["card_id", "id"]));
    if let Some(id) = id.filter(|id| *id as i64 % 2 == 0) {
        return format_number(id / 2.0);
    }
    String::new()
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

static NON_POKEMON_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|/)(?:one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery|palworld|cyberpunk|weiss-schwarz|final-fantasy|force-of-will|world-of-warcraft|battle-spirits-saga|star-wars-destiny|dragon-born|my-little-pony|the-spoils)/")
        .unwrap()
});

/// `rewriteCdnKeyPrefix(url, fromId, toId)`.
pub fn rewrite_cdn_key_prefix(url: &str, from_id: &str, to_id: &str) -> String {
    let from = from_id.trim();
    let to = to_id.trim();
    if url.is_empty() || from.is_empty() || to.is_empty() || from == to {
        return url.to_owned();
    }
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    if !digits(from) || !digits(to) {
        return url.to_owned();
    }
    // `(^|/)(previews/)?${from}_` -> `$1$2${to}_`
    let needle = format!("{from}_");
    let mut out = String::new();
    let bytes: Vec<char> = url.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        let rest: String = bytes[index..].iter().collect();
        let boundary = index == 0 || bytes[index - 1] == '/';
        let previews = rest.starts_with("previews/");
        if boundary {
            let body_start = if previews { 9 } else { 0 };
            if rest[body_start..].starts_with(&needle) {
                out.push_str(&rest[..body_start]);
                out.push_str(to);
                out.push('_');
                index += body_start + needle.chars().count();
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    out
}

/// `rewriteCdnPokoinPrefix(url, row)` — Pokemon keys become public card ids;
/// prefixed multi-game keys stay raw CardTrader ids.
pub fn rewrite_cdn_pokoin_prefix(url: &str, row: &Value) -> String {
    if NON_POKEMON_PREFIX.is_match(url) {
        return url.to_owned();
    }
    let pokoin = str_field(row, &["card_id", "id"]);
    let mut lookup = row.clone();
    if let Value::Object(map) = &mut lookup {
        if !pokoin.is_empty() {
            map.insert("card_id".into(), Value::String(pokoin.clone()));
        }
    }
    let ct = ct_id_from_row(&lookup);
    rewrite_cdn_key_prefix(url, &ct, &pokoin)
}

const IMAGE_KEYS: [&str; 7] = [
    "image_url",
    "cdn_image_url",
    "preview_image_url",
    "homepage_image_url",
    "imageUrl",
    "previewImageUrl",
    "homepageImageUrl",
];

fn is_fragile_preview_webp(url: &str) -> bool {
    PREVIEW_WEBP.is_match(url)
}

static PREVIEW_WEBP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)/previews/[^?\s]+\.webp(?:\?|$)").unwrap());

fn is_raster_card_image(url: &str) -> bool {
    RASTER.is_match(url)
}

static RASTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(?:jpe?g|png)(?:\?|$)").unwrap());

/// `preferDecodableTileImage(row)` — swap a fragile `.webp` preview for the
/// raster image.
pub fn prefer_decodable_tile_image(row: &mut Value) {
    let image = str_field(row, &["image_url", "cdn_image_url", "imageUrl"]);
    let preview = str_field(row, &["preview_image_url", "previewImageUrl"]);
    if is_fragile_preview_webp(&preview) && is_raster_card_image(&image) {
        if let Value::Object(map) = row {
            map.insert("preview_image_url".into(), Value::String(image.clone()));
            if map.contains_key("previewImageUrl") {
                map.insert("previewImageUrl".into(), Value::String(image));
            }
        }
    }
}

/// `isMarketAvailable(row)`.
pub fn is_market_available(row: &Value) -> bool {
    let stock = num_field(
        row,
        &[
            "stock",
            "listed_quantity",
            "cardtraderListedQuantity",
            "cardtrader_listed_quantity",
        ],
    );
    let listing_count = num_field(
        row,
        &[
            "cardtraderEligibleListingCount",
            "cardtrader_eligible_listing_count",
        ],
    );
    let has_trader = matches!(get(row, "hasCardTraderListing"), Some(Value::Bool(true)))
        || matches!(get(row, "has_cardtrader_listing"), Some(Value::Bool(true)))
        || matches!(get(row, "cardtrader_available"), Some(Value::Bool(true)))
        || listing_count > 0.0;
    stock.is_finite() && stock > 0.0 || has_trader
}

/// `normalizeMarketplaceRow(row)`.
pub fn normalize_marketplace_row(row: &Value) -> Value {
    let mut normalized = row.clone();
    let collector_number = {
        let value = get_any(row, &["card_number", "expansion_number", "version"]);
        js_str_or(value)
    };
    if has_collector_number(&collector_number) {
        if let Value::Object(map) = &mut normalized {
            map.insert("item_kind".into(), Value::String("single".into()));
            map.insert("product_type".into(), Value::String("card".into()));
        }
    }
    let ct = ct_id_from_row(&normalized);
    if !ct.is_empty() && get(&normalized, "ct_id").is_none() {
        if let Value::Object(map) = &mut normalized {
            map.insert(
                "ct_id".into(),
                ct.parse::<f64>().map(Value::from).unwrap_or(Value::Null),
            );
        }
    }
    for key in IMAGE_KEYS {
        if let Some(value) = get(&normalized, key).cloned() {
            let rewritten = rewrite_cdn_pokoin_prefix(&js_str_or(Some(&value)), &normalized);
            if let Value::Object(map) = &mut normalized {
                map.insert(key.into(), Value::String(rewritten));
            }
        }
    }
    let available = is_market_available(&normalized);
    if let Value::Object(map) = &mut normalized {
        map.insert("isMarketAvailable".into(), Value::Bool(available));
        map.insert("inStock".into(), Value::Bool(available));
    }
    prefer_decodable_tile_image(&mut normalized);
    normalized
}

/// `normalizeMarketplaceRows(rows)`.
pub fn normalize_marketplace_rows(rows: Vec<Value>) -> Vec<Value> {
    rows.iter().map(normalize_marketplace_row).collect()
}

// --- canonical paths (_marketplace_canonical_path.js) ---

fn clean_card_id(value: &Value) -> f64 {
    let text = js_str_or(Some(value));
    match pokoin_api_common::http::js_number(&text) {
        Some(number) if safe_positive(number).is_some() => number,
        _ => 0.0,
    }
}

/// `publicCardIdForRow(row)`.
pub fn public_card_id_for_row(row: &Value) -> f64 {
    let card_id = clean_card_id(get_any(row, &["card_id", "id"]).unwrap_or(&Value::Null));
    let ct_id = clean_card_id(get_any(row, &["ct_id", "ctId"]).unwrap_or(&Value::Null));
    if ct_id > 0.0 {
        return ct_id * 2.0;
    }
    if card_id == 0.0 {
        return 0.0;
    }
    if card_id as i64 % 2 == 1 {
        card_id * 2.0
    } else {
        card_id
    }
}

/// `cleanCollectorNumber(value, cardId)`.
pub fn clean_collector_number(value: &str, card_id: &Value) -> String {
    let text = value.trim().trim_start_matches('#').trim_start().to_owned();
    let text = text.trim_start_matches('#').to_owned();
    let text = text.trim().to_owned();
    let card_id_text = js_str_or(Some(card_id));
    if text.is_empty() || text == card_id_text.trim() {
        return String::new();
    }
    text
}

fn slug_part(value: &str) -> String {
    let folded: String = value
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect();
    let mut out = String::new();
    let mut dash = false;
    for ch in folded.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// `canonicalSlugForRow(row)`.
pub fn canonical_slug_for_row(row: &Value) -> String {
    let rarity = str_field(row, &["rarity"]);
    let name = str_field(row, &["display_name", "canonical_name", "name"]);
    let number = clean_collector_number(
        &str_field(row, &["card_number"]),
        get_any(row, &["card_id", "id"]).unwrap_or(&Value::Null),
    );
    let set = str_field(row, &["set_name"]);
    [
        if rarity.trim().is_empty() {
            "Card".to_owned()
        } else {
            rarity
        },
        name,
        number,
        set,
    ]
    .iter()
    .map(|part| slug_part(part))
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("-")
}

/// `canonicalPathForRow(row)`.
pub fn canonical_path_for_row(row: &Value) -> String {
    let stored = str_field(row, &["canonical_path", "canonicalPath"]);
    if stored.starts_with("/marketplace/") && stored.contains("/cards/") {
        return stored;
    }
    let clean_id = public_card_id_for_row(row);
    let slug = canonical_slug_for_row(row);
    if clean_id > 0.0 && !slug.is_empty() {
        format!("/marketplace/en/cards/{}/{slug}", format_number(clean_id))
    } else {
        String::new()
    }
}

/// `attachCanonicalPath(row, lookupPath)` — resolve the path then normalize.
pub fn attach_canonical_path(row: &Value, lookup_path: &str) -> Value {
    let stored = {
        let raw = str_field(row, &["canonical_path", "canonicalPath"]);
        if raw.trim().is_empty() {
            lookup_path.trim().to_owned()
        } else {
            raw
        }
    };
    let mut with_path = row.clone();
    if let Value::Object(map) = &mut with_path {
        map.insert("canonical_path".into(), Value::String(stored.clone()));
        map.insert("canonicalPath".into(), Value::String(stored));
    }
    let path = canonical_path_for_row(&with_path);
    if !path.is_empty() {
        if let Value::Object(map) = &mut with_path {
            map.insert("canonical_path".into(), Value::String(path.clone()));
            map.insert("canonicalPath".into(), Value::String(path));
        }
    }
    normalize_marketplace_row(&with_path)
}

// --- card emoji fields (_marketplace_card_emoji.js) ---

/// `emojiTokens(value)` — grapheme segmentation.
pub fn emoji_tokens(value: &str) -> Vec<String> {
    let text = value.trim();
    if text.is_empty() {
        return Vec::new();
    }
    unicode_segmentation::UnicodeSegmentation::graphemes(text, true)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `cardIdentityEmojisForCard(row)`.
pub fn card_identity_emojis_for_card(row: &Value) -> Vec<String> {
    match get_any(row, &["cardIdentityEmojis", "card_identity_emojis"]) {
        Some(Value::Array(items)) => items
            .iter()
            .flat_map(|item| emoji_tokens(&js_str_or(Some(item))))
            .collect(),
        _ => {
            let single = js_str_or(get_any(row, &["cardIdentityEmoji", "card_identity_emoji"]));
            emoji_tokens(&single)
        }
    }
}

/// `cardEmojiFields(row)` — the six emoji columns stamped onto every row.
pub fn card_emoji_fields(row: &Value) -> Vec<(&'static str, Value)> {
    let identity = card_identity_emojis_for_card(row);
    let variant = emoji_tokens(&js_str_or(get_any(
        row,
        &[
            "rarityVariantEmoji",
            "rarity_variant_emoji",
            "variantEmoji",
            "variant_emoji",
        ],
    )))
    .first()
    .cloned()
    .unwrap_or_default();
    let emoji = str_field(row, &["emoji"]);
    let joined = identity.join(" ");
    vec![
        ("cardIdentityEmoji", Value::String(joined.clone())),
        ("card_identity_emoji", Value::String(joined.clone())),
        (
            "cardIdentityEmojis",
            Value::Array(identity.iter().cloned().map(Value::String).collect()),
        ),
        (
            "card_identity_emojis",
            Value::Array(identity.iter().cloned().map(Value::String).collect()),
        ),
        ("rarityVariantEmoji", Value::String(variant.clone())),
        ("rarity_variant_emoji", Value::String(variant)),
        ("emoji", Value::String(emoji)),
    ]
}

/// `withCardEmojiFields(row)`.
pub fn with_card_emoji_fields(row: &Value) -> Value {
    let mut out = row.clone();
    if let Value::Object(map) = &mut out {
        for (key, value) in card_emoji_fields(row) {
            map.insert(key.into(), value);
        }
    }
    out
}

// --- theme packs (_marketplace_react_sql.readCardThemePacks +
//     _card_visual_theme.visualThemeForShade / packVisualTheme) ---

const THEME_VERSION: &str = "v1";
const THEME_HEX_FIELDS: [&str; 7] = [
    "background",
    "surface",
    "surfaceRaised",
    "hero",
    "heroBorder",
    "border",
    "tint",
];

fn rgb(hex: &str) -> Option<[f64; 3]> {
    let bytes = hex.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' {
        return None;
    }
    let channel =
        |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range.start..range.end], 16).ok();
    Some([
        channel(1..3)? as f64,
        channel(3..5)? as f64,
        channel(5..7)? as f64,
    ])
}

fn lin(v: f64) -> f64 {
    let v = v / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn dot(m: [[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}

fn oklch_to_hex(l: f64, c: f64, h_deg: f64) -> String {
    let rad = h_deg.to_radians();
    let p = dot(
        [
            [1.0, 0.3963377774, 0.2158037573],
            [1.0, -0.1055613458, -0.0638541728],
            [1.0, -0.0894841775, -1.291485548],
        ],
        [l, rad.cos() * c, rad.sin() * c],
    )
    .map(|v| v * v * v);
    let rgb = dot(
        [
            [4.0767416621, -3.3077115913, 0.2309699292],
            [-1.2684380046, 2.6097574011, -0.3413193965],
            [-0.0041960863, -0.7034186147, 1.707614701],
        ],
        p,
    )
    .map(|v| {
        ((if v <= 0.0031308 {
            v * 12.92
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        }) * 255.0)
            .round()
            .clamp(0.0, 255.0) as u8
    });
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

fn contrast_white(hex: &str) -> f64 {
    let v = rgb(hex).map(|channel| channel.map(lin)).unwrap_or([0.0; 3]);
    1.05 / (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] + 0.05)
}

/// `buildVisualTheme(artShade, artworkIdentity)`.
pub fn build_visual_theme(art_shade: &str, artwork_identity: &str) -> Value {
    let Some(v) = rgb(art_shade) else {
        return Value::Null;
    };
    let lms = dot(
        [
            [0.4122214708, 0.5363325363, 0.0514459929],
            [0.2119034982, 0.6806995451, 0.1073969566],
            [0.0883024619, 0.2817188376, 0.6299787005],
        ],
        v.map(lin),
    )
    .map(f64::cbrt);
    let [l, a, b] = dot(
        [
            [0.2104542553, 0.793617785, -0.0040720468],
            [1.9779984951, -2.428592205, 0.4505937099],
            [0.0259040371, 0.7827717662, -0.808675766],
        ],
        lms,
    );
    let c = (a * a + b * b).sqrt();
    let neutral = c < 0.02;
    let h = if neutral {
        0.0
    } else {
        b.atan2(a).to_degrees().rem_euclid(360.0)
    };
    let kept = if neutral {
        0.0
    } else {
        (c * 2.2).clamp(0.055, 0.11)
    };
    let background_l = (l * 0.5).clamp(0.15, 0.2);
    let surface_l = (background_l + 0.04).clamp(0.19, 0.24);
    let mut hero_l = (l + 0.04).clamp(0.34, 0.52);
    let hero_c = if neutral { 0.0 } else { (c * 1.35).min(0.115) };
    for _ in 0..8 {
        if contrast_white(&oklch_to_hex(hero_l, hero_c, h)) >= 4.5 {
            break;
        }
        hero_l -= 0.025;
    }
    json!({
        "version": THEME_VERSION,
        "artworkShade": art_shade.to_lowercase(),
        "artworkIdentity": artwork_identity,
        "hue": round3(h),
        "chroma": round3(c),
        "background": oklch_to_hex(background_l, kept, h),
        "surface": oklch_to_hex(surface_l, (kept * 1.15).min(0.12), h),
        "surfaceRaised": oklch_to_hex((surface_l + 0.018).clamp(0.21, 0.255), (kept * 1.2).min(0.125), h),
        "hero": oklch_to_hex(hero_l, hero_c, h),
        "heroBorder": oklch_to_hex(0.45, if neutral { 0.0 } else { (c * 0.9).min(0.09) }, h),
        "border": oklch_to_hex(0.34, if neutral { 0.0 } else { (c * 0.5).min(0.035) }, h),
        "tint": oklch_to_hex((hero_l + 0.05).clamp(0.4, 0.55), if neutral { 0.0 } else { c.min(0.075) }, h),
    })
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn row_hex(row: &Value, field: &str) -> Option<String> {
    let raw = js_str_or(get(row, field)).to_lowercase();
    rgb(&raw).map(|_| raw)
}

/// `visualThemeForShade(row, artShade, artworkIdentity)`.
pub fn visual_theme_for_shade(
    row: Option<&Value>,
    art_shade: &str,
    artwork_identity: &str,
) -> Value {
    let normalized_shade = art_shade.to_lowercase();
    if rgb(&normalized_shade).is_none() {
        return Value::Null;
    }
    let current_identity = artwork_identity.to_owned();
    if let Some(row) = row {
        let version = js_str_or(get(row, "version"));
        let row_identity = js_str_or(get_any(row, &["artwork_identity", "artworkIdentity"]));
        let hexes: Vec<Option<String>> = THEME_HEX_FIELDS
            .iter()
            .map(|field| row_hex(row, field))
            .collect();
        if version == THEME_VERSION
            && !current_identity.is_empty()
            && row_identity == current_identity
            && hexes.iter().all(Option::is_some)
        {
            let mut theme = Map::new();
            theme.insert("version".into(), Value::String(version));
            theme.insert("artworkShade".into(), Value::String(normalized_shade));
            theme.insert("artworkIdentity".into(), Value::String(row_identity));
            for (index, field) in THEME_HEX_FIELDS.iter().enumerate() {
                theme.insert(
                    (*field).into(),
                    Value::String(hexes[index].clone().unwrap_or_default()),
                );
            }
            let hue = js_num_or(get(row, "hue"), 0.0);
            let chroma = js_num_or(get(row, "chroma"), 0.0);
            theme.insert("hue".into(), json!(hue));
            theme.insert("chroma".into(), json!(chroma));
            return Value::Object(theme);
        }
    }
    build_visual_theme(&normalized_shade, &current_identity)
}

/// `packVisualTheme(theme)` — `v1` + the seven hexes (44 chars).
pub fn pack_visual_theme(theme: &Value) -> String {
    if js_str_or(get(theme, "version")) != THEME_VERSION {
        return String::new();
    }
    let mut packed = THEME_VERSION.to_owned();
    for field in THEME_HEX_FIELDS {
        let hex = js_str_or(get(theme, field)).to_lowercase();
        if rgb(&hex).is_none() {
            return String::new();
        }
        packed.push_str(&hex[1..]);
    }
    packed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> Value {
        serde_json::json!({
            "card_id": 10,
            "ct_id": 5,
            "name": "Charizard",
            "set_name": "Base Set",
            "card_number": "4/102",
            "rarity": "Rare",
            "item_kind": "single",
            "product_type": "card",
            "image_url": "https://cdn.pokoin.com/5_charizard.jpg",
            "preview_image_url": "https://cdn.pokoin.com/previews/5_charizard.webp",
            "emoji": "🔥",
            "stock": 2,
        })
    }

    #[test]
    fn collector_numbers_make_rows_singles() {
        assert!(has_collector_number("4/102"));
        assert!(has_collector_number("Secret Rare | 090/087"));
        assert!(!has_collector_number("151 Poster Collection"));
        assert!(!has_collector_number("s8a"));
    }

    #[test]
    fn cdn_prefix_is_rewritten_to_public_ids() {
        let rewritten = rewrite_cdn_pokoin_prefix("https://cdn.pokoin.com/5_charizard.jpg", &row());
        assert_eq!(rewritten, "https://cdn.pokoin.com/10_charizard.jpg");
        let preview =
            rewrite_cdn_pokoin_prefix("https://cdn.pokoin.com/previews/5_charizard.webp", &row());
        assert_eq!(preview, "https://cdn.pokoin.com/previews/10_charizard.webp");
        let magic = rewrite_cdn_pokoin_prefix("https://cdn.pokoin.com/magic/5_xxx.jpg", &row());
        assert_eq!(magic, "https://cdn.pokoin.com/magic/5_xxx.jpg");
    }

    #[test]
    fn normalization_stamps_market_availability_and_raster_previews() {
        let normalized = normalize_marketplace_row(&row());
        assert_eq!(normalized["isMarketAvailable"], true);
        assert_eq!(normalized["inStock"], true);
        assert_eq!(
            normalized["image_url"],
            "https://cdn.pokoin.com/10_charizard.jpg"
        );
        // the fragile /previews/*.webp preview is swapped for the raster image
        assert_eq!(
            normalized["preview_image_url"],
            "https://cdn.pokoin.com/10_charizard.jpg"
        );
        let product = normalize_marketplace_row(&serde_json::json!({
            "card_id": 12, "name": "Booster Bundle", "item_kind": "product",
        }));
        assert_eq!(product["isMarketAvailable"], false);
    }

    #[test]
    fn canonical_path_uses_the_public_id() {
        assert_eq!(
            canonical_path_for_row(&row()),
            "/marketplace/en/cards/10/rare-charizard-4-102-base-set"
        );
        let odd = serde_json::json!({"card_id": 7, "name": "Mew", "rarity": "", "set_name": "", "card_number": ""});
        assert_eq!(
            canonical_path_for_row(&odd),
            "/marketplace/en/cards/14/card-mew"
        );
        let stored = serde_json::json!({"canonical_path": "/marketplace/en/cards/3/x/cards/3"});
        assert_eq!(
            canonical_path_for_row(&stored),
            "/marketplace/en/cards/3/x/cards/3"
        );
    }

    #[test]
    fn attach_canonical_path_normalizes_the_row() {
        let attached = attach_canonical_path(&row(), "");
        assert_eq!(
            attached["canonicalPath"],
            "/marketplace/en/cards/10/rare-charizard-4-102-base-set"
        );
        assert_eq!(attached["canonical_path"], attached["canonicalPath"]);
    }

    #[test]
    fn emoji_fields_split_graphemes() {
        let stamped = with_card_emoji_fields(&row());
        assert_eq!(stamped["emoji"], "🔥");
        assert_eq!(stamped["cardIdentityEmoji"], "");
        assert_eq!(stamped["cardIdentityEmojis"], serde_json::json!([]));
        assert_eq!(stamped["rarityVariantEmoji"], "");
        let identity = with_card_emoji_fields(&serde_json::json!({
            "cardIdentityEmojis": ["🐭", "⚡"],
            "emoji": "🐭 ⚡",
        }));
        assert_eq!(identity["cardIdentityEmoji"], "🐭 ⚡");
        assert_eq!(
            identity["cardIdentityEmojis"],
            serde_json::json!(["🐭", "⚡"])
        );
    }

    #[test]
    fn theme_packs_derive_from_shades() {
        let theme = visual_theme_for_shade(None, "#c4c4c4", "artwork-1");
        assert_eq!(theme["version"], "v1");
        assert_eq!(theme["artworkIdentity"], "artwork-1");
        let packed = pack_visual_theme(&theme);
        assert_eq!(packed.len(), 44);
        assert!(packed.starts_with("v1"));
        assert_eq!(pack_visual_theme(&Value::Null), "");
        assert_eq!(visual_theme_for_shade(None, "", "x"), Value::Null);
        let stale = serde_json::json!({
            "version": "v1", "artwork_identity": "old",
            "background": "#ff0000", "surface": "#ff0000", "surfaceRaised": "#ff0000",
            "hero": "#ff0000", "heroBorder": "#ff0000", "border": "#ff0000", "tint": "#ff0000",
            "hue": 120.0, "chroma": 0.1,
        });
        let rederived = visual_theme_for_shade(Some(&stale), "#c4c4c4", "new");
        assert_eq!(rederived["artworkIdentity"], "new");
        assert_ne!(rederived["background"], "#ff0000");
    }

    #[test]
    fn ct_id_halves_even_public_ids() {
        assert_eq!(ct_id_from_row(&row()), "5");
        assert_eq!(ct_id_from_row(&serde_json::json!({"card_id": 7})), "");
        assert_eq!(ct_id_from_row(&serde_json::json!({"ctId": 9})), "9");
    }
}
