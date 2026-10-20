//! `card.deskArtUrl` on the card page: the exact URL of the card desk's hero
//! scan, so `market/public/card-url-boot.js` can start it before the SPA entry
//! chunk runs, and the desk `<img>` then reuses that download.
//!
//! A port of `clientDeskArtUrl` in `market/src/api.js` (`imageSrc` hero/grid,
//! `ownCatalogImage`, `rewritePublicImage`, `rasterSiblings`, `cdnFetchUrl`
//! in `market/src/image-urls.js`, and the slug helpers in `card-stub.js`).
//! The cache-buster tables are the same JSON files the SPA imports. Regex
//! classes are ASCII to match JavaScript's non-Unicode `\d` and `/i`.
//! `fixtures/desk-art-golden.json` (from `scripts/export-desk-art-golden.mjs`)
//! holds the JavaScript answers for real card pages; the test below asserts
//! every one.
use regex::Regex;
use serde_json::Value;
use std::{collections::HashSet, sync::LazyLock};

const CDN_ORIGIN: &str = "https://cdn.pokoin.com";

/// Satellite catalogs live under `/{slug}/` on the CDN (`isPrefixedCatalog`);
/// each is also that game's site slug (`market/src/game.js`).
const PREFIXED: [&str; 24] = [
    "one-piece", "riftbound", "magic", "yugioh", "lorcana", "flesh-and-blood", "digimon",
    "dragon-ball-super", "vanguard", "star-wars", "union-arena", "gundam", "sorcery", "palworld",
    "cyberpunk", "weiss-schwarz", "final-fantasy", "force-of-will", "world-of-warcraft",
    "battle-spirits-saga", "star-wars-destiny", "dragon-born", "my-little-pony", "the-spoils",
];

const RARITY_TAILS: [&str; 21] = [
    "special-illustration-rare", "illustration-rare", "gold-secret-rare", "secret-rare",
    "hyper-rare", "ultra-rare", "double-rare", "rainbow-rare", "gold-rare", "amazing-rare",
    "full-art", "alternate-art", "super-rare", "uncommon", "common", "alt-art",
    "cracked-ice-holo", "cosmos-holo", "reverse-holo", "holo-rare", "non-holo",
];

struct CacheRule {
    token: String,
    ids: HashSet<u64>,
    ranges: Vec<(u64, u64)>,
}

static CACHE_TABLE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../market/src/data/catalog-image-cache.json")).expect("catalog-image-cache.json")
});

static THUMB_TOKEN: LazyLock<String> = LazyLock::new(|| CACHE_TABLE["thumbToken"].as_str().unwrap_or("").to_owned());

static CACHE_RULES: LazyLock<Vec<CacheRule>> = LazyLock::new(|| {
    let table = &*CACHE_TABLE;
    let list = |name: &str| -> Vec<u64> {
        let text = match name {
            "small-scan-ctf1" => include_str!("../../../../market/src/data/small-scan-ctf1.json"),
            "pokoin-placeholder-leftovers" => include_str!("../../../../market/src/data/pokoin-placeholder-leftovers.json"),
            other => panic!("catalog-image-cache.json names an unknown idList {other}"),
        };
        serde_json::from_str(text).expect("id list")
    };
    let ids = |v: &Value| v.as_array().map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>()).unwrap_or_default();
    table["rules"].as_array().expect("rules").iter().map(|rule| {
        let mut set: HashSet<u64> = ids(&rule["ids"]).into_iter().collect();
        if let Some(name) = rule["idList"].as_str() {
            set.extend(list(name));
        }
        let ranges = rule["ranges"].as_array().map(|a| a.iter().filter_map(|r| Some((r[0].as_u64()?, r[1].as_u64()?))).collect()).unwrap_or_default();
        CacheRule { token: rule["token"].as_str().expect("token").to_owned(), ids: set, ranges }
    }).collect()
});

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("desk_art regex")
}

static PREFIXED_RE: LazyLock<Regex> = LazyLock::new(|| re(&format!("(?:^|/)(?i-u:{})/", PREFIXED.join("|"))));
static COMPETITIVE_RE: LazyLock<Regex> = LazyLock::new(|| re("(?:^|/)(?i-u:competitive)/"));
static VERSION_QUERY_RE: LazyLock<Regex> = LazyLock::new(|| re("[?&]v="));
static PREVIEW_RE: LazyLock<Regex> = LazyLock::new(|| re("/(?i-u:previews/|preview_)"));
static CARDTRADER_HOST_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|\.)(?i-u:cardtrader\.com)$"));
static HOMEPAGE_WEBP_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u:_homepage\.webp)(\?|$)"));
static HOMEPAGE_THUMB_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u:_homepage\.webp)(?:[?#]|$)"));
static VERSION_VALUE_RE: LazyLock<Regex> = LazyLock::new(|| re("([?&]v=)([^&#]*)"));
static PNG_WEBP_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\.(?i-u:png|webp)(\?|$)"));
static RASTER_EXT_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\.(?i-u:jpe?g|png|webp)(\?|$)"));
static EXT_MATCH_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\.((?i-u:jpe?g|png|webp))(?:\?|$)"));
static STEM_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^(.*?)(?:(?i-u:_homepage))?\.(?i-u:jpe?g|png|webp)(\?.*)?$"));
static HOMEPAGE_TAIL_RE: LazyLock<Regex> = LazyLock::new(|| re("(?i-u:_homepage)$"));
static SLUG_HOMEPAGE_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u:_homepage)(\.(?i-u:webp|jpe?g|png))"));
static SLUG_EXT_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\.(?i-u:jpe?g|png|webp)$"));
static SLUG_ID_RE: LazyLock<Regex> = LazyLock::new(|| re("^[0-9]+_"));
static FILE_ID_RE: LazyLock<Regex> = LazyLock::new(|| re("^([0-9]+)_"));
static CARD_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| re("^(?i-u:card|product)-"));
static COLLECTOR_RE: LazyLock<Regex> = LazyLock::new(|| re("-([0-9]{1,3})-([0-9]{2,3})(?:-|$)"));
static PROMO_RE: LazyLock<Regex> = LazyLock::new(|| re("-([a-zA-Z]{2,8}[pP])-([0-9]{1,4})(?:-|$)"));
static YEAR_VERSION_RE: LazyLock<Regex> = LazyLock::new(|| re("^(.*?)-((?:[a-zA-Z]+-)+[a-zA-Z]+-[0-9]{4})$"));
static SET_CODE_TAIL_RE: LazyLock<Regex> = LazyLock::new(|| re("-[a-zA-Z]{1,4}[0-9][a-zA-Z0-9]{0,4}$"));
static CODED_COLLECTOR_RE: LazyLock<Regex> = LazyLock::new(|| re("^(.*?)-((?i-u:op|st|eb|prb)[0-9]{2}-[0-9]{3}[a-zA-Z]?)(?:-|$)"));
static BARE_COLLECTOR_RE: LazyLock<Regex> = LazyLock::new(|| re("-([0-9]{1,3})-"));
static NAME_QUOTES_RE: LazyLock<Regex> = LazyLock::new(|| re("['’]"));
static NAME_GAPS_RE: LazyLock<Regex> = LazyLock::new(|| re("[^a-z0-9]+"));

/// JavaScript `value || …` on one card field: the field when it is truthy.
fn truthy(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) if n.as_f64().is_some_and(|f| f != 0.0) => Some(n.to_string()),
        Value::Bool(true) => Some("true".into()),
        _ => None,
    }
}

fn first(card: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| truthy(card.get(k))).unwrap_or_default()
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `str.length` in JavaScript (UTF-16 code units).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn replace_first(re: &Regex, text: &str, with: impl Fn(&regex::Captures) -> String) -> String {
    re.replace(text, |caps: &regex::Captures| with(caps)).into_owned()
}

fn group<'a>(caps: &'a regex::Captures, i: usize) -> &'a str {
    caps.get(i).map_or("", |m| m.as_str())
}

/// The game's site and CDN slug; Pokemon has none.
pub fn game_slug(game: &str) -> &'static str {
    let slug = game.trim().to_ascii_lowercase().replace('_', "-");
    PREFIXED.iter().find(|s| **s == slug).copied().unwrap_or("")
}

fn is_prefixed_catalog(value: &str) -> bool {
    PREFIXED_RE.is_match(value)
}

fn real_public_card_id(card_id: &str) -> String {
    let id = card_id.trim();
    if !digits(id) {
        return id.to_owned();
    }
    match id.parse::<u64>() {
        Ok(value) if value >= 999_000_000 => (value - 999_000_000).to_string(),
        _ => id.to_owned(),
    }
}

fn leftover_cdn_id(card_id: &str) -> String {
    let id = real_public_card_id(card_id);
    if !digits(&id) {
        return String::new();
    }
    match id.parse::<u128>() {
        Ok(0) | Err(_) => String::new(),
        Ok(value) if value % 2 == 0 => (value / 2).to_string(),
        Ok(_) => id,
    }
}

fn catalog_file_name(value: &str) -> &str {
    let path = value.split(['?', '#']).next().unwrap_or("");
    path.split('/').filter(|p| !p.is_empty()).next_back().unwrap_or("")
}

fn catalog_image_slug(value: &str) -> String {
    let name = catalog_file_name(value);
    let name = replace_first(&SLUG_HOMEPAGE_RE, name, |c| group(c, 1).to_owned());
    let name = SLUG_EXT_RE.replace(&name, "");
    SLUG_ID_RE.replace(&name, "").to_lowercase()
}

fn catalog_image_id(value: &str) -> String {
    FILE_ID_RE.captures(catalog_file_name(value)).map(|c| group(&c, 1).to_owned()).unwrap_or_default()
}

fn catalog_cache_token(id: &str) -> &'static str {
    // JavaScript Number(''): 0, which no rule holds.
    let value = if id.is_empty() { 0 } else { id.parse::<u64>().unwrap_or(u64::MAX) };
    CACHE_RULES.iter()
        .find(|rule| rule.ids.contains(&value) || rule.ranges.iter().any(|(from, to)| value >= *from && value <= *to))
        .map_or("", |rule| rule.token.as_str())
}

fn with_catalog_cache(url: &str) -> String {
    if url.is_empty() || is_prefixed_catalog(url) || COMPETITIVE_RE.is_match(url) {
        return url.to_owned();
    }
    let token = catalog_cache_token(&catalog_image_id(url));
    if token.is_empty() || VERSION_QUERY_RE.is_match(url) {
        return with_thumb_token(url);
    }
    with_thumb_token(&format!("{url}{}v={token}", if url.contains('?') { '&' } else { '?' }))
}

/// `withThumbToken`: Pokemon `_homepage.webp` thumbs were all rebuilt under their
/// old keys, so their `v` also carries `thumbToken` (`v=hd1.t480`, or `v=t480`).
fn with_thumb_token(url: &str) -> String {
    let token = THUMB_TOKEN.as_str();
    if token.is_empty() || !HOMEPAGE_THUMB_RE.is_match(url) || is_prefixed_catalog(url) {
        return url.to_owned();
    }
    let Some(caps) = VERSION_VALUE_RE.captures(url) else {
        let (head, hash) = url.find('#').map_or((url, ""), |i| url.split_at(i));
        return format!("{head}{}v={token}{hash}", if head.contains('?') { '&' } else { '?' });
    };
    let value = group(&caps, 2);
    if value == token || value.ends_with(&format!(".{token}")) {
        return url.to_owned();
    }
    let whole = caps.get(0).expect("match");
    let dot = if value.is_empty() { String::new() } else { format!("{value}.") };
    format!("{}{}{dot}{token}{}", &url[..whole.start()], group(&caps, 1), &url[whole.end()..])
}

/// `withoutThumbToken`: the JPEG behind a thumb keeps only its own id token.
fn without_thumb_token(url: &str) -> String {
    let token = THUMB_TOKEN.as_str();
    let Some(at) = url.find('?') else { return url.to_owned() };
    if token.is_empty() {
        return url.to_owned();
    }
    let hash_at = url[at..].find('#').map(|i| at + i);
    let query = &url[at + 1..hash_at.unwrap_or(url.len())];
    let hash = hash_at.map_or("", |i| &url[i..]);
    let suffix = format!(".{token}");
    let params: Vec<String> = query
        .split('&')
        .filter_map(|param| match param.strip_prefix("v=") {
            Some(value) if value == token => None,
            Some(value) => Some(value.strip_suffix(&suffix).map_or_else(|| param.to_owned(), |v| format!("v={v}"))),
            None => Some(param.to_owned()),
        })
        .collect();
    let query = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
    format!("{}{query}{hash}", &url[..at])
}

fn leftover_key_matches_card(url: &str, card_id: &str) -> bool {
    let file_id = catalog_image_id(url);
    let leftover = leftover_cdn_id(card_id);
    !file_id.is_empty() && !leftover.is_empty() && file_id == leftover
}

/// `(^|/)(previews/)?{fileId}_` → `$1$2{leftover}_`, first match only.
fn rewrite_catalog_image_id(url: &str, card_id: &str) -> String {
    let leftover = leftover_cdn_id(card_id);
    let file_id = catalog_image_id(url);
    if url.is_empty() || leftover.is_empty() || file_id.is_empty() || file_id == leftover || is_prefixed_catalog(url) {
        return url.to_owned();
    }
    let key = format!("{file_id}_");
    let at = |rest: &str| -> Option<usize> {
        if rest.starts_with(&format!("previews/{key}")) {
            Some("previews/".len())
        } else if rest.starts_with(&key) {
            Some(0)
        } else {
            None
        }
    };
    let bytes = url.as_bytes();
    for p in 0..bytes.len() {
        let hit = if p == 0 { at(url) } else { None }
            .or_else(|| (bytes[p] == b'/').then(|| at(&url[p + 1..]).map(|o| o + 1)).flatten());
        if let Some(offset) = hit {
            let start = p + offset;
            return format!("{}{leftover}_{}", &url[..start], &url[start + key.len()..]);
        }
    }
    url.to_owned()
}

fn catalog_slug_head(slug: &str) -> String {
    let lower = slug.to_lowercase();
    let parts: Vec<&str> = lower.split('-').filter(|p| !p.is_empty()).collect();
    match parts.first() {
        None => String::new(),
        Some(head) if js_len(head) >= 4 => (*head).to_owned(),
        Some(_) => parts.iter().take(2).copied().collect::<Vec<_>>().join("-"),
    }
}

fn catalog_slug_matches_card(url: &str, id: &str, card: &Value, game: &str) -> bool {
    let got = catalog_image_slug(url);
    let want = catalog_image_slug(&leftover_url_from_card(id, card, game));
    if want.is_empty() {
        return true;
    }
    if got.is_empty() {
        return false;
    }
    if got == want || got.starts_with(&format!("{want}-")) || want.starts_with(&format!("{got}-")) {
        return true;
    }
    let got_head = catalog_slug_head(&got);
    !got_head.is_empty() && got_head == catalog_slug_head(&want)
}

fn leftover_url(card_id: &str, name_slug: &str, game: &str) -> String {
    let leftover = leftover_cdn_id(card_id);
    if leftover.is_empty() {
        return String::new();
    }
    let stem = name_slug.trim_matches('-');
    let slug = game_slug(game);
    let prefix = if slug.is_empty() { String::new() } else { format!("{slug}/") };
    format!("/card-images/{prefix}{leftover}_{stem}.jpg")
}

/// `leftoverUrlFromCard({ ...card, id })`.
fn leftover_url_from_card(id: &str, card: &Value, game: &str) -> String {
    if !digits(id) {
        return String::new();
    }
    let path = first(card, &["canonicalPath", "canonical_path"]);
    let slug_part = path.split('/').filter(|p| !p.is_empty()).next_back().unwrap_or("");
    let from_path = name_slug_from_card_slug(slug_part);
    if !from_path.is_empty() && !digits(&from_path) {
        return leftover_url(id, &from_path, game);
    }
    let name = first(card, &["name"]).trim().to_lowercase();
    let name = NAME_QUOTES_RE.replace_all(&name, "");
    let name = NAME_GAPS_RE.replace_all(&name, "-");
    leftover_url(id, name.trim_matches('-'), game)
}

/// `prettySlug(x)` is non-empty exactly when `x` has a non-empty `-` segment.
fn pretty_nonempty(slug: &str) -> bool {
    slug.split('-').any(|w| !w.is_empty())
}

/// `parseMarketplaceCardSlug(slug).nameSlug`.
fn name_slug_from_card_slug(slug: &str) -> String {
    let raw = slug.trim().trim_matches('/');
    let body = CARD_PREFIX_RE.replace(raw, "");
    let body = body.as_ref();
    if body.is_empty() {
        return String::new();
    }
    let mut numbered = false;
    let mut head = body.to_owned();
    let mut promo_version = false;
    if let Some(m) = COLLECTOR_RE.find(body) {
        numbered = true;
        head = body[..m.start()].to_owned();
    } else if let Some(m) = PROMO_RE.find_iter(body).last() {
        numbered = true;
        let before = &body[..m.start()];
        match YEAR_VERSION_RE.captures(before) {
            Some(c) if !group(&c, 1).is_empty() => {
                head = group(&c, 1).to_owned();
                promo_version = true;
            }
            _ => head = before.to_owned(),
        }
    } else if let Some(at) = body.find("--").filter(|at| *at > 0) {
        head = body[..at].to_owned();
    }
    let mut rarity = false;
    let mut name_slug = head.clone();
    for token in RARITY_TAILS {
        if head == token || head.ends_with(&format!("-{token}")) {
            rarity = true;
            let kept = &head[..head.len() - token.len()];
            name_slug = kept.strip_suffix('-').unwrap_or(kept).to_owned();
            break;
        }
        if head.starts_with(&format!("{token}-")) {
            rarity = true;
            name_slug = head[token.len() + 1..].to_owned();
            break;
        }
    }
    if rarity || promo_version {
        name_slug = SET_CODE_TAIL_RE.replace(&name_slug, "").into_owned();
    }
    if !numbered {
        if let Some(peeled) = peel_printed_collector(&name_slug) {
            name_slug = peeled;
        }
    }
    name_slug
}

fn peel_printed_collector(name_slug: &str) -> Option<String> {
    if let Some(c) = CODED_COLLECTOR_RE.captures(name_slug) {
        if !group(&c, 1).is_empty() {
            return Some(group(&c, 1).to_owned());
        }
    }
    let last = BARE_COLLECTOR_RE.find_iter(name_slug).last()?;
    if last.start() == 0 {
        return None;
    }
    let name = &name_slug[..last.start()];
    if name.is_empty() || !pretty_nonempty(&name_slug[last.end()..]) {
        return None;
    }
    Some(name.to_owned())
}

fn parse_url(text: &str) -> Option<url::Url> {
    url::Url::options().base_url(Some(&BASE)).parse(text).ok()
}

static BASE: LazyLock<url::Url> = LazyLock::new(|| url::Url::parse("https://pokoin.com").expect("base"));

/// `pathname + search` of a parsed URL (`search` is empty for a bare `?`).
fn path_and_search(url: &url::Url) -> String {
    match url.query() {
        Some(q) if !q.is_empty() => format!("{}?{q}", url.path()),
        _ => url.path().to_owned(),
    }
}

/// `rewritePublicImage(value, { allowPreview: false })`, alias `preferFullImage`.
fn prefer_full_image(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() || PREVIEW_RE.is_match(text) {
        return String::new();
    }
    let mut next = text.to_owned();
    if let Some(url) = parse_url(text) {
        let host = url.host_str().unwrap_or("");
        if CARDTRADER_HOST_RE.is_match(host) {
            return String::new();
        }
        if host == "cdn.pokoin.com" {
            next = format!("/card-images{}", path_and_search(&url));
        }
    }
    if HOMEPAGE_WEBP_RE.is_match(&next) {
        next = without_thumb_token(&replace_first(&HOMEPAGE_WEBP_RE, &next, |c| format!(".jpg{}", group(c, 1))));
    }
    if is_prefixed_catalog(&next) || COMPETITIVE_RE.is_match(&next) {
        return next;
    }
    with_catalog_cache(&replace_first(&PNG_WEBP_RE, &next, |c| format!(".jpg{}", group(c, 1))))
}

fn homepage_derivative_url(value: &str) -> String {
    let full = prefer_full_image(value);
    if full.is_empty() {
        return full;
    }
    if HOMEPAGE_WEBP_RE.is_match(&full) {
        return with_thumb_token(&full);
    }
    with_thumb_token(&replace_first(&RASTER_EXT_RE, &full, |c| format!("_homepage.webp{}", group(c, 1))))
}

fn own_catalog_image(card: &Value, advertised: &str, game: &str) -> String {
    if is_prefixed_catalog(advertised) {
        return advertised.to_owned();
    }
    let id = first(card, &["id", "card_id"]);
    if !advertised.is_empty() && leftover_key_matches_card(advertised, &id) && catalog_slug_matches_card(advertised, &id, card, game) {
        return with_catalog_cache(advertised);
    }
    let rewritten = rewrite_catalog_image_id(advertised, &id);
    if !rewritten.is_empty() && leftover_key_matches_card(&rewritten, &id) && catalog_slug_matches_card(&rewritten, &id, card, game) {
        return with_catalog_cache(rewritten.split(['?', '#']).next().unwrap_or(""));
    }
    let leftover = leftover_url_from_card(&id, card, game);
    let pick = [leftover.as_str(), rewritten.as_str(), advertised].into_iter().find(|s| !s.is_empty()).unwrap_or("");
    with_catalog_cache(pick)
}

fn hero_src(card: &Value, game: &str) -> String {
    let advertised = first(card, &[
        "heroImageUrl", "imageUrl", "cdn_image_url", "image_url",
        "gridImageUrl", "tileImageUrl", "homepageImageUrl", "homepage_image_url",
    ]);
    own_catalog_image(card, &prefer_full_image(&advertised), game)
}

fn grid_src(card: &Value, game: &str) -> String {
    let full = own_catalog_image(card, &prefer_full_image(&first(card, &["gridImageUrl", "imageUrl", "cdn_image_url", "image_url"])), game);
    let advertised = first(card, &["tileImageUrl", "homepageImageUrl", "homepage_image_url"]);
    let public_id = real_public_card_id(&first(card, &["id", "card_id"]));
    let full_or = if full.is_empty() { advertised.as_str() } else { full.as_str() };
    if !advertised.is_empty() && leftover_key_matches_card(&advertised, &public_id) {
        let (home, cat) = (catalog_image_slug(&advertised), catalog_image_slug(full_or));
        if !home.is_empty() && home == cat {
            return homepage_derivative_url(&advertised);
        }
    }
    homepage_derivative_url(full_or)
}

/// `stem + ext + query` of a satellite master (`prefixedMasterSiblings(value)[0]`).
fn prefixed_master(value: &str) -> String {
    let full = prefer_full_image(value);
    let current = if full.is_empty() { value } else { full.as_str() };
    let Some(stem) = STEM_RE.captures(current) else {
        return full;
    };
    let ext = EXT_MATCH_RE.captures(current)
        .map(|c| format!(".{}", group(&c, 1).to_ascii_lowercase().replacen("jpeg", "jpg", 1)))
        .unwrap_or_else(|| ".jpg".into());
    let base = HOMEPAGE_TAIL_RE.replace(group(&stem, 1), "");
    format!("{base}{ext}{}", group(&stem, 2))
}

/// `rasterSiblings(value, { full: true })[0]`.
fn first_full_sibling(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    if is_prefixed_catalog(text) {
        return prefixed_master(text);
    }
    prefer_full_image(text)
}

fn cdn_fetch_url(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() || text.starts_with("data:") || text.starts_with("blob:") {
        return text.to_owned();
    }
    if let Some(url) = parse_url(text) {
        if url.host_str() == Some("cdn.pokoin.com") {
            return format!("{CDN_ORIGIN}{}", path_and_search(&url));
        }
        if url.path().starts_with("/card-images/") {
            return format!("{CDN_ORIGIN}{}", &path_and_search(&url)["/card-images".len()..]);
        }
    }
    if text.starts_with("/card-images/") {
        return format!("{CDN_ORIGIN}{}", &text["/card-images".len()..]);
    }
    text.to_owned()
}

/// The desk hero URL for one card-page `card` (a `react_record`) of `game`.
pub fn desk_art_url(card: &Value, game: &str) -> String {
    let hero = hero_src(card, game);
    let src = if hero.is_empty() { grid_src(card, game) } else { hero };
    cdn_fetch_url(&first_full_sibling(&src))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn leftover_key_cache_buster_and_cdn_host() {
        let card = json!({"id":"222454","name":"Charizard","canonicalPath":"/marketplace/en/cards/222454/charizard-4-102-base-set",
            "heroImageUrl":"/card-images/222454_charizard-4-102-base-set.jpg"});
        assert_eq!(desk_art_url(&card, "pokemon"), "https://cdn.pokoin.com/111227_charizard-4-102-base-set.jpg?v=bsu2");
    }

    #[test]
    fn satellite_masters_keep_their_extension_and_prefix() {
        let card = json!({"id":"20","imageUrl":"/card-images/magic/10_card.png"});
        assert_eq!(desk_art_url(&card, "magic"), "https://cdn.pokoin.com/magic/10_card.png");
        let bare = json!({"id":"20","name":"Black Lotus"});
        assert_eq!(desk_art_url(&bare, "magic"), "https://cdn.pokoin.com/magic/10_black-lotus.jpg");
    }

    #[test]
    fn previews_and_cardtrader_scans_fall_back_to_the_leftover() {
        let card = json!({"id":"806390","name":"Pikachu","heroImageUrl":"https://www.cardtrader.com/uploads/x.jpg"});
        assert_eq!(desk_art_url(&card, "pokemon"), "https://cdn.pokoin.com/403195_pikachu.jpg");
    }

    #[test]
    fn thumbs_carry_the_thumb_token_and_their_jpeg_does_not() {
        assert_eq!(with_thumb_token("/card-images/1_x_homepage.webp"), "/card-images/1_x_homepage.webp?v=t480");
        assert_eq!(with_thumb_token("/card-images/1_x_homepage.webp?v=hd1"), "/card-images/1_x_homepage.webp?v=hd1.t480");
        assert_eq!(with_thumb_token("/card-images/1_x_homepage.webp?v=hd1.t480"), "/card-images/1_x_homepage.webp?v=hd1.t480");
        assert_eq!(with_thumb_token("/card-images/1_x.jpg?v=hd1"), "/card-images/1_x.jpg?v=hd1");
        assert_eq!(with_thumb_token("/card-images/magic/1_x_homepage.webp"), "/card-images/magic/1_x_homepage.webp");
        assert_eq!(without_thumb_token("/card-images/1_x.jpg?v=hd1.t480"), "/card-images/1_x.jpg?v=hd1");
        assert_eq!(without_thumb_token("/card-images/1_x.jpg?v=t480"), "/card-images/1_x.jpg");
        assert_eq!(without_thumb_token("/card-images/1_x.jpg?a=1&v=t480#z"), "/card-images/1_x.jpg?a=1#z");
        assert_eq!(prefer_full_image("/card-images/1_x_homepage.webp?v=hd1.t480"), "/card-images/1_x.jpg?v=hd1");
        assert_eq!(
            homepage_derivative_url("/card-images/114719_wigglytuff-rare-holo-13-100-ex-crystal-guardians.jpg"),
            "/card-images/114719_wigglytuff-rare-holo-13-100-ex-crystal-guardians_homepage.webp?v=wg1.t480"
        );
    }

    #[test]
    fn real_card_pages_match_the_spa() {
        let golden: Value = serde_json::from_str(include_str!("../fixtures/desk-art-golden.json")).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert!(cases.len() >= 1000, "golden has {} cases", cases.len());
        let mut wrong = Vec::new();
        for case in cases {
            let got = desk_art_url(&case["card"], case["game"].as_str().unwrap());
            if got != case["url"].as_str().unwrap() {
                wrong.push(format!("{} {}: rust {got} js {}", case["game"], case["card"]["id"], case["url"]));
            }
        }
        assert!(wrong.is_empty(), "{} of {} differ:\n{}", wrong.len(), cases.len(), wrong.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    }
}
