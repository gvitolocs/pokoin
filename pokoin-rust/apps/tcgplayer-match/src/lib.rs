//! Pokoin public printing -> TCGplayer product matcher.
//!
//! CardTrader supplies explicit `tcg_player_ids` for about 60% of the Pokémon
//! printings. This fills the rest without fuzzy guessing:
//!
//! * set: a CardTrader expansion may only resolve inside TCGplayer groups it
//!   is tied to, in tier order: groups its explicitly linked cards already
//!   live in, groups named like it (or carrying its set code), then the one
//!   group holding a clear majority of its (number, name) pairs.
//! * card: same category (western -> Pokemon, japanese -> Pokemon Japan), same
//!   normalized collector number and the same name. Exactly one product must
//!   survive at the best name score; ties stay unresolved.
//! * guard: a product already explicitly linked to another printing, or picked
//!   by two printings, is never assigned.

use std::collections::{HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;

pub const POKEMON: i32 = 3;
pub const POKEMON_JAPAN: i32 = 85;

/// Minimum name score that may produce a link (2 = same name once variant
/// parentheses are dropped and TCGplayer has no variant marker).
const ACCEPT: u8 = 2;

#[derive(Clone, Debug, Default)]
pub struct Card {
    pub card_id: i64,
    pub ct_id: i64,
    pub name: String,
    pub alt_name: String,
    /// Collector-number candidates, best first (fixed collector_number,
    /// blueprint version, projected card_number).
    pub numbers: Vec<String>,
    pub expansion_id: i64,
    pub expansion_name: String,
    pub expansion_code: String,
    pub nationality: String,
}

#[derive(Clone, Debug, Default)]
pub struct Product {
    pub product_id: i64,
    pub group_id: i64,
    pub category_id: i32,
    pub name: String,
    pub number: String,
    pub group_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Matched {
        product: usize,
        tier: Tier,
        score: u8,
    },
    AlreadyLinked,
    Unsupported,
    NoNumber,
    NoGroup,
    NoCandidate,
    NameMismatch,
    Ambiguous(Vec<i64>),
    ProductTaken(i64),
    Shared(i64),
}

impl Outcome {
    pub fn status(&self) -> &'static str {
        match self {
            Outcome::Matched { .. } => "matched",
            Outcome::AlreadyLinked => "already_linked",
            Outcome::Unsupported => "unsupported_language",
            Outcome::NoNumber => "no_number",
            Outcome::NoGroup => "no_group",
            Outcome::NoCandidate => "no_candidate",
            Outcome::NameMismatch => "name_mismatch",
            Outcome::Ambiguous(_) => "ambiguous",
            Outcome::ProductTaken(_) => "product_taken",
            Outcome::Shared(_) => "shared_product",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    Linked,
    Named,
    Evidence,
}

impl Tier {
    pub fn label(self) -> &'static str {
        match self {
            Tier::Linked => "linked-group",
            Tier::Named => "named-group",
            Tier::Evidence => "evidence-group",
        }
    }
}

pub fn category_for(nationality: &str) -> Option<i32> {
    match nationality {
        "western" | "american" => Some(POKEMON),
        "japanese" => Some(POKEMON_JAPAN),
        _ => None,
    }
}

/// `"Rare | 019/214"`, `"TG03/TG30"`, `"SV086"`, `"177a"` -> `19`, `TG3`,
/// `SV86`, `177A`. Pokédex numbers (`No.123`) and values without digits are
/// not collector numbers.
pub fn norm_number(raw: &str) -> Option<String> {
    let tail = raw.rsplit('|').next().unwrap_or("").trim();
    let left = tail.split('/').next().unwrap_or("").trim();
    let compact: String = left
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let start = compact.find(|c: char| c.is_ascii_digit())?;
    let (prefix, rest) = compact.split_at(start);
    if prefix == "NO" || prefix.len() > 6 {
        return None;
    }
    let digits_end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    let (digits, suffix) = rest.split_at(digits_end);
    let trimmed = digits.trim_start_matches('0');
    let digits = if trimmed.is_empty() { "0" } else { trimmed };
    // 5+ digit values are CardTrader catalog ids standing in for a number.
    if digits.len() > 4 {
        return None;
    }
    Some(format!("{prefix}{digits}{suffix}"))
}

/// The number without a trailing letter suffix (`3H` -> `3`): Pokoin marks
/// half-deck positions (`003h`, `017to`) that TCGplayer does not print.
pub fn number_core(number: &str) -> &str {
    let end = number
        .rfind(|c: char| c.is_ascii_digit())
        .map(|i| i + 1)
        .unwrap_or(number.len());
    &number[..end]
}

/// `"004/102"` -> `102`, `"016/PCG-P"` -> `PCGP`; `None` without a set total.
pub fn denominator(raw: &str) -> Option<String> {
    let tail = raw.rsplit('|').next().unwrap_or("");
    let (_, right) = tail.split_once('/')?;
    let compact: String = right
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let trimmed = compact.trim_start_matches('0');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn card_denominator(card: &Card) -> Option<String> {
    card.numbers.iter().find_map(|raw| denominator(raw))
}

pub fn card_number(card: &Card) -> Option<String> {
    card.numbers.iter().find_map(|raw| norm_number(raw))
}

/// Lowercase ASCII words: accents folded, gender/delta/star glyphs spelled,
/// apostrophes dropped, every other symbol a word break.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.nfkd() {
        match c {
            '♀' => out.push_str(" f "),
            '♂' => out.push_str(" m "),
            'δ' | 'Δ' => out.push_str(" delta "),
            '★' | '☆' => out.push_str(" star "),
            '◇' | '◆' => out.push_str(" prism "),
            '\'' | '’' | '`' | '.' => {}
            c if unicode_normalization::char::is_combining_mark(c) => {}
            c if c.is_ascii_alphanumeric() => out.push(c.to_ascii_lowercase()),
            _ => out.push(' '),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// TCGplayer suffixes many names with the printed number (`Charizard ex - 199/165`).
pub fn tcg_head(name: &str) -> &str {
    match name.rfind(" - ") {
        Some(at) if name[at + 3..].chars().any(|c| c.is_ascii_digit()) => name[..at].trim(),
        _ => name.trim(),
    }
}

pub fn strip_parens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

fn has_parens(text: &str) -> bool {
    text.contains('(') || text.contains('[')
}

/// The name with every variant description dropped: ` - Professor Birch`
/// tails, parentheses, numeric levels (`Lv.52`, not `LV.X`) and the
/// δ Delta Species / ☆ Gold Star markers that each source spells its own way.
pub fn base_name(name: &str) -> String {
    let cut = name.split(" - ").next().unwrap_or(name);
    fold(&strip_parens(cut))
        .split(' ')
        .filter(|w| {
            !matches!(*w, "delta" | "species" | "gold" | "star")
                && !(w.len() > 2
                    && w.starts_with("lv")
                    && w[2..].chars().all(|c| c.is_ascii_digit()))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NameKey {
    pub full: String,
    pub base: String,
    pub variant: bool,
}

impl NameKey {
    pub fn tcg(name: &str) -> Self {
        let head = tcg_head(name);
        NameKey {
            full: fold(head),
            base: base_name(head),
            variant: has_parens(head),
        }
    }

    pub fn pokoin(name: &str) -> Self {
        NameKey {
            full: fold(name),
            base: base_name(name),
            variant: has_parens(name),
        }
    }
}

/// 3 exact name, 2 same base name and TCGplayer names no variant, 1 same base
/// name but TCGplayer names a variant.
pub fn score_keys(card: &[NameKey], tcg: &NameKey) -> u8 {
    let mut best = 0;
    for key in card {
        if !key.full.is_empty() && key.full == tcg.full {
            return 3;
        }
        if !key.base.is_empty() && key.base == tcg.base {
            best = best.max(if tcg.variant { 1 } else { 2 });
        }
    }
    best
}

pub fn name_score(names: &[&str], tcg_name: &str) -> u8 {
    let keys: Vec<NameKey> = names
        .iter()
        .filter(|n| !n.trim().is_empty())
        .map(|n| NameKey::pokoin(n))
        .collect();
    score_keys(&keys, &NameKey::tcg(tcg_name))
}

/// `"SV3: Ruler of the Black Flame"` -> (`sv3`, `ruler of the black flame`);
/// `"SM - Team Up"` -> (`sm`, `team up`).
pub fn group_parts(group_name: &str) -> (String, String) {
    for separator in [": ", " - "] {
        if let Some(at) = group_name.find(separator) {
            let code = &group_name[..at];
            if !code.is_empty() && code.len() <= 10 && !code.contains(' ') {
                return (
                    code.to_ascii_lowercase(),
                    fold(&group_name[at + separator.len()..]),
                );
            }
        }
    }
    (String::new(), fold(group_name))
}

fn keys_of(card: &Card) -> Vec<NameKey> {
    let mut keys = vec![NameKey::pokoin(&card.name)];
    if !card.alt_name.is_empty() && card.alt_name != card.name {
        keys.push(NameKey::pokoin(&card.alt_name));
    }
    keys
}

/// Precomputed per-product lookup data.
struct Index {
    keys: Vec<NameKey>,
    denominators: Vec<Option<String>>,
    by_number: HashMap<(i32, String), Vec<usize>>,
    /// Unnumbered products by (category, group).
    unnumbered: HashMap<(i32, i64), Vec<usize>>,
}

pub struct Matcher<'a> {
    pub cards: &'a [Card],
    pub products: &'a [Product],
    /// Explicit (CardTrader / reviewed) links: card_id -> product ids.
    pub links: &'a HashMap<i64, Vec<i64>>,
}

#[derive(Default)]
pub struct Result {
    pub outcomes: Vec<Outcome>,
    /// Expansion id -> tiered candidate groups.
    pub groups: HashMap<i64, Vec<(Tier, i64)>>,
}

impl<'a> Matcher<'a> {
    pub fn run(&self) -> Result {
        let index = self.index();
        let product_at: HashMap<i64, usize> = self
            .products
            .iter()
            .enumerate()
            .map(|(i, p)| (p.product_id, i))
            .collect();
        let card_by_id: HashMap<i64, &Card> = self.cards.iter().map(|c| (c.card_id, c)).collect();
        let mut owner: HashMap<i64, i64> = HashMap::new();
        for (card_id, products) in self.links {
            for product in products {
                owner.entry(*product).or_insert(*card_id);
            }
        }
        let card_keys: Vec<Vec<NameKey>> = self.cards.iter().map(keys_of).collect();

        let groups = self.expansion_groups(&index, &card_keys, &product_at, &card_by_id);
        let mut outcomes: Vec<Outcome> = self
            .cards
            .iter()
            .zip(&card_keys)
            .map(|(card, keys)| self.match_card(card, keys, &groups, &index))
            .collect();

        let mut picked: HashMap<i64, usize> = HashMap::new();
        for outcome in &outcomes {
            if let Outcome::Matched { product, .. } = outcome {
                *picked
                    .entry(self.products[*product].product_id)
                    .or_default() += 1;
            }
        }
        for (i, outcome) in outcomes.iter_mut().enumerate() {
            if let Outcome::Matched { product, .. } = outcome {
                let product_id = self.products[*product].product_id;
                if let Some(other) = owner
                    .get(&product_id)
                    .filter(|o| **o != self.cards[i].card_id)
                {
                    *outcome = Outcome::ProductTaken(*other);
                } else if picked[&product_id] > 1 {
                    *outcome = Outcome::Shared(product_id);
                }
            }
        }
        Result { outcomes, groups }
    }

    fn index(&self) -> Index {
        let mut index = Index {
            keys: Vec::with_capacity(self.products.len()),
            denominators: Vec::with_capacity(self.products.len()),
            by_number: HashMap::new(),
            unnumbered: HashMap::new(),
        };
        for (i, product) in self.products.iter().enumerate() {
            index.keys.push(NameKey::tcg(&product.name));
            match norm_number(&product.number) {
                Some(n) => index
                    .by_number
                    .entry((product.category_id, n))
                    .or_default()
                    .push(i),
                None => index
                    .unnumbered
                    .entry((product.category_id, product.group_id))
                    .or_default()
                    .push(i),
            }
            index.denominators.push(denominator(&product.number));
        }
        index
    }

    /// Products at the card's number (exact, else without a half-deck suffix)
    /// whose set total does not contradict the card's.
    fn numbered(
        &self,
        index: &Index,
        category: i32,
        number: &str,
        total: &Option<String>,
    ) -> Vec<usize> {
        let fits = |&&i: &&usize| match (total, &index.denominators[i]) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        };
        let exact: Vec<usize> = index
            .by_number
            .get(&(category, number.to_string()))
            .map(|v| v.iter().filter(fits).copied().collect())
            .unwrap_or_default();
        let core = number_core(number);
        if !exact.is_empty() || core == number {
            return exact;
        }
        index
            .by_number
            .get(&(category, core.to_string()))
            .map(|v| v.iter().filter(fits).copied().collect())
            .unwrap_or_default()
    }

    fn expansion_groups(
        &self,
        index: &Index,
        card_keys: &[Vec<NameKey>],
        product_at: &HashMap<i64, usize>,
        card_by_id: &HashMap<i64, &Card>,
    ) -> HashMap<i64, Vec<(Tier, i64)>> {
        let mut expansions: HashMap<i64, Vec<usize>> = HashMap::new();
        for (i, card) in self.cards.iter().enumerate() {
            expansions.entry(card.expansion_id).or_default().push(i);
        }
        // Linked: groups the expansion's explicit links already resolve to.
        let mut linked: HashMap<i64, HashMap<i64, usize>> = HashMap::new();
        for (card_id, products) in self.links {
            let Some(card) = card_by_id.get(card_id) else {
                continue;
            };
            for product in products {
                if let Some(&i) = product_at.get(product) {
                    *linked
                        .entry(card.expansion_id)
                        .or_default()
                        .entry(self.products[i].group_id)
                        .or_default() += 1;
                }
            }
        }
        // Named: group title or set code equals the CardTrader expansion's.
        let mut group_info: HashMap<i64, (i32, String, String, String)> = HashMap::new();
        for product in self.products {
            group_info.entry(product.group_id).or_insert_with(|| {
                let (code, core) = group_parts(&product.group_name);
                (product.category_id, code, core, fold(&product.group_name))
            });
        }

        let mut out = HashMap::new();
        for (expansion_id, members) in &expansions {
            let first = &self.cards[members[0]];
            let Some(category) = category_for(&first.nationality) else {
                continue;
            };
            let mut tiers: Vec<(Tier, i64)> = Vec::new();
            let mut seen = HashSet::new();
            let mut push = |tiers: &mut Vec<(Tier, i64)>, tier, group| {
                if seen.insert(group) {
                    tiers.push((tier, group));
                }
            };
            if let Some(votes) = linked.get(expansion_id) {
                let mut votes: Vec<_> = votes.iter().collect();
                votes.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
                for (group, _) in votes {
                    push(&mut tiers, Tier::Linked, *group);
                }
            }
            let name = fold(&first.expansion_name);
            let code = first.expansion_code.to_ascii_lowercase();
            let code_ok = code.len() >= 3 && code.chars().any(|c| c.is_ascii_digit());
            let mut named: Vec<i64> = group_info
                .iter()
                .filter(|(_, (cat, gcode, core, full))| {
                    *cat == category
                        && (!name.is_empty() && (*core == name || *full == name)
                            || code_ok && *gcode == code)
                })
                .map(|(group, _)| *group)
                .collect();
            named.sort_unstable();
            for group in named {
                push(&mut tiers, Tier::Named, group);
            }
            // Evidence: the group holding a clear majority of (number, name) pairs.
            let mut hits: HashMap<i64, usize> = HashMap::new();
            let mut numbered = 0usize;
            for &c in members {
                let card = &self.cards[c];
                let Some(number) = card_number(card) else {
                    continue;
                };
                numbered += 1;
                let mut groups_hit = HashSet::new();
                for i in self.numbered(index, category, &number, &card_denominator(card)) {
                    if score_keys(&card_keys[c], &index.keys[i]) >= ACCEPT {
                        groups_hit.insert(self.products[i].group_id);
                    }
                }
                for group in groups_hit {
                    *hits.entry(group).or_default() += 1;
                }
            }
            let mut ranked: Vec<_> = hits.into_iter().collect();
            ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            if let Some(&(group, top)) = ranked.first() {
                let second = ranked.get(1).map(|r| r.1).unwrap_or(0);
                if top >= 3 && top * 10 >= numbered * 4 && top * 2 > second * 3 {
                    push(&mut tiers, Tier::Evidence, group);
                }
            }
            if !tiers.is_empty() {
                out.insert(*expansion_id, tiers);
            }
        }
        out
    }

    fn match_card(
        &self,
        card: &Card,
        keys: &[NameKey],
        groups: &HashMap<i64, Vec<(Tier, i64)>>,
        index: &Index,
    ) -> Outcome {
        if self.links.get(&card.card_id).is_some_and(|l| !l.is_empty()) {
            return Outcome::AlreadyLinked;
        }
        let Some(category) = category_for(&card.nationality) else {
            return Outcome::Unsupported;
        };
        let number = card_number(card);
        let Some(tiers) = groups.get(&card.expansion_id) else {
            return if number.is_none() {
                Outcome::NoNumber
            } else {
                Outcome::NoGroup
            };
        };
        let candidates = match &number {
            Some(n) => self.numbered(index, category, n, &card_denominator(card)),
            // Unnumbered printings (old JP Pokédex-numbered sets) may only meet
            // unnumbered products, by exact name, in linked or named groups.
            None => tiers
                .iter()
                .filter(|(t, _)| *t != Tier::Evidence)
                .flat_map(|(_, g)| {
                    index
                        .unnumbered
                        .get(&(category, *g))
                        .into_iter()
                        .flatten()
                        .copied()
                })
                .collect(),
        };
        let mut saw_candidate = false;
        for tier in [Tier::Linked, Tier::Named, Tier::Evidence] {
            let in_tier: HashSet<i64> = tiers
                .iter()
                .filter(|(t, _)| *t == tier)
                .map(|(_, g)| *g)
                .collect();
            if in_tier.is_empty() {
                continue;
            }
            let scored: Vec<(u8, usize)> = candidates
                .iter()
                .filter(|&&i| in_tier.contains(&self.products[i].group_id))
                .map(|&i| (score_keys(keys, &index.keys[i]), i))
                .collect();
            if scored.is_empty() {
                continue;
            }
            saw_candidate = true;
            let best = scored.iter().map(|s| s.0).max().unwrap_or(0);
            // A TCGplayer variant name is accepted only when it is the one product
            // printed at that number in the tier; never for unnumbered cards.
            let floor = if number.is_none() {
                3
            } else if scored.len() == 1 {
                1
            } else {
                ACCEPT
            };
            if best < floor {
                continue;
            }
            let top: Vec<usize> = scored.iter().filter(|s| s.0 == best).map(|s| s.1).collect();
            if top.len() == 1 {
                return Outcome::Matched {
                    product: top[0],
                    tier,
                    score: best,
                };
            }
            let mut ids: Vec<i64> = top.iter().map(|&i| self.products[i].product_id).collect();
            ids.sort_unstable();
            return Outcome::Ambiguous(ids);
        }
        match (saw_candidate, number.is_some()) {
            (true, _) => Outcome::NameMismatch,
            (false, true) => Outcome::NoCandidate,
            (false, false) => Outcome::NoNumber,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_normalize_like_printed_collectors() {
        assert_eq!(norm_number("005/049").as_deref(), Some("5"));
        assert_eq!(norm_number("Rare | 119/214").as_deref(), Some("119"));
        assert_eq!(norm_number("TG03/TG30").as_deref(), Some("TG3"));
        assert_eq!(norm_number("SV086").as_deref(), Some("SV86"));
        assert_eq!(norm_number("SWSH050").as_deref(), Some("SWSH50"));
        assert_eq!(norm_number("177a").as_deref(), Some("177A"));
        assert_eq!(norm_number("001/SV-P").as_deref(), Some("1"));
        assert_eq!(norm_number("000").as_deref(), Some("0"));
        assert_eq!(norm_number("No.123"), None);
        assert_eq!(norm_number("Holo"), None);
        assert_eq!(norm_number("245879"), None);
        assert_eq!(number_core("3H"), "3");
        assert_eq!(number_core("TG3"), "TG3");
        assert_eq!(denominator("004/102").as_deref(), Some("102"));
        assert_eq!(denominator("016/PCG-P").as_deref(), Some("PCGP"));
        assert_eq!(denominator("016"), None);
        assert_eq!(norm_number(""), None);
    }

    #[test]
    fn names_fold_symbols_and_accents() {
        assert_eq!(fold("Pokémon Center Lady"), "pokemon center lady");
        assert_eq!(fold("Mewtwo-EX"), "mewtwo ex");
        assert_eq!(fold("Nidoran♀"), "nidoran f");
        assert_eq!(fold("Professor's Research"), "professors research");
        assert_eq!(fold("Mr. Mime"), "mr mime");
        assert_eq!(fold("Pikachu & Zekrom-GX"), "pikachu zekrom gx");
        assert_eq!(fold("Latias δ"), "latias delta");
        assert_eq!(tcg_head("Charizard ex - 199/165"), "Charizard ex");
        assert_eq!(tcg_head("Ho-Oh - SWSH050"), "Ho-Oh");
        assert_eq!(tcg_head("Ho-Oh"), "Ho-Oh");
    }

    #[test]
    fn name_scores_rank_exact_over_variants() {
        assert_eq!(name_score(&["Charizard"], "Charizard"), 3);
        assert_eq!(name_score(&["Charizard ex"], "Charizard ex - 199/165"), 3);
        assert_eq!(name_score(&["Pikachu (Pokemon Center)"], "Pikachu"), 2);
        assert_eq!(name_score(&["Charizard"], "Charizard (Black Dot Error)"), 1);
        assert_eq!(name_score(&["Charizard"], "Blastoise"), 0);
        assert_eq!(name_score(&["Empoleon Lv.52"], "Empoleon"), 2);
        assert_eq!(name_score(&["Garchomp LV.X"], "Garchomp"), 0);
        assert_eq!(name_score(&["Groudon ☆ Gold Star"], "Groudon Star"), 2);
        assert_eq!(
            name_score(
                &["Professor's Research - Professor Birch"],
                "Professor's Research"
            ),
            2
        );
    }

    #[test]
    fn group_titles_split_code_and_name() {
        assert_eq!(
            group_parts("SV3: Ruler of the Black Flame"),
            ("sv3".into(), "ruler of the black flame".into())
        );
        assert_eq!(group_parts("SM - Team Up"), ("sm".into(), "team up".into()));
        assert_eq!(group_parts("Base Set"), (String::new(), "base set".into()));
    }

    fn card(card_id: i64, name: &str, number: &str, expansion_id: i64, nationality: &str) -> Card {
        Card {
            card_id,
            ct_id: card_id / 2,
            name: name.into(),
            numbers: vec![number.into()],
            expansion_id,
            expansion_name: "VSTAR Universe".into(),
            expansion_code: "s12a".into(),
            nationality: nationality.into(),
            ..Card::default()
        }
    }

    fn product(product_id: i64, group_id: i64, name: &str, number: &str, group: &str) -> Product {
        Product {
            product_id,
            group_id,
            category_id: POKEMON_JAPAN,
            name: name.into(),
            number: number.into(),
            group_name: group.into(),
        }
    }

    #[test]
    fn matches_inside_named_group_only() {
        let cards = vec![
            card(10, "Arceus VSTAR", "123/172", 1, "japanese"),
            card(12, "Charizard", "011/172", 1, "japanese"),
            card(14, "Mew", "001/172", 1, "chinese"),
        ];
        let products = vec![
            product(
                100,
                7,
                "Arceus VSTAR - 123/172",
                "123/172",
                "S12a: VSTAR Universe",
            ),
            product(101, 7, "Charizard", "011/172", "S12a: VSTAR Universe"),
            product(
                102,
                7,
                "Charizard (Master Ball)",
                "011/172",
                "S12a: VSTAR Universe",
            ),
            product(200, 8, "Arceus VSTAR", "123/172", "Other Set"),
        ];
        let links = HashMap::new();
        let result = Matcher {
            cards: &cards,
            products: &products,
            links: &links,
        }
        .run();
        assert_eq!(
            result.outcomes[0],
            Outcome::Matched {
                product: 0,
                tier: Tier::Named,
                score: 3
            }
        );
        assert_eq!(
            result.outcomes[1],
            Outcome::Matched {
                product: 1,
                tier: Tier::Named,
                score: 3
            }
        );
        assert_eq!(result.outcomes[2], Outcome::Unsupported);
    }

    #[test]
    fn guards_taken_shared_and_ambiguous_products() {
        let mut cards = vec![
            card(10, "Pikachu", "001/010", 1, "japanese"),
            card(12, "Pikachu", "001/010", 1, "japanese"),
            card(14, "Raichu", "002/010", 1, "japanese"),
            card(16, "Eevee", "003/010", 1, "japanese"),
        ];
        for c in &mut cards {
            c.expansion_name = "Mini Set".into();
            c.expansion_code = "ms".into();
        }
        let products = vec![
            product(100, 7, "Pikachu", "001/010", "Mini Set"),
            product(101, 7, "Raichu", "002/010", "Mini Set"),
            product(102, 7, "Eevee", "003/010", "Mini Set"),
            product(103, 7, "Eevee", "003/010", "Mini Set"),
        ];
        let links = HashMap::from([(99, vec![101])]);
        let result = Matcher {
            cards: &cards,
            products: &products,
            links: &links,
        }
        .run();
        assert_eq!(result.outcomes[0], Outcome::Shared(100));
        assert_eq!(result.outcomes[1], Outcome::Shared(100));
        assert_eq!(result.outcomes[2], Outcome::ProductTaken(99));
        assert_eq!(result.outcomes[3], Outcome::Ambiguous(vec![102, 103]));
    }

    #[test]
    fn linked_groups_win_and_evidence_needs_majority() {
        let mut cards: Vec<Card> = (0..5)
            .map(|i| {
                card(
                    10 + 2 * i,
                    &format!("Mon{i}"),
                    &format!("{:03}/005", i + 1),
                    1,
                    "western",
                )
            })
            .collect();
        for c in &mut cards {
            c.expansion_name = "Odd CT Title".into();
            c.expansion_code = "odd".into();
        }
        let mut products: Vec<Product> = (0..5)
            .map(|i| Product {
                category_id: POKEMON,
                ..product(
                    100 + i,
                    7,
                    &format!("Mon{i}"),
                    &format!("{:03}/005", i + 1),
                    "TCG Title",
                )
            })
            .collect();
        // A reprint group carrying one coincidence must not win the set.
        products.push(Product {
            category_id: POKEMON,
            ..product(300, 9, "Mon0", "001/099", "Reprints")
        });
        let links = HashMap::new();
        let result = Matcher {
            cards: &cards,
            products: &products,
            links: &links,
        }
        .run();
        assert_eq!(result.groups[&1], vec![(Tier::Evidence, 7)]);
        assert!(result.outcomes.iter().all(|o| matches!(
            o,
            Outcome::Matched {
                tier: Tier::Evidence,
                ..
            }
        )));
    }

    #[test]
    fn half_deck_suffixes_totals_and_unnumbered_cards() {
        let mut cards = vec![
            card(10, "Crocalor", "003h", 1, "japanese"),
            card(12, "Giovanni's Machop", "No.066", 1, "japanese"),
            card(14, "Blaine's Charmander", "No.004", 1, "japanese"),
            card(16, "Machop", "049/150", 1, "japanese"),
        ];
        for c in &mut cards {
            c.expansion_name = "Mini Set".into();
            c.expansion_code = "ms".into();
        }
        let products = vec![
            product(100, 7, "Crocalor", "003/021", "Mini Set"),
            product(101, 7, "Giovanni's Machop", "", "Mini Set"),
            product(102, 7, "Blaine's Charmander (Holo)", "", "Mini Set"),
            product(103, 7, "Machop", "049/092", "Mini Set"),
        ];
        let links = HashMap::new();
        let result = Matcher {
            cards: &cards,
            products: &products,
            links: &links,
        }
        .run();
        assert_eq!(
            result.outcomes[0],
            Outcome::Matched {
                product: 0,
                tier: Tier::Named,
                score: 3
            }
        );
        assert_eq!(
            result.outcomes[1],
            Outcome::Matched {
                product: 1,
                tier: Tier::Named,
                score: 3
            }
        );
        assert_eq!(result.outcomes[2], Outcome::NameMismatch);
        assert_eq!(result.outcomes[3], Outcome::NoCandidate);
    }
}
