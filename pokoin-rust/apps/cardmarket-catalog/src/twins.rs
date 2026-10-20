//! Japanese Weiss Schwarz printings → the Cardmarket page of their English twin.
//!
//! Cardmarket lists only the English edition, so a Japanese printing shares
//! the page of the English printing with the same artwork, as Pokémon
//! printings share one through their artwork versions. The English edition
//! keeps the Japanese card code with an `E` before the number
//! (`AYT/W110-010` → `AYT/W110-E010`, trial decks `T01` → `TE01`).
//!
//! - Same code: the twin's linked page (`links.rs`).
//! - A Japanese parallel (`AYT/W110-010S`, SR) whose English parallel Pokoin
//!   does not list: the harvested Cardmarket product of that rarity under the
//!   twin's name (`…-Matsuri-V2-Super-Rare`).
//!
//! Either way the two scans must show the same picture: a 64-bit difference
//! hash of the art area (`art_hash`) within `max_distance` bits. Text, name
//! bar and language differ between editions, so the crop leaves them out.
//! Checked by eye 2026-10-19: same art stays within ~23 bits (SAMPLE stamp,
//! crop, an added logo), different art or a renumbered card starts at 28;
//! the default 18 keeps a margin.
//!
//! A parallel is compared with the English *regular* scan (Pokoin has no
//! English parallel scan), so it passes only within `PARALLEL_MAX_DISTANCE`:
//! the same picture with foil and signature. Alternate-art SP/SSP never do.

/// Default `--max-art-distance`.
pub const MAX_DISTANCE: u32 = 18;
pub const PARALLEL_MAX_DISTANCE: u32 = 8;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::db::Card;
use crate::links::{rarity_word, set_key, Outcome};

/// `AYT/W110-010S` → (`AYT/W110-E010S`, `AYT/W110-E010`): the English code of
/// the same printing and of its regular printing.
pub fn twin_code(collector: &str) -> Option<(String, String)> {
    let (set, number) = collector.trim().rsplit_once('-')?;
    let prefix_len = number.bytes().take_while(u8::is_ascii_uppercase).count();
    let (prefix, rest) = number.split_at(prefix_len);
    let digits_len = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits_len == 0 || prefix.ends_with('E') {
        return None;
    }
    let (digits, suffix) = rest.split_at(digits_len);
    Some((
        format!("{set}-{prefix}E{digits}{suffix}"),
        format!("{set}-{prefix}E{digits}"),
    ))
}

/// Difference hash of a card's art area: grey 9×8 thumbnail of the picture
/// between the cost/level corner and the text box, one bit per left/right
/// brightness step.
pub fn art_hash(path: &Path) -> Option<u64> {
    let img = image::open(path).ok()?;
    let (w, h) = (img.width(), img.height());
    if w < 40 || h < 40 {
        return None;
    }
    let art = img
        .crop_imm(w * 8 / 100, h * 8 / 100, w * 84 / 100, h * 54 / 100)
        .grayscale()
        .resize_exact(9, 8, image::imageops::FilterType::Triangle)
        .to_luma8();
    let mut bits = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            bits <<= 1;
            if art.get_pixel(x, y)[0] > art.get_pixel(x + 1, y)[0] {
                bits |= 1;
            }
        }
    }
    Some(bits)
}

/// `<dir>/<blueprint id>_<slug>.jpg` per catalog row (the importer's cache).
pub fn scan_index(dir: &Path) -> HashMap<i64, PathBuf> {
    let mut out = HashMap::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(".jpg") {
            continue;
        }
        if let Some(id) = name.split('_').next().and_then(|s| s.parse::<i64>().ok()) {
            out.insert(id, entry.path());
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct JpLink {
    pub blueprint_id: i64,
    pub card_id: i64,
    pub collector: String,
    pub rarity: String,
    pub name: String,
    pub twin_blueprint_id: i64,
    pub twin_collector: String,
    pub product: i64,
    pub url: String,
    pub method: &'static str,
    pub art_distance: u32,
}

#[derive(Debug, Default, Serialize)]
pub struct JpOutcome {
    pub jp_cards: usize,
    pub links: Vec<JpLink>,
    pub unmatched: BTreeMap<&'static str, usize>,
    /// Art-hash distance (bits) → candidate pairs, before the threshold.
    pub distances: BTreeMap<u32, usize>,
    pub samples: BTreeMap<&'static str, Vec<String>>,
}

impl JpOutcome {
    fn miss(&mut self, reason: &'static str, card: &Card, detail: &str) {
        *self.unmatched.entry(reason).or_default() += 1;
        let list = self.samples.entry(reason).or_default();
        if list.len() < 12 {
            let name = card.name.lines().next().unwrap_or("");
            list.push(format!("{} {} {name} ({}){detail}", card.collector, card.rarity, card.set_name));
        }
    }
}

pub fn run(
    cards: &[Card],
    en: &Outcome,
    scans: &HashMap<i64, PathBuf>,
    max_distance: u32,
) -> JpOutcome {
    let mut out = JpOutcome::default();
    let english: HashMap<&str, &Card> = cards
        .iter()
        .filter(|c| c.language.eq_ignore_ascii_case("EN"))
        .map(|c| (c.collector.as_str(), c))
        .collect();
    let english_sets: std::collections::HashSet<&str> =
        english.keys().map(|c| set_key(c)).collect();
    let linked: HashMap<i64, &crate::links::Link> =
        en.links.iter().map(|l| (l.blueprint_id, l)).collect();
    let mut hashes: HashMap<i64, Option<u64>> = HashMap::new();
    let mut hash = |id: i64| -> Option<u64> {
        *hashes
            .entry(id)
            .or_insert_with(|| scans.get(&id).and_then(|p| art_hash(p)))
    };

    for card in cards.iter().filter(|c| c.language.eq_ignore_ascii_case("JP")) {
        out.jp_cards += 1;
        let Some((exact, base)) = twin_code(&card.collector) else {
            out.miss("card code has no English form", card, "");
            continue;
        };
        // (twin, product, url, method)
        let target = if let Some(twin) = english.get(exact.as_str()) {
            match linked.get(&twin.id) {
                Some(l) if twin.rarity == card.rarity || rarity_word(&twin.rarity) == rarity_word(&card.rarity) => {
                    Some((*twin, l.product, l.url.clone(), "en-twin"))
                }
                Some(_) => {
                    out.miss("rarity differs from the English twin", card, &format!(" vs {} {}", twin.collector, twin.rarity));
                    continue;
                }
                None => {
                    out.miss("English twin has no Cardmarket page", card, &format!(" → {}", twin.collector));
                    continue;
                }
            }
        } else if let Some(twin) = english.get(base.as_str()).filter(|_| exact != base) {
            let word = rarity_word(&card.rarity).unwrap_or("");
            let products: Vec<&(i64, String, String)> = en
                .en_group
                .get(&twin.id)
                .and_then(|g| en.harvested_group.get(g))
                .into_iter()
                .flatten()
                .filter(|(_, w, _)| !word.is_empty() && w == word)
                .collect();
            match products.as_slice() {
                [(product, _, url)] => Some((*twin, *product, url.clone(), "en-twin-parallel")),
                [] => {
                    out.miss("parallel: no harvested Cardmarket product of that rarity", card, &format!(" → {}", twin.collector));
                    continue;
                }
                _ => {
                    out.miss("parallel: several Cardmarket products of that rarity", card, "");
                    continue;
                }
            }
        } else if english_sets.contains(set_key(&exact)) {
            out.miss("English edition has no printing with that number", card, "");
            continue;
        } else {
            out.miss("set has no English edition", card, "");
            continue;
        };
        let Some((twin, product, url, method)) = target else { continue };
        let Some(card_id) = card.card_id else {
            out.miss("not projected (no public card id)", card, "");
            continue;
        };
        let (Some(a), Some(b)) = (hash(card.id), hash(twin.id)) else {
            out.miss("no scan to compare artwork", card, "");
            continue;
        };
        let distance = (a ^ b).count_ones();
        *out.distances.entry(distance).or_default() += 1;
        if method == "en-twin-parallel" && distance > max_distance.min(PARALLEL_MAX_DISTANCE) {
            out.miss(
                "parallel: art differs from the English regular scan (no English parallel scan to compare)",
                card,
                &format!(" vs {} ({distance} bits)", twin.collector),
            );
            continue;
        }
        if distance > max_distance {
            out.miss("artwork differs from the English twin", card, &format!(" vs {} ({distance} bits)", twin.collector));
            continue;
        }
        out.links.push(JpLink {
            blueprint_id: card.id,
            card_id,
            collector: card.collector.clone(),
            rarity: card.rarity.clone(),
            name: card.name.lines().next().unwrap_or("").to_string(),
            twin_blueprint_id: twin.id,
            twin_collector: twin.collector.clone(),
            product,
            url,
            method,
            art_distance: distance,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_codes_put_an_e_before_the_number() {
        assert_eq!(
            twin_code("AYT/W110-010"),
            Some(("AYT/W110-E010".into(), "AYT/W110-E010".into()))
        );
        assert_eq!(
            twin_code("AYT/W110-010S"),
            Some(("AYT/W110-E010S".into(), "AYT/W110-E010".into()))
        );
        assert_eq!(
            twin_code("BM/S15-T03"),
            Some(("BM/S15-TE03".into(), "BM/S15-TE03".into()))
        );
        assert_eq!(
            twin_code("BD/W125-067a"),
            Some(("BD/W125-E067a".into(), "BD/W125-E067".into()))
        );
        assert_eq!(twin_code("AYT/W110-E010"), None, "already English");
        assert_eq!(twin_code("PR-SP"), None);
    }
}
