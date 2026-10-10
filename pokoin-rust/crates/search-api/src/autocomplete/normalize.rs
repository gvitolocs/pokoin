//! Text normalisation of the autocomplete handler: `foldDiacritics`, `compact`,
//! `searchTerms`, the variation/rarity/expansion vocabularies, predictive
//! n-gram chunks and the bounded Damerau-Levenshtein distance.

use serde_json::Value;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// `foldDiacritics(value)` — NFKD then strip U+0300–U+036F.
pub fn fold_diacritics(value: &str) -> String {
    value
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect()
}

static HEART_GOLD_SOUL_SILVER_SPACED: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\bheart\s*gold\s*&\s*soul\s*silver\b").unwrap());
static HEART_GOLD_SOUL_SILVER_TIGHT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\bheartgold\s*&\s*soulsilver\b").unwrap());

/// `compact(value)` of the autocomplete module (folds HGSS spellings, turns `&`
/// into `tagteam`, keeps only `[a-z0-9]`).
pub fn compact(value: &str) -> String {
    let folded = fold_diacritics(value);
    let folded = HEART_GOLD_SOUL_SILVER_SPACED.replace_all(&folded, "heartgoldsoulsilver");
    let folded = HEART_GOLD_SOUL_SILVER_TIGHT.replace_all(&folded, "heartgoldsoulsilver");
    folded
        .replace('&', " tagteam ")
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .collect()
}

/// `compact` of `marketplace-search-candidates.js` (no HGSS/tagteam rewrites).
pub fn compact_plain(value: &str) -> String {
    fold_diacritics(value)
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .collect()
}

static VARIATION_PHRASES: LazyLock<Vec<(regex::Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            regex::Regex::new(r"(?i)\bhearth\s+gold\b").unwrap(),
            "heartgold",
        ),
        (
            regex::Regex::new(r"(?i)\bheart\s+gold\b").unwrap(),
            "heartgold",
        ),
        (regex::Regex::new(r"(?i)\blv\s*\.?\s*x\b").unwrap(), "lvx"),
        (regex::Regex::new(r"(?i)\blevel\s+x\b").unwrap(), "lvx"),
        (regex::Regex::new(r"(?i)\bv\s*max\b").unwrap(), "vmax"),
        (regex::Regex::new(r"(?i)\bv\s*star\b").unwrap(), "vstar"),
        (regex::Regex::new(r"(?i)\bg\s*x\b").unwrap(), "gx"),
        (regex::Regex::new(r"(?i)\be\s*x\b").unwrap(), "ex"),
    ]
});

/// `normalizeVariationPhrases(value)`.
pub fn normalize_variation_phrases(value: &str) -> String {
    let mut out = value.to_owned();
    for (pattern, replacement) in VARIATION_PHRASES.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

static POSSESSIVE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b([a-z0-9]+)s\b").unwrap());

/// `searchTerms(value)` of the autocomplete module. `cards` becomes `card` (the
/// possessive rewrite splits the trailing `s` off and the single-letter filter
/// drops it).
pub fn search_terms(value: &str) -> Vec<String> {
    let raw: String = POSSESSIVE
        .replace_all(
            &fold_diacritics(&normalize_variation_phrases(value)).to_lowercase(),
            "${1}'s",
        )
        .into_owned();
    let raw_terms: Vec<String> = raw
        .split(|ch: char| !ch.is_ascii_lowercase() && !ch.is_ascii_digit())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_owned)
        .collect();
    let multi = raw_terms.len() > 1;
    raw_terms
        .into_iter()
        .filter(|term| {
            term.chars().count() >= 2
                || term == "v"
                || term == "n"
                || ((term == "g" || term == "e") && multi)
        })
        .collect()
}

/// `searchTerms(value)` of `marketplace-search-candidates.js` (no possessive /
/// HGSS rewrites; the `ex` phrase rewrite only fires on spaced `e x`).
pub fn candidates_search_terms(value: &str) -> Vec<String> {
    let raw = fold_diacritics(value).replace('&', " tagteam ");
    let mut raw = raw;
    for (pattern, replacement) in VARIATION_PHRASES.iter().skip(2) {
        raw = pattern.replace_all(&raw, *replacement).into_owned();
    }
    let raw = raw.to_lowercase();
    let raw_terms: Vec<String> = raw
        .split(|ch: char| !ch.is_ascii_lowercase() && !ch.is_ascii_digit())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_owned)
        .collect();
    let multi = raw_terms.len() > 1;
    raw_terms
        .into_iter()
        .filter(|term| {
            term.chars().count() >= 2
                || term == "v"
                || term == "n"
                || ((term == "g" || term == "e") && multi)
        })
        .collect()
}

pub const VARIATION_TERMS: [&str; 14] = [
    "ex", "v", "vmax", "vstar", "gx", "lvx", "lv", "mega", "break", "radiant", "shining", "shiny",
    "prime", "tagteam",
];

/// `isVariationTerm(term)`.
pub fn is_variation_term(term: &str) -> bool {
    let compact_term = compact(term);
    VARIATION_TERMS.contains(&compact_term.as_str())
}

/// `variationTermTargets(term)` — exact match, else the variations the term is
/// a prefix of (iteration order of the JS Set).
pub fn variation_term_targets(term: &str) -> Vec<String> {
    let normalized = compact(term);
    if normalized.is_empty() {
        return Vec::new();
    }
    if is_variation_term(&normalized) {
        return vec![normalized];
    }
    VARIATION_TERMS
        .iter()
        .filter(|variation| variation.starts_with(normalized.as_str()))
        .map(|variation| (*variation).to_owned())
        .collect()
}

/// `isVariationIntentTerm(term)`.
pub fn is_variation_intent_term(term: &str) -> bool {
    let normalized = compact(term);
    if normalized.is_empty() {
        return false;
    }
    is_variation_term(&normalized)
        || normalized == "g"
        || normalized == "e"
        || (normalized.chars().count() >= 2 && !variation_term_targets(&normalized).is_empty())
}

pub const RARITY_TERMS: [&str; 12] = [
    "sir",
    "ir",
    "ur",
    "sr",
    "rare",
    "ultra",
    "secret",
    "ill",
    "illus",
    "illustration",
    "holo",
    "shiny",
];

/// `isRarityTerm(term)`.
pub fn is_rarity_term(term: &str) -> bool {
    RARITY_TERMS.contains(&compact(term).as_str())
}

/// Expansion alias table (`expansionAliases` map): alias -> compact set names.
pub fn expansion_alias_targets(term: &str) -> Vec<String> {
    match compact(term).as_str() {
        "col" | "calllegends" | "calloflegends" => vec!["calloflegends".into()],
        "hgss" | "hgs" => vec![
            "heartgoldsoulsilver",
            "unleashed",
            "undaunted",
            "triumphant",
            "calloflegends",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        "heartgold" | "hearthgold" => vec![
            "heartgoldsoulsilver",
            "heartgoldcollection",
            "unleashed",
            "undaunted",
            "triumphant",
            "calloflegends",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        "soulsilver" => vec![
            "heartgoldsoulsilver",
            "soulsilvercollection",
            "unleashed",
            "undaunted",
            "triumphant",
            "calloflegends",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        "heartgoldsoulsilver" => vec![
            "heartgoldsoulsilver",
            "unleashed",
            "undaunted",
            "triumphant",
            "calloflegends",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        "unleashed" => vec!["unleashed".into()],
        "undaunted" => vec!["undaunted".into()],
        "triumphant" => vec!["triumphant".into()],
        "151" => vec!["151", "pokemoncard151", "collect151"]
            .into_iter()
            .map(String::from)
            .collect(),
        "pokemon151" | "pokemoncard151" => vec!["pokemoncard151".into()],
        "collect151" => vec!["collect151".into()],
        "cel" => vec!["celebrations".into()],
        "pal" => vec!["paldeaevolved".into()],
        "obf" | "obs" => vec!["obsidianflames".into()],
        "svi" | "sv" => vec!["scarletviolet".into()],
        _ => Vec::new(),
    }
}

/// `isExpansionAliasTerm(term)`.
pub fn is_expansion_alias_term(term: &str) -> bool {
    !expansion_alias_targets(term).is_empty()
}

/// `meaningfulSearchDepth(query)` — count of `[a-z0-9]` letters.
pub fn meaningful_search_depth(query: &str) -> usize {
    query
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .count()
}

/// `boundedDistance(a, b, maxDistance)` — Damerau-Levenshtein (optimal string
/// alignment) with the JS early bail-outs.
pub fn bounded_distance(a: &str, b: &str, max_distance: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max_distance {
        return max_distance + 1;
    }
    let mut matrix = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in matrix.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=b.len() {
        matrix[0][j] = j;
    }
    for i in 1..=a.len() {
        let mut row_min = max_distance + 1;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut value = (matrix[i - 1][j] + 1)
                .min(matrix[i][j - 1] + 1)
                .min(matrix[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                value = value.min(matrix[i - 2][j - 2] + 1);
            }
            matrix[i][j] = value;
            row_min = row_min.min(value);
        }
        if row_min > max_distance {
            return max_distance + 1;
        }
    }
    matrix[a.len()][b.len()]
}

/// `predictiveChunksForQuery(value, minLength = 2, maxLength = 3)`.
pub fn predictive_chunks_for_query(
    value: &str,
    min_length: usize,
    max_length: usize,
) -> Vec<Value> {
    let compact_value = compact(&normalize_variation_phrases(value));
    if compact_value.chars().count() < min_length {
        return Vec::new();
    }
    let chars: Vec<char> = compact_value.chars().collect();
    let clean_max_length = max_length.clamp(min_length, 4);
    let mut chunks: Vec<(String, usize, usize, bool)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for length in min_length..=clean_max_length.min(chars.len()) {
        for index in 0..=(chars.len() - length) {
            let chunk: String = chars[index..index + length].iter().collect();
            let key = format!("{chunk}:{index}");
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            chunks.push((chunk, index + 1, length, index == 0));
        }
    }
    chunks.sort_by(|left, right| {
        left.3
            .cmp(&right.3)
            .reverse()
            .then(right.2.cmp(&left.2))
            .then(left.1.cmp(&right.1))
            .then(left.0.cmp(&right.0))
    });
    chunks.truncate(16);
    chunks
        .into_iter()
        .map(|(chunk, position, length, is_prefix)| {
            serde_json::json!({
                "chunk": chunk,
                "position": position,
                "length": length,
                "isPrefix": is_prefix,
            })
        })
        .collect()
}

/// Total order for `f64` sort keys: numbers by `partial_cmp` (optionally
/// descending), NaN after every number. `partial_cmp(..).unwrap_or(Equal)`
/// makes NaN equal to everything, which is not transitive and makes
/// `sort_by` panic ("does not correctly implement a total order").
pub fn cmp_f64_nan_last(left: f64, right: f64, descending: bool) -> std::cmp::Ordering {
    match (left.is_nan(), right.is_nan()) {
        (false, false) => {
            let order = left
                .partial_cmp(&right)
                .unwrap_or(std::cmp::Ordering::Equal);
            if descending {
                order.reverse()
            } else {
                order
            }
        }
        (left_nan, right_nan) => left_nan.cmp(&right_nan),
    }
}

/// JS `localeCompare` tie-breaks. ICU collation is approximated by comparing
/// the diacritic-folded lowercase strings first (base letters), then the raw
/// strings; `localeCompare` in Node returns (-1|0|1)-shaped values but only
/// the sign is ever observed.
pub fn locale_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let fold = |value: &str| {
        fold_diacritics(value)
            .to_lowercase()
            .chars()
            .filter(|ch| *ch != '\'' && *ch != '\u{2019}')
            .collect::<String>()
    };
    fold(left).cmp(&fold(right)).then_with(|| left.cmp(right))
}

/// JS `Number(value)` for a decoded JSON value: `undefined` (missing) is NaN,
/// `null` is 0, arrays coerce like `Number([x])`.
pub fn js_value_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::String(text) => pokoin_api_common::http::js_number(text),
        Value::Array(items) => match items.len() {
            0 => Some(0.0),
            1 => js_value_number(&items[0]),
            _ => Some(f64::NAN),
        },
        Value::Object(_) => Some(f64::NAN),
    }
}

/// JS `Number(value || fallback)` for row/body fields: falsy JSON values fall
/// back; `undefined` (missing key) also falls back.
pub fn js_num_or(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(fallback),
        Some(Value::String(text)) => match pokoin_api_common::http::js_number(text) {
            Some(parsed) if !parsed.is_nan() => parsed,
            _ => fallback,
        },
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                fallback
            }
        }
        _ => fallback,
    }
}

/// JS `String(value || '')`.
pub fn js_str_or(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

/// `cleanSearchTerm(value)` of `marketplace-search-candidates.js`:
/// `String(value || '').trim().slice(0, 80)`.
pub fn clean_search_term(value: Option<&Value>) -> String {
    let mut text = js_str_or(value);
    text.truncate_preserving_graphemes_80();
    text.trim().to_owned()
}

trait Slice80 {
    fn truncate_preserving_graphemes_80(&mut self);
}

impl Slice80 for String {
    fn truncate_preserving_graphemes_80(&mut self) {
        // JS slice(0, 80) counts UTF-16 code units; terms are user text, so
        // cutting on chars keeps the 80-unit behaviour for BMP input.
        if self.chars().count() > 80 {
            *self = self.chars().take(80).collect();
        }
    }
}

/// `cleanLimit(value)` — `Number(value)`; non-finite (incl. undefined) -> 20,
/// then `min(max(trunc, 1), 15874)`.
pub fn clean_limit(value: Option<&Value>) -> i64 {
    let parsed = value.and_then(js_value_number);
    match parsed {
        Some(limit) if limit.is_finite() => (limit.trunc() as i64).clamp(1, 15_874),
        _ => 20,
    }
}

/// `cleanOffset(value)` — non-finite (incl. undefined) -> 0, clamp 0..=15874.
pub fn clean_offset(value: Option<&Value>) -> i64 {
    let parsed = value.and_then(js_value_number);
    match parsed {
        Some(offset) if offset.is_finite() => (offset.trunc() as i64).clamp(0, 15_874),
        _ => 0,
    }
}

/// `cleanLanguage(value)` — `en` unless a `xx` / `xx-XX` tag.
pub fn clean_language(value: Option<&Value>) -> String {
    let raw = match value {
        None => "en".to_owned(),
        Some(value) => js_str_or(Some(value)),
    };
    let language = raw.trim().to_lowercase();
    let bytes = language.as_bytes();
    let two = bytes.len() == 2 && bytes.iter().all(|b| b.is_ascii_lowercase());
    let five = bytes.len() == 5
        && bytes[2] == b'-'
        && bytes[..2].iter().all(|b| b.is_ascii_lowercase())
        && bytes[3..].iter().all(|b| b.is_ascii_lowercase());
    if two || five {
        language
    } else {
        "en".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_folds_diactitics_and_ampersands() {
        assert_eq!(compact("Pokémon"), "pokemon");
        assert_eq!(compact("Zacian & Zamazenta"), "zaciantagteamzamazenta");
        assert_eq!(compact("Heart Gold & Soul Silver"), "heartgoldsoulsilver");
        assert_eq!(compact("heartgold & soulsilver"), "heartgoldsoulsilver");
        assert_eq!(compact_plain("Zacian & Zamazenta"), "zacianzamazenta");
    }

    #[test]
    fn search_terms_rewrite_variations_and_possessives() {
        assert_eq!(search_terms("Charizard V MAX"), vec!["charizard", "vmax"]);
        assert_eq!(search_terms("keldeo ex"), vec!["keldeo", "ex"]);
        assert_eq!(search_terms("cards"), vec!["card"]);
        assert_eq!(search_terms("zapdos g"), vec!["zapdo", "g"]); // possessive rewrite strips the s
        assert_eq!(search_terms("g"), Vec::<String>::new());
        assert_eq!(candidates_search_terms("cards"), vec!["cards"]);
        assert_eq!(candidates_search_terms("v max"), vec!["vmax"]);
        assert_eq!(
            candidates_search_terms("Zacian & Zamazenta"),
            vec!["zacian", "tagteam", "zamazenta"]
        );
    }

    #[test]
    fn variation_vocab() {
        assert!(is_variation_term("EX"));
        assert_eq!(variation_term_targets("v"), vec!["v"]);
        assert_eq!(variation_term_targets("vm"), vec!["vmax"]);
        assert_eq!(variation_term_targets("e"), vec!["ex"]); // prefix of ex
        assert!(is_variation_intent_term("e"));
        assert!(is_variation_intent_term("vm"));
        assert!(!is_variation_intent_term("q"));
    }

    #[test]
    fn rarity_and_expansion_vocab() {
        assert!(is_rarity_term("SIR"));
        assert!(is_rarity_term("illus"));
        assert!(!is_rarity_term("charizard"));
        assert_eq!(expansion_alias_targets("sv"), vec!["scarletviolet"]);
        assert_eq!(
            expansion_alias_targets("151"),
            vec!["151", "pokemoncard151", "collect151"]
        );
        assert_eq!(expansion_alias_targets("hgss").len(), 5);
        assert!(is_expansion_alias_term("OBS"));
        assert!(!is_expansion_alias_term("obsidian"));
    }

    #[test]
    fn depth_counts_alnum_only() {
        assert_eq!(meaningful_search_depth("pikachu"), 7);
        assert_eq!(meaningful_search_depth("sv 25"), 4);
        assert_eq!(meaningful_search_depth("  ! "), 0);
    }

    #[test]
    fn distance_is_damerau_with_bailouts() {
        assert_eq!(bounded_distance("pikachu", "pikach", 2), 1);
        assert_eq!(bounded_distance("umbreon", "umbrean", 2), 1);
        assert_eq!(bounded_distance("ab", "ba", 1), 1);
        assert_eq!(bounded_distance("abc", "xy", 1), 2);
        assert_eq!(bounded_distance("kitten", "mutton", 2), 3);
    }

    #[test]
    fn predictive_chunks_prefers_prefixes_then_longer() {
        let chunks = predictive_chunks_for_query("pika", 2, 3);
        // prefix chunks first, longest first
        assert_eq!(
            chunks[0],
            serde_json::json!({"chunk": "pik", "position": 1, "length": 3, "isPrefix": true})
        );
        assert!(chunks.iter().any(|chunk| chunk["chunk"] == "pi"));
        let empty = predictive_chunks_for_query("a", 2, 3);
        assert!(empty.is_empty());
    }

    #[test]
    fn clean_helpers_match_node_defaults() {
        assert_eq!(clean_search_term(Some(&serde_json::Value::Null)), "");
        assert_eq!(
            clean_search_term(Some(&serde_json::json!("  pika  "))),
            "pika"
        );
        assert_eq!(clean_search_term(Some(&serde_json::json!(42))), "42");
        assert_eq!(clean_limit(Some(&serde_json::json!(0))), 1);
        assert_eq!(clean_limit(Some(&serde_json::Value::Null)), 1);
        assert_eq!(clean_limit(None), 20);
        assert_eq!(clean_limit(Some(&serde_json::json!(99_999))), 15_874);
        assert_eq!(clean_offset(Some(&serde_json::json!(-5))), 0);
        assert_eq!(clean_offset(None), 0);
        assert_eq!(clean_language(Some(&serde_json::json!("EN"))), "en");
        assert_eq!(clean_language(Some(&serde_json::json!("pt-br"))), "pt-br");
        assert_eq!(clean_language(Some(&serde_json::json!("jap"))), "en");
        assert_eq!(clean_language(None), "en");
    }

    #[test]
    fn js_coercions() {
        assert_eq!(js_value_number(&serde_json::Value::Null), Some(0.0));
        assert_eq!(js_value_number(&serde_json::json!([])), Some(0.0));
        assert_eq!(js_value_number(&serde_json::json!("12")), Some(12.0));
        assert_eq!(js_value_number(&serde_json::json!("x")), None);
        assert_eq!(js_num_or(Some(&serde_json::Value::Null), 7.0), 7.0);
        assert_eq!(js_num_or(Some(&serde_json::json!("3.5")), 7.0), 3.5);
        assert_eq!(js_str_or(Some(&serde_json::json!(4.5))), "4.5");
        assert_eq!(js_str_or(Some(&serde_json::Value::Null)), "");
    }
}
