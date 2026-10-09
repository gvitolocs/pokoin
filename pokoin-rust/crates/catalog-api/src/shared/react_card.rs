//! Port of `_marketplace_react_card.js` — the canonical card JSON for React
//! clients, its parsers and the read-CORS/timeout plumbing.
//!
//! `to_react_card` must match `toReactCard` exactly; do not reuse
//! `pokoin_catalog::card::react_record` (an older partial port).

use serde_json::{Map, Value};
use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use super::{card_emoji, js, row};

pub use pokoin_api_common::http::{
    json_ok, parse_id_list, parse_limit, parse_offset, parse_public_card_id, READ_CORS,
};

/// `cleanText(value, maxLength = 800)` of this module.
pub fn clean_text(value: Option<&Value>, max_length: usize) -> String {
    js::clean_text(value, max_length)
}

/// `normalizeImageUrl(value)` — `https://cdn.pokoin.com/x` becomes
/// `/card-images/x`, everything else (and unparseable input) stays.
pub fn normalize_image_url(value: Option<&Value>) -> String {
    let text = js::string_or_empty(value);
    if text.trim().is_empty() {
        return String::new();
    }
    let Some(url) = parse_url(&text) else {
        return text;
    };
    if url.hostname != "cdn.pokoin.com" {
        return text;
    }
    format!("/card-images{}{}", url.pathname, url.search)
}

struct ParsedUrl {
    hostname: String,
    pathname: String,
    search: String,
}

/// A minimal `new URL(text)` for the shapes rows carry: absolute URLs with a
/// scheme, optional userinfo/port, path, query, hash.
fn parse_url(text: &str) -> Option<ParsedUrl> {
    let (scheme, rest) = text.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let tail = &rest[authority_end..];
    if authority.is_empty() {
        return None;
    }
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let hostname = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    if hostname.is_empty() {
        return None;
    }
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let pathname = &tail[..path_end];
    let pathname = if pathname.is_empty() { "/" } else { pathname };
    let search = tail[path_end..].split('#').next().unwrap_or("").to_string();
    Some(ParsedUrl {
        hostname,
        pathname: pathname.to_string(),
        search,
    })
}

/// `isPreviewPath(value)`.
pub fn is_preview_path(value: Option<&Value>) -> bool {
    let text = js::string_or_empty(value);
    previews_re().is_match(&text)
        || preview_underscore_re().is_match(&text)
        || preview_file_re().is_match(&text)
}

/// `isHomepageWebp(value)`.
pub fn is_homepage_webp(value: Option<&Value>) -> bool {
    homepage_webp_re().is_match(&js::string_or_empty(value))
}

/// Same rule as `ctIdFromRow` in `_marketplace_row`.
fn row_ct_id(row: &Value) -> String {
    row::ct_id_from_row(row)
}

/// `foreignImagePrefix(url, row)` — the key's leading id belongs to another
/// card (an old halved key: ct_id/2, ct_id/4 …).
pub fn foreign_image_prefix(url: Option<&Value>, row: &Value) -> bool {
    let text = js::string_or_empty(url);
    let text = text.split(['?', '#']).next().unwrap_or("");
    if text.is_empty() || multigame_key_re().is_match(text) {
        return false;
    }
    let Some(captures) = image_id_prefix_re().captures(text) else {
        return false;
    };
    let prefix = &captures[1];
    let card = js::string_or_empty(js::get(row, "card_id").or_else(|| js::get(row, "id")))
        .trim()
        .to_string();
    let ct = row_ct_id(row);
    if card.is_empty() && ct.is_empty() {
        return false;
    }
    prefix != card && prefix != ct
}

/// `rewriteRowImages(row)`.
pub fn rewrite_row_images(row: &Value) -> Value {
    let mut rewritten = row.as_object().cloned().unwrap_or_default();

    let image_source = js::value_chain(
        &[
            js::get(row, "cdn_image_url"),
            js::get(row, "cdnImageUrl"),
            js::get(row, "image_url"),
            js::get(row, "imageUrl"),
        ],
        Value::String(String::new()),
    );
    rewritten.insert(
        "image_url".to_string(),
        Value::String(row::rewrite_cdn_pokoin_prefix(Some(&image_source), row)),
    );
    let preview_source = js::value_chain(
        &[
            js::get(row, "preview_image_url"),
            js::get(row, "previewImageUrl"),
        ],
        Value::String(String::new()),
    );
    rewritten.insert(
        "preview_image_url".to_string(),
        Value::String(row::rewrite_cdn_pokoin_prefix(Some(&preview_source), row)),
    );
    let homepage_source = js::value_chain(
        &[
            js::get(row, "homepage_image_url"),
            js::get(row, "homepageImageUrl"),
        ],
        Value::String(String::new()),
    );
    rewritten.insert(
        "homepage_image_url".to_string(),
        Value::String(row::rewrite_cdn_pokoin_prefix(Some(&homepage_source), row)),
    );

    // Drop another card's picture so pickFullImage falls back to the per-id preview.
    let view = Value::Object(rewritten.clone());
    if foreign_image_prefix(js::get(&view, "image_url"), row) {
        rewritten.insert("image_url".to_string(), Value::String(String::new()));
        rewritten.insert("cdn_image_url".to_string(), Value::String(String::new()));
        rewritten.insert("imageUrl".to_string(), Value::String(String::new()));
        rewritten.insert("cdnImageUrl".to_string(), Value::String(String::new()));
        rewritten.insert("_foreignFullImage".to_string(), Value::Bool(true));
    }
    let view = Value::Object(rewritten.clone());
    if foreign_image_prefix(js::get(&view, "preview_image_url"), row) {
        rewritten.insert(
            "preview_image_url".to_string(),
            Value::String(String::new()),
        );
        rewritten.insert("previewImageUrl".to_string(), Value::String(String::new()));
    }
    let view = Value::Object(rewritten.clone());
    if foreign_image_prefix(js::get(&view, "homepage_image_url"), row) {
        rewritten.insert(
            "homepage_image_url".to_string(),
            Value::String(String::new()),
        );
        rewritten.insert("homepageImageUrl".to_string(), Value::String(String::new()));
    }
    Value::Object(rewritten)
}

/// `pickFullImage(row)`.
pub fn pick_full_image(row: &Value) -> String {
    let view = Value::Object(row.as_object().cloned().unwrap_or_default());
    let candidates = [
        js::get(&view, "image_url"),
        js::get(&view, "cdn_image_url"),
        js::get(&view, "imageUrl"),
        js::get(&view, "cdnImageUrl"),
    ];
    for candidate in candidates {
        let url = normalize_image_url(candidate);
        if !url.is_empty() && !is_preview_path(Some(&Value::String(url.clone()))) {
            return url;
        }
    }
    for candidate in candidates.into_iter().chain([
        js::get(&view, "preview_image_url"),
        js::get(&view, "previewImageUrl"),
        js::get(&view, "homepage_image_url"),
        js::get(&view, "homepageImageUrl"),
    ]) {
        let url = normalize_image_url(candidate);
        if !url.is_empty() {
            return url;
        }
    }
    String::new()
}

/// `catalogImageSlug(value)` — the leftover key's slug (`668126_levincia.jpg`
/// -> `levincia`).
pub fn catalog_image_slug(value: Option<&Value>) -> String {
    let text = js::string_or_empty(value);
    let name = text
        .split(['/', '?', '#'])
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or("");
    let name = homepage_suffix_re().replace(name, "$1");
    let name = extension_re().replace(&name, "");
    let name = leading_id_re().replace(&name, "");
    name.to_lowercase()
}

/// `homepageMatchesFullImage(homepageUrl, fullUrl)`.
pub fn homepage_matches_full_image(homepage_url: Option<&Value>, full_url: Option<&Value>) -> bool {
    let homepage = catalog_image_slug(homepage_url);
    let full = catalog_image_slug(full_url);
    !homepage.is_empty() && !full.is_empty() && homepage == full
}

/// `reactImageUrls(row)`.
pub fn react_image_urls(row: &Value) -> Map<String, Value> {
    let rewritten = rewrite_row_images(row);
    let image_url = pick_full_image(&rewritten);
    let preview_raw = normalize_image_url(js::get(&rewritten, "preview_image_url"));
    let preview_image_url = if preview_raw.is_empty() {
        image_url.clone()
    } else {
        preview_raw
    };
    let homepage_image_url = normalize_image_url(js::get(&rewritten, "homepage_image_url"));
    // After a foreign full image falls back to the preview, the card's own
    // homepage webp is still the right tile even when its slug differs.
    let tile_from_homepage = is_homepage_webp(Some(&Value::String(homepage_image_url.clone())))
        && (js::get(&rewritten, "_foreignFullImage") == Some(&Value::Bool(true))
            || homepage_matches_full_image(
                Some(&Value::String(homepage_image_url.clone())),
                Some(&Value::String(image_url.clone())),
            ));
    let mut out = Map::new();
    out.insert("imageUrl".into(), Value::String(image_url.clone()));
    out.insert("previewImageUrl".into(), Value::String(preview_image_url));
    out.insert(
        "homepageImageUrl".into(),
        Value::String(if tile_from_homepage {
            homepage_image_url.clone()
        } else {
            String::new()
        }),
    );
    out.insert("gridImageUrl".into(), Value::String(image_url.clone()));
    out.insert("heroImageUrl".into(), Value::String(image_url.clone()));
    out.insert(
        "tileImageUrl".into(),
        Value::String(if tile_from_homepage {
            homepage_image_url
        } else {
            image_url
        }),
    );
    out
}

/// `toReactCard(row)`.
pub fn to_react_card(row: &Value) -> Value {
    let normalized = row::normalize_marketplace_row(&rewrite_row_images(row));
    let images = react_image_urls(&normalized);

    let id = js::js_string(
        js::nullish_or(js::get(&normalized, "card_id"), js::get(&normalized, "id"))
            .unwrap_or(&Value::String(String::new())),
    );
    let name = clean_text(js::get(&normalized, "name"), 240);
    let set_name = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "set"),
            js::get(&normalized, "set_name"),
            js::get(&normalized, "expansion_name"),
        ]),
        240,
    );
    let number = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "number"),
            js::get(&normalized, "card_number"),
            js::get(&normalized, "expansion_number"),
        ]),
        80,
    );
    let rarity_raw = clean_text(js::get(&normalized, "rarity"), 120);
    let rarity = if rarity_raw.is_empty() {
        "Card".to_string()
    } else {
        rarity_raw
    };
    let localized_name = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "localized_name"),
            js::get(&normalized, "localizedName"),
        ]),
        240,
    );
    let localized_set = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "localized_set"),
            js::get(&normalized, "localizedSet"),
        ]),
        240,
    );
    let localized_rarity = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "localized_rarity"),
            js::get(&normalized, "localizedRarity"),
        ]),
        120,
    );
    let canonical_path = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "canonicalPath"),
            js::get(&normalized, "canonical_path"),
        ]),
        800,
    );
    let available = js::get(&normalized, "isMarketAvailable") == Some(&Value::Bool(true))
        || row::is_market_available(&normalized);

    let price = js::number(js::nullish_or(
        js::get(&normalized, "price"),
        js::get(&normalized, "lowest_price_pkn"),
    ));

    let mut card = Map::new();
    card.insert("id".into(), Value::String(id.clone()));
    card.insert("card_id".into(), Value::String(id));
    card.insert("name".into(), Value::String(name));
    card.insert("set".into(), Value::String(set_name.clone()));
    card.insert("set_name".into(), Value::String(set_name));
    card.insert("number".into(), Value::String(number.clone()));
    card.insert("card_number".into(), Value::String(number));
    card.insert("rarity".into(), Value::String(rarity));

    let kind_text = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "rarity_kind"),
            js::get(&normalized, "rarityKind"),
        ]),
        16,
    )
    .to_lowercase();
    let rarity_kind = if matches!(kind_text.as_str(), "rainbow" | "gold" | "ghost") {
        kind_text
    } else {
        String::new()
    };
    card.insert("rarityKind".into(), Value::String(rarity_kind));

    if !localized_name.is_empty() {
        card.insert("localized_name".into(), Value::String(localized_name));
    }
    if !localized_set.is_empty() {
        card.insert("localized_set".into(), Value::String(localized_set));
    }
    if !localized_rarity.is_empty() {
        card.insert("localized_rarity".into(), Value::String(localized_rarity));
    }

    let single = Value::String("single".to_string());
    let card_kind = Value::String("card".to_string());
    let item_kind = js::string_or_empty(Some(
        js::truthy_chain(&[
            js::get(&normalized, "item_kind"),
            js::get(&normalized, "itemKind"),
        ])
        .unwrap_or(&single),
    ));
    let product_type = js::string_or_empty(Some(
        js::truthy_chain(&[
            js::get(&normalized, "product_type"),
            js::get(&normalized, "productType"),
        ])
        .unwrap_or(&card_kind),
    ));
    card.insert("itemKind".into(), Value::String(item_kind));
    card.insert("productType".into(), Value::String(product_type));
    card.insert(
        "canonicalPath".into(),
        Value::String(canonical_path.clone()),
    );
    card.insert("canonical_path".into(), Value::String(canonical_path));
    card.insert(
        "artist".into(),
        Value::String(clean_text(
            js::truthy_chain(&[
                js::get(&normalized, "artist"),
                js::get(&normalized, "illustrator"),
            ]),
            120,
        )),
    );
    card.insert(
        "illustrator".into(),
        Value::String(clean_text(
            js::truthy_chain(&[
                js::get(&normalized, "illustrator"),
                js::get(&normalized, "artist"),
            ]),
            120,
        )),
    );
    for (key, value) in card_emoji::card_emoji_fields(&normalized) {
        card.insert(key, value);
    }
    card.insert(
        "version".into(),
        Value::String(clean_text(js::get(&normalized, "version"), 40)),
    );
    let art_layout = clean_text(
        js::truthy_chain(&[
            js::get(&normalized, "artLayout"),
            js::get(&normalized, "art_layout"),
        ]),
        16,
    );
    card.insert("artLayout".into(), Value::String(art_layout.clone()));
    card.insert("art_layout".into(), Value::String(art_layout));
    card.insert(
        "artShade".into(),
        Value::String(clean_text(
            js::truthy_chain(&[
                js::get(&normalized, "artShade"),
                js::get(&normalized, "art_shade"),
            ]),
            9,
        )),
    );
    card.insert(
        "nationality".into(),
        Value::String(clean_text(js::get(&normalized, "nationality"), 24)),
    );

    let version_count = js::number(js::truthy_chain(&[
        js::get(&normalized, "versionCount"),
        js::get(&normalized, "version_count"),
        js::get(&normalized, "member_count"),
    ]));
    card.insert(
        "versionCount".into(),
        if version_count.is_finite() && version_count != 0.0 {
            js::js_json_number(version_count)
        } else {
            Value::Null
        },
    );
    card.insert(
        "expansionSymbolUrl".into(),
        Value::String(clean_text(
            js::truthy_chain(&[
                js::get(&normalized, "expansion_symbol_url"),
                js::get(&normalized, "expansionSymbolUrl"),
            ]),
            800,
        )),
    );
    for (key, value) in images {
        card.insert(key, value);
    }

    card.insert(
        "price".into(),
        if price.is_finite() && price > 0.0 {
            js::js_json_number(price)
        } else {
            Value::Null
        },
    );
    let stock = js::number_chain(&[
        js::get(&normalized, "stock"),
        js::get(&normalized, "listed_quantity"),
    ]);
    card.insert(
        "stock".into(),
        js::js_json_number(if stock.is_finite() { stock } else { 0.0 }),
    );

    let has_ct = js::get(&normalized, "hasCardTraderListing") == Some(&Value::Bool(true))
        || js::get(&normalized, "has_cardtrader_listing") == Some(&Value::Bool(true));
    card.insert("hasCardTraderListing".into(), Value::Bool(has_ct));

    let ct_eligible = js::number_chain(&[
        js::get(&normalized, "cardtraderEligibleListingCount"),
        js::get(&normalized, "cardtrader_eligible_listing_count"),
    ]);
    card.insert(
        "cardtraderEligibleListingCount".into(),
        js::js_json_number(if ct_eligible.is_finite() {
            ct_eligible
        } else {
            0.0
        }),
    );

    card.insert("isMarketAvailable".into(), Value::Bool(available));
    card.insert("inStock".into(), Value::Bool(available));

    let has_ct_explicit = js::get(&normalized, "hasCardTraderListing") == Some(&Value::Bool(true))
        || js::get(&normalized, "has_cardtrader_listing") == Some(&Value::Bool(true))
        || js::get(&normalized, "hasCardTraderListing") == Some(&Value::Bool(false))
        || js::get(&normalized, "has_cardtrader_listing") == Some(&Value::Bool(false));
    let listed_positive = js::number_chain(&[js::get(&normalized, "listed_quantity")]) > 0.0;
    let availability_known =
        has_ct_explicit || listed_positive || (price.is_finite() && price > 0.0);
    card.insert("availabilityKnown".into(), Value::Bool(availability_known));

    Value::Object(card)
}

/// `toReactCards(rows)`.
pub fn to_react_cards(rows: &[Value]) -> Vec<Value> {
    rows.iter().map(to_react_card).collect()
}

/// `setCorsHeaders(res)` — the four read CORS headers.
pub fn set_cors_headers() -> [(&'static str, &'static str); 4] {
    READ_CORS
}

/// `withTimeout(work, ms, fallback, label)` — same budget, same fallback,
/// and the same warn line on timeout.
pub async fn with_timeout<F, T>(ms: u64, label: &str, work: F, fallback: T) -> T
where
    F: Future<Output = T>,
{
    match tokio::time::timeout(Duration::from_millis(ms), work).await {
        Ok(value) => value,
        Err(_) => {
            if !label.is_empty() {
                tracing::warn!("{label} timed out after {ms}ms");
            }
            fallback
        }
    }
}

fn previews_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)/previews/").expect("valid regex"))
}

fn preview_underscore_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)/preview_").expect("valid regex"))
}

fn preview_file_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)(?:^|/)preview_[^/?#]+\.(?:jpe?g|png|webp)(?:\?|$)")
            .expect("valid regex")
    })
}

fn homepage_webp_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)_homepage\.webp(?:\?|$)").expect("valid regex"))
}

fn multigame_key_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(?:^|/)(?:one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery)/",
        )
        .expect("valid regex")
    })
}

fn image_id_prefix_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?:^|/)(?:previews/)?(\d+)_[^/]*$").expect("valid regex"))
}

fn homepage_suffix_re() -> &'static regex::Regex {
    // JS `/_homepage(?=\.(?:webp|jpe?g|png))/i` — a zero-width lookahead is
    // exactly `_homepage` immediately followed by the extension.
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)_homepage(\.(?:webp|jpe?g|png))").expect("valid regex")
    })
}

fn extension_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)\.(?:jpe?g|png|webp)$").expect("valid regex"))
}

fn leading_id_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^\d+_").expect("valid regex"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_text_trims_and_caps() {
        assert_eq!(clean_text(Some(&json!("  x  ")), 2), "x");
        assert_eq!(clean_text(Some(&json!(null)), 8), "");
        assert_eq!(clean_text(Some(&json!(0)), 8), "");
    }

    #[test]
    fn cdn_urls_rewrite_to_card_images() {
        assert_eq!(
            normalize_image_url(Some(&json!("https://cdn.pokoin.com/668126_a.jpg"))),
            "/card-images/668126_a.jpg"
        );
        assert_eq!(
            normalize_image_url(Some(&json!("https://cdn.pokoin.com/previews/x.jpg?v=2"))),
            "/card-images/previews/x.jpg?v=2"
        );
        assert_eq!(
            normalize_image_url(Some(&json!("https://other.cdn/x.jpg"))),
            "https://other.cdn/x.jpg"
        );
        assert_eq!(normalize_image_url(Some(&json!("not a url"))), "not a url");
        assert_eq!(normalize_image_url(Some(&json!(""))), "");
        assert_eq!(
            normalize_image_url(Some(&json!("https://cdn.pokoin.com"))),
            "/card-images/"
        );
    }

    #[test]
    fn preview_paths_and_homepage_webps() {
        assert!(is_preview_path(Some(&json!("/previews/x.jpg"))));
        assert!(is_preview_path(Some(&json!("/x/preview_abc.png"))));
        assert!(is_preview_path(Some(&json!("preview_abc.webp"))));
        assert!(!is_preview_path(Some(&json!(
            "/card-images/previewless.jpg"
        ))));
        assert!(!is_preview_path(Some(&json!(""))));
        assert!(is_homepage_webp(Some(&json!(
            "/card-images/5_x_homepage.webp"
        ))));
        assert!(is_homepage_webp(Some(&json!(
            "/card-images/5_x_homepage.webp?size=2"
        ))));
        assert!(!is_homepage_webp(Some(&json!("/card-images/5_x.jpg"))));
    }

    #[test]
    fn foreign_prefixes_detect_other_cards() {
        let row = json!({"card_id": 668126, "ct_id": 334063});
        assert!(!foreign_image_prefix(
            Some(&json!("https://cdn/668126_a.jpg")),
            &row
        ));
        assert!(!foreign_image_prefix(
            Some(&json!("https://cdn/334063_a.jpg")),
            &row
        ));
        assert!(!foreign_image_prefix(
            Some(&json!("https://cdn/previews/668126_a.jpg")),
            &row
        ));
        assert!(foreign_image_prefix(
            Some(&json!("https://cdn/109873_hisuian.jpg")),
            &row
        ));
        assert!(!foreign_image_prefix(Some(&json!("magic/1_a.jpg")), &row));
        assert!(!foreign_image_prefix(Some(&json!("")), &row));
        assert!(!foreign_image_prefix(
            Some(&json!("https://cdn/nokey.jpg")),
            &row
        ));
        assert!(!foreign_image_prefix(
            Some(&json!("https://cdn/5_a.jpg")),
            &json!({})
        ));
        // Halved legacy keys (ct_id/2) are foreign for another card's row.
        assert!(foreign_image_prefix(
            Some(&json!("/54879_a.jpg")),
            &json!({"card_id": 668126})
        ));
    }

    #[test]
    fn slugs_strip_ids_and_homepage_suffixes() {
        assert_eq!(
            catalog_image_slug(Some(&json!("/card-images/668126_levincia.jpg"))),
            "levincia"
        );
        assert_eq!(
            catalog_image_slug(Some(&json!("/card-images/668126_levincia_homepage.webp"))),
            "levincia"
        );
        assert_eq!(catalog_image_slug(Some(&json!(""))), "");
        assert_eq!(
            catalog_image_slug(Some(&json!("/x/334063_team-rocket-s-crobat-ex.JPG"))),
            "team-rocket-s-crobat-ex"
        );
        assert!(homepage_matches_full_image(
            Some(&json!("/card-images/668126_levincia_homepage.webp")),
            Some(&json!("/card-images/668126_levincia.jpg"))
        ));
        assert!(!homepage_matches_full_image(
            Some(&json!("/card-images/668126_levincia_homepage.webp")),
            Some(&json!("/card-images/668126_other.jpg"))
        ));
    }

    #[test]
    fn react_urls_pick_full_then_preview_then_homepage() {
        let row = json!({
            "card_id": 668126,
            "ct_id": 334063,
            "image_url": "https://cdn.pokoin.com/334063_levincia.jpg",
            "cdn_image_url": "https://cdn.pokoin.com/334063_levincia.jpg",
            "preview_image_url": "https://cdn.pokoin.com/previews/334063_levincia.jpg",
            "homepage_image_url": "https://cdn.pokoin.com/334063_levincia_homepage.webp",
        });
        let urls = react_image_urls(&row);
        assert_eq!(urls["imageUrl"], json!("/card-images/668126_levincia.jpg"));
        assert_eq!(
            urls["previewImageUrl"],
            json!("/card-images/previews/668126_levincia.jpg")
        );
        assert_eq!(
            urls["homepageImageUrl"],
            json!("/card-images/668126_levincia_homepage.webp")
        );
        assert_eq!(
            urls["tileImageUrl"],
            json!("/card-images/668126_levincia_homepage.webp")
        );
        assert_eq!(
            urls["gridImageUrl"],
            json!("/card-images/668126_levincia.jpg")
        );
    }

    #[test]
    fn react_urls_fall_back_when_the_full_image_is_foreign() {
        let row = json!({
            "card_id": 668126,
            "image_url": "https://cdn.pokoin.com/109873_hisuian-zoroark-vstar.jpg",
            "preview_image_url": "https://cdn.pokoin.com/previews/668126_entei.jpg",
            "homepage_image_url": "https://cdn.pokoin.com/668126_entei_homepage.webp",
        });
        let urls = react_image_urls(&row);
        assert_eq!(
            urls["imageUrl"],
            json!("/card-images/previews/668126_entei.jpg")
        );
        assert_eq!(
            urls["previewImageUrl"],
            json!("/card-images/previews/668126_entei.jpg")
        );
        // The card's own homepage webp still wins the tile.
        assert_eq!(
            urls["homepageImageUrl"],
            json!("/card-images/668126_entei_homepage.webp")
        );
        assert_eq!(
            urls["tileImageUrl"],
            json!("/card-images/668126_entei_homepage.webp")
        );
    }

    #[test]
    fn to_react_card_matches_the_live_shape() {
        let row = json!({
            "card_id": 668126,
            "ct_id": 334063,
            "name": "Levincia",
            "image_url": "https://cdn.pokoin.com/334063_levincia.jpg",
            "cdn_image_url": "https://cdn.pokoin.com/334063_levincia.jpg",
            "preview_image_url": "https://cdn.pokoin.com/previews/334063_levincia.jpg",
            "homepage_image_url": "https://cdn.pokoin.com/334063_levincia_homepage.webp",
            "set_name": "Destined Rivals",
            "rarity": "Card",
            "card_number": "Gold Secret Rare | 244/182",
            "item_kind": "single",
            "product_type": "card",
            "emoji": "🏆",
            "version": "v651326",
            "rarity_kind": "gold",
            "art_layout": "bleed",
            "artist": "MARINA Chikazawa",
            "illustrator": "MARINA Chikazawa",
        });
        let enriched = json!({
            "card_id": 668126,
            "ct_id": 334063,
            "name": "Levincia",
            "image_url": "https://cdn.pokoin.com/334063_levincia.jpg",
            "cdn_image_url": "https://cdn.pokoin.com/334063_levincia.jpg",
            "preview_image_url": "https://cdn.pokoin.com/previews/334063_levincia.jpg",
            "homepage_image_url": "https://cdn.pokoin.com/334063_levincia_homepage.webp",
            "set_name": "Destined Rivals",
            "rarity": "Card",
            "card_number": "Gold Secret Rare | 244/182",
            "item_kind": "single",
            "product_type": "card",
            "emoji": "🏆",
            "version": "v651326",
            "rarity_kind": "gold",
            "art_layout": "bleed",
            "artist": "MARINA Chikazawa",
            "illustrator": "MARINA Chikazawa",
            "canonical_path": "/marketplace/en/cards/668126/card-levincia-gold-secret-rare-244-182-destined-rivals",
            "lowest_price_pkn": 1426.0,
            "listed_quantity": 102.0,
            "has_cardtrader_listing": true,
            "cardtrader_eligible_listing_count": 102.0,
            "nationality": "",
        });
        let card = to_react_card(&enriched);
        let keys: Vec<&str> = card
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "card_id",
                "name",
                "set",
                "set_name",
                "number",
                "card_number",
                "rarity",
                "rarityKind",
                "itemKind",
                "productType",
                "canonicalPath",
                "canonical_path",
                "artist",
                "illustrator",
                "cardIdentityEmoji",
                "card_identity_emoji",
                "cardIdentityEmojis",
                "card_identity_emojis",
                "rarityVariantEmoji",
                "rarity_variant_emoji",
                "emoji",
                "version",
                "artLayout",
                "art_layout",
                "artShade",
                "nationality",
                "versionCount",
                "expansionSymbolUrl",
                "imageUrl",
                "previewImageUrl",
                "homepageImageUrl",
                "gridImageUrl",
                "heroImageUrl",
                "tileImageUrl",
                "price",
                "stock",
                "hasCardTraderListing",
                "cardtraderEligibleListingCount",
                "isMarketAvailable",
                "inStock",
                "availabilityKnown"
            ]
        );
        assert_eq!(card["id"], json!("668126"));
        assert_eq!(card["rarityKind"], json!("gold"));
        assert_eq!(card["emoji"], json!("🏆"));
        assert_eq!(card["version"], json!("v651326"));
        assert_eq!(card["artLayout"], json!("bleed"));
        assert_eq!(card["versionCount"], Value::Null);
        assert_eq!(card["price"], json!(1426));
        assert_eq!(card["stock"], json!(102));
        assert_eq!(card["hasCardTraderListing"], json!(true));
        assert_eq!(card["cardtraderEligibleListingCount"], json!(102));
        assert_eq!(card["isMarketAvailable"], json!(true));
        assert_eq!(card["inStock"], json!(true));
        assert_eq!(card["availabilityKnown"], json!(true));
        let _ = row;
    }

    #[test]
    fn to_react_card_defaults_for_empty_rows() {
        let card = to_react_card(&json!({}));
        assert_eq!(card["id"], json!(""));
        assert_eq!(card["rarity"], json!("Card"));
        assert_eq!(card["itemKind"], json!("single"));
        assert_eq!(card["productType"], json!("card"));
        assert_eq!(card["price"], Value::Null);
        assert_eq!(card["stock"], json!(0));
        assert_eq!(card["isMarketAvailable"], json!(false));
        assert_eq!(card["availabilityKnown"], json!(false));
    }

    #[test]
    fn to_react_cards_maps_lists() {
        let cards = to_react_cards(&[json!({"card_id": 1}), json!({"card_id": 2})]);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[1]["card_id"], json!("2"));
        assert_eq!(to_react_cards(&[]).len(), 0);
    }

    #[tokio::test]
    async fn with_timeout_returns_the_fallback() {
        let ok = with_timeout(50, "x", async { 1u8 }, 9).await;
        assert_eq!(ok, 1);
        let slow = with_timeout(
            10,
            "x",
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                1u8
            },
            9u8,
        )
        .await;
        assert_eq!(slow, 9);
    }
}
