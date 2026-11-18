//! Weiss Schwarz printing → Cardmarket product page (`links` command).
//!
//! Cardmarket sells only the English edition of Weiss Schwarz
//! (`products_singles_10.json`: 165 expansions, all English releases), so the
//! Japanese printings have no product to link to. The product list has no
//! card codes, rarities or URLs, so a link is built in three steps:
//!
//! 1. Expansion: each Pokoin EN set (collector prefix `AYT/W110`) belongs to
//!    the Cardmarket idExpansion that holds most of its card names.
//! 2. Printing: same name inside that expansion. Cardmarket gives a repeated
//!    name a `-V<n>-<Rarity>` URL suffix (`With-Lots-of-Love-Matsuri-V2-Super-Rare`),
//!    and that rarity picks the Pokoin printing; parallels Pokoin does not
//!    list (most EN SR/SP/SSP/OFR/FR) stay unmatched.
//! 3. URL: a harvested product page (`cardmarket-links.sqlite`, the candyext
//!    dump) is exact. Otherwise the URL is generated from the expansion's
//!    harvested slug with the slug style that reproduces that expansion's
//!    harvested URLs; generated links are kept apart (`generated: true`).

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::db::Card;
use crate::matcher::compact;
use crate::sources::CmProduct;

/// A Cardmarket product page URL harvested from the website.
#[derive(Debug, Clone)]
pub struct Harvest {
    pub id: i64,
    pub url: String,
}

/// Cardmarket rarity words in URL suffixes → Pokoin `cm_rarity` codes.
const RARITIES: &[(&str, &[&str])] = &[
    // Premium boosters print every regular card as `N`.
    ("Common", &["C", "N"]),
    ("Uncommon", &["U"]),
    ("Rare", &["R"]),
    ("Double-Rare", &["RR", "RR+"]),
    ("Triple-Rare", &["RRR"]),
    ("Super-Rare", &["SR"]),
    ("Special-Rare", &["SP"]),
    ("Super-Special-Rare", &["SSP"]),
    ("Secret-Rare", &["SEC"]),
    ("Overframe-Rare", &["OFR"]),
    ("Feature-Rare", &["FR"]),
    ("Climax-Common", &["CC"]),
    ("Climax-Rare", &["CR"]),
    ("Trial-Deck", &["TD"]),
    ("Promo", &["PR", "PR+"]),
    ("Parallel-Foil", &[]),
];

/// Parallel (foil) treatments: never the regular printing of a name.
const PARALLELS: &[&str] = &[
    "Super-Rare",
    "Special-Rare",
    "Super-Special-Rare",
    "Secret-Rare",
    "Overframe-Rare",
    "Feature-Rare",
    "Parallel-Foil",
];

fn rarity_codes(word: &str) -> Option<&'static [&'static str]> {
    RARITIES.iter().find(|(w, _)| *w == word).map(|(_, c)| *c)
}

/// The URL word for a Pokoin rarity code (`RR` → `Double-Rare`).
pub fn rarity_word(code: &str) -> Option<&'static str> {
    RARITIES
        .iter()
        .find(|(_, codes)| codes.contains(&code))
        .map(|(w, _)| *w)
}

/// `…/Singles/<expansion>/<product>` → (expansion slug, product slug).
pub fn split_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.split("/Products/Singles/").nth(1)?;
    let (expansion, product) = rest.split_once('/')?;
    (!expansion.is_empty() && !product.is_empty()).then_some((expansion, product))
}

/// How an expansion writes `-V<n>`: `V2` (current pages) or `V-2` (2018 pages).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Marker {
    Joined,
    Split,
}

/// The `-V<n>[-<Rarity>]` suffix of a product slug: (name part, n, marker, rarity word).
pub fn parse_suffix(slug: &str) -> Option<(&str, u32, Marker, &str)> {
    let tokens: Vec<&str> = slug.split('-').collect();
    for i in (1..tokens.len()).rev() {
        let (n, marker, word_from) = if let Some(n) = tokens[i]
            .strip_prefix('V')
            .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        {
            (n.parse().ok()?, Marker::Joined, i + 1)
        } else if tokens[i] == "V"
            && tokens
                .get(i + 1)
                .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        {
            (tokens[i + 1].parse().ok()?, Marker::Split, i + 2)
        } else {
            continue;
        };
        let word_start = tokens[..word_from.min(tokens.len())]
            .iter()
            .map(|t| t.len() + 1)
            .sum::<usize>()
            .min(slug.len());
        let word = &slug[word_start..];
        if word.is_empty() || rarity_codes(word).is_some() {
            let name_end = tokens[..i].iter().map(|t| t.len() + 1).sum::<usize>() - 1;
            return Some((&slug[..name_end], n, marker, word));
        }
    }
    None
}

/// Product slug styles seen on Cardmarket Weiss Schwarz pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Style {
    /// `Tiamat's` → `Tiamats` (current) instead of `Tiamat-s` (2018).
    pub drop_apostrophes: bool,
    /// A leading quote is dropped (current) instead of giving `-Hero-…` (2018).
    pub trim_start: bool,
    pub marker: Marker,
    /// `-V1-Rare` (current) instead of a bare `-V-1` (some 2018 pages).
    pub rarity_word: bool,
}

const STYLES: [Style; 16] = {
    let mut out = [Style {
        drop_apostrophes: true,
        trim_start: true,
        marker: Marker::Joined,
        rarity_word: true,
    }; 16];
    let mut i = 0;
    while i < 16 {
        out[i] = Style {
            drop_apostrophes: i & 1 == 0,
            trim_start: i & 2 == 0,
            marker: if i & 4 == 0 { Marker::Joined } else { Marker::Split },
            rarity_word: i & 8 == 0,
        };
        i += 1;
    }
    out
};

/// Cardmarket's name slug: ASCII letters and digits, every other run → `-`.
pub fn name_slug(name: &str, style: Style) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in name.nfkd() {
        if style.drop_apostrophes && matches!(c, '\'' | '’' | '`') {
            continue;
        }
        if c.is_ascii_alphanumeric() {
            if gap && (!out.is_empty() || !style.trim_start) {
                out.push('-');
            }
            gap = false;
            out.push(c);
        } else if !('\u{0300}'..='\u{036f}').contains(&c) {
            gap = true;
        }
    }
    out
}

/// The product slug for a name; `variant` is (n, rarity word) for a name that
/// repeats inside its expansion.
pub fn product_slug(name: &str, variant: Option<(u32, &str)>, style: Style) -> String {
    let mut slug = name_slug(name, style);
    if let Some((n, word)) = variant {
        match style.marker {
            Marker::Joined => slug.push_str(&format!("-V{n}")),
            Marker::Split => slug.push_str(&format!("-V-{n}")),
        }
        if style.rarity_word && !word.is_empty() {
            slug.push('-');
            slug.push_str(word);
        }
    }
    slug
}

/// `AYT/W110-E001` → `AYT/W110`; the set a Pokoin EN printing belongs to.
pub fn set_key(collector: &str) -> &str {
    collector
        .rsplit_once('-')
        .map(|(set, _)| set)
        .unwrap_or(collector)
}

#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub blueprint_id: i64,
    pub card_id: Option<i64>,
    pub product: i64,
    pub expansion: i64,
    pub url: String,
    pub generated: bool,
    pub method: &'static str,
    pub name: String,
    pub set_name: String,
    pub collector: String,
    pub rarity: String,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct ExpansionReport {
    pub id: i64,
    pub slug: String,
    pub sets: Vec<String>,
    pub singles: usize,
    pub harvested: usize,
    pub linked: usize,
    pub generated: usize,
    /// The slug style chosen for generated URLs and how many harvested URLs it
    /// reproduces (checked, exact). `None`: no generated links here.
    pub style: Option<Style>,
    pub style_check: (usize, usize),
}

#[derive(Debug, Default, Serialize)]
pub struct Outcome {
    pub links: Vec<Link>,
    pub expansions: Vec<ExpansionReport>,
    pub en_cards: usize,
    pub jp_cards: usize,
    /// EN printings without a link, by reason.
    pub unmatched: BTreeMap<&'static str, usize>,
    /// Cardmarket singles without a Pokoin printing, by reason.
    pub unmatched_products: BTreeMap<&'static str, usize>,
    /// Harvested repeated names paired by rarity: (pairs of a base rarity,
    /// of those the first product). Cardmarket adds the regular printing
    /// first, so unharvested groups pair their one printing with `V1` only
    /// when this holds for at least `MIN_STYLE_SHARE`.
    pub order_check: (usize, usize),
    pub samples: BTreeMap<&'static str, Vec<String>>,
    /// EN printing → its (idExpansion, compact name) group (`twins.rs`).
    #[serde(skip)]
    pub en_group: HashMap<i64, (i64, String)>,
    /// (idExpansion, compact name) → harvested (idProduct, rarity word, URL).
    #[serde(skip)]
    pub harvested_group: HashMap<(i64, String), Vec<(i64, String, String)>>,
}

/// A generated URL is kept only where the style reproduces at least this share
/// of the expansion's harvested, linked URLs (and at least `MIN_CHECKED`).
/// 2014–2018 pages mix `V-1`, `V1`, bare and rarity suffixes inside one
/// expansion, so a handful of matching pages proves nothing there.
pub const MIN_STYLE_SHARE: f64 = 0.98;
pub const MIN_CHECKED: usize = 20;

fn sample(out: &mut Outcome, reason: &'static str, text: String) {
    let list = out.samples.entry(reason).or_default();
    if list.len() < 12 {
        list.push(text);
    }
}

pub fn run(cards: &[Card], singles: &[CmProduct], harvest: &[Harvest]) -> Outcome {
    let mut out = Outcome::default();
    let en: Vec<&Card> = cards
        .iter()
        .filter(|c| c.language.eq_ignore_ascii_case("EN"))
        .collect();
    out.en_cards = en.len();
    out.jp_cards = cards.len() - en.len();

    let urls: HashMap<i64, &str> = harvest.iter().map(|h| (h.id, h.url.as_str())).collect();
    let mut by_name: HashMap<String, Vec<&Card>> = HashMap::new();
    for card in &en {
        by_name.entry(compact(&card.name)).or_default().push(card);
    }

    // 1. Pokoin EN set → the Cardmarket expansion holding most of its names.
    let mut hits: HashMap<&str, HashMap<i64, HashSet<String>>> = HashMap::new();
    for p in singles {
        let key = compact(&p.name);
        for card in by_name.get(&key).into_iter().flatten() {
            hits.entry(set_key(&card.collector))
                .or_default()
                .entry(p.expansion)
                .or_default()
                .insert(key.clone());
        }
    }
    let mut set_names: HashMap<&str, HashSet<String>> = HashMap::new();
    for card in &en {
        set_names
            .entry(set_key(&card.collector))
            .or_default()
            .insert(compact(&card.name));
    }
    let mut owner: HashMap<&str, i64> = HashMap::new();
    for (set, per_expansion) in &hits {
        let Some((expansion, names)) = per_expansion
            .iter()
            .max_by_key(|(e, names)| (names.len(), std::cmp::Reverse(**e)))
        else {
            continue;
        };
        let size = set_names.get(set).map_or(1, HashSet::len).max(1);
        if names.len() >= 3 || names.len() * 2 >= size {
            owner.insert(set, *expansion);
        }
    }

    // 2. Pair products and printings per (expansion, name).
    let mut products: BTreeMap<(i64, String), Vec<&CmProduct>> = BTreeMap::new();
    for p in singles {
        products
            .entry((p.expansion, compact(&p.name)))
            .or_default()
            .push(p);
    }
    let mut printings: HashMap<(i64, String), Vec<&Card>> = HashMap::new();
    for card in &en {
        if let Some(e) = owner.get(set_key(&card.collector)) {
            printings
                .entry((*e, compact(&card.name)))
                .or_default()
                .push(card);
        }
    }
    let mut expansion_slug: HashMap<i64, &str> = HashMap::new();
    for p in singles {
        if let Some((slug, _)) = urls.get(&p.id).and_then(|u| split_url(u)) {
            expansion_slug.entry(p.expansion).or_insert(slug);
        }
    }

    for (key, group) in &printings {
        for card in group {
            out.en_group.insert(card.id, key.clone());
        }
    }
    for (key, group) in &products {
        for p in group {
            if let Some(url) = urls.get(&p.id) {
                let word = split_url(url)
                    .and_then(|(_, slug)| parse_suffix(slug))
                    .map_or("", |(_, _, _, w)| w);
                out.harvested_group
                    .entry(key.clone())
                    .or_default()
                    .push((p.id, word.to_string(), url.to_string()));
            }
        }
    }

    // (product, card, n within the name, group size) of every pairing.
    let mut pairs: Vec<(&CmProduct, &Card, u32, usize, &'static str)> = Vec::new();
    let mut paired_cards: HashSet<i64> = HashSet::new();
    let mut deferred: Vec<(Vec<&CmProduct>, &Card)> = Vec::new();
    for (key, group) in &mut products {
        group.sort_by_key(|p| p.id);
        let mut cands: Vec<&Card> = printings.get(key).cloned().unwrap_or_default();
        cands.sort_by(|a, b| a.collector.cmp(&b.collector).then(a.id.cmp(&b.id)));
        if cands.is_empty() {
            let reason = if owner.values().any(|e| *e == key.0) {
                "no Pokoin printing with that name in the expansion's sets"
            } else {
                "expansion has no Pokoin EN set"
            };
            *out.unmatched_products.entry(reason).or_default() += group.len();
            continue;
        }
        let words: Vec<Option<&str>> = group
            .iter()
            .map(|p| {
                urls.get(&p.id)
                    .and_then(|u| split_url(u))
                    .and_then(|(_, slug)| parse_suffix(slug))
                    .map(|(_, _, _, w)| w)
            })
            .collect();
        let size = group.len();
        if size == 1 && cands.len() == 1 {
            pairs.push((group[0], cands[0], 1, 1, "name"));
            continue;
        }
        if words.iter().all(Option::is_none)
            && cands.len() == 1
            && rarity_word(&cands[0].rarity).is_some_and(|w| !PARALLELS.contains(&w))
        {
            deferred.push((group.clone(), cands[0]));
            continue;
        }
        let mut used: HashSet<i64> = HashSet::new();
        for (i, p) in group.iter().enumerate() {
            let n = i as u32 + 1;
            let word = words[i].filter(|w| !w.is_empty());
            let fit: Vec<&Card> = match word {
                Some(w) => {
                    let codes = rarity_codes(w).unwrap_or(&[]);
                    cands
                        .iter()
                        .copied()
                        .filter(|c| !used.contains(&c.id) && codes.contains(&c.rarity.as_str()))
                        .collect()
                }
                // No rarity: the product list alone cannot tell parallels apart.
                None => Vec::new(),
            };
            match fit.as_slice() {
                [card] => {
                    used.insert(card.id);
                    pairs.push((p, card, n, size, "name+rarity"));
                }
                [] if word.is_some() => {
                    *out.unmatched_products
                        .entry("no Pokoin printing of that rarity (parallel Pokoin does not list)")
                        .or_default() += 1;
                }
                [] => {
                    *out.unmatched_products
                        .entry("repeated name without a harvested rarity")
                        .or_default() += 1;
                    sample(
                        &mut out,
                        "repeated name without a harvested rarity",
                        format!("{} {} ({} products, {} printings)", p.id, p.name, size, cands.len()),
                    );
                }
                many => {
                    *out.unmatched_products
                        .entry("several Pokoin printings of that rarity")
                        .or_default() += 1;
                    sample(
                        &mut out,
                        "several Pokoin printings of that rarity",
                        format!(
                            "{} {} → {}",
                            p.id,
                            p.name,
                            many.iter().map(|c| c.collector.as_str()).collect::<Vec<_>>().join(", ")
                        ),
                    );
                }
            }
        }
    }

    let base: Vec<u32> = pairs
        .iter()
        .filter(|(.., size, method)| *size > 1 && *method == "name+rarity")
        .filter(|(_, card, ..)| rarity_word(&card.rarity).is_some_and(|w| !PARALLELS.contains(&w)))
        .map(|(_, _, n, ..)| *n)
        .collect();
    out.order_check = (base.len(), base.iter().filter(|n| **n == 1).count());
    let order_holds = base.len() >= MIN_CHECKED
        && out.order_check.1 as f64 >= MIN_STYLE_SHARE * base.len() as f64;
    for (group, card) in deferred {
        if order_holds {
            pairs.push((group[0], card, 1, group.len(), "name+order"));
        } else {
            *out.unmatched_products
                .entry("repeated name without a harvested rarity")
                .or_default() += group.len();
        }
    }

    // One Cardmarket page per printing and one printing per page.
    let mut per_card: HashMap<i64, usize> = HashMap::new();
    for (_, card, ..) in &pairs {
        *per_card.entry(card.id).or_default() += 1;
    }
    pairs.retain(|(_, card, ..)| {
        if per_card[&card.id] > 1 {
            *out.unmatched_products
                .entry("printing claimed by several products")
                .or_default() += 1;
            false
        } else {
            true
        }
    });

    // 3. URLs: harvested pages, else the expansion's checked slug style.
    let mut reports: BTreeMap<i64, ExpansionReport> = BTreeMap::new();
    for p in singles {
        let r = reports.entry(p.expansion).or_insert_with(|| ExpansionReport {
            id: p.expansion,
            slug: expansion_slug.get(&p.expansion).unwrap_or(&"").to_string(),
            ..Default::default()
        });
        r.singles += 1;
        if urls.contains_key(&p.id) {
            r.harvested += 1;
        }
    }
    for (set, e) in &owner {
        if let Some(r) = reports.get_mut(e) {
            r.sets.push(set.to_string());
        }
    }
    let variant = |card: &Card, n: u32, size: usize| -> Option<Option<(u32, &'static str)>> {
        if size == 1 {
            return Some(None);
        }
        rarity_word(&card.rarity).map(|w| Some((n, w)))
    };
    let mut styles: HashMap<i64, Style> = HashMap::new();
    for r in reports.values_mut() {
        r.sets.sort();
        let checks: Vec<(&str, String, Option<(u32, &str)>)> = pairs
            .iter()
            .filter(|(p, ..)| p.expansion == r.id)
            .filter_map(|(p, card, n, size, _)| {
                let (_, slug) = split_url(urls.get(&p.id)?)?;
                Some((slug, p.name.clone(), variant(card, *n, *size)?))
            })
            .collect();
        let best = STYLES
            .iter()
            .map(|s| {
                let exact = checks
                    .iter()
                    .filter(|(slug, name, v)| product_slug(name, *v, *s) == *slug)
                    .count();
                (exact, *s)
            })
            .max_by_key(|(exact, _)| *exact);
        if let Some((exact, style)) = best {
            r.style_check = (checks.len(), exact);
            if !r.slug.is_empty()
                && checks.len() >= MIN_CHECKED
                && exact as f64 >= MIN_STYLE_SHARE * checks.len() as f64
            {
                r.style = Some(style);
                styles.insert(r.id, style);
            }
        }
    }
    for (p, card, n, size, method) in pairs {
        let url = match urls.get(&p.id) {
            Some(url) => Some((url.to_string(), false)),
            None => styles.get(&p.expansion).and_then(|style| {
                let v = variant(card, n, size)?;
                Some((
                    format!(
                        "https://www.cardmarket.com/en/WeissSchwarz/Products/Singles/{}/{}",
                        expansion_slug[&p.expansion],
                        product_slug(&p.name, v, *style)
                    ),
                    true,
                ))
            }),
        };
        let Some((url, generated)) = url else {
            *out.unmatched
                .entry(if expansion_slug.contains_key(&p.expansion) {
                    "matched, but the expansion's slug style is unchecked (no URL)"
                } else {
                    "matched, but no harvested URL in the expansion (no URL)"
                })
                .or_default() += 1;
            paired_cards.insert(card.id);
            continue;
        };
        paired_cards.insert(card.id);
        let r = reports.get_mut(&p.expansion).expect("report per expansion");
        r.linked += 1;
        if generated {
            r.generated += 1;
        }
        out.links.push(Link {
            blueprint_id: card.id,
            card_id: card.card_id,
            product: p.id,
            expansion: p.expansion,
            url,
            generated,
            method,
            name: card.name.clone(),
            set_name: card.set_name.clone(),
            collector: card.collector.clone(),
            rarity: card.rarity.clone(),
        });
    }
    // The same page from two products (a harvest duplicate) links neither.
    let mut per_url: HashMap<String, usize> = HashMap::new();
    for l in &out.links {
        *per_url.entry(l.url.clone()).or_default() += 1;
    }
    let before = out.links.len();
    out.links.retain(|l| per_url[&l.url] == 1);
    if before > out.links.len() {
        *out.unmatched.entry("URL shared by two printings").or_default() += before - out.links.len();
    }

    for card in &en {
        if paired_cards.contains(&card.id) {
            continue;
        }
        let reason = match owner.get(set_key(&card.collector)) {
            None => "set not on Cardmarket (no expansion holds its names)",
            Some(e) if products.contains_key(&(*e, compact(&card.name))) => {
                "name on Cardmarket, printing not told apart (repeated name, no harvested rarity)"
            }
            Some(_) => "no Cardmarket product of that name in the expansion",
        };
        *out.unmatched.entry(reason).or_default() += 1;
        sample(
            &mut out,
            reason,
            format!("{} {} {} ({})", card.collector, card.rarity, card.name, card.set_name),
        );
    }
    out.expansions = reports.into_values().collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURRENT: Style = Style {
        drop_apostrophes: true,
        trim_start: true,
        marker: Marker::Joined,
        rarity_word: true,
    };
    const OLD: Style = Style {
        drop_apostrophes: false,
        trim_start: false,
        marker: Marker::Split,
        rarity_word: true,
    };

    fn card(id: i64, name: &str, collector: &str, rarity: &str) -> Card {
        Card {
            id,
            key: format!("EN:{collector}:{rarity}"),
            source: "ws-ccondeluci-db".into(),
            name: name.into(),
            set_name: "Ayakashi Triangle".into(),
            set_code: "AYT/110".into(),
            collector: collector.into(),
            rarity: rarity.into(),
            language: "EN".into(),
            card_market_ids: vec![],
            card_id: Some(id * 2),
        }
    }

    fn product(id: i64, name: &str, expansion: i64) -> CmProduct {
        CmProduct {
            id,
            name: name.into(),
            expansion,
            metacard: 0,
            category: String::new(),
        }
    }

    #[test]
    fn suffixes_and_slugs_follow_cardmarket() {
        assert_eq!(
            parse_suffix("With-Lots-of-Love-Matsuri-V2-Super-Rare"),
            Some(("With-Lots-of-Love-Matsuri", 2, Marker::Joined, "Super-Rare"))
        );
        assert_eq!(
            parse_suffix("Sleeping-Knights-Siune-Tecchi-V-1-Common"),
            Some(("Sleeping-Knights-Siune-Tecchi", 1, Marker::Split, "Common"))
        );
        assert_eq!(
            parse_suffix("Yuuki-s-Raised-Antenna-V-1"),
            Some(("Yuuki-s-Raised-Antenna", 1, Marker::Split, ""))
        );
        assert_eq!(parse_suffix("Incredible-Power-Thanos"), None);
        assert_eq!(
            product_slug("Tiamat's Contractor, Wilhelmina", Some((1, "Common")), CURRENT),
            "Tiamats-Contractor-Wilhelmina-V1-Common"
        );
        assert_eq!(
            product_slug("\"\"Hero of Justice\"\" Tsukihi Araragi", Some((1, "Trial-Deck")), OLD),
            "-Hero-of-Justice-Tsukihi-Araragi-V-1-Trial-Deck"
        );
        assert_eq!(product_slug("Déjà vu, Knapsack Kid", None, CURRENT), "Deja-vu-Knapsack-Kid");
        assert_eq!(set_key("AYT/W110-E001"), "AYT/W110");
    }

    #[test]
    fn harvested_rarity_picks_the_printing_and_parallels_stay_unmatched() {
        let cards = vec![
            card(1, "With Lots of Love, Matsuri", "AYT/W110-E010", "R"),
            card(2, "Suited Up, Matsuri", "AYT/W110-E015", "U"),
            card(3, "Feminine Side, Matsuri", "AYT/W110-E001", "RR"),
            card(4, "Bewildered at His Childhood Friend, Matsuri", "AYT/W110-E016", "U"),
        ];
        let base = "https://www.cardmarket.com/en/WeissSchwarz/Products/Singles/Ayakashi-Triangle";
        let singles = vec![
            product(10, "With Lots of Love, Matsuri", 5818),
            product(11, "With Lots of Love, Matsuri", 5818),
            product(12, "Suited Up, Matsuri", 5818),
            product(13, "Suited Up, Matsuri", 5818),
            product(14, "Feminine Side, Matsuri", 5818),
            product(15, "Feminine Side, Matsuri", 5818),
            product(16, "Bewildered at His Childhood Friend, Matsuri", 5818),
        ];
        let harvest = vec![
            Harvest { id: 10, url: format!("{base}/With-Lots-of-Love-Matsuri-V1-Rare") },
            Harvest { id: 11, url: format!("{base}/With-Lots-of-Love-Matsuri-V2-Super-Rare") },
            Harvest { id: 12, url: format!("{base}/Suited-Up-Matsuri-V1-Uncommon") },
            Harvest { id: 13, url: format!("{base}/Suited-Up-Matsuri-V2-Special-Rare") },
            Harvest { id: 16, url: format!("{base}/Bewildered-at-His-Childhood-Friend-Matsuri") },
        ];
        let out = run(&cards, &singles, &harvest);
        let by_card: HashMap<i64, &Link> = out.links.iter().map(|l| (l.blueprint_id, l)).collect();
        assert_eq!(by_card[&1].product, 10);
        assert!(!by_card[&1].generated);
        assert_eq!(by_card[&2].product, 12);
        assert_eq!(by_card[&4].url, format!("{base}/Bewildered-at-His-Childhood-Friend-Matsuri"));
        // Feminine Side has no harvested rarity: two products, not guessed.
        assert!(!by_card.contains_key(&3));
        assert_eq!(
            out.unmatched_products["no Pokoin printing of that rarity (parallel Pokoin does not list)"],
            2
        );
    }

    #[test]
    fn japanese_printings_are_never_linked() {
        let mut jp = card(1, "パパと大ゲンカ カレン", "KMS/W133-020", "C");
        jp.language = "JP".into();
        let out = run(&[jp], &[product(10, "Karen Kujo", 9999)], &[]);
        assert!(out.links.is_empty());
        assert_eq!((out.en_cards, out.jp_cards), (0, 1));
    }
}
