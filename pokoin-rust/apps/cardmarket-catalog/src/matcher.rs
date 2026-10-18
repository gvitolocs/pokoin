//! Cardmarket singles → Pokoin catalog rows.
//!
//! Cardmarket's product list has only idProduct, name, idExpansion and
//! idMetacard. Name + expansion is ambiguous for reprints and parallels (a
//! Saga Rare is a second product with the same name), so TCGplayer is the
//! bridge: its names carry the treatment or source pack ("(SAGA)",
//! "(Judge Pack Vol. 1)") and its rows carry the printed number.
//!
//! Within one name, both marketplaces add the regular printing first and the
//! parallels after it, so equal-sized groups are paired in id order. Groups of
//! different sizes pair only the regular printing; the rest is reported.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::db::Card;
use crate::game::{Expansion, Game};
use crate::sources::{CmProduct, TcgProduct};

pub fn compact(value: &str) -> String {
    value
        .nfkd()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// `"Rocket City (Box Topper) (Textured Foil)"` → every reading, longest name
/// first: the full name, then with one, two … trailing groups taken as tags.
/// Card names can end in brackets themselves ("EVA-02 Beast Form 2nd Phase (Type 1)").
pub fn readings(name: &str) -> Vec<(String, Vec<String>)> {
    let mut out = vec![(name.trim().to_string(), Vec::new())];
    let mut rest = name.trim().to_string();
    let mut tags = Vec::new();
    while rest.ends_with(')') {
        let Some(open) = rest.rfind('(') else { break };
        let tag = rest[open + 1..rest.len() - 1].trim().to_string();
        rest = rest[..open].trim_end().to_string();
        if rest.is_empty() {
            break;
        }
        tags.insert(0, tag);
        out.push((rest.clone(), tags.clone()));
    }
    // Collaboration rares: "Freedom Gundam - Rage Dragon Emperor Ira".
    for (base, tags) in out.clone() {
        if let Some((collab, card)) = base.rsplit_once(" - ") {
            if !collab.trim().is_empty() && !card.trim().is_empty() {
                let mut tags = tags.clone();
                tags.insert(0, collab.trim().to_string());
                out.push((card.trim().to_string(), tags));
            }
        }
    }
    out
}

/// A TCGplayer row read for one card name: its tags beyond that name.
#[derive(Debug, Clone)]
struct Tcg<'a> {
    row: &'a TcgProduct,
    tags: Vec<String>,
}

impl Tcg<'_> {
    /// 0 for the regular printing, 1 when a source pack is named, 2 for a
    /// treatment (SAGA, SPR, foils, winner, top N …).
    fn special(&self) -> u8 {
        if self.row.rarity.to_lowercase().contains("collaboration") {
            return 2;
        }
        let mut level = 0;
        for tag in &self.tags {
            let t = tag.to_lowercase();
            let treatment = [
                "saga",
                "spr",
                "foil",
                "textured",
                "winner",
                "top ",
                "place",
                "box topper",
                "alternate",
                "lenticular",
                "signature",
                "hot stamped",
                "champion",
                "convention",
            ]
            .iter()
            .any(|k| t.contains(k));
            level = level.max(if treatment { 2 } else { 1 });
        }
        level
    }

    fn version(&self) -> String {
        self.tags.join(" · ")
    }
}

/// Treatment suffix of an official-site product scan (`BSS01-001_sgr`) and
/// whether a TCGplayer tag names the same treatment.
fn treatment_fits(suffix: &str, tags: &[String]) -> bool {
    let tags = tags.iter().map(|t| t.to_lowercase()).collect::<Vec<_>>();
    let any = |keys: &[&str]| tags.iter().any(|t| keys.iter().any(|k| t.contains(k)));
    match suffix.to_lowercase().as_str() {
        "sgr" => any(&["saga"]),
        "spr" => any(&["spr", "special rare"]),
        "holo" => any(&["box topper"]),
        "p" | "p1" => !tags.is_empty() && !any(&["saga", "spr", "box topper"]),
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Extra {
    pub key: String,
    pub name: String,
    pub set_name: String,
    pub set_code: String,
    pub collector: String,
    pub rarity: String,
    pub version: String,
    pub image_url: String,
    pub source_url: String,
    pub card_market_ids: Vec<i64>,
    pub tcg_player_ids: Vec<i64>,
    pub cardmarket_expansion: i64,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct ExpansionReport {
    pub id: i64,
    pub set: String,
    pub singles: usize,
    /// Paired with a card the catalog already has.
    pub matched: usize,
    /// New catalog rows; `new_with_image` have a TCGplayer picture (listed).
    pub new: usize,
    pub new_with_image: usize,
    /// Paired by name with a TCGplayer row whose count differs (left unpaired).
    pub unpaired: usize,
}

#[derive(Debug, Default, Serialize)]
pub struct Outcome {
    /// source_key → Cardmarket idProducts.
    pub matches: BTreeMap<String, Vec<i64>>,
    pub extras: Vec<Extra>,
    pub expansions: Vec<ExpansionReport>,
    /// Cardmarket expansions missing from the game table.
    pub unknown_expansions: Vec<(i64, usize)>,
    /// Pairs whose CM trend order and TCGplayer market order disagree.
    pub price_order_conflicts: Vec<String>,
    pub price_order_checked: usize,
    pub notes: Vec<String>,
}

struct Ours<'a> {
    card: &'a Card,
    /// Printed number without the product-scan suffix (`BSS01-001`).
    number: String,
    /// Product-scan treatment suffix (`sgr`, `spr`, `p` …); empty for the
    /// official database row.
    suffix: String,
}

fn ours(card: &Card) -> Ours<'_> {
    let (number, suffix) = if card.source.ends_with("-products") {
        match card.collector.rsplit_once('_') {
            Some((n, s)) if n.contains('-') => (n.to_string(), s.to_string()),
            _ => (card.collector.clone(), "x".to_string()),
        }
    } else {
        (card.collector.clone(), String::new())
    };
    Ours {
        card,
        number: number.to_uppercase(),
        suffix,
    }
}

fn dice(a: &str, b: &str) -> f64 {
    let grams = |s: &str| {
        s.as_bytes()
            .windows(2)
            .map(|w| (w[0], w[1]))
            .collect::<Vec<_>>()
    };
    let (x, y) = (grams(a), grams(b));
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let mut pool = y.clone();
    let mut hits = 0;
    for g in &x {
        if let Some(i) = pool.iter().position(|h| h == g) {
            pool.swap_remove(i);
            hits += 1;
        }
    }
    2.0 * hits as f64 / (x.len() + y.len()) as f64
}

/// Which promo expansion a TCGplayer source-pack tag belongs to: the longest
/// sealed-product name that contains it or that it contains.
fn promo_owner(tags: &[String], families: &[(i64, String)]) -> Option<i64> {
    let mut best: Option<(usize, i64)> = None;
    for tag in tags {
        let t = family_key(tag);
        if t.len() < 6 {
            continue;
        }
        for (expansion, family) in families {
            if family.len() < 6 {
                continue;
            }
            if t == *family || t.contains(family.as_str()) || family.contains(t.as_str()) {
                let score = if t == *family {
                    usize::MAX
                } else {
                    family.len().min(t.len())
                };
                if best.is_none_or(|(s, _)| score > s) {
                    best = Some((score, *expansion));
                }
            }
        }
    }
    best.map(|(_, e)| e)
}

/// TCGplayer's base rarities in the official site's codes (C, UC, R, X, L);
/// parallels keep their names, like the product-page scans (Saga Rare …).
fn rarity_code(rarity: &str) -> String {
    match rarity.trim() {
        "Common" => "C",
        "Uncommon" => "UC",
        "Rare" => "R",
        "X Rare" => "X",
        "Legend" | "Legendary" => "L",
        other => other,
    }
    .to_string()
}

/// A stray TCGplayer row must have been released within this many product
/// ids (about three months) of the Cardmarket product's predicted time.
const STRAY_WINDOW: i64 = 12_000;

/// The plain printing of a set card (no tag, in that set's group): never a
/// stand-in for a promo or reprint elsewhere.
fn set_regular(game: &Game, row: &TcgProduct) -> bool {
    !row.name.trim_end().ends_with(')')
        && !row.name.contains(" - ")
        && game.expansions.iter().any(|(_, x)| matches!(x, Expansion::Set { tcg_groups, numbers, .. } if tcg_groups.contains(&row.group) && row.number.starts_with(numbers)))
}

/// A sealed-product or pack-tag name for comparison: "Judge Pack Vol. 1
/// Booster" and "Judge Pack 1" are the same pack.
fn family_key(name: &str) -> String {
    let key = compact(name).replace("vol", "");
    key.strip_suffix("booster").unwrap_or(&key).to_string()
}

/// (Cardmarket idProduct, TCGplayer productId) of names both sites print
/// exactly once: both number products in release order, so this maps a
/// Cardmarket product to the TCGplayer ids of its time.
fn release_clock(singles: &[CmProduct], tcg: &[TcgProduct]) -> Vec<(i64, i64)> {
    let mut cm: HashMap<String, Vec<i64>> = HashMap::new();
    for p in singles {
        cm.entry(compact(&p.name)).or_default().push(p.id);
    }
    let mut tc: HashMap<String, Vec<i64>> = HashMap::new();
    for row in tcg {
        tc.entry(compact(&row.name)).or_default().push(row.id);
    }
    let mut clock: Vec<(i64, i64)> = cm
        .iter()
        .filter_map(
            |(name, ids)| match (ids.as_slice(), tc.get(name).map(Vec::as_slice)) {
                ([c], Some([t])) => Some((*c, *t)),
                _ => None,
            },
        )
        .collect();
    clock.sort();
    clock
}

fn predict(clock: &[(i64, i64)], cm_id: i64) -> i64 {
    let at = clock.partition_point(|(c, _)| *c < cm_id);
    let around = [at.checked_sub(1), Some(at)]
        .into_iter()
        .flatten()
        .filter_map(|i| clock.get(i));
    around
        .min_by_key(|(c, _)| (c - cm_id).abs())
        .map_or(0, |(_, t)| *t)
}

/// TCGplayer rows read as this card name: exact, else one close spelling
/// ("Judgement" / "Judgment").
fn candidates<'a>(pool: &[&'a TcgProduct], name_key: &str, used: &HashSet<i64>) -> Vec<Tcg<'a>> {
    let free = || pool.iter().copied().filter(|row| !used.contains(&row.id));
    let exact: Vec<Tcg> = free()
        .filter_map(|row| {
            readings(&row.name)
                .into_iter()
                .find(|(base, _)| compact(base) == name_key)
                .map(|(_, tags)| Tcg { row, tags })
        })
        .collect();
    if !exact.is_empty() || name_key.len() < 8 {
        return exact;
    }
    let mut best: Option<(f64, String)> = None;
    for row in free() {
        for (base, _) in readings(&row.name) {
            let key = compact(&base);
            let score = dice(&key, name_key);
            if score >= 0.9 && best.as_ref().is_none_or(|(s, _)| score > *s) {
                best = Some((score, key));
            }
        }
    }
    let Some((_, key)) = best else {
        return Vec::new();
    };
    free()
        .filter_map(|row| {
            readings(&row.name)
                .into_iter()
                .find(|(base, _)| compact(base) == key)
                .map(|(_, tags)| Tcg { row, tags })
        })
        .collect()
}

/// Flags a paired group whose Cardmarket and TCGplayer prices point in clearly
/// opposite directions (each side ≥ 3× apart, both ≥ 0.25).
fn check_price_order(
    out: &mut Outcome,
    set_name: &str,
    pairs: &[(&CmProduct, Option<Tcg>)],
    cm_trend: &HashMap<i64, f64>,
) {
    let priced: Vec<(f64, f64)> = pairs
        .iter()
        .filter_map(|(cm, t)| Some((*cm_trend.get(&cm.id)?, t.as_ref()?.row.market?)))
        .filter(|(a, b)| *a >= 0.25 && *b >= 0.25)
        .collect();
    if priced.len() < 2 {
        return;
    }
    out.price_order_checked += 1;
    let clash = priced.iter().enumerate().any(|(i, a)| {
        priced[i + 1..].iter().any(|b| {
            (a.0 >= 3.0 * b.0 && b.1 >= 3.0 * a.1) || (b.0 >= 3.0 * a.0 && a.1 >= 3.0 * b.1)
        })
    });
    if clash {
        out.price_order_conflicts.push(format!(
            "{} [{}]: {}",
            pairs[0].0.name,
            set_name,
            pairs
                .iter()
                .map(|(cm, t)| format!(
                    "{} €{} ↔ {} ${}",
                    cm.id,
                    cm_trend.get(&cm.id).map_or("-".into(), |v| v.to_string()),
                    t.as_ref()
                        .map_or("none".into(), |t| format!("{} [{}]", t.row.id, t.version())),
                    t.as_ref()
                        .and_then(|t| t.row.market)
                        .map_or("-".into(), |v| v.to_string())
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
}

pub fn run(
    game: &Game,
    cards: &[Card],
    singles: &[CmProduct],
    nonsingles: &[CmProduct],
    tcg: &[TcgProduct],
    cm_trend: &HashMap<i64, f64>,
) -> Outcome {
    let mut out = Outcome::default();
    let ours_all: Vec<Ours> = cards.iter().map(ours).collect();
    let mut claimed: HashSet<i64> = HashSet::new(); // our card ids already paired
    let mut used_tcg: HashSet<i64> = HashSet::new();

    // Promo families: compact sealed-product names, "booster" dropped.
    let mut families: Vec<(i64, String)> = Vec::new();
    for product in nonsingles {
        if let Some(Expansion::Promo { .. }) = game.expansion(product.expansion) {
            families.push((product.expansion, family_key(&product.name)));
        }
    }
    for (id, expansion) in game.expansions {
        if let Expansion::Promo { aliases, .. } = expansion {
            families.extend(aliases.iter().map(|a| (*id, family_key(a))));
        }
    }
    // Every TCGplayer row → the promo expansion its source pack belongs to.
    let mut tcg_promo: HashMap<i64, i64> = HashMap::new();
    for row in tcg {
        let group_owner = game.expansions.iter().find_map(|(id, x)| match x {
            Expansion::Promo { tcg_groups, .. } if tcg_groups.contains(&row.group) => Some(*id),
            _ => None,
        });
        let tags = readings(&row.name)
            .last()
            .map(|r| r.1.clone())
            .unwrap_or_default();
        if let Some(owner) = group_owner.or_else(|| promo_owner(&tags, &families)) {
            tcg_promo.insert(row.id, owner);
        }
    }

    let mut by_expansion: BTreeMap<i64, Vec<&CmProduct>> = BTreeMap::new();
    for product in singles {
        by_expansion
            .entry(product.expansion)
            .or_default()
            .push(product);
    }
    // Sets first: promo printings take their number from the regular card.
    let mut order: Vec<i64> = by_expansion.keys().copied().collect();
    order.sort_by_key(|id| {
        (
            matches!(game.expansion(*id), Some(Expansion::Promo { .. })),
            *id,
        )
    });

    let clock = release_clock(singles, tcg);
    let mut metacard_number: HashMap<i64, String> = HashMap::new();
    let mut extras_by_set: HashMap<String, usize> = HashMap::new();

    for expansion_id in order {
        let products = &by_expansion[&expansion_id];
        let Some(expansion) = game.expansion(expansion_id) else {
            out.unknown_expansions.push((expansion_id, products.len()));
            continue;
        };
        let (set_name, set_code, is_promo) = match expansion {
            Expansion::Set { name, .. } => {
                let code = ours_all
                    .iter()
                    .find(|o| o.card.set_name == *name)
                    .map(|o| o.card.set_code.clone())
                    .unwrap_or_default();
                (name.to_string(), code, false)
            }
            Expansion::Promo { name, code, .. } => (name.to_string(), code.to_string(), true),
        };
        let mut report = ExpansionReport {
            id: expansion_id,
            set: set_name.clone(),
            singles: products.len(),
            ..Default::default()
        };

        // Candidate TCGplayer rows for this expansion.
        let pool: Vec<&TcgProduct> = tcg
            .iter()
            .filter(|row| match expansion {
                Expansion::Set {
                    tcg_groups,
                    numbers,
                    ..
                } => {
                    tcg_groups.contains(&row.group)
                        && row.number.starts_with(numbers)
                        && !tcg_promo.contains_key(&row.id)
                }
                Expansion::Promo { .. } => tcg_promo.get(&row.id) == Some(&expansion_id),
            })
            .collect();
        // Rows of other groups a name may fall back to: reprints sold in this
        // expansion's boosters (BSS01 box toppers in Aquatic Invaders), never
        // rows another promo expansion owns.
        let strays: Vec<&TcgProduct> = tcg
            .iter()
            .filter(|row| !pool.iter().any(|p| p.id == row.id) && !set_regular(game, row))
            .filter(|row| {
                tcg_promo
                    .get(&row.id)
                    .is_none_or(|owner| *owner == expansion_id)
            })
            .collect();
        let set_cards: Vec<&Ours> = ours_all
            .iter()
            .filter(|o| !is_promo && o.card.set_name == set_name)
            .collect();
        let promo_cards: Vec<&Ours> = ours_all
            .iter()
            .filter(|o| !o.suffix.is_empty() && o.card.rarity == "Promo")
            .collect();

        let mut names: BTreeMap<String, Vec<&CmProduct>> = BTreeMap::new();
        for product in products {
            names
                .entry(compact(&product.name))
                .or_default()
                .push(product);
        }
        for (name_key, mut cms) in names {
            cms.sort_by_key(|p| p.id);
            let mut rows = candidates(&pool, &name_key, &used_tcg);
            let pairs: Vec<(&CmProduct, Option<Tcg>)> = if rows.is_empty() {
                // Each product takes the stray TCGplayer row released nearest
                // to it (both sites number products in release order).
                let mut left = candidates(&strays, &name_key, &used_tcg);
                let pairs: Vec<(&CmProduct, Option<Tcg>)> = cms
                    .iter()
                    .map(|cm| {
                        let near = predict(&clock, cm.id);
                        let pick = left
                            .iter()
                            .enumerate()
                            .filter(|(_, t)| (t.row.id - near).abs() <= STRAY_WINDOW)
                            .min_by_key(|(_, t)| ((t.row.id - near).abs(), t.row.id))
                            .map(|(i, _)| i);
                        (*cm, pick.map(|i| left.remove(i)))
                    })
                    .collect();
                if pairs.iter().any(|(_, t)| t.is_some()) {
                    out.notes.push(format!(
                        "stray: {} '{}' ← {}",
                        set_name,
                        cms[0].name,
                        pairs
                            .iter()
                            .map(|(cm, t)| format!(
                                "{}→{}",
                                cm.id,
                                t.as_ref().map_or("none".into(), |t| format!(
                                    "{} {} [{}] Δ{}",
                                    t.row.id,
                                    t.row.number,
                                    t.version(),
                                    t.row.id - predict(&clock, cm.id)
                                ))
                            ))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                pairs
            } else {
                // Regular printing first, then parallels in the order TCGplayer
                // added them; Cardmarket lists the regular printing first too.
                rows.sort_by_key(|t| (t.special(), t.row.id));
                if cms.len() > rows.len() {
                    report.unpaired += cms.len() - rows.len();
                }
                let mut rows = rows.into_iter();
                cms.iter().map(|cm| (*cm, rows.next())).collect()
            };
            check_price_order(&mut out, &set_name, &pairs, cm_trend);

            for (index, (cm, tcg_row)) in pairs.into_iter().enumerate() {
                if let Some(t) = &tcg_row {
                    used_tcg.insert(t.row.id);
                }
                let regular = tcg_row.as_ref().map_or(index == 0, |t| {
                    t.special() == 0 || (index == 0 && !is_promo && t.special() < 2)
                });
                let number = tcg_row.as_ref().map(|t| t.row.number.to_uppercase());
                // 1. A card we already have.
                let target: Option<&Ours> = if is_promo {
                    number.as_ref().and_then(|n| {
                        let hits: Vec<&Ours> = promo_cards
                            .iter()
                            .copied()
                            .filter(|o| {
                                !claimed.contains(&o.card.id)
                                    && o.number == *n
                                    && compact(&o.card.name) == name_key
                            })
                            .filter(|o| {
                                let pin = game
                                    .promo_pins
                                    .iter()
                                    .find(|(key, _)| *key == o.card.key)
                                    .map(|(_, tag)| compact(tag));
                                tcg_row.as_ref().is_some_and(|t| {
                                    pin.is_some_and(|pin| {
                                        t.tags.iter().any(|tag| compact(tag) == pin)
                                    })
                                })
                            })
                            .collect();
                        (hits.len() == 1).then(|| hits[0])
                    })
                } else if regular {
                    let base: Vec<&Ours> = set_cards
                        .iter()
                        .copied()
                        .filter(|o| o.suffix.is_empty() && !claimed.contains(&o.card.id))
                        .collect();
                    let by_number: Vec<&Ours> = number
                        .as_ref()
                        .map(|n| base.iter().copied().filter(|o| o.number == *n).collect())
                        .unwrap_or_default();
                    let by_name: Vec<&Ours> = base
                        .iter()
                        .copied()
                        .filter(|o| compact(&o.card.name) == name_key)
                        .collect();
                    if by_number.len() == 1
                        && (by_name.is_empty()
                            || by_name.iter().any(|o| o.card.id == by_number[0].card.id)
                            || dice(&compact(&by_number[0].card.name), &name_key) > 0.6)
                    {
                        Some(by_number[0])
                    } else if by_name.len() == 1 {
                        Some(by_name[0])
                    } else if by_name.is_empty() && number.is_none() {
                        // Spelling differs and TCGplayer has no row: closest name in the set.
                        let mut scored: Vec<(f64, &Ours)> = base
                            .iter()
                            .map(|o| (dice(&compact(&o.card.name), &name_key), *o))
                            .collect();
                        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
                        match scored.as_slice() {
                            [(best, o), rest @ ..]
                                if *best >= 0.85
                                    && rest.first().is_none_or(|r| r.0 < *best - 0.1) =>
                            {
                                out.notes.push(format!(
                                    "fuzzy: CM {} '{}' → {} '{}' ({best:.2})",
                                    cm.id, cm.name, o.card.collector, o.card.name
                                ));
                                Some(*o)
                            }
                            _ => None,
                        }
                    } else {
                        None
                    }
                } else {
                    let hits: Vec<&Ours> = set_cards
                        .iter()
                        .copied()
                        .filter(|o| !o.suffix.is_empty() && !claimed.contains(&o.card.id))
                        .filter(|o| {
                            Some(&o.number) == number.as_ref()
                                && tcg_row
                                    .as_ref()
                                    .is_some_and(|t| treatment_fits(&o.suffix, &t.tags))
                        })
                        .collect();
                    (hits.len() == 1).then(|| hits[0])
                };
                if let Some(o) = target {
                    claimed.insert(o.card.id);
                    out.matches
                        .entry(o.card.key.clone())
                        .or_default()
                        .push(cm.id);
                    if regular && !is_promo && cm.metacard > 0 {
                        metacard_number
                            .entry(cm.metacard)
                            .or_insert_with(|| o.number.clone());
                    }
                    report.matched += 1;
                    continue;
                }
                // 2. A new catalog row.
                let collector = number
                    .clone()
                    .or_else(|| metacard_number.get(&cm.metacard).cloned())
                    .unwrap_or_default();
                let image = tcg_row
                    .as_ref()
                    .map(|t| t.row.image.clone())
                    .unwrap_or_default();
                let rarity = match &tcg_row {
                    Some(t) if !t.row.rarity.is_empty() => rarity_code(&t.row.rarity),
                    _ if is_promo => "Promo".to_string(),
                    _ => String::new(),
                };
                if !image.is_empty() {
                    report.new_with_image += 1;
                }
                report.new += 1;
                *extras_by_set.entry(set_name.clone()).or_default() += 1;
                out.extras.push(Extra {
                    key: format!("cm-{}", cm.id),
                    name: cm.name.trim().to_string(),
                    set_name: set_name.clone(),
                    set_code: set_code.clone(),
                    collector,
                    rarity,
                    version: tcg_row.as_ref().map(Tcg::version).unwrap_or_default(),
                    image_url: image,
                    source_url: tcg_row
                        .as_ref()
                        .map(|t| format!("https://www.tcgplayer.com/product/{}", t.row.id))
                        .unwrap_or_default(),
                    card_market_ids: vec![cm.id],
                    tcg_player_ids: tcg_row.as_ref().map(|t| vec![t.row.id]).unwrap_or_default(),
                    cardmarket_expansion: expansion_id,
                });
            }
        }
        out.expansions.push(report);
    }
    // Metacard numbers learnt after a promo row was built (same pass order
    // guarantees sets first, so this only fills promos without TCGplayer).
    for extra in out.extras.iter_mut().filter(|e| e.collector.is_empty()) {
        if let Some(cm) = singles.iter().find(|p| p.id == extra.card_market_ids[0]) {
            if let Some(n) = metacard_number.get(&cm.metacard) {
                extra.collector = n.clone();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readings_peel_trailing_tags() {
        let r = readings("Rocket City (Box Topper) (Textured Foil)");
        assert_eq!(r[0].0, "Rocket City (Box Topper) (Textured Foil)");
        assert_eq!(
            r[2],
            (
                "Rocket City".to_string(),
                vec!["Box Topper".to_string(), "Textured Foil".to_string()]
            )
        );
        assert_eq!(readings("Pentan").len(), 1);
    }

    #[test]
    fn compact_drops_marks_and_punctuation() {
        assert_eq!(
            compact("EVA-01 -Operation Yashima-"),
            "eva01operationyashima"
        );
        assert_eq!(compact("Pokémon"), "pokemon");
    }

    #[test]
    fn promo_owner_prefers_the_longest_family() {
        let families = vec![
            (5464, family_key("X Rare Special Pack Vol. 1 Booster")),
            (
                5704,
                family_key("Pro Fest X Rare Special Pack Vol. 1 Booster"),
            ),
        ];
        assert_eq!(
            promo_owner(&["Pro Fest X Rare Special Pack Vol. 1".into()], &families),
            Some(5704)
        );
        assert_eq!(
            promo_owner(&["X Rare Special Pack Vol. 1".into()], &families),
            Some(5464)
        );
        let store = vec![(
            5464,
            family_key("Store Championship Pack 2023 Vol.1 Booster"),
        )];
        assert_eq!(
            promo_owner(&["Championship Pack 2023 Vol. 1".into()], &store),
            Some(5464)
        );
        assert_eq!(promo_owner(&["SAGA".into()], &store), None);
        // "Promotion Pack 1" is TCGplayer's name for "Promotion Pack Vol. 1".
        let packs = vec![(5462, family_key("Promotion Pack Vol. 1 Booster"))];
        assert_eq!(
            promo_owner(&["Promotion Pack 1".into()], &packs),
            Some(5462)
        );
    }

    #[test]
    fn collaboration_names_read_as_the_card() {
        let r = readings("Freedom Gundam - Rage Dragon Emperor Ira");
        assert!(r.contains(&(
            "Rage Dragon Emperor Ira".to_string(),
            vec!["Freedom Gundam".to_string()]
        )));
        assert_eq!(readings("EVA-01 -Operation Yashima-").len(), 1);
    }

    #[test]
    fn release_clock_predicts_the_nearest_known_pair() {
        let clock = vec![(100, 5000), (200, 6000), (300, 9000)];
        assert_eq!(predict(&clock, 190), 6000);
        assert_eq!(predict(&clock, 1000), 9000);
        assert_eq!(predict(&clock, 1), 5000);
    }

    #[test]
    fn treatments() {
        assert!(treatment_fits("sgr", &["SAGA".into()]));
        assert!(treatment_fits("holo", &["Box Topper".into()]));
        assert!(!treatment_fits("holo", &["SPR".into()]));
        assert!(treatment_fits("P", &["Alternate Art".into()]));
    }
}
