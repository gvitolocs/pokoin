//! Search-page ranking and the React card JSON the Node handler returns.
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

static COLLECTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^0-9])([0-9]{1,4}[a-z]?)/([0-9]{1,4})([^0-9]|$)").unwrap());
static COLLECTOR_ANY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^0-9])[0-9]{1,4}[a-z]?/[0-9]{1,4}([^0-9]|$)").unwrap()
});

#[derive(Clone, Debug)]
pub struct SearchCandidate {
    pub card_id: String,
    pub search_weight: f64,
    pub print_bucket: String,
}

#[derive(Clone, Debug)]
pub struct SearchRow {
    pub card_id: i64,
    pub ct_id: Option<i64>,
    pub name: String,
    pub set_name: String,
    pub card_number: String,
    pub rarity: String,
    pub item_kind: String,
    pub product_type: String,
    pub image_url: String,
    pub cdn_image_url: String,
    pub preview_image_url: String,
    pub homepage_image_url: String,
    pub artist: String,
    pub illustrator: String,
    pub nationality: String,
    pub product_variant: String,
    pub emoji: String,
    pub search_weight: f64,
    pub price: Option<f64>,
    pub stock: i64,
    pub has_cardtrader: bool,
    pub eligible_count: i64,
}

pub fn compact_name(value: &str) -> String {
    value
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .flat_map(|ch| ch.to_lowercase())
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

pub fn local_name_score(name: &str, query: &str, weight: f64) -> i64 {
    let name = compact_name(name);
    let query = compact_name(query);
    let mut score = weight.clamp(0.0, 5000.0) as i64;
    if !query.is_empty() && name == query {
        score += 100_000;
    } else if !query.is_empty() && name.starts_with(&query) {
        score += 40_000;
    } else if !query.is_empty() && name.contains(&query) {
        score += 10_000;
    }
    score
}

fn collector_key(value: &str) -> String {
    let folded = value.to_lowercase();
    let Some(caps) = COLLECTOR.captures(&folded) else {
        return String::new();
    };
    let left: i64 = caps.get(2).and_then(|m| m.as_str().trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse().ok()).unwrap_or(0);
    let right: i64 = caps.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
    if left == 0 || right == 0 {
        return String::new();
    }
    format!("{left}/{right}")
}

pub fn rank_rows(rows: &mut [SearchRow], query: &str) {
    rows.sort_by(|left, right| {
        local_name_score(&right.name, query, right.search_weight)
            .cmp(&local_name_score(&left.name, query, left.search_weight))
    });
    let wanted = collector_key(query);
    if wanted.is_empty() || rows.len() < 2 {
        return;
    }
    rows.sort_by(|left, right| {
        let left_match = if collector_key(&left.card_number) == wanted { 0 } else { 1 };
        let right_match = if collector_key(&right.card_number) == wanted { 0 } else { 1 };
        left_match.cmp(&right_match)
    });
}

pub fn print_bucket(nationality: &str) -> String {
    match nationality.trim().to_ascii_lowercase().as_str() {
        "" | "product" | "unknown" => "unknown".into(),
        "japanese" | "ja" | "jp" => "japanese".into(),
        "korean" | "ko" => "korean".into(),
        "chinese" | "zh" | "cn" | "zht" => "chinese".into(),
        "western" | "european" | "eu" | "american" | "us" | "french" | "fr" | "german" | "de" => {
            "western".into()
        }
        other => other.to_string(),
    }
}

pub fn print_matches(want: &str, bucket: &str) -> bool {
    let want = want.trim().to_ascii_lowercase();
    if want.is_empty() || want == "all" {
        return true;
    }
    let have = print_bucket(bucket);
    if want == "japanese" || want == "korean" {
        return have == "japanese" || have == "korean";
    }
    have == want
}

fn slug_part(value: &str) -> String {
    let folded: String = value
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect::<String>()
        .trim()
        .to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for ch in folded.chars() {
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

fn public_card_id(card_id: i64, ct_id: Option<i64>) -> i64 {
    if let Some(ct) = ct_id.filter(|id| *id > 0) {
        return ct.saturating_mul(2);
    }
    if card_id <= 0 {
        return 0;
    }
    if card_id % 2 == 1 {
        card_id.saturating_mul(2)
    } else {
        card_id
    }
}

fn canonical_path(row: &SearchRow) -> String {
    let id = public_card_id(row.card_id, row.ct_id);
    let number = row.card_number.trim().trim_start_matches('#').trim();
    let number = if number == row.card_id.to_string() { "" } else { number };
    let slug = [
        slug_part(if row.rarity.trim().is_empty() { "Card" } else { &row.rarity }),
        slug_part(&row.name),
        slug_part(number),
        slug_part(&row.set_name),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("-");
    if id > 0 && !slug.is_empty() {
        format!("/marketplace/en/cards/{id}/{slug}")
    } else {
        String::new()
    }
}

fn rewrite_cdn(url: &str, card_id: i64, ct_id: Option<i64>) -> String {
    let source = url.trim();
    if source.is_empty() {
        return String::new();
    }
    let public_id = card_id.to_string();
    let ct = ct_id
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
        .or_else(|| {
            if card_id > 0 && card_id % 2 == 0 {
                Some((card_id / 2).to_string())
            } else {
                None
            }
        });
    let rewritten = if let Some(ct) = ct.filter(|ct| ct != &public_id) {
        source.replace(&format!("{ct}_"), &format!("{public_id}_"))
    } else {
        source.to_string()
    };
    if let Ok(parsed) = reqwest_free_url(&rewritten) {
        return parsed;
    }
    rewritten
}

fn reqwest_free_url(value: &str) -> Result<String, ()> {
    let rest = value.strip_prefix("https://cdn.pokoin.com").or_else(|| value.strip_prefix("http://cdn.pokoin.com"));
    let Some(path) = rest else {
        return Err(());
    };
    Ok(format!("/card-images{path}"))
}

fn has_collector(value: &str) -> bool {
    COLLECTOR_ANY.is_match(&value.to_lowercase())
}

pub fn react_card(row: &SearchRow) -> Value {
    let mut item_kind = if row.item_kind.is_empty() { "single".into() } else { row.item_kind.clone() };
    let mut product_type = if row.product_type.is_empty() { "card".into() } else { row.product_type.clone() };
    if has_collector(&row.card_number) {
        item_kind = "single".into();
        product_type = "card".into();
    }
    let image = rewrite_cdn(
        if !row.cdn_image_url.is_empty() { &row.cdn_image_url } else { &row.image_url },
        row.card_id,
        row.ct_id,
    );
    let preview = {
        let raw = rewrite_cdn(&row.preview_image_url, row.card_id, row.ct_id);
        if raw.is_empty() { image.clone() } else { raw }
    };
    let homepage = rewrite_cdn(&row.homepage_image_url, row.card_id, row.ct_id);
    let tile_homepage = homepage.contains("_homepage.webp") && !homepage.is_empty();
    let path = canonical_path(row);
    let available = row.stock > 0 || row.has_cardtrader || row.eligible_count > 0;
    let price = row.price.filter(|value| value.is_finite() && *value > 0.0);
    let id = row.card_id.to_string();
    json!({
        "id": id,
        "card_id": id,
        "name": row.name,
        "set": row.set_name,
        "set_name": row.set_name,
        "number": row.card_number,
        "card_number": row.card_number,
        "rarity": if row.rarity.trim().is_empty() { "Card".into() } else { row.rarity.clone() },
        "rarityKind": "",
        "itemKind": item_kind,
        "productType": product_type,
        "canonicalPath": path,
        "canonical_path": path,
        "artist": if row.artist.is_empty() { row.illustrator.clone() } else { row.artist.clone() },
        "illustrator": if row.illustrator.is_empty() { row.artist.clone() } else { row.illustrator.clone() },
        "cardIdentityEmoji": "",
        "card_identity_emoji": "",
        "cardIdentityEmojis": [],
        "card_identity_emojis": [],
        "rarityVariantEmoji": "",
        "rarity_variant_emoji": "",
        "emoji": row.emoji,
        "version": row.product_variant,
        "artLayout": "",
        "art_layout": "",
        "artShade": "",
        "nationality": row.nationality,
        "versionCount": Value::Null,
        "expansionSymbolUrl": "",
        "imageUrl": image,
        "previewImageUrl": preview,
        "homepageImageUrl": if tile_homepage { homepage.clone() } else { String::new() },
        "gridImageUrl": image,
        "heroImageUrl": image,
        "tileImageUrl": if tile_homepage { homepage } else { image },
        "price": price,
        "stock": row.stock,
        "hasCardTraderListing": row.has_cardtrader,
        "cardtraderEligibleListingCount": row.eligible_count,
        "isMarketAvailable": available,
        "inStock": available,
        "availabilityKnown": row.has_cardtrader || row.stock > 0 || price.is_some(),
    })
}

pub fn page_body(
    query: &str,
    game: &str,
    product_type: &str,
    product_search_only: bool,
    lang: &str,
    limit: i64,
    offset: i64,
    total: Option<i64>,
    cards: Vec<Value>,
) -> Value {
    let count = cards.len();
    let has_more = false;
    json!({
        "query": query,
        "game": game,
        "productType": product_type,
        "productSearchOnly": product_search_only,
        "lang": lang,
        "limit": limit,
        "offset": offset,
        "count": count,
        "total": total,
        "hasMore": has_more,
        "cards": cards,
        "facets": { "products": [] },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, number: &str, weight: f64) -> SearchRow {
        SearchRow {
            card_id: 10,
            ct_id: Some(5),
            name: name.into(),
            set_name: "Base Set".into(),
            card_number: number.into(),
            rarity: "Rare".into(),
            item_kind: "single".into(),
            product_type: "card".into(),
            image_url: String::new(),
            cdn_image_url: "https://cdn.pokoin.com/5_charizard.jpg".into(),
            preview_image_url: String::new(),
            homepage_image_url: String::new(),
            artist: String::new(),
            illustrator: String::new(),
            nationality: "western".into(),
            product_variant: String::new(),
            emoji: String::new(),
            search_weight: weight,
            price: Some(12.0),
            stock: 1,
            has_cardtrader: true,
            eligible_count: 1,
        }
    }

    #[test]
    fn exact_name_outranks_a_heavier_partial() {
        assert!(local_name_score("Pikachu", "pikachu", 10.0) > local_name_score("Pikachu V", "pikachu", 4000.0));
    }

    #[test]
    fn collector_number_moves_to_the_front() {
        let mut rows = vec![
            row("Charizard", "4/102", 100.0),
            row("Charizard", "6/102", 10.0),
        ];
        rows[0].card_id = 1;
        rows[1].card_id = 2;
        rank_rows(&mut rows, "charizard 6/102");
        assert_eq!(rows[0].card_id, 2);
    }

    #[test]
    fn card_json_uses_the_public_image_path() {
        let card = react_card(&row("Charizard", "4/102", 1.0));
        assert_eq!(card["gridImageUrl"], "/card-images/10_charizard.jpg");
        assert_eq!(card["canonicalPath"], "/marketplace/en/cards/10/rare-charizard-4-102-base-set");
        assert_eq!(card["price"], 12.0);
    }
}
