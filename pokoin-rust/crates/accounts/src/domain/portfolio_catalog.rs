//! Pokoin catalog row shaping for the React clients — a port of the parts of
//! `_marketplace_react_card.js`, `_marketplace_row.js` and
//! `marketplace-portfolio.js` the portfolio BFF needs.
//!
//! Rules that must not drift:
//! * grid/hero image URLs are always the full raster image, never `/previews/`;
//! * a foreign leftover key (another card's picture, e.g. an old halved
//!   `ct_id/2` prefix) is dropped so the per-id preview is used instead;
//! * CardTrader image hosts are blanked — Pokoin CDN art only;
//! * `cdn.pokoin.com` URLs are rewritten to the same-origin `/card-images` path.

use std::collections::HashMap;

use serde_json::{json, Map, Value as Json};

use crate::error::ApiError;

/// `cleanText(value, max)`. Note the Node helper only trims.
pub fn clean_text(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn field_str(row: &Json, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| row.get(*key))
        .map(json_to_js_string)
        .unwrap_or_default()
}

/// Whether a JSON value is falsy the way JavaScript means it.
fn is_falsy(value: &Json) -> bool {
    match value {
        Json::Null => true,
        Json::String(text) => text.is_empty(),
        Json::Bool(flag) => !*flag,
        Json::Number(number) => number.as_f64() == Some(0.0),
        _ => false,
    }
}

/// `a || b || c || ''` — the first truthy key, as a string.
fn or_str(row: &Json, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = row.get(*key) {
            if !is_falsy(value) {
                return json_to_js_string(value);
            }
        }
    }
    String::new()
}

/// `a ?? b ?? ''` — the first key that is not null or missing.
fn nullish_str(row: &Json, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = row.get(*key) {
            if !value.is_null() {
                return json_to_js_string(value);
            }
        }
    }
    String::new()
}

/// `String(value || '')` for the value shapes these rows hold.
fn json_to_js_string(value: &Json) -> String {
    match value {
        Json::String(text) => text.clone(),
        Json::Number(number) => number.to_string(),
        Json::Bool(flag) => flag.to_string(),
        Json::Null => String::new(),
        other => other.to_string(),
    }
}

/// `Number(value)` — `None` for the shapes JavaScript makes `NaN`/`undefined`.
fn js_number(value: Option<&Json>) -> Option<f64> {
    match value? {
        Json::Number(number) => number.as_f64(),
        Json::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Json::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Json::Null => Some(0.0),
        _ => None,
    }
}

/// `JSON.stringify` of a JS number: an integral value loses its decimal point
/// (`25.0` is `25` on the wire, `12.5` stays `12.5`).
pub fn js_num(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `Number(value) || 0`.
fn number_or_zero(row: &Json, key: &str) -> f64 {
    js_number(row.get(key))
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn is_safe_positive_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value > 0.0 && value <= 9_007_199_254_740_991.0
}

/// `parseLimit(value, fallback, max)`.
pub fn parse_limit(value: Option<&Json>, fallback: i64, max: i64) -> i64 {
    let Some(value) = value else {
        return fallback;
    };
    if value.is_null() {
        return fallback;
    }
    let Some(number) = js_number(Some(value)) else {
        return fallback;
    };
    if !number.is_finite() {
        return fallback;
    }
    (number.trunc() as i64).clamp(1, max)
}

/// `parsePublicCardId(value)` — digits only, a positive safe integer.
pub fn parse_public_card_id(value: Option<&Json>) -> String {
    let text = match value {
        Some(Json::String(text)) => text.trim().to_string(),
        Some(Json::Number(number)) => number.to_string(),
        _ => return String::new(),
    };
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return String::new();
    }
    match text.parse::<f64>() {
        Ok(number) if is_safe_positive_integer(number) => text,
        _ => String::new(),
    }
}

/// `limitForGame(raw, game)` — Pokemon pages are smaller than the other games.
pub fn limit_for_game(value: Option<&Json>, game: &str) -> i64 {
    if crate::domain::marketplace_game::is_pokemon_game(game) {
        parse_limit(value, 400, 500)
    } else {
        parse_limit(value, 2_000, 2_500)
    }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/// Multi-game CDN keys stay raw CardTrader ids.
const MULTIGAME_KEY: &[&str] = &[
    "one-piece", "riftbound", "magic", "yugioh", "lorcana", "flesh-and-blood",
    "digimon", "dragon-ball-super", "vanguard", "star-wars", "union-arena",
    "gundam", "sorcery", "palworld", "cyberpunk", "weiss-schwarz",
    "final-fantasy", "force-of-will", "world-of-warcraft", "battle-spirits-saga",
    "star-wars-destiny", "dragon-born", "my-little-pony", "the-spoils",
];

/// `/(?:^|\/)(?:slug|…)\//i`
fn has_multigame_prefix(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    let bytes = lowered.as_bytes();
    for slug in MULTIGAME_KEY {
        let mut search = 0usize;
        while let Some(found) = lowered[search..].find(&format!("{slug}/")) {
            let index = search + found;
            if index == 0 || bytes[index - 1] == b'/' {
                return true;
            }
            search = index + 1;
        }
    }
    false
}

/// `normalizeImageUrl(value)` — `cdn.pokoin.com` becomes same-origin.
pub fn normalize_image_url(value: Option<&Json>) -> String {
    let text = value.map(json_to_js_string).unwrap_or_default();
    let text = text.trim().to_string();
    if text.is_empty() {
        return String::new();
    }
    match split_url(&text) {
        Some((host, path)) if host == "cdn.pokoin.com" => format!("/card-images{path}"),
        _ => text,
    }
}

/// The hostname and `path+query` of an absolute URL.
fn split_url(value: &str) -> Option<(String, String)> {
    let rest = value.split("://").nth(1)?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    let mut tail = &rest[authority_end..];
    if let Some(hash) = tail.find('#') {
        tail = &tail[..hash];
    }
    if host.is_empty() {
        return None;
    }
    Some((host, tail.to_string()))
}

/// `isPreviewPath(value)`.
pub fn is_preview_path(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let lowered = value.to_ascii_lowercase();
    if lowered.contains("/previews/") || lowered.contains("/preview_") {
        return true;
    }
    // `(?:^|/)preview_<name>.(jpg|jpeg|png|webp)(?:\?|$)`
    let mut search = 0usize;
    while let Some(found) = lowered[search..].find("preview_") {
        let index = search + found;
        if index == 0 || lowered.as_bytes()[index - 1] == b'/' {
            let rest = &lowered[index + "preview_".len()..];
            let end = rest
                .find(['?', '#'])
                .map(|offset| index + "preview_".len() + offset)
                .unwrap_or(lowered.len());
            let candidate = &lowered[index..end];
            for suffix in [".jpg", ".jpeg", ".png", ".webp"] {
                if candidate.ends_with(suffix) {
                    return true;
                }
            }
        }
        search = index + 1;
    }
    false
}

/// `isHomepageWebp(value)`.
pub fn is_homepage_webp(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    match lowered.find("_homepage.webp") {
        Some(index) => {
            let rest = &lowered[index + "_homepage.webp".len()..];
            rest.is_empty() || rest.starts_with('?') || rest.starts_with('#')
        }
        None => false,
    }
}

/// `ctIdFromRow(row)`.
pub fn ct_id_from_row(row: &Json) -> String {
    let ct = js_number(row.get("ct_id").or_else(|| row.get("ctId"))).unwrap_or(f64::NAN);
    if is_safe_positive_integer(ct) {
        return format!("{}", ct as i64);
    }
    let id = js_number(row.get("card_id").or_else(|| row.get("id"))).unwrap_or(f64::NAN);
    if is_safe_positive_integer(id) && (id as i64) % 2 == 0 {
        return format!("{}", (id as i64) / 2);
    }
    String::new()
}

/// `foreignImagePrefix(url, row)` — the leading `\d+_` is not this card's id.
pub fn foreign_image_prefix(url: &str, row: &Json) -> bool {
    let text = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_string();
    if text.is_empty() || has_multigame_prefix(&text) {
        return false;
    }
    // `(?:^|/)(?:previews/)?(\d+)_[^/]*$`
    let Some(prefix) = image_id_prefix(&text) else {
        return false;
    };
    let card = nullish_str(row, &["card_id", "id"]).trim().to_string();
    let ct = ct_id_from_row(row);
    if card.is_empty() && ct.is_empty() {
        return false;
    }
    prefix != card && prefix != ct
}

/// The leading numeric id of an image key, if it has one.
fn image_id_prefix(text: &str) -> Option<String> {
    let name = text.rsplit('/').next()?;
    let name = name.strip_prefix("previews/").unwrap_or(name);
    let name = if text.contains("/previews/") {
        text.rsplit("/previews/").nth(1).unwrap_or(name)
    } else {
        name
    };
    let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &name[digits.len()..];
    if !rest.starts_with('_') {
        return None;
    }
    // `[^/]*$` — nothing but the tail after the prefix.
    Some(digits)
}

/// `rewriteCdnKeyPrefix(url, from, to)`.
pub fn rewrite_cdn_key_prefix(url: &str, from: &str, to: &str) -> String {
    let from = from.trim();
    let to = to.trim();
    if url.is_empty() || from.is_empty() || to.is_empty() || from == to {
        return url.to_string();
    }
    if !from.bytes().all(|byte| byte.is_ascii_digit())
        || !to.bytes().all(|byte| byte.is_ascii_digit())
    {
        return url.to_string();
    }
    // `(^|/)(previews/)?{from}_` -> `$1$2{to}_`
    let needle = format!("{from}_");
    let mut out = String::with_capacity(url.len());
    let mut index = 0usize;
    while let Some(found) = url[index..].find(&needle) {
        let at = index + found;
        // The match must be at the start or right after a slash.
        let boundary_ok = at == 0 || url.as_bytes()[at - 1] == b'/';
        if boundary_ok {
            // `previews/` between the slash and the id moves with the prefix.
            out.push_str(&url[index..at]);
            out.push_str(to);
            out.push('_');
            index = at + needle.len();
        } else {
            out.push_str(&url[index..at + 1]);
            index = at + 1;
        }
    }
    out.push_str(&url[index..]);
    out
}

/// `rewriteCdnPokoinPrefix(url, row)`.
pub fn rewrite_cdn_pokoin_prefix(url: &str, row: &Json) -> String {
    if has_multigame_prefix(url) {
        return url.to_string();
    }
    let pokoin = nullish_str(row, &["card_id", "id"]).trim().to_string();
    let mut ct_row = row.clone();
    if let Some(object) = ct_row.as_object_mut() {
        object.insert(
            "card_id".into(),
            json!(if pokoin.is_empty() {
                field_str(row, &["card_id"])
            } else {
                pokoin.clone()
            }),
        );
    }
    let ct = ct_id_from_row(&ct_row);
    rewrite_cdn_key_prefix(url, &ct, &pokoin)
}

/// `rewriteRowImages(row)` — also marks a dropped foreign full image.
pub fn rewrite_row_images(row: &Json) -> Json {
    let mut rewritten = row.as_object().cloned().unwrap_or_default();
    let raw_image = or_str(row, &["cdn_image_url", "cdnImageUrl", "image_url", "imageUrl"]);
    let image = rewrite_cdn_pokoin_prefix(&raw_image, row);
    let raw_preview = or_str(row, &["preview_image_url", "previewImageUrl"]);
    let preview = rewrite_cdn_pokoin_prefix(&raw_preview, row);
    let raw_homepage = or_str(row, &["homepage_image_url", "homepageImageUrl"]);
    let homepage = rewrite_cdn_pokoin_prefix(&raw_homepage, row);
    rewritten.insert("image_url".into(), json!(image));
    rewritten.insert("preview_image_url".into(), json!(preview));
    rewritten.insert("homepage_image_url".into(), json!(homepage));

    if foreign_image_prefix(&image, row) {
        for key in ["image_url", "cdn_image_url", "imageUrl", "cdnImageUrl"] {
            rewritten.insert(key.into(), json!(""));
        }
        rewritten.insert("_foreignFullImage".into(), json!(true));
    }
    if foreign_image_prefix(&preview, row) {
        for key in ["preview_image_url", "previewImageUrl"] {
            rewritten.insert(key.into(), json!(""));
        }
    }
    if foreign_image_prefix(&homepage, row) {
        for key in ["homepage_image_url", "homepageImageUrl"] {
            rewritten.insert(key.into(), json!(""));
        }
    }
    Json::Object(rewritten)
}

/// `pickFullImage(row)` — a full raster, falling back to preview/homepage.
pub fn pick_full_image(row: &Json) -> String {
    let candidates = ["image_url", "cdn_image_url", "imageUrl", "cdnImageUrl"];
    for key in candidates {
        let url = normalize_image_url(row.get(key));
        if !url.is_empty() && !is_preview_path(&url) {
            return url;
        }
    }
    for key in [
        "image_url", "cdn_image_url", "imageUrl", "cdnImageUrl",
        "preview_image_url", "previewImageUrl", "homepage_image_url", "homepageImageUrl",
    ] {
        let url = normalize_image_url(row.get(key));
        if !url.is_empty() {
            return url;
        }
    }
    String::new()
}

/// `catalogImageSlug(value)`.
pub fn catalog_image_slug(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let name = lower
        .split(['/', '?', '#'])
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("");
    let name = name.replace("_homepage.webp", "");
    let name = name.replace("_homepage.jpg", "");
    let name = name.replace("_homepage.jpeg", "");
    let name = name.replace("_homepage.png", "");
    let mut name = name;
    for suffix in [".jpg", ".jpeg", ".png", ".webp"] {
        if name.ends_with(suffix) {
            name = name[..name.len() - suffix.len()].to_string();
        }
    }
    // `^\d+_`
    let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() && name[digits.len()..].starts_with('_') {
        name = name[digits.len() + 1..].to_string();
    }
    name
}

/// `homepageMatchesFullImage(homepageUrl, fullUrl)`.
pub fn homepage_matches_full_image(homepage_url: &str, full_url: &str) -> bool {
    let homepage = catalog_image_slug(homepage_url);
    let full = catalog_image_slug(full_url);
    !homepage.is_empty() && !full.is_empty() && homepage == full
}

/// `reactImageUrls(row)`.
pub fn react_image_urls(row: &Json) -> Json {
    let rewritten = rewrite_row_images(row);
    let image_url = pick_full_image(&rewritten);
    let preview = normalize_image_url(rewritten.get("preview_image_url"));
    let preview_url = if preview.is_empty() {
        image_url.clone()
    } else {
        preview
    };
    let homepage_url = normalize_image_url(rewritten.get("homepage_image_url"));
    let foreign = rewritten
        .get("_foreignFullImage")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let tile_from_homepage = is_homepage_webp(&homepage_url)
        && (foreign || homepage_matches_full_image(&homepage_url, &image_url));
    json!({
        "imageUrl": image_url,
        "previewImageUrl": preview_url,
        "homepageImageUrl": if tile_from_homepage { homepage_url.clone() } else { String::new() },
        "gridImageUrl": image_url,
        "heroImageUrl": image_url,
        "tileImageUrl": if tile_from_homepage { homepage_url } else { image_url },
    })
}

// ---------------------------------------------------------------------------
// Foreign hosts and holdings
// ---------------------------------------------------------------------------

/// `isCardtraderHost(value)`.
pub fn is_cardtrader_host(value: &str) -> bool {
    let text = value.trim();
    if text.is_empty() {
        return false;
    }
    // `new URL(text, 'https://pokoin.com')` then a hostname check.
    let host = match split_url(text) {
        Some((host, _)) if text.contains("://") => host,
        _ => text
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .rsplit('@')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase(),
    };
    if host.is_empty() {
        return text.to_ascii_lowercase().contains("cardtrader.com");
    }
    host == "cardtrader.com" || host.ends_with(".cardtrader.com")
}

/// `dropForeignImages(row)`.
pub fn drop_foreign_images(row: &Json) -> Json {
    let mut next = row.as_object().cloned().unwrap_or_default();
    for key in [
        "cdn_image_url",
        "image_url",
        "preview_image_url",
        "homepage_image_url",
    ] {
        let value = field_str(row, &[key]);
        if is_cardtrader_host(&value) {
            next.insert(key.into(), json!(""));
        }
    }
    Json::Object(next)
}

/// `gameLabel(game)`.
pub fn game_label(game: &str) -> String {
    match game {
        "pokemon" => "Pokémon".to_string(),
        "one_piece" => "One Piece".to_string(),
        "riftbound" => "Riftbound".to_string(),
        other if other.is_empty() => "Pokoin".to_string(),
        other => other.to_string(),
    }
}

/// `holdingFromRow(row, game)`.
pub fn holding_from_row(row: &Json, game: &str) -> Json {
    let card_id = parse_public_card_id(row.get("card_id"));
    let images = react_image_urls(&drop_foreign_images(&json!({
        "card_id": card_id,
        "ct_id": row.get("ct_id").cloned().unwrap_or(Json::Null),
        "cdn_image_url": field_str(row, &["cdn_image_url"]),
        "image_url": field_str(row, &["image_url"]),
    })));
    let qty = {
        let raw = number_or_zero(row, "qty").max(0.0);
        if raw == 0.0 {
            1
        } else {
            raw as i64
        }
    };
    let price_pkn = number_or_zero(row, "floor_pkn");
    let total_pkn = {
        let raw = number_or_zero(row, "total_pkn");
        if raw != 0.0 {
            raw
        } else if price_pkn * qty as f64 != 0.0 {
            price_pkn * qty as f64
        } else {
            0.0
        }
    };
    let name = {
        let primary = clean_text(&field_str(row, &["catalog_name"]), 240);
        if primary.is_empty() {
            clean_text(&field_str(row, &["card_name"]), 240)
        } else {
            primary
        }
    };
    let expansion = {
        let primary = clean_text(&field_str(row, &["expansion_name"]), 240);
        if !primary.is_empty() {
            primary
        } else {
            let second = clean_text(&field_str(row, &["catalog_set"]), 240);
            if !second.is_empty() {
                second
            } else {
                clean_text(&field_str(row, &["set_name"]), 240)
            }
        }
    };
    let listing_count = number_or_zero(row, "listing_count").max(0.0) as i64;
    let canonical_path = {
        let raw = clean_text(&field_str(row, &["canonical_path"]), 800);
        if !raw.is_empty() || card_id.is_empty() {
            raw
        } else {
            format!("/marketplace/en/cards/{card_id}")
        }
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(card_id));
    out.insert("cardId".into(), json!(card_id));
    out.insert("card_id".into(), json!(card_id));
    out.insert("name".into(), json!(name));
    out.insert("expansion".into(), json!(expansion));
    out.insert("set".into(), json!(expansion));
    out.insert("set_name".into(), json!(expansion));
    let number = {
        let primary = clean_text(&field_str(row, &["card_number"]), 80);
        if primary.is_empty() {
            clean_text(&field_str(row, &["collector_number"]), 80)
        } else {
            primary
        }
    };
    out.insert("number".into(), json!(number));
    out.insert("game".into(), json!(game_label(game)));
    out.insert("gameId".into(), json!(game));
    out.insert("qty".into(), json!(qty));
    out.insert("listingCount".into(), json!(listing_count));
    out.insert("pricePkn".into(), js_num(price_pkn));
    out.insert("totalPkn".into(), js_num(total_pkn));
    out.insert(
        "condition".into(),
        json!(clean_text(&field_str(row, &["condition"]), 80)),
    );
    out.insert(
        "language".into(),
        json!(clean_text(&field_str(row, &["language"]), 16).to_ascii_uppercase()),
    );
    out.insert(
        "sealed".into(),
        json!(row.get("sealed").and_then(Json::as_bool).unwrap_or(false)),
    );
    out.insert(
        "source".into(),
        json!(if listing_count > 0 { "native" } else { "catalog" }),
    );
    out.insert("canonicalPath".into(), json!(canonical_path));
    out.insert("canonical_path".into(), json!(canonical_path));
    if let Some(fields) = images.as_object() {
        for (key, value) in fields {
            out.insert(key.clone(), value.clone());
        }
    }
    Json::Object(out)
}

/// `rollupSets(items)` — per-expansion totals, biggest value first.
pub fn rollup_sets(items: &[Json]) -> Vec<Json> {
    let mut order: Vec<String> = Vec::new();
    let mut by_set: HashMap<String, (f64, f64, f64)> = HashMap::new();
    for item in items {
        let key = {
            let expansion = field_str(item, &["expansion"]);
            if expansion.is_empty() {
                "—".to_string()
            } else {
                expansion
            }
        };
        let entry = by_set.entry(key.clone()).or_insert((0.0, 0.0, 0.0));
        entry.0 += js_number(item.get("totalPkn")).unwrap_or(0.0);
        entry.1 += js_number(item.get("qty")).unwrap_or(0.0);
        entry.2 += js_number(item.get("listingCount")).unwrap_or(0.0);
        if !order.contains(&key) {
            order.push(key);
        }
    }
    let mut rows: Vec<Json> = order
        .iter()
        .map(|key| {
            let (pkn, qty, listings) = by_set[key];
            json!({ "name": key, "pkn": js_num(pkn), "qty": js_num(qty), "listings": js_num(listings) })
        })
        .collect();
    // A stable sort keeps first-seen order for equal values.
    rows.sort_by(|a, b| {
        let left = a.get("pkn").and_then(Json::as_f64).unwrap_or(0.0);
        let right = b.get("pkn").and_then(Json::as_f64).unwrap_or(0.0);
        right.partial_cmp(&left).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

/// `emptyPayload(game)`.
pub fn empty_payload(game: &str, generated: &str) -> Json {
    let label = game_label(game);
    json!({
        "game": game,
        "generated": generated,
        "totals": { "pkn": 0, "qty": 0, "listings": 0, "cards": 0 },
        "games": [{ "id": game, "name": label, "pkn": 0, "qty": 0 }],
        "sets": [],
        "items": [],
    })
}

/// `payloadFromRows(rows, game)`.
pub fn payload_from_rows(rows: &[Json], game: &str, generated: &str) -> Json {
    let items: Vec<Json> = rows
        .iter()
        .map(|row| holding_from_row(row, game))
        .filter(|row| {
            !row.get("id")
                .and_then(Json::as_str)
                .unwrap_or("")
                .is_empty()
        })
        .collect();
    let mut totals = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for item in &items {
        totals.0 += js_number(item.get("totalPkn")).unwrap_or(0.0);
        totals.1 += js_number(item.get("qty")).unwrap_or(0.0);
        totals.2 += js_number(item.get("listingCount")).unwrap_or(0.0);
        totals.3 += 1.0;
    }
    let label = game_label(game);
    json!({
        "game": game,
        "generated": generated,
        "totals": {
            "pkn": js_num(totals.0),
            "qty": js_num(totals.1),
            "listings": js_num(totals.2),
            "cards": js_num(totals.3),
        },
        "games": [{ "id": game, "name": label, "pkn": js_num(totals.0), "qty": js_num(totals.1) }],
        "sets": rollup_sets(&items),
        "items": items,
    })
}

/// `isUndefinedTable(error)` — a missing relation is an empty catalog, not a
/// 500. The SQLSTATE is not carried on the crate's `ApiError`, so the Postgres
/// wording is matched (which is what `42P01` always produces).
pub fn is_undefined_table(error: &ApiError) -> bool {
    let message = error.message().to_ascii_lowercase();
    message.contains("does not exist") || message.contains("42p01")
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

pub struct CatalogSelect {
    pub listing_join: String,
    pub cheap_join: String,
    pub select: String,
}

/// `listingJoinSql()`.
pub const fn listing_join_sql() -> &'static str {
    "left join lateral ( \
       select min(listings.price_pkn)::float8 as floor_pkn, \
              sum(listings.quantity_available * listings.price_pkn)::float8 as total_pkn, \
              sum(listings.quantity_available)::int as qty, \
              count(*)::int as listing_count, \
              bool_or(listings.sealed) as sealed, \
              max(listings.card_name) as card_name, \
              max(listings.collector_number) as collector_number, \
              max(listings.condition) as condition, \
              max(listings.language) as language \
         from public.marketplace_user_listings listings \
        where listings.card_id = c.card_id::text \
          and listings.status = 'active' \
          and listings.quantity_available > 0 \
          and coalesce(listings.source, '') not ilike '%cardtrader%' \
     ) listings on true"
}

/// `cheapLookupSql()`.
pub const fn cheap_lookup_sql() -> &'static str {
    "left join lateral ( \
       select cheapest_price_pkn::float8 as floor_pkn, eligible_quantity::int as qty \
         from public.cheapest_homepage_cache_blueprint cheap \
        where cheap.cheapest_price_pkn is not null \
          and cheap.cheapest_price_pkn > 0 \
          and coalesce(cheap.eligible_listing_count, 0) > 0 \
          and cheap.provider in ('pokoin_native', 'cardtrader') \
          and cheap.pokoin_card_id = c.card_id::text \
        order by case when cheap.provider = 'pokoin_native' then 0 else 1 end, \
                 cheap.cheapest_price_pkn asc \
        limit 1 \
     ) cheap on true"
}

/// `urlsJoinSql()`.
pub const fn urls_join_sql() -> &'static str {
    "left join lateral ( \
       select canonical_path from public.marketplace_card_urls u \
        where u.card_id = c.card_id and u.language = 'en' \
        order by u.canonical_path limit 1 \
     ) urls on true"
}

/// `catalogSelectSql({hasListings, hasCheap})`.
pub fn catalog_select_sql(has_listings: bool, has_cheap: bool) -> CatalogSelect {
    let floor = match (has_listings, has_cheap) {
        (true, true) => "coalesce(listings.floor_pkn, cheap.floor_pkn, 0)".to_string(),
        (true, false) => "coalesce(listings.floor_pkn, 0)".to_string(),
        (false, true) => "coalesce(cheap.floor_pkn, 0)".to_string(),
        (false, false) => "0".to_string(),
    };
    let qty = match (has_listings, has_cheap) {
        (true, true) => "coalesce(listings.qty, cheap.qty, 1)".to_string(),
        (true, false) => "coalesce(listings.qty, 1)".to_string(),
        (false, true) => "coalesce(cheap.qty, 1)".to_string(),
        (false, false) => "1".to_string(),
    };
    let total = if has_listings {
        format!("coalesce(listings.total_pkn, ({floor}) * ({qty}), 0)")
    } else {
        format!("({floor}) * ({qty})")
    };
    let listing_count = if has_listings {
        "coalesce(listings.listing_count, 0)"
    } else {
        "0"
    };
    let sealed = if has_listings {
        "coalesce(listings.sealed, c.item_kind = 'product')"
    } else {
        "c.item_kind = 'product'"
    };
    let card_name = if has_listings {
        "listings.card_name"
    } else {
        "null::text"
    };
    let collector = if has_listings {
        "listings.collector_number"
    } else {
        "null::text"
    };
    let condition = if has_listings {
        "listings.condition"
    } else {
        "null"
    };
    let language = if has_listings {
        "listings.language"
    } else {
        "null"
    };
    CatalogSelect {
        listing_join: if has_listings { listing_join_sql().to_string() } else { String::new() },
        cheap_join: if has_cheap { cheap_lookup_sql().to_string() } else { String::new() },
        select: format!(
            "c.card_id::text as card_id, c.ct_id, \
             ({floor})::float8 as floor_pkn, \
             ({total})::float8 as total_pkn, \
             ({qty})::int as qty, \
             ({listing_count})::int as listing_count, \
             ({sealed}) as sealed, \
             {card_name} as card_name, \
             c.name as catalog_name, c.set_name, c.expansion_name, c.card_number, \
             {collector} as collector_number, {condition} as condition, {language} as language, \
             c.cdn_image_url, c.image_url, urls.canonical_path"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_follow_the_game_and_clamp() {
        assert_eq!(limit_for_game(None, "pokemon"), 400);
        assert_eq!(limit_for_game(Some(&json!(10)), "pokemon"), 10);
        assert_eq!(limit_for_game(Some(&json!(9999)), "pokemon"), 500);
        assert_eq!(limit_for_game(Some(&json!(0)), "pokemon"), 1);
        assert_eq!(limit_for_game(Some(&json!("abc")), "pokemon"), 400);
        assert_eq!(limit_for_game(Some(&json!(12.9)), "pokemon"), 12);
        assert_eq!(limit_for_game(None, "magic"), 2000);
        assert_eq!(limit_for_game(Some(&json!(9999)), "magic"), 2500);
        assert_eq!(limit_for_game(Some(&json!(7)), "one_piece"), 7);
    }

    #[test]
    fn public_card_ids_must_be_positive_digits() {
        assert_eq!(parse_public_card_id(Some(&json!("12345"))), "12345");
        assert_eq!(parse_public_card_id(Some(&json!(12345))), "12345");
        assert_eq!(parse_public_card_id(Some(&json!(" 42 "))), "42");
        assert_eq!(parse_public_card_id(Some(&json!("0"))), "");
        assert_eq!(parse_public_card_id(Some(&json!("abc"))), "");
        assert_eq!(parse_public_card_id(Some(&json!("12.5"))), "");
        assert_eq!(parse_public_card_id(None), "");
    }

    #[test]
    fn pokoin_cdn_urls_become_same_origin_paths() {
        assert_eq!(
            normalize_image_url(Some(&json!("https://cdn.pokoin.com/card-images/1_2.jpg?a=1"))),
            "/card-images/card-images/1_2.jpg?a=1"
        );
        assert_eq!(
            normalize_image_url(Some(&json!("https://cdn.pokoin.com/x.webp"))),
            "/card-images/x.webp"
        );
        // Other hosts are untouched.
        assert_eq!(
            normalize_image_url(Some(&json!("https://other.com/x.jpg"))),
            "https://other.com/x.jpg"
        );
        assert_eq!(normalize_image_url(None), "");
        assert_eq!(normalize_image_url(Some(&json!(""))), "");
    }

    #[test]
    fn preview_paths_are_detected() {
        assert!(is_preview_path("/previews/1_2.jpg"));
        assert!(is_preview_path("https://x/a/preview_1_2.jpg"));
        assert!(is_preview_path("/a/preview_1_2.PNG"));
        assert!(!is_preview_path("/cards/1_2.jpg"));
        assert!(!is_preview_path(""));
        // `preview_` must start a path segment.
        assert!(!is_preview_path("/a/xpreview_1_2.jpg"));
    }

    #[test]
    fn homepage_webp_detection() {
        assert!(is_homepage_webp("/a/1_x_homepage.webp"));
        assert!(is_homepage_webp("/a/1_x_homepage.webp?v=2"));
        assert!(!is_homepage_webp("/a/1_x_homepage.webp2"));
        assert!(!is_homepage_webp("/a/1_x.webp"));
    }

    #[test]
    fn ct_ids_prefer_the_column_and_halve_even_public_ids() {
        assert_eq!(ct_id_from_row(&json!({ "ct_id": 99 })), "99");
        assert_eq!(ct_id_from_row(&json!({ "ctId": "99" })), "99");
        assert_eq!(ct_id_from_row(&json!({ "card_id": 100 })), "50");
        assert_eq!(ct_id_from_row(&json!({ "card_id": 101 })), "");
        assert_eq!(ct_id_from_row(&json!({})), "");
    }

    #[test]
    fn foreign_prefixes_drop_another_cards_picture() {
        // The documented 109873_hisuian-zoroark-vstar.jpg serving Entei.
        let row = json!({ "card_id": 4242, "ct_id": 2121 });
        assert!(foreign_image_prefix("/card-images/109873_x.jpg", &row));
        // The card's own public id or ct id is fine.
        assert!(!foreign_image_prefix("/card-images/4242_x.jpg", &row));
        assert!(!foreign_image_prefix("/card-images/2121_x.jpg", &row));
        assert!(!foreign_image_prefix("/card-images/previews/4242_x.jpg", &row));
        // Multi-game keys stay raw CardTrader ids.
        assert!(!foreign_image_prefix("/magic/109873_x.jpg", &row));
        // No id at all in the row: never foreign.
        assert!(!foreign_image_prefix("/card-images/109873_x.jpg", &json!({})));
        // No numeric prefix: not foreign.
        assert!(!foreign_image_prefix("/card-images/entei.jpg", &row));
    }

    #[test]
    fn cdn_key_prefixes_are_rewritten_at_boundaries() {
        assert_eq!(
            rewrite_cdn_key_prefix("/card-images/2121_x.jpg", "2121", "4242"),
            "/card-images/4242_x.jpg"
        );
        // `previews/` moves with the prefix.
        assert_eq!(
            rewrite_cdn_key_prefix("/card-images/previews/2121_x.jpg", "2121", "4242"),
            "/card-images/previews/4242_x.jpg"
        );
        // Never a partial id: 121 must not match 2121.
        assert_eq!(
            rewrite_cdn_key_prefix("/card-images/2121_x.jpg", "121", "9"),
            "/card-images/2121_x.jpg"
        );
        // Identical or non-numeric ids are no-ops.
        assert_eq!(rewrite_cdn_key_prefix("/a/1_x.jpg", "1", "1"), "/a/1_x.jpg");
        assert_eq!(rewrite_cdn_key_prefix("/a/1_x.jpg", "a", "b"), "/a/1_x.jpg");
        assert_eq!(rewrite_cdn_key_prefix("", "1", "2"), "");
    }

    #[test]
    fn rewrite_row_images_drops_a_foreign_full_image_and_keeps_the_tile() {
        let row = json!({
            "card_id": 4242,
            "ct_id": 2121,
            "image_url": "https://cdn.pokoin.com/card-images/109873_entei.jpg",
            "preview_image_url": "https://cdn.pokoin.com/card-images/previews/4242_entei_homepage.webp",
            "homepage_image_url": "https://cdn.pokoin.com/card-images/4242_entei_homepage.webp"
        });
        let urls = react_image_urls(&row);
        // The foreign full image is dropped and the preview becomes the full image.
        assert_eq!(
            urls["imageUrl"],
            json!("/card-images/card-images/previews/4242_entei_homepage.webp")
        );
        assert_eq!(urls["gridImageUrl"], urls["imageUrl"]);
        assert_eq!(urls["heroImageUrl"], urls["imageUrl"]);
        // After a foreign full image the card's own homepage webp is the tile.
        assert_eq!(
            urls["homepageImageUrl"],
            json!("/card-images/card-images/4242_entei_homepage.webp")
        );
        assert_eq!(urls["tileImageUrl"], urls["homepageImageUrl"]);
    }

    #[test]
    fn a_clean_row_uses_the_full_image_and_keeps_previews_out_of_the_grid() {
        let row = json!({
            "card_id": 4242,
            "ct_id": 2121,
            "image_url": "https://cdn.pokoin.com/card-images/4242_pikachu.jpg",
            "preview_image_url": "https://cdn.pokoin.com/card-images/previews/4242_pikachu.jpg",
            "homepage_image_url": "https://cdn.pokoin.com/card-images/4242_pikachu_homepage.webp"
        });
        let urls = react_image_urls(&row);
        assert_eq!(urls["imageUrl"], json!("/card-images/card-images/4242_pikachu.jpg"));
        assert_eq!(
            urls["previewImageUrl"],
            json!("/card-images/card-images/previews/4242_pikachu.jpg")
        );
        // The slug matches, so the homepage webp is the tile.
        assert_eq!(
            urls["tileImageUrl"],
            json!("/card-images/card-images/4242_pikachu_homepage.webp")
        );
        // A preview-only row still yields a full image (the leftover rule).
        let row = json!({
            "card_id": 4242,
            "preview_image_url": "https://cdn.pokoin.com/card-images/previews/4242_x.jpg"
        });
        let urls = react_image_urls(&row);
        assert_eq!(urls["imageUrl"], json!("/card-images/card-images/previews/4242_x.jpg"));
        assert_eq!(urls["homepageImageUrl"], json!(""));
        assert_eq!(urls["tileImageUrl"], urls["imageUrl"]);
        // No images at all.
        let urls = react_image_urls(&json!({}));
        assert_eq!(urls["imageUrl"], json!(""));
    }

    #[test]
    fn cardtrader_hosts_are_blanked() {
        assert!(is_cardtrader_host("https://www.cardtrader.com/x.jpg"));
        assert!(is_cardtrader_host("https://cardtrader.com/x.jpg"));
        assert!(is_cardtrader_host("cdn.cardtrader.com/x.jpg"));
        assert!(!is_cardtrader_host("https://cdn.pokoin.com/x.jpg"));
        assert!(!is_cardtrader_host(""));
        assert!(!is_cardtrader_host("not-a-host"));
        let row = json!({
            "cdn_image_url": "https://www.cardtrader.com/a.jpg",
            "image_url": "https://cdn.pokoin.com/b.jpg",
            "preview_image_url": "cardtrader.com/c.jpg",
            "homepage_image_url": "https://cdn.pokoin.com/d.webp"
        });
        let dropped = drop_foreign_images(&row);
        assert_eq!(dropped["cdn_image_url"], json!(""));
        assert_eq!(dropped["preview_image_url"], json!(""));
        assert_eq!(dropped["image_url"], json!("https://cdn.pokoin.com/b.jpg"));
        assert_eq!(dropped["homepage_image_url"], json!("https://cdn.pokoin.com/d.webp"));
    }

    #[test]
    fn holdings_render_the_react_shape() {
        let row = json!({
            "card_id": 4242, "ct_id": 2121,
            "catalog_name": "Pikachu", "expansion_name": "Base Set", "card_number": "58/102",
            "floor_pkn": 12.5, "total_pkn": 25.0, "qty": 2, "listing_count": 3,
            "condition": "NM", "language": "en", "sealed": false,
            "canonical_path": "/marketplace/en/cards/4242/pikachu",
            "image_url": "https://cdn.pokoin.com/card-images/4242_pikachu.jpg"
        });
        let holding = holding_from_row(&row, "pokemon");
        assert_eq!(holding["id"], json!("4242"));
        assert_eq!(holding["cardId"], json!("4242"));
        assert_eq!(holding["name"], json!("Pikachu"));
        assert_eq!(holding["expansion"], json!("Base Set"));
        assert_eq!(holding["set"], json!("Base Set"));
        assert_eq!(holding["number"], json!("58/102"));
        assert_eq!(holding["game"], json!("Pokémon"));
        assert_eq!(holding["gameId"], json!("pokemon"));
        assert_eq!(holding["qty"], json!(2));
        assert_eq!(holding["listingCount"], json!(3));
        assert_eq!(holding["pricePkn"], json!(12.5));
        assert_eq!(holding["totalPkn"], json!(25));
        assert_eq!(holding["language"], json!("EN"));
        assert_eq!(holding["source"], json!("native"));
        assert_eq!(holding["canonicalPath"], json!("/marketplace/en/cards/4242/pikachu"));
        assert_eq!(holding["imageUrl"], json!("/card-images/card-images/4242_pikachu.jpg"));

        // Zero quantity becomes 1; a catalog-only row says so; the path is built.
        let row = json!({ "card_id": 7, "catalog_name": "Eevee", "floor_pkn": 5, "qty": 0 });
        let holding = holding_from_row(&row, "magic");
        assert_eq!(holding["qty"], json!(1));
        assert_eq!(holding["totalPkn"], json!(5));
        assert_eq!(holding["source"], json!("catalog"));
        assert_eq!(holding["game"], json!("magic"));
        assert_eq!(holding["canonicalPath"], json!("/marketplace/en/cards/7"));
        assert_eq!(holding["condition"], json!(""));
        assert_eq!(holding["sealed"], json!(false));

        // A row with no usable public id is filtered out of a payload.
        let holding = holding_from_row(&json!({ "card_id": "abc" }), "pokemon");
        assert_eq!(holding["id"], json!(""));
    }

    #[test]
    fn holdings_fall_back_through_the_name_and_set_columns() {
        let row = json!({
            "card_id": 1, "card_name": "From listings", "catalog_set": "From cheap",
            "collector_number": "9/9", "sealed": true, "total_pkn": 0, "floor_pkn": 3, "qty": 4
        });
        let holding = holding_from_row(&row, "pokemon");
        assert_eq!(holding["name"], json!("From listings"));
        assert_eq!(holding["expansion"], json!("From cheap"));
        assert_eq!(holding["number"], json!("9/9"));
        assert_eq!(holding["sealed"], json!(true));
        // totalPkn falls back to floor * qty.
        assert_eq!(holding["totalPkn"], json!(12));
    }

    #[test]
    fn payload_totals_and_set_rollups() {
        let rows = vec![
            json!({ "card_id": 1, "catalog_name": "A", "expansion_name": "Set X",
                    "floor_pkn": 10, "total_pkn": 30, "qty": 3, "listing_count": 1 }),
            json!({ "card_id": 2, "catalog_name": "B", "expansion_name": "Set X",
                    "floor_pkn": 5, "total_pkn": 5, "qty": 1, "listing_count": 0 }),
            json!({ "card_id": 3, "catalog_name": "C", "expansion_name": "Set Y",
                    "floor_pkn": 100, "total_pkn": 100, "qty": 1, "listing_count": 4 }),
            json!({ "card_id": "bad", "catalog_name": "dropped" }),
        ];
        let payload = payload_from_rows(&rows, "pokemon", "2026-10-08T00:00:00.000Z");
        assert_eq!(payload["game"], json!("pokemon"));
        assert_eq!(payload["generated"], json!("2026-10-08T00:00:00.000Z"));
        assert_eq!(payload["items"].as_array().unwrap().len(), 3);
        assert_eq!(payload["totals"]["pkn"], json!(135));
        assert_eq!(payload["totals"]["qty"], json!(5));
        assert_eq!(payload["totals"]["listings"], json!(5));
        assert_eq!(payload["totals"]["cards"], json!(3));
        assert_eq!(payload["games"][0]["name"], json!("Pokémon"));
        assert_eq!(payload["games"][0]["pkn"], json!(135));
        let sets = payload["sets"].as_array().unwrap();
        // Biggest value first: Set Y (100) before Set X (35).
        assert_eq!(sets[0]["name"], json!("Set Y"));
        assert_eq!(sets[0]["pkn"], json!(100));
        assert_eq!(sets[1]["name"], json!("Set X"));
        assert_eq!(sets[1]["pkn"], json!(35));
        assert_eq!(sets[1]["qty"], json!(4));
        assert_eq!(sets[1]["listings"], json!(1));
    }

    #[test]
    fn an_empty_payload_has_the_documented_shape() {
        let payload = empty_payload("one_piece", "now");
        assert_eq!(payload["game"], json!("one_piece"));
        assert_eq!(payload["totals"]["pkn"], json!(0));
        assert_eq!(payload["totals"]["cards"], json!(0));
        assert_eq!(payload["games"][0]["name"], json!("One Piece"));
        assert_eq!(payload["sets"], json!([]));
        assert_eq!(payload["items"], json!([]));
        // Unknown games fall back to the raw id, and an empty one to Pokoin.
        assert_eq!(game_label("gundam"), "gundam");
        assert_eq!(game_label(""), "Pokoin");
    }

    #[test]
    fn undefined_tables_are_recognised_from_the_message() {
        assert!(is_undefined_table(&ApiError::internal(
            "error returned from database: relation \"public.marketplace_user_listings\" does not exist"
        )));
        assert!(is_undefined_table(&ApiError::internal("42P01")));
        assert!(!is_undefined_table(&ApiError::internal("connection refused")));
    }

    #[test]
    fn the_select_sql_adapts_to_the_available_relations() {
        // Both relations present.
        let parts = catalog_select_sql(true, true);
        assert!(parts.listing_join.contains("marketplace_user_listings"));
        assert!(parts.cheap_join.contains("cheapest_homepage_cache_blueprint"));
        assert!(parts.select.contains("coalesce(listings.floor_pkn, cheap.floor_pkn, 0)"));
        assert!(parts.select.contains("coalesce(listings.qty, cheap.qty, 1)"));
        assert!(parts.select.contains("coalesce(listings.total_pkn,"));
        assert!(parts.select.contains("coalesce(listings.sealed, c.item_kind = 'product')"));
        assert!(parts.select.contains("listings.collector_number as collector_number"));
        assert!(parts.select.contains("listings.card_name as card_name"));

        // Only the listing relation.
        let parts = catalog_select_sql(true, false);
        assert!(parts.cheap_join.is_empty());
        assert!(parts.select.contains("coalesce(listings.floor_pkn, 0)"));
        assert!(parts.select.contains("coalesce(listings.qty, 1)"));
        // Without the cheap relation the total is still the listing total.
        assert!(parts.select.contains("coalesce(listings.total_pkn,"));

        // Only the cheap cache.
        let parts = catalog_select_sql(false, true);
        assert!(parts.listing_join.is_empty());
        assert!(parts.select.contains("coalesce(cheap.floor_pkn, 0)"));
        assert!(parts.select.contains("coalesce(cheap.qty, 1)"));
        assert!(parts.select.contains("(coalesce(cheap.floor_pkn, 0)) * (coalesce(cheap.qty, 1))"));
        assert!(parts.select.contains("(0)::int as listing_count"));
        assert!(parts.select.contains("c.item_kind = 'product'"));
        assert!(parts.select.contains("null::text as card_name"));
        assert!(parts.select.contains("null as condition"));

        // Neither: a pure catalog row.
        let parts = catalog_select_sql(false, false);
        assert!(parts.listing_join.is_empty());
        assert!(parts.cheap_join.is_empty());
        assert!(parts.select.contains("(0)::float8 as floor_pkn"));
        assert!(parts.select.contains("(1)::int as qty"));
        assert!(parts.select.contains("c.name as catalog_name"));
        assert!(parts.select.contains("urls.canonical_path"));

        // The shared joins are always the documented ones.
        assert!(listing_join_sql().contains("listings.status = 'active'"));
        assert!(listing_join_sql().contains("not ilike '%cardtrader%'"));
        assert!(cheap_lookup_sql().contains("cheap.provider in ('pokoin_native', 'cardtrader')"));
        assert!(cheap_lookup_sql().contains("limit 1"));
        assert!(urls_join_sql().contains("u.language = 'en'"));
    }
}
