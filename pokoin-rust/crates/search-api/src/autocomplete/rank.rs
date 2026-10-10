//! Ranking of the autocomplete handler: token plans (`intersectionTokenPlan`,
//! `candidateFanoutPlan`, `genericEnergyExpansionPlan`, `predictivePoolPlan`),
//! `scoreRow` and its helper matchers, `rankAutocompleteEntries`, the
//! name-token confidence model, the predictive pool merges and the one
//! character prefix shard plan.

use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use super::ladder::AUTOCOMPLETE_SQL_SAFE_POOL_CAP;
use super::normalize::{
    bounded_distance, cmp_f64_nan_last, compact, expansion_alias_targets, is_expansion_alias_term,
    is_rarity_term, is_variation_intent_term, is_variation_term, js_num_or, locale_cmp,
    normalize_variation_phrases, search_terms, variation_term_targets,
};
use super::row::{get, get_any, num_field, str_field};

/// Query token: `term` + `kind` + optional predictive `sourceHint`.
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub term: String,
    pub kind: &'static str,
    pub source_hint: Option<String>,
}

impl Token {
    pub fn new(term: &str, kind: &'static str) -> Self {
        Self {
            term: term.to_owned(),
            kind,
            source_hint: None,
        }
    }

    pub fn to_json(&self) -> Value {
        match &self.source_hint {
            Some(hint) => json!({"term": self.term, "kind": self.kind, "sourceHint": hint}),
            None => json!({"term": self.term, "kind": self.kind}),
        }
    }

    pub fn tokens_json(tokens: &[Token]) -> Value {
        Value::Array(tokens.iter().map(Token::to_json).collect())
    }
}

/// `tokenKind(term)`.
pub fn token_kind(term: &str) -> &'static str {
    if !term.is_empty() && term.bytes().all(|b| b.is_ascii_digit()) {
        return "number";
    }
    if is_variation_intent_term(term) {
        return "variation";
    }
    if is_rarity_term(term) {
        return "rarity";
    }
    if is_expansion_alias_term(term) {
        return "expansion";
    }
    "text"
}

pub fn tokens_for_query(query: &str) -> Vec<Token> {
    search_terms(query)
        .iter()
        .map(|term| Token::new(term, token_kind(term)))
        .collect()
}

#[derive(Clone, Debug)]
pub struct IntersectionPlan {
    pub tokens: Vec<Token>,
    pub skipped_tokens: Vec<Token>,
}

/// `intersectionTokenPlan(query)`.
pub fn intersection_token_plan(query: &str) -> Option<IntersectionPlan> {
    let terms = search_terms(query);
    let tokens = tokens_for_query(query);
    let text_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "text")
        .cloned()
        .collect();
    let structured_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "number" || t.kind == "variation" || t.kind == "expansion")
        .cloned()
        .collect();
    let rarity_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "rarity")
        .cloned()
        .collect();
    if terms.len() < 2
        || text_tokens.is_empty()
        || structured_tokens.is_empty()
        || !rarity_tokens.is_empty()
    {
        return None;
    }
    Some(IntersectionPlan {
        tokens: text_tokens
            .iter()
            .chain(structured_tokens.iter())
            .cloned()
            .collect(),
        skipped_tokens: rarity_tokens,
    })
}

#[derive(Clone, Debug)]
pub struct FanoutPlan {
    pub tokens: Vec<Token>,
    pub name_probe_tokens: Vec<Token>,
}

/// `candidateFanoutPlan(query)`.
pub fn candidate_fanout_plan(query: &str) -> Option<FanoutPlan> {
    let terms = search_terms(query);
    if terms.len() < 2 {
        return None;
    }
    let tokens = tokens_for_query(query);
    let text_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "text")
        .cloned()
        .collect();
    let structured_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| {
            t.kind == "number"
                || t.kind == "variation"
                || t.kind == "expansion"
                || t.kind == "rarity"
        })
        .cloned()
        .collect();
    let has_structured_intent = !text_tokens.is_empty() && !structured_tokens.is_empty();
    let name_probe_tokens = if has_structured_intent {
        text_tokens
    } else {
        tokens
            .iter()
            .filter(|t| t.kind == "text" || t.kind == "expansion")
            .cloned()
            .collect()
    };
    if name_probe_tokens.is_empty() {
        return None;
    }
    Some(FanoutPlan {
        tokens,
        name_probe_tokens,
    })
}

#[derive(Clone, Debug)]
pub struct EnergyPlan {
    pub tokens: Vec<Token>,
    pub expansion_tokens: Vec<Token>,
}

/// `genericEnergyExpansionPlan(query)`.
pub fn generic_energy_expansion_plan(query: &str) -> Option<EnergyPlan> {
    let tokens = tokens_for_query(query);
    let expansion_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "expansion")
        .cloned()
        .collect();
    let text_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "text")
        .cloned()
        .collect();
    if expansion_tokens.is_empty()
        || !text_tokens
            .iter()
            .any(|token| compact(&token.term) == "energy")
    {
        return None;
    }
    let non_generic: Vec<&Token> = text_tokens
        .iter()
        .filter(|token| !["basic", "energy"].contains(&compact(&token.term).as_str()))
        .collect();
    if !non_generic.is_empty() {
        return None;
    }
    Some(EnergyPlan {
        tokens,
        expansion_tokens,
    })
}

// --- row matchers ---

/// `rowHasVariation(row, term)`.
pub fn row_has_variation(row: &Value, term: &str) -> bool {
    let normalized = compact(term);
    let text = [
        str_field(row, &["name"]),
        str_field(row, &["rarity"]),
        str_field(row, &["card_type"]),
        str_field(row, &["product_type"]),
        str_field(row, &["product_variant"]),
    ]
    .join(" ")
    .to_lowercase();
    let word = |needle: &str| bounded_word_match(&text, needle);
    match normalized.as_str() {
        "lvx" => LazyLock::force(&LVX_RE).is_match(&text),
        "lv" => LazyLock::force(&LV_RE).is_match(&text),
        "v" => word("v"),
        "mega" => word("mega") || word("m"),
        "tagteam" => LazyLock::force(&TAGTEAM_RE).is_match(&text),
        other => !other.is_empty() && word(other),
    }
}

fn bounded_word_match(text: &str, needle: &str) -> bool {
    let bytes = text.as_bytes();
    let pattern = needle.as_bytes();
    if pattern.is_empty() {
        return false;
    }
    let boundary = |index: usize| {
        index == 0 || !bytes[index - 1].is_ascii_lowercase() && !bytes[index - 1].is_ascii_digit()
    };
    let end_boundary = |index: usize| {
        index >= bytes.len() || !bytes[index].is_ascii_lowercase() && !bytes[index].is_ascii_digit()
    };
    if !text.is_ascii() {
        // Non-ASCII text: fall back to the regex path used by JS.
        let re = regex::Regex::new(&format!(
            r"(^|[^a-z0-9]){}([^a-z0-9]|$)",
            regex::escape(needle)
        ))
        .map(|re| re.is_match(text))
        .unwrap_or(false);
        return re;
    }
    let mut start = 0;
    while let Some(found) = find_sub(&bytes[start..], pattern) {
        let at = start + found;
        if boundary(at) && end_boundary(at + pattern.len()) {
            return true;
        }
        start = at + 1;
    }
    false
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

static LVX_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(^|[^a-z0-9])(lv\.?x|level x)([^a-z0-9]|$)").unwrap());
static LV_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(^|[^a-z0-9])lv\.?([0-9]+|x)([^a-z0-9]|$)").unwrap());
static TAGTEAM_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(^|[^a-z0-9])(tag\s*team|tagteam|&)([^a-z0-9]|$)").unwrap()
});

/// `rowHasVariationIntent(row, term)`.
pub fn row_has_variation_intent(row: &Value, term: &str) -> bool {
    variation_term_targets(term)
        .iter()
        .any(|target| row_has_variation(row, target))
}

/// `rowHasSetToken(row, term)`.
pub fn row_has_set_token(row: &Value, term: &str) -> bool {
    let normalized = compact(term);
    if normalized.is_empty() {
        return false;
    }
    let set = str_field(row, &["set_name"]).to_lowercase();
    bounded_word_match(&set, &normalized)
}

/// `rowHasRarity(row, term)`.
pub fn row_has_rarity(row: &Value, term: &str) -> bool {
    let normalized = compact(term);
    let text = [
        str_field(row, &["card_number"]),
        str_field(row, &["rarity"]),
    ]
    .join(" ")
    .to_lowercase();
    let normalized_text = text
        .split(|ch: char| !ch.is_ascii_lowercase() && !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    match normalized.as_str() {
        "sir" => normalized_text.contains("special illustration rare"),
        "ir" => normalized_text.contains("illustration rare"),
        "ill" | "illus" | "illustration" => normalized_text.contains("illustration rare"),
        "ur" | "ultra" => normalized_text.contains("ultra rare"),
        "sr" | "secret" => normalized_text.contains("secret rare"),
        other => normalized_text.contains(other),
    }
}

/// `rowHasExpansionAlias(row, term)`.
pub fn row_has_expansion_alias(row: &Value, term: &str) -> bool {
    let compact_set = compact(&str_field(row, &["set_name", "set"]));
    expansion_alias_targets(term).iter().any(|target| {
        compact_set == *target
            || compact_set.starts_with(target.as_str())
            || target.starts_with(compact_set.as_str())
    })
}

/// `isPokemonIdentityRow(row)`.
pub fn is_pokemon_identity_row(row: &Value) -> bool {
    if str_field(row, &["item_kind"]) == "product" {
        return false;
    }
    let card_type = str_field(row, &["card_type"]).to_lowercase();
    if card_type.is_empty() || card_type == "card" {
        return false;
    }
    static EXCLUDED: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\b(trainer|supporter|item|stadium|energy|accessory|product|sealed)\b")
            .unwrap()
    });
    !EXCLUDED.is_match(&card_type)
}

/// `isEnergyCardName(row)`.
pub fn is_energy_card_name(row: &Value) -> bool {
    let words = search_terms(&str_field(row, &["canonical_name", "name"]));
    !words.is_empty() && compact(words.last().unwrap()) == "energy"
}

/// `rowMatchesAnyExpansionToken(row, expansionTokens)`.
pub fn row_matches_any_expansion_token(row: &Value, expansion_tokens: &[Token]) -> bool {
    expansion_tokens
        .iter()
        .any(|token| row_has_expansion_alias(row, &token.term))
}

/// `fuzzyPrefixMatch(value, term, maxDistance = 2)`.
pub fn fuzzy_prefix_match(value: &str, term: &str, max_distance: usize) -> bool {
    let compact_value = compact(value);
    let compact_term = compact(term);
    if compact_value.is_empty() || compact_term.chars().count() < 4 {
        return false;
    }
    if compact_value.starts_with(&compact_term) || compact_value.contains(&compact_term) {
        return true;
    }
    let prefix3: String = compact_term.chars().take(3).collect();
    if !compact_value.starts_with(&prefix3) {
        return false;
    }
    let sliced: String = compact_value
        .chars()
        .take(compact_term.chars().count())
        .collect();
    bounded_distance(&sliced, &compact_term, max_distance) <= max_distance
}

/// `nameTokenConfidence(name, nameWords, term)`.
pub fn name_token_confidence(name: &str, name_words: &[String], term: &str) -> i64 {
    let compact_name_value = compact(name);
    let compact_term = compact(term);
    if compact_term.is_empty() {
        return 0;
    }
    if name == term || compact_name_value == compact_term {
        return 100;
    }
    if name.starts_with(term) || compact_name_value.starts_with(&compact_term) {
        return 90;
    }
    if name_words.iter().any(|word| word.starts_with(term)) {
        return 82;
    }
    if is_likely_name_token_typo(name_words, term) {
        return 76;
    }
    let term_len = compact_term.chars().count();
    let two_prefix: String = compact_term.chars().take(2).collect();
    if term_len >= 5
        && compact_name_value.starts_with(&two_prefix)
        && bounded_distance(&compact_name_value, &compact_term, 3) <= 3
    {
        return 64;
    }
    if name.contains(term) || (term_len >= 4 && compact_name_value.contains(&compact_term)) {
        return 60;
    }
    0
}

/// `isLikelyNameTokenTypo(nameWords, term)`.
pub fn is_likely_name_token_typo(name_words: &[String], term: &str) -> bool {
    let normalized_term = compact(term);
    if normalized_term.chars().count() < 3 {
        return false;
    }
    let max = if normalized_term.chars().count() <= 4 {
        1
    } else {
        2
    };
    name_words.iter().any(|word| {
        let normalized_word = compact(word);
        if normalized_word.chars().count() < 3 {
            return false;
        }
        if normalized_word.starts_with(&normalized_term)
            || normalized_term.starts_with(&normalized_word)
        {
            return true;
        }
        bounded_distance(&normalized_word, &normalized_term, max) <= max
    })
}

/// `confidentNameTokenSet(name, nameWords, terms)` — at most one term.
pub fn confident_name_token_set(
    name: &str,
    name_words: &[String],
    terms: &[String],
) -> HashSet<String> {
    let mut candidates: Vec<(String, i64)> = terms
        .iter()
        .filter(|term| {
            !term.bytes().all(|b| b.is_ascii_digit())
                && !is_variation_intent_term(term)
                && !is_rarity_term(term)
                && !is_expansion_alias_term(term)
        })
        .map(|term| (term.clone(), name_token_confidence(name, name_words, term)))
        .filter(|(_, confidence)| *confidence >= 60)
        .collect();
    candidates.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then(right.0.chars().count().cmp(&left.0.chars().count()))
    });
    candidates
        .first()
        .map(|(term, _)| HashSet::from([term.clone()]))
        .unwrap_or_default()
}

/// `nameRootTokens(value)`.
pub fn name_root_tokens(value: &str) -> Vec<String> {
    const CARD_NAME_ROOT_STOP_WORDS: [&str; 19] = [
        "ex", "v", "vmax", "vstar", "gx", "lvx", "lv", "mega", "break", "radiant", "shining",
        "shiny", "prime", "tagteam", "and", "gold", "star", "legend", "delta",
    ];
    let mut stop: HashSet<&str> = CARD_NAME_ROOT_STOP_WORDS.into_iter().collect();
    stop.insert("species");
    search_terms(value)
        .iter()
        .map(|term| compact(term))
        .filter(|term| {
            term.chars().count() >= 3
                && !stop.contains(term.as_str())
                && !term.bytes().all(|b| b.is_ascii_digit())
                && !is_rarity_term(term)
                && !is_expansion_alias_term(term)
        })
        .collect()
}

static COMPOUND_SEPARATOR: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)(^|[^a-z0-9])(&|and|tag\s*team|tagteam)([^a-z0-9]|$)").unwrap()
});

/// `rowHasCompoundNameSeparator(row)`.
pub fn row_has_compound_name_separator(row: &Value) -> bool {
    let name = str_field(row, &["name", "canonical_name"]);
    COMPOUND_SEPARATOR.is_match(&name)
}

/// `compoundNameCoverageAdjustment(row, query, terms, nameWords, baseScore)`.
pub fn compound_name_coverage_adjustment(
    row: &Value,
    query: &str,
    terms: &[String],
    name_words: &[String],
    base_score: f64,
) -> f64 {
    if !row_has_compound_name_separator(row) {
        return 0.0;
    }
    let query_roots: Vec<String> = dedupe(name_root_tokens(query));
    if query_roots.is_empty() {
        return 0.0;
    }
    let candidate_roots: Vec<String> = dedupe(name_root_tokens(&str_field(
        row,
        &["canonical_name", "name"],
    )));
    if candidate_roots.len() < 2 || !candidate_roots.contains(&query_roots[0]) {
        return 0.0;
    }
    if query_roots.len() > 1 {
        let missing: Vec<&String> = query_roots
            .iter()
            .filter(|root| !candidate_roots.contains(root))
            .collect();
        if !missing.is_empty() {
            return -(3600.0 + (missing.len() as f64) * 1200.0).max((base_score * 0.65).round());
        }
        return 0.0;
    }
    let typed_roots: HashSet<String> = terms
        .iter()
        .map(|term| compact(term))
        .filter(|term| candidate_roots.contains(term))
        .collect();
    let untyped: Vec<&String> = candidate_roots
        .iter()
        .filter(|root| *root != &query_roots[0] && !typed_roots.contains(*root))
        .collect();
    if untyped.is_empty() {
        return 0.0;
    }
    let compact_name_words: HashSet<String> = name_words.iter().map(|word| compact(word)).collect();
    let query_root_is_exact = compact_name_words.contains(&query_roots[0]);
    let coverage_penalty = base_score * (untyped.len() as f64 / candidate_roots.len() as f64);
    let fixed_penalty = if query_root_is_exact {
        3600.0 + (untyped.len() as f64) * 900.0
    } else {
        1800.0
    };
    -fixed_penalty.max(coverage_penalty.round() + 1800.0)
}

/// `missingNameRootCoverageAdjustment(row, query, baseScore)`.
pub fn missing_name_root_coverage_adjustment(row: &Value, query: &str, base_score: f64) -> f64 {
    let terms = search_terms(query);
    let has_special_rarity_phrase = terms.contains(&"special".to_owned())
        && (terms.contains(&"illustration".to_owned())
            || terms.contains(&"rare".to_owned())
            || terms.contains(&"sir".to_owned()));
    let query_roots: Vec<String> = dedupe(
        name_root_tokens(query)
            .into_iter()
            .filter(|root| !(root == "special" && has_special_rarity_phrase))
            .collect(),
    );
    if query_roots.len() < 2 {
        return 0.0;
    }
    let candidate_roots: Vec<String> = dedupe(name_root_tokens(&str_field(
        row,
        &["canonical_name", "name"],
    )));
    if candidate_roots.is_empty() || !candidate_roots.contains(&query_roots[0]) {
        return 0.0;
    }
    let missing: Vec<&String> = query_roots
        .iter()
        .filter(|root| {
            !candidate_roots.iter().any(|candidate| {
                candidate == *root
                    || candidate.starts_with(root.as_str())
                    || root.starts_with(candidate.as_str())
            })
        })
        .collect();
    if missing.is_empty() {
        return 0.0;
    }
    -(2600.0 + (missing.len() as f64) * 900.0).max((base_score * 0.55).round())
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

// --- token filtering ---

/// `rowMatchesIntersectionToken(row, token)`.
pub fn row_matches_intersection_token(row: &Value, token: &Token) -> bool {
    let term = &token.term;
    let normalized_term = compact(term);
    if normalized_term.is_empty() {
        return false;
    }
    match token.kind {
        "text" => {
            let name = str_field(row, &["name"]).to_lowercase();
            let name_words = search_terms(&name);
            name_token_confidence(&name, &name_words, term) >= 60
        }
        "variation" => row_has_variation_intent(row, term),
        "number" => {
            let number = str_field(row, &["card_number", "version", "card_id"]).to_lowercase();
            let compact_number = compact(&number);
            number == *term
                || compact_number == normalized_term
                || search_terms(&number).contains(term)
                || number.starts_with(term.as_str())
                || compact_number.starts_with(&normalized_term)
        }
        "expansion" => row_has_expansion_alias(row, term),
        _ => false,
    }
}

#[derive(Debug, Clone)]
pub struct TokenFilterResult {
    pub rows: Vec<Value>,
    pub required_tokens: Vec<Token>,
    pub applied: bool,
    pub filtered_count: usize,
}

/// `filterRowsByAnyStructuredToken(rows, structuredTokens)`.
pub fn filter_rows_by_any_structured_token(
    rows: Vec<Value>,
    structured_tokens: &[Token],
) -> TokenFilterResult {
    let tokens: Vec<Token> = structured_tokens
        .iter()
        .filter(|t| t.kind == "number" || t.kind == "variation" || t.kind == "expansion")
        .cloned()
        .collect();
    if rows.is_empty() || tokens.is_empty() {
        return TokenFilterResult {
            rows,
            required_tokens: Vec::new(),
            applied: false,
            filtered_count: 0,
        };
    }
    let filtered: Vec<Value> = rows
        .iter()
        .filter(|row| {
            tokens
                .iter()
                .any(|token| row_matches_intersection_token(row, token))
        })
        .cloned()
        .collect();
    let applied = !filtered.is_empty();
    let filtered_count = rows.len().saturating_sub(filtered.len());
    TokenFilterResult {
        rows: if applied { filtered } else { rows },
        required_tokens: Vec::new(),
        applied,
        filtered_count,
    }
}

/// `requiredNameTokensForQuery(query)`.
pub fn required_name_tokens_for_query(query: &str) -> Vec<Token> {
    let tokens = tokens_for_query(query);
    let text_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "text")
        .cloned()
        .collect();
    let structured_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "number" || t.kind == "variation" || t.kind == "expansion")
        .cloned()
        .collect();
    if tokens.len() > 1 && !text_tokens.is_empty() && !structured_tokens.is_empty() {
        let all: Vec<Token> = text_tokens
            .iter()
            .chain(structured_tokens.iter())
            .cloned()
            .collect();
        if structured_tokens
            .iter()
            .any(|t| t.kind == "number" || t.kind == "expansion")
            || structured_tokens
                .iter()
                .filter(|t| t.kind == "variation")
                .count()
                > 1
        {
            return all;
        }
        return text_tokens;
    }
    if !text_tokens.is_empty() {
        return text_tokens;
    }
    if tokens.len() > 1 && !structured_tokens.is_empty() {
        return structured_tokens;
    }
    Vec::new()
}

/// `filterRowsByRequiredNameTokens(rows, query)`.
pub fn filter_rows_by_required_name_tokens(rows: Vec<Value>, query: &str) -> TokenFilterResult {
    let required_tokens = required_name_tokens_for_query(query);
    if rows.is_empty() || required_tokens.is_empty() {
        return TokenFilterResult {
            rows,
            required_tokens,
            applied: false,
            filtered_count: 0,
        };
    }
    let filtered: Vec<Value> = rows
        .iter()
        .filter(|row| {
            required_tokens
                .iter()
                .all(|token| row_matches_intersection_token(row, token))
        })
        .cloned()
        .collect();
    let applied = !filtered.is_empty();
    let filtered_count = rows.len().saturating_sub(filtered.len());
    TokenFilterResult {
        rows: if applied { filtered } else { rows },
        required_tokens,
        applied,
        filtered_count,
    }
}

/// `rowKey(row)` — `card_id || blueprint_id || id`.
pub fn row_key(row: &Value) -> String {
    str_field(row, &["card_id", "blueprint_id", "id"])
}

/// `dedupeRows(rows)`.
pub fn dedupe_rows(rows: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let id = str_field(&row, &["card_id", "id"]);
        if id.is_empty() || !seen.insert(id) {
            continue;
        }
        out.push(row);
    }
    out
}

/// `intersectRows(rowGroups, limit)`.
pub fn intersect_rows(row_groups: &[Vec<Value>], limit: usize) -> Vec<Value> {
    if row_groups.is_empty() {
        return Vec::new();
    }
    let remaining: Vec<HashSet<String>> = row_groups[1..]
        .iter()
        .map(|rows| {
            rows.iter()
                .map(|row| str_field(row, &["card_id"]))
                .filter(|id| !id.is_empty())
                .collect()
        })
        .collect();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for row in &row_groups[0] {
        let id = str_field(row, &["card_id"]);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        if remaining.iter().all(|ids| ids.contains(&id)) {
            result.push(row.clone());
            if result.len() >= limit {
                break;
            }
        }
    }
    result
}

fn rank_sort_cmp(left: &Value, right: &Value) -> Ordering {
    let left_rank = num_field(left, &["search_rank"]);
    let right_rank = num_field(right, &["search_rank"]);
    right_rank
        .partial_cmp(&left_rank)
        .unwrap_or(Ordering::Equal)
}

fn default_rank_cmp(left: &Value, right: &Value) -> Ordering {
    rank_sort_cmp(left, right)
        .then_with(|| locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"])))
        .then_with(|| {
            locale_cmp(
                &str_field(left, &["card_number"]),
                &str_field(right, &["card_number"]),
            )
        })
}

/// `mergeRowsPreservingBest(rowGroups, resultLimit)`.
pub fn merge_rows_preserving_best(row_groups: Vec<Vec<Value>>, result_limit: usize) -> Vec<Value> {
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for rows in &row_groups {
        for row in rows {
            let id = str_field(row, &["card_id"]);
            if id.is_empty() {
                continue;
            }
            match by_id.get(&id) {
                Some(existing)
                    if num_field(existing, &["search_rank"])
                        >= num_field(row, &["search_rank"]) => {}
                _ => {
                    by_id.insert(id, row.clone());
                }
            }
        }
    }
    let mut rows: Vec<Value> = by_id.into_values().collect();
    rows.sort_by(default_rank_cmp);
    rows.truncate(result_limit);
    rows
}

/// `mergeSearchRows(rowGroups, resultLimit)` of marketplace-search-candidates.js
/// (same merge, kept under its exported name).
pub fn merge_search_rows(row_groups: Vec<Vec<Value>>, result_limit: usize) -> Vec<Value> {
    merge_rows_preserving_best(row_groups, result_limit)
}

/// `fieldTokenScore(row, token)`.
pub fn field_token_score(row: &Value, token: &Token) -> f64 {
    let term = &token.term;
    let compact_term = compact(term);
    if compact_term.is_empty() {
        return 0.0;
    }
    if token.kind == "number" {
        let normalized_number_terms =
            search_terms(&str_field(row, &["normalized_number", "card_number"]));
        let compact_number = {
            let from_row = str_field(row, &["compact_number"]);
            if from_row.is_empty() {
                compact(&str_field(row, &["card_number"]))
            } else {
                from_row
            }
        };
        if normalized_number_terms.contains(term) || compact_number == compact_term {
            return 1400.0;
        }
        if compact_number.contains(&compact_term) {
            return 1100.0;
        }
        return 0.0;
    }
    if token.kind == "variation" {
        let variations: HashSet<String> = match get(row, "variation_keys") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| compact(&super::normalize::js_str_or(Some(item))))
                .collect(),
            _ => HashSet::new(),
        };
        if variation_term_targets(term)
            .iter()
            .any(|target| variations.contains(target))
            || row_has_variation_intent(row, term)
        {
            return 1300.0;
        }
        return 0.0;
    }
    if token.kind == "expansion" {
        if row_has_expansion_alias(row, term) {
            return 1250.0;
        }
        if fuzzy_prefix_match(&str_field(row, &["set_name"]), term, 2) {
            return 980.0;
        }
        return 0.0;
    }
    if token.kind == "rarity" {
        return if row_has_rarity(row, term) {
            860.0
        } else {
            0.0
        };
    }
    let trainer = {
        let from_row = str_field(row, &["normalized_trainer"]);
        if from_row.is_empty() {
            str_field(row, &["trainer_name"])
        } else {
            from_row
        }
    };
    let set = {
        let from_row = str_field(row, &["normalized_set"]);
        if from_row.is_empty() {
            str_field(row, &["set_name"])
        } else {
            from_row
        }
    };
    let variant = {
        let from_row = str_field(row, &["normalized_variant"]);
        if from_row.is_empty() {
            str_field(row, &["product_variant"])
        } else {
            from_row
        }
    };
    if search_terms(&trainer).contains(term) || compact(&trainer) == compact_term {
        return 1050.0;
    }
    if fuzzy_prefix_match(&trainer, term, 1) {
        return 900.0;
    }
    if search_terms(&set).contains(term) || compact(&set) == compact_term {
        return 780.0;
    }
    if fuzzy_prefix_match(&set, term, 2) {
        return 680.0;
    }
    if search_terms(&variant).contains(term) || compact(&variant) == compact_term {
        return 420.0;
    }
    0.0
}

/// `shouldUseSupplementalNameFallback(token, nameRows)`.
pub fn should_use_supplemental_name_fallback(token: &Token, name_rows: &[Value]) -> bool {
    if name_rows.is_empty() {
        return true;
    }
    let term = compact(&token.term);
    if term.chars().count() <= 3 {
        return name_rows.iter().any(|row| {
            let name_terms = search_terms(&str_field(row, &["name"]));
            !name_terms.contains(&term)
                && name_terms.iter().any(|name_term| {
                    name_token_confidence(name_term, std::slice::from_ref(name_term), &term) >= 60
                })
        });
    }
    false
}

/// `scoreRow(row, query)` — the relevance model. `query` is already
/// `normalizeVariationPhrases(query).toLowerCase()`.
pub fn score_row(row: &Value, query: &str) -> f64 {
    let name = str_field(row, &["name"]).to_lowercase();
    let set = str_field(row, &["set_name"]).to_lowercase();
    let number = str_field(row, &["card_number", "version", "card_id"]).to_lowercase();
    let rarity = str_field(row, &["rarity"]).to_lowercase();
    let card_type = str_field(row, &["card_type"]).to_lowercase();
    let trainer = str_field(row, &["trainer_name"]).to_lowercase();
    let haystack = format!("{name} {number} {set} {rarity} {card_type} {trainer}");
    let compact_query = compact(query);
    let compact_name = compact(&name);
    let compact_number = compact(&number);
    let compact_set = compact(&set);
    let terms = search_terms(query);
    let name_words = search_terms(&name);
    let has_number_term = terms
        .iter()
        .any(|term| !term.is_empty() && term.bytes().all(|b| b.is_ascii_digit()));
    let has_variation_term = terms.iter().any(|term| is_variation_intent_term(term));
    let has_rarity_term = terms.iter().any(|term| is_rarity_term(term));
    let has_expansion_alias_term = terms.iter().any(|term| is_expansion_alias_term(term));
    let generic_energy_plan = generic_energy_expansion_plan(query);
    let fuzzy_expansion_terms: Vec<&String> = terms
        .iter()
        .filter(|term| {
            if term.is_empty()
                || term.bytes().all(|b| b.is_ascii_digit())
                || is_variation_intent_term(term)
                || is_rarity_term(term)
            {
                return false;
            }
            let compact_term = compact(term);
            let term_len = compact_term.chars().count();
            let three: String = compact_term.chars().take(3).collect();
            let sliced: String = compact_set.chars().take(term_len).collect();
            term_len >= 5
                && compact_set.starts_with(&three)
                && bounded_distance(&sliced, &compact_term, 2) <= 2
        })
        .collect();
    let has_text_term = terms.iter().any(|term| {
        !term.bytes().all(|b| b.is_ascii_digit())
            && !is_variation_intent_term(term)
            && !is_rarity_term(term)
            && !is_expansion_alias_term(term)
    });
    let single_variation_term: Option<&String> = if terms.len() == 1 && is_variation_term(&terms[0])
    {
        Some(&terms[0])
    } else {
        None
    };
    let has_structured_intent = terms.len() > 1
        && has_text_term
        && (has_number_term || has_variation_term || has_rarity_term || has_expansion_alias_term);
    let single_text_term: Option<&String> =
        if terms.len() == 1 && has_text_term && !has_structured_intent {
            Some(&terms[0])
        } else {
            None
        };
    let confident_name_terms = if has_structured_intent {
        confident_name_token_set(&name, &name_words, &terms)
    } else {
        HashSet::new()
    };
    let remote_score = num_field(row, &["search_rank"]);
    let is_product = str_field(row, &["item_kind"]) == "product";
    let is_single_card_identity = !is_product;
    let is_pokemon_identity = is_pokemon_identity_row(row);
    let product_query = LazyLock::force(&PRODUCT_QUERY_RE).is_match(query);
    let mut score = 0.0f64;

    if let Some(term) = single_variation_term {
        if row_has_variation(row, term) {
            return 1600.0 + remote_score * 0.35;
        }
        if term == "vstar" && row_has_set_token(row, term) {
            return 900.0 + remote_score * 0.25;
        }
        return 0.0;
    }

    if let Some(term) = single_text_term {
        let compact_term = compact(term);
        if is_single_card_identity && (name == *term || compact_name == compact_term) {
            score = score.max(5200.0);
        } else if is_single_card_identity
            && (name.starts_with(term.as_str()) || compact_name.starts_with(&compact_term))
        {
            score = score.max(if is_pokemon_identity { 4900.0 } else { 4400.0 });
        } else if is_single_card_identity
            && name_words
                .iter()
                .any(|word| word.starts_with(term.as_str()))
        {
            score = score.max(if is_pokemon_identity { 4300.0 } else { 3800.0 });
        } else if is_single_card_identity && is_likely_name_token_typo(&name_words, term) {
            score = score.max(3600.0);
        } else if !is_product && name.contains(term.as_str()) {
            score = score.max(2600.0);
        } else if is_product && !product_query {
            if name.starts_with(term.as_str()) || compact_name.starts_with(&compact_term) {
                score = score.max(900.0);
            } else if name.contains(term.as_str()) || set.contains(term.as_str()) {
                score = score.max(220.0);
            }
        }
    }

    if number == query {
        score = score.max(980.0);
    }
    if !compact_query.is_empty() && compact_number.starts_with(&compact_query) {
        score = score.max(880.0);
    }
    if name == query {
        score = score.max(if is_single_card_identity {
            1420.0
        } else {
            1000.0
        });
    }
    if compact_name == compact_query {
        score = score.max(if is_single_card_identity {
            1380.0
        } else {
            980.0
        });
    }
    if !compact_query.is_empty() && compact_name.starts_with(&compact_query) {
        let single_prefix_score = if compact_query.chars().count() >= 5 {
            1140.0
        } else {
            820.0
        };
        score = score.max(if is_pokemon_identity {
            1180.0
        } else if is_single_card_identity {
            single_prefix_score
        } else {
            820.0
        });
    }
    if name.contains(query) {
        score = score.max(680.0);
    }
    if number.contains(query) {
        score = score.max(700.0);
    }
    if set.contains(query) {
        score = score.max(360.0);
    }
    if rarity.contains(query) {
        score = score.max(340.0);
    }

    if terms.len() > 1
        && (has_number_term || has_variation_term || has_expansion_alias_term)
        && has_text_term
    {
        let mut intent_score = 0.0;
        let mut matched_name = false;
        let mut matched_number = false;
        let mut matched_variation = false;
        let mut matched_expansion = false;
        let mut matched_set = false;
        for term in &terms {
            let compact_term = compact(term);
            if !term.is_empty() && term.bytes().all(|b| b.is_ascii_digit()) {
                let number_tokens = search_terms(&number);
                if number == *term || compact_number == compact_term || number_tokens.contains(term)
                {
                    intent_score += 1600.0;
                    matched_number = true;
                } else if number.starts_with(term.as_str())
                    || compact_number.starts_with(&compact_term)
                {
                    intent_score += 1300.0;
                    matched_number = true;
                } else if number.contains(term.as_str()) || compact_number.contains(&compact_term) {
                    intent_score += 900.0;
                    matched_number = true;
                }
                continue;
            }
            if is_variation_intent_term(term) {
                if row_has_variation_intent(row, term) {
                    intent_score += 1500.0;
                    matched_variation = true;
                }
                continue;
            }
            if is_expansion_alias_term(term) {
                if row_has_expansion_alias(row, term) {
                    intent_score += 1550.0;
                    matched_expansion = true;
                }
                continue;
            }
            let can_match_name = !has_structured_intent || confident_name_terms.contains(term);
            if can_match_name && (name == *term || compact_name == compact_term) {
                intent_score += 1400.0;
                matched_name = true;
            } else if can_match_name
                && (name.starts_with(term.as_str()) || compact_name.starts_with(&compact_term))
            {
                intent_score += 1150.0;
                matched_name = true;
            } else if can_match_name
                && name_words
                    .iter()
                    .any(|word| word.starts_with(term.as_str()))
            {
                intent_score += 980.0;
                matched_name = true;
            } else if can_match_name && is_likely_name_token_typo(&name_words, term) {
                intent_score += 920.0;
                matched_name = true;
            } else if can_match_name
                && compact_term.chars().count() >= 5
                && compact_name
                    .starts_with(compact_term.chars().take(2).collect::<String>().as_str())
                && bounded_distance(&compact_name, &compact_term, 3) <= 3
            {
                intent_score += 760.0;
                matched_name = true;
            } else if can_match_name
                && (name.contains(term.as_str())
                    || (compact_term.chars().count() >= 4 && compact_name.contains(&compact_term)))
            {
                intent_score += 720.0;
                matched_name = true;
            } else if set.starts_with(term.as_str()) || compact_set.starts_with(&compact_term) {
                intent_score += 520.0;
                matched_set = true;
            } else if set.contains(term.as_str()) || compact_set.contains(&compact_term) {
                intent_score += 360.0;
                matched_set = true;
            } else if fuzzy_expansion_terms.contains(&term) {
                intent_score += 700.0;
                matched_set = true;
            }
        }
        if matched_name && matched_number {
            score = score.max(intent_score + 5200.0);
        } else if matched_name && matched_variation {
            score = score.max(intent_score + 4400.0);
        } else if matched_name && matched_expansion {
            score = score.max(intent_score + 4600.0);
        } else if matched_name && matched_set {
            score = score.max(intent_score + 700.0);
        } else if matched_name && has_variation_term {
            score = score.max(intent_score + 900.0);
        } else if matched_number || matched_variation || matched_expansion {
            score = score.min(1.0);
        }
    }

    if compact_query.chars().count() >= 4 && !compact_name.is_empty() {
        let prefix: String = compact_name
            .chars()
            .take(compact_query.chars().count())
            .collect();
        let distance = bounded_distance(&prefix, &compact_query, 2);
        if distance <= 1 {
            score = score.max(760.0 - distance as f64 * 80.0);
        }
        if compact_query.chars().count() >= 5
            && compact_name
                .chars()
                .count()
                .abs_diff(compact_query.chars().count())
                <= 2
        {
            let full_distance = bounded_distance(&compact_name, &compact_query, 2);
            if full_distance <= 2 {
                score = score.max(900.0 - full_distance as f64 * 90.0);
            }
        }
    }

    for term in &terms {
        let compact_term = compact(term);
        if compact_term.is_empty() {
            continue;
        }
        let mut matched_name_term = false;
        let can_match_name = !has_structured_intent || confident_name_terms.contains(term);
        if can_match_name && name_words.contains(term) {
            score += if is_single_card_identity {
                1040.0
            } else {
                760.0
            };
            matched_name_term = true;
        } else if can_match_name && is_likely_name_token_typo(&name_words, term) {
            score += if is_single_card_identity {
                920.0
            } else {
                620.0
            };
            matched_name_term = true;
        } else if can_match_name && compact_name == compact_term {
            score += 900.0;
            matched_name_term = true;
        } else if can_match_name && compact_name.starts_with(&compact_term) {
            let single_prefix_score = if compact_term.chars().count() >= 5 {
                940.0
            } else {
                720.0
            };
            score += if is_pokemon_identity {
                980.0
            } else if is_single_card_identity {
                single_prefix_score
            } else {
                720.0
            };
            matched_name_term = true;
        } else if can_match_name && compact_term.chars().count() >= 4 {
            let prefix: String = compact_name
                .chars()
                .take(compact_term.chars().count())
                .collect();
            let distance = bounded_distance(&prefix, &compact_term, 2);
            if distance <= 1 {
                score += 620.0 - distance as f64 * 80.0;
                matched_name_term = true;
            }
        }
        if matched_name_term {
            continue;
        }
        if compact_number == compact_term || compact_set == compact_term {
            score += 520.0;
        } else if compact_number.starts_with(&compact_term)
            || compact_set.starts_with(&compact_term)
        {
            score += 320.0;
        }
        if rarity.contains(term.as_str()) {
            score += 180.0;
        }
    }

    if terms.len() > 1 {
        if terms.iter().all(|term| haystack.contains(term.as_str())) {
            score = score.max(620.0 + terms.len() as f64 * 40.0);
        }
        let name_matches = terms
            .iter()
            .filter(|term| {
                let compact_term = compact(term);
                !compact_term.is_empty()
                    && (!has_structured_intent || confident_name_terms.contains(*term))
                    && (compact_name.starts_with(&compact_term)
                        || is_likely_name_token_typo(&name_words, term)
                        || {
                            let sliced: String = compact_name
                                .chars()
                                .take(compact_term.chars().count())
                                .collect();
                            bounded_distance(&sliced, &compact_term, 2) <= 1
                        })
            })
            .count();
        if name_matches > 0 {
            score += 420.0 * name_matches as f64;
        }
    }

    if terms.len() > 1 && has_rarity_term && has_text_term {
        let mut rarity_score = 420.0;
        let mut matched_name = false;
        let mut matched_rarity = false;
        for term in &terms {
            if is_rarity_term(term) {
                if row_has_rarity(row, term) {
                    rarity_score += 420.0;
                    matched_rarity = true;
                }
            } else {
                let can_match_name = !has_structured_intent || confident_name_terms.contains(term);
                if can_match_name && name.starts_with(term.as_str()) {
                    rarity_score += 260.0;
                    matched_name = true;
                } else if can_match_name
                    && name_words
                        .iter()
                        .any(|word| word.starts_with(term.as_str()))
                {
                    rarity_score += 220.0;
                    matched_name = true;
                } else if can_match_name && name.contains(term.as_str()) {
                    rarity_score += 160.0;
                    matched_name = true;
                }
            }
        }
        if matched_name && matched_rarity {
            score = score.max(rarity_score);
        }
    }

    if has_structured_intent && score <= 0.0 {
        return 0.0;
    }

    if is_product && !product_query {
        score -= 900.0;
    } else if is_product {
        score -= 80.0;
    }
    if !is_single_card_identity
        && compact_query.chars().count() <= 5
        && compact_query.bytes().all(|b| b.is_ascii_lowercase())
        && compact_query.chars().count() >= 2
    {
        score -= 220.0;
    }
    if terms.len() > 1 && !fuzzy_expansion_terms.is_empty() {
        let matched_name = terms.iter().any(|term| {
            let compact_term = compact(term);
            !compact_term.is_empty()
                && !fuzzy_expansion_terms.contains(&term)
                && (name_words.contains(term) || compact_name.starts_with(&compact_term))
        });
        if matched_name {
            score += 2200.0 + fuzzy_expansion_terms.len() as f64 * 520.0;
        }
    }
    if let Some(plan) = &generic_energy_plan {
        if row_matches_any_expansion_token(row, &plan.expansion_tokens) {
            if is_energy_card_name(row) {
                score += if name_words.len() == 2 {
                    5200.0
                } else {
                    3400.0
                };
            } else if name_words
                .first()
                .map(|word| word == "energy")
                .unwrap_or(false)
            {
                score += 900.0;
            }
        }
    }
    let remote_multiplier = if is_product && !product_query {
        0.18
    } else {
        0.35
    };
    let final_score = score.max(remote_score * remote_multiplier);
    (final_score
        + compound_name_coverage_adjustment(row, query, &terms, &name_words, final_score)
        + missing_name_root_coverage_adjustment(row, query, final_score))
    .max(0.0)
}

static PRODUCT_QUERY_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\b(box|booster|pack|deck|display|collection|bundle|tin|blister|case|etb|dice|binder|premium|set)\b")
        .unwrap()
});

/// `scoreExplanation(row, query)` — the debug entry per ranked row.
pub fn score_explanation(row: &Value, query: &str) -> Value {
    let normalized_query = normalize_variation_phrases(query).to_lowercase();
    let terms = search_terms(&normalized_query);
    let text = [
        str_field(row, &["name"]),
        str_field(row, &["set_name"]),
        str_field(row, &["card_number"]),
        str_field(row, &["rarity"]),
        str_field(row, &["product_variant"]),
    ]
    .join(" ")
    .to_lowercase();
    let matched_terms: Vec<&String> = terms
        .iter()
        .filter(|term| {
            text.contains(term.as_str())
                || row_has_variation(row, term)
                || row_has_rarity(row, term)
                || row_has_set_token(row, term)
        })
        .collect();
    json!({
        "card_id": get_any(row, &["card_id"]).cloned().unwrap_or(Value::Null),
        "name": get_any(row, &["name"]).cloned().unwrap_or(Value::Null),
        "set_name": get_any(row, &["set_name"]).cloned().unwrap_or(Value::Null),
        "card_number": get_any(row, &["card_number"]).cloned().unwrap_or(Value::Null),
        "rarity": get_any(row, &["rarity"]).cloned().unwrap_or(Value::Null),
        "product_variant": get_any(row, &["product_variant"]).cloned().unwrap_or(Value::Null),
        "item_kind": get_any(row, &["item_kind"]).cloned().unwrap_or(Value::Null),
        "product_type": get_any(row, &["product_type"]).cloned().unwrap_or(Value::Null),
        "db_rank": num_field(row, &["search_rank"]),
        "score": score_row(row, &normalized_query),
        "matchedTerms": matched_terms,
    })
}

// --- depth bookkeeping ---

pub type DepthMap = HashMap<String, f64>;

/// `depthScoreForRow(row, depthScores)`.
pub fn depth_score_for_row(row: &Value, depth_scores: &DepthMap) -> f64 {
    let id = str_field(row, &["card_id", "id"]);
    if id.is_empty() {
        return 0.0;
    }
    depth_scores
        .get(&id)
        .copied()
        .filter(|score| score.is_finite() && *score > 0.0)
        .unwrap_or(0.0)
}

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `depthMetadataForRow(row, metadata)` — `(latestDepth, latestOrder)`.
pub fn depth_metadata_for_row(
    row: &Value,
    latest_depths: &DepthMap,
    latest_orders: &DepthMap,
) -> (f64, f64) {
    let id = str_field(row, &["card_id", "id"]);
    if id.is_empty() {
        return (0.0, MAX_SAFE_INTEGER);
    }
    let latest_depth = latest_depths.get(&id).copied().unwrap_or(0.0);
    let latest_order = latest_orders.get(&id).copied();
    (
        if latest_depth.is_finite() && latest_depth > 0.0 {
            latest_depth
        } else {
            0.0
        },
        match latest_order {
            Some(order) if order.is_finite() && order >= 0.0 => order,
            _ => MAX_SAFE_INTEGER,
        },
    )
}

#[derive(Clone, Debug)]
pub struct RankedEntry {
    pub row: Value,
    pub score: f64,
    pub relevance_score: f64,
    pub analytics_boost: f64,
    pub depth_weight: f64,
    pub latest_depth: f64,
    pub latest_order: f64,
    pub depth_boost: f64,
}

/// `rankAutocompleteEntries(rows, query, limit, analyticsBoosts, options)`.
pub fn rank_autocomplete_entries(
    rows: Vec<Value>,
    query: &str,
    limit: usize,
    analytics_boosts: &super::analytics::AnalyticsBoosts,
    depth_scores: &DepthMap,
    latest_depths: &DepthMap,
    latest_orders: &DepthMap,
) -> Vec<RankedEntry> {
    let normalized_query = normalize_variation_phrases(query).to_lowercase();
    dedupe_rows(rows)
        .into_iter()
        .filter_map(|row| {
            let relevance_score = score_row(&row, &normalized_query);
            if relevance_score <= 0.0 {
                return None;
            }
            let raw_boost = analytics_boosts
                .boosts
                .get(&str_field(&row, &["card_id"]))
                .copied()
                .unwrap_or(0.0);
            let boost_cap = if relevance_score >= 5000.0 {
                1800.0
            } else if relevance_score >= 4200.0 {
                900.0
            } else {
                450.0
            };
            let analytics_boost = raw_boost.min(boost_cap);
            let depth_weight = depth_score_for_row(&row, depth_scores);
            let (latest_depth, latest_order) =
                depth_metadata_for_row(&row, latest_depths, latest_orders);
            let depth_boost_cap = if relevance_score >= 5000.0 {
                900.0
            } else if relevance_score >= 4200.0 {
                650.0
            } else {
                360.0
            };
            let depth_boost = if relevance_score > 0.0 {
                latest_depth * 1200.0 + (depth_weight * 45.0).min(depth_boost_cap)
            } else {
                0.0
            };
            Some(RankedEntry {
                score: relevance_score + analytics_boost + depth_boost,
                row,
                relevance_score,
                analytics_boost,
                depth_weight,
                latest_depth,
                latest_order,
                depth_boost,
            })
        })
        .collect::<Vec<_>>()
        .sort_and_limit(limit)
}

trait SortAndLimit {
    fn sort_and_limit(self, limit: usize) -> Self;
}

impl SortAndLimit for Vec<RankedEntry> {
    fn sort_and_limit(mut self, limit: usize) -> Self {
        self.sort_by(|left, right| {
            right
                .latest_depth
                .partial_cmp(&left.latest_depth)
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    right
                        .score
                        .partial_cmp(&left.score)
                        .unwrap_or(Ordering::Equal)
                })
                .then_with(|| {
                    left.latest_order
                        .partial_cmp(&right.latest_order)
                        .unwrap_or(Ordering::Equal)
                })
                .then_with(|| {
                    locale_cmp(
                        &str_field(&left.row, &["name"]),
                        &str_field(&right.row, &["name"]),
                    )
                })
        });
        self.truncate(limit);
        self
    }
}

/// `rankAutocompleteRows(rows, query, limit, analyticsBoosts, options)`.
pub fn rank_autocomplete_rows(
    rows: Vec<Value>,
    query: &str,
    limit: usize,
    analytics_boosts: &super::analytics::AnalyticsBoosts,
    depth_scores: &DepthMap,
    latest_depths: &DepthMap,
    latest_orders: &DepthMap,
) -> Vec<Value> {
    rank_autocomplete_entries(
        rows,
        query,
        limit,
        analytics_boosts,
        depth_scores,
        latest_depths,
        latest_orders,
    )
    .into_iter()
    .map(|entry| entry.row)
    .collect()
}

/// `rowNameTokenScore(row, token)`.
pub fn row_name_token_score(row: &Value, token: &Token) -> i64 {
    let name = str_field(row, &["canonical_name", "name"]).to_lowercase();
    let name_words = search_terms(&name);
    name_token_confidence(&name, &name_words, &token.term)
}

/// `scoreRowAgainstFanoutPlan(row, plan)`.
pub fn score_row_against_fanout_plan(row: &Value, plan: &FanoutPlan) -> (bool, f64) {
    let name_token_scores: Vec<(&Token, i64)> = plan
        .tokens
        .iter()
        .filter(|token| token.kind == "text" || token.kind == "expansion")
        .map(|token| (token, row_name_token_score(row, token)))
        .collect();
    let best = name_token_scores
        .iter()
        .filter(|(_, score)| *score >= 60)
        .max_by_key(|(_, score)| *score);
    let Some((best_token, best_score)) = best else {
        return (false, 0.0);
    };
    let field_tokens: Vec<&Token> = plan
        .tokens
        .iter()
        .filter(|token| token.term != best_token.term)
        .collect();
    let mut field_score = 0.0;
    for token in field_tokens {
        let score = field_token_score(row, token);
        if score <= 0.0 {
            return (false, 0.0);
        }
        field_score += score;
    }
    (
        true,
        *best_score as f64 * 14.0 + field_score + num_field(row, &["search_rank"]),
    )
}

/// `nameSeedCombinations(nameEntityGroups, maxGroups)` — the grouping part only
/// (entities ride along in the engine layer).
pub fn name_seed_scores(entities: &[(String, f64)]) -> Vec<(String, f64)> {
    let mut by_name: HashMap<String, f64> = HashMap::new();
    for (name, score) in entities {
        let entry = by_name.entry(name.clone()).or_insert(0.0);
        *entry = (*entry).max(*score);
    }
    let mut pairs: Vec<(String, f64)> = by_name.into_iter().collect();
    pairs.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| locale_cmp(&left.0, &right.0))
    });
    pairs
}

// --- predictive pool helpers ---

pub const PREDICTIVE_DIMENSION_SOURCES: [&str; 4] =
    ["number", "expansion", "rarity", "variation_owner"];
pub const FIRST_NAME_ANCHOR_MIN_CONFIDENCE: i64 = 60;
pub const MODIFIER_ONLY_ANCHOR_WORDS: [&str; 14] = [
    "ex", "v", "vmax", "vstar", "gx", "lvx", "lv", "mega", "break", "radiant", "shining", "shiny",
    "prime", "tagteam",
];

/// `dimensionTokensForSource(source, tokens)`.
pub fn dimension_tokens_for_source(source: &str, tokens: &[Token]) -> Vec<Token> {
    tokens
        .iter()
        .filter(|token| match source {
            "number" => token.kind == "number",
            "expansion" => {
                token.kind == "expansion"
                    || token.source_hint.as_deref() == Some("expansion")
                    || (token.kind == "text" && token.source_hint.is_none())
            }
            "rarity" => token.kind == "rarity",
            "variation_owner" => {
                token.kind == "variation"
                    || token.source_hint.as_deref() == Some("variation_owner")
                    || (token.kind == "text" && token.source_hint.is_none())
            }
            _ => false,
        })
        .cloned()
        .collect()
}

/// `sourceFlagsFor(row)`.
pub fn source_flags_for(row: &Value) -> Vec<String> {
    match get(row, "predictive_source_flags") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| super::normalize::js_str_or(Some(item)))
            .filter(|flag| !flag.is_empty())
            .collect(),
        Some(value @ Value::Object(_)) => {
            let mut keys: Vec<String> =
                Value::Object(value.as_object().cloned().unwrap_or_default())
                    .as_object()
                    .map(|map| {
                        map.iter()
                            .filter(|(_, flag)| is_truthy(Some(flag)))
                            .map(|(key, _)| key.clone())
                            .collect()
                    })
                    .unwrap_or_default();
            keys.sort();
            keys
        }
        _ => Vec::new(),
    }
}

fn is_truthy(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null) | Some(Value::Bool(false)))
        && !matches!(value, Some(Value::Number(n)) if n.as_f64() == Some(0.0))
        && !matches!(value, Some(Value::String(s)) if s.is_empty())
}

/// `predictiveSourceWeight(source)`.
pub fn predictive_source_weight(source: &str) -> f64 {
    match source {
        "name" => 700_000.0,
        "predicted_name_verified" => 680_000.0,
        "variation_owner" => 520_000.0,
        "number" => 390_000.0,
        "expansion" => 260_000.0,
        "rarity" => 150_000.0,
        _ => 50_000.0,
    }
}

/// `predictiveConfidenceBoost(confidence)`.
pub fn predictive_confidence_boost(confidence: f64) -> f64 {
    if !confidence.is_finite() || confidence <= 0.0 {
        return 0.0;
    }
    if confidence >= 70.0 {
        confidence * 4200.0
    } else {
        confidence * 2300.0
    }
}

/// `predictivePrefixDepthBoost(prediction, query)`.
pub fn predictive_prefix_depth_boost(prediction: &Value, query: &str) -> f64 {
    let compact_query = compact(query);
    let normalized = str_field(prediction, &["normalized", "normalized_token"]);
    if compact_query.is_empty() || normalized.is_empty() {
        return 0.0;
    }
    if normalized == compact_query {
        return compact_query.len() as f64 * 1800.0;
    }
    if normalized.starts_with(&compact_query) {
        return compact_query.len() as f64 * 1500.0;
    }
    compact_query.len().min(normalized.len()) as f64 * 800.0
}

/// `predictionCandidateCardIds(prediction, limit)`.
pub fn prediction_candidate_card_ids(prediction: &Value, limit: usize) -> Vec<String> {
    let ids = match get_any(
        prediction,
        &[
            "candidate_card_ids",
            "candidateCardIds",
            "representative_card_ids",
        ],
    ) {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| super::normalize::js_str_or(Some(item)).trim().to_owned())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        seen.insert(id.clone());
        out.push(id);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// `predictionDebugEntry(prediction)`.
pub fn prediction_debug_entry(prediction: &Value) -> Value {
    let candidate_card_ids = prediction_candidate_card_ids(prediction, 32);
    let mut entry = json!({
        "normalized": get_any(prediction, &["normalized"]).cloned().unwrap_or(Value::Null),
        "display": get_any(prediction, &["display"]).cloned().unwrap_or(Value::Null),
        "confidence": get_any(prediction, &["confidence"]).cloned().unwrap_or(Value::Null),
        "score": get_any(prediction, &["score"]).cloned().unwrap_or(Value::Null),
        "source_rank": get_any(prediction, &["source_rank"]).cloned().unwrap_or(Value::Null),
        "language": get_any(prediction, &["language"]).cloned().unwrap_or(Value::Null),
        "representative_card_ids": candidate_card_ids.iter().take(8).cloned().collect::<Vec<_>>(),
    });
    if !candidate_card_ids.is_empty() {
        entry["candidate_card_ids"] = json!(candidate_card_ids);
    }
    entry
}

/// `mergePredictivePoolRows(sourceResults, query, poolLimit)` — each source
/// result carries its source name and ordered rows.
pub fn merge_predictive_pool_rows(
    source_results: &[(String, Vec<Value>)],
    query: &str,
    pool_limit: usize,
) -> Vec<Value> {
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for (source, rows) in source_results {
        for (index, row) in rows.iter().enumerate() {
            let id = row_key(row);
            if id.is_empty() {
                continue;
            }
            let mut existing = match by_id.get(&id) {
                Some(existing) => existing.clone(),
                None => {
                    let mut base = row.clone();
                    if let Value::Object(map) = &mut base {
                        map.insert("search_rank".into(), json!(0.0));
                        map.insert("predictive_score_components".into(), json!({}));
                        map.insert("predictive_source_flags".into(), json!([]));
                        map.insert("predictive_best_rank".into(), json!(MAX_SAFE_INTEGER));
                    }
                    base
                }
            };
            let prediction_boost =
                predictive_confidence_boost(num_field(row, &["predicted_name_confidence"]))
                    + predictive_prefix_depth_boost(
                        &get(row, "predicted_name").cloned().unwrap_or(Value::Null),
                        query,
                    );
            let match_boost = num_field(row, &["predictive_dimension_match_count"]) * 180_000.0;
            let source_score = predictive_source_weight(source)
                + (50_000.0 - index as f64 * 10.0).max(0.0)
                + prediction_boost
                + match_boost
                + num_field(row, &["search_rank"]) * 0.2;
            let new_rank = num_field(&existing, &["search_rank"]).max(0.0) + source_score;
            let mut components = get(&existing, "predictive_score_components")
                .cloned()
                .unwrap_or(json!({}));
            let component_slot = |components: &mut Value, key: &str, value: f64| {
                if let Value::Object(map) = components {
                    let current = js_num_or(map.get(key), 0.0);
                    map.insert(key.into(), json!(current.max(value)));
                }
            };
            component_slot(&mut components, source, source_score);
            if prediction_boost > 0.0 {
                component_slot(
                    &mut components,
                    "predicted_name_confidence",
                    prediction_boost,
                );
            }
            if match_boost > 0.0 {
                component_slot(&mut components, "dimension_matches", match_boost);
            }
            let mut flags: Vec<String> = source_flags_for(&existing);
            flags.push(source.clone());
            flags.extend(source_flags_for(row));
            let mut seen = HashSet::new();
            flags.retain(|flag| seen.insert(flag.clone()));
            let best_rank = js_num_or(get(&existing, "predictive_best_rank"), MAX_SAFE_INTEGER)
                .min(index as f64);
            if let Value::Object(map) = &mut existing {
                // `...row` overwrites the base fields, then the accumulated
                // predictive fields are restored on top.
                if let Value::Object(row_map) = row {
                    for (key, value) in row_map {
                        map.insert(key.clone(), value.clone());
                    }
                }
                map.insert("search_rank".into(), json!(new_rank));
                map.insert("predictive_score_components".into(), components);
                map.insert("predictive_source_flags".into(), json!(flags));
                map.insert("predictive_best_rank".into(), json!(best_rank));
            }
            by_id.insert(id, existing);
        }
    }
    let mut rows: Vec<Value> = by_id.into_values().collect();
    for row in rows.iter_mut() {
        let boosted = num_field(row, &["search_rank"]) + score_row(row, query) * 80.0;
        if let Value::Object(map) = row {
            map.insert("search_rank".into(), json!(boosted));
        }
    }
    rows.sort_by(|left, right| {
        num_field(right, &["search_rank"])
            .partial_cmp(&num_field(left, &["search_rank"]))
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                num_field(left, &["predictive_best_rank"])
                    .partial_cmp(&num_field(right, &["predictive_best_rank"]))
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| locale_cmp(&str_field(left, &["name"]), &str_field(right, &["name"])))
            .then_with(|| {
                locale_cmp(
                    &str_field(left, &["card_number"]),
                    &str_field(right, &["card_number"]),
                )
            })
    });
    rows.truncate(pool_limit.clamp(1, AUTOCOMPLETE_SQL_SAFE_POOL_CAP));
    rows
}

// --- one character prefix shard plan ---

/// `predictivePoolPlan(query)`.
pub struct PredictivePlan {
    pub tokens: Vec<Token>,
    pub text_tokens: Vec<Token>,
    pub dimension_tokens: Vec<Token>,
    pub name_fragment_candidates: Vec<Value>,
    pub sources: Vec<&'static str>,
}

pub fn predictive_pool_plan(query: &str) -> Option<PredictivePlan> {
    let tokens = tokens_for_query(query);
    let text_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| t.kind == "text")
        .cloned()
        .collect();
    let dimension_tokens: Vec<Token> = tokens
        .iter()
        .filter(|t| {
            t.kind == "number"
                || t.kind == "expansion"
                || t.kind == "rarity"
                || t.kind == "variation"
        })
        .cloned()
        .collect();
    if super::normalize::meaningful_search_depth(query) < 2 {
        return None;
    }
    Some(PredictivePlan {
        name_fragment_candidates: predictive_name_fragment_candidates(&tokens),
        tokens,
        text_tokens,
        dimension_tokens,
        sources: PREDICTIVE_DIMENSION_SOURCES.to_vec(),
    })
}

/// `predictiveNameFragmentCandidates(tokens)` — the ≤8 name-fragment/dimension
/// splits the predictive pool scores.
pub fn predictive_name_fragment_candidates(tokens: &[Token]) -> Vec<Value> {
    let indexed: Vec<(usize, &Token)> = tokens.iter().enumerate().collect();
    let text_tokens: Vec<(usize, &Token)> = indexed
        .iter()
        .filter(|(_, token)| token.kind == "text")
        .copied()
        .collect();
    if text_tokens.is_empty() {
        return Vec::new();
    }
    struct Candidate {
        key: String,
        name_fragment: String,
        name_terms: Vec<String>,
        name_token_indexes: Vec<usize>,
        dimension_tokens: Vec<Token>,
        reason: &'static str,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut add_candidate = |name_indexes: Vec<usize>, reason: &'static str| {
        let index_set: HashSet<usize> = name_indexes.iter().copied().collect();
        let name_terms: Vec<String> = indexed
            .iter()
            .filter(|(index, _)| index_set.contains(index))
            .map(|(_, token)| token.term.clone())
            .collect();
        if name_terms.is_empty() {
            return;
        }
        let min_name_index = *name_indexes.iter().min().unwrap();
        let max_name_index = *name_indexes.iter().max().unwrap();
        let dimension_tokens: Vec<Token> = indexed
            .iter()
            .filter(|(index, _)| !index_set.contains(index))
            .map(|(index, token)| {
                if token.kind != "text" {
                    Token {
                        source_hint: None,
                        ..(*token).clone()
                    }
                } else {
                    let hint = if index < &min_name_index {
                        "variation_owner"
                    } else if index > &max_name_index {
                        "expansion"
                    } else {
                        "variation_owner"
                    };
                    Token {
                        term: token.term.clone(),
                        kind: "text",
                        source_hint: Some(hint.to_owned()),
                    }
                }
            })
            .collect();
        let name_fragment = name_terms.join(" ");
        let key = format!(
            "{}|{}",
            compact(&name_fragment),
            dimension_tokens
                .iter()
                .map(|token| format!(
                    "{}:{}",
                    token
                        .source_hint
                        .clone()
                        .unwrap_or_else(|| token.kind.to_owned()),
                    token.term
                ))
                .collect::<Vec<_>>()
                .join(",")
        );
        if candidates.iter().any(|candidate| candidate.key == key) {
            return;
        }
        candidates.push(Candidate {
            key,
            name_fragment,
            name_terms,
            name_token_indexes: name_indexes,
            dimension_tokens,
            reason,
        });
    };

    add_candidate(
        text_tokens.iter().map(|(index, _)| *index).collect(),
        "all_text_tokens",
    );

    let first_text_index = text_tokens[0].0;
    let last_text_index = text_tokens[text_tokens.len() - 1].0;
    let mut leading_text: Vec<usize> = Vec::new();
    for (index, token) in &indexed {
        if *index < first_text_index {
            continue;
        }
        if token.kind != "text" {
            break;
        }
        leading_text.push(*index);
    }
    for length in (1..leading_text.len()).rev() {
        add_candidate(leading_text[..length].to_vec(), "leading_text_prefix");
    }

    if first_text_index == last_text_index && indexed.len() > 1 {
        add_candidate(vec![first_text_index], "single_text_token");
    } else if last_text_index < indexed.len() - 1 {
        add_candidate(vec![last_text_index], "last_text_before_structured_token");
    }

    candidates
        .into_iter()
        .take(8)
        .map(|candidate| {
            json!({
                "nameFragment": candidate.name_fragment,
                "nameTerms": candidate.name_terms,
                "nameTokenIndexes": candidate.name_token_indexes,
                "dimensionTokens": Token::tokens_json(&candidate.dimension_tokens),
                "reason": candidate.reason,
            })
        })
        .collect()
}

// --- one character prefix shard plan (cont.) ---

pub struct PrefixShardBucket {
    pub kind: &'static str,
    pub start: &'static str,
    pub end: &'static str,
}

/// `PREFIX_SHARD_SECONDARY_BUCKETS`.
pub const PREFIX_SHARD_SECONDARY_BUCKETS: [PrefixShardBucket; 5] = [
    PrefixShardBucket {
        kind: "range",
        start: "a",
        end: "g",
    },
    PrefixShardBucket {
        kind: "range",
        start: "h",
        end: "o",
    },
    PrefixShardBucket {
        kind: "range",
        start: "p",
        end: "u",
    },
    PrefixShardBucket {
        kind: "range",
        start: "v",
        end: "z",
    },
    PrefixShardBucket {
        kind: "non_alpha",
        start: "",
        end: "",
    },
];

/// `shardLabelForBucket(initial, bucket)`.
pub fn shard_label_for_bucket(initial: &str, bucket: &PrefixShardBucket) -> String {
    if bucket.kind == "range" {
        format!(
            "{initial}{start}-{initial}{end}",
            start = bucket.start,
            end = bucket.end
        )
    } else {
        format!("{initial}+numeric_special_diacritic_apostrophe_hyphen_space")
    }
}

pub struct PrefixShard {
    pub index: usize,
    pub role: String,
    pub buckets: Vec<usize>,
    pub label: String,
}

/// `distributePrefixShardBuckets(clients, buckets)` — bucket indices per shard.
pub fn distribute_prefix_shard_buckets(client_count: usize) -> Vec<(Option<usize>, Vec<usize>)> {
    let client_count = client_count.max(1);
    let shard_count = client_count.min(PREFIX_SHARD_SECONDARY_BUCKETS.len());
    let mut shards: Vec<(Option<usize>, Vec<usize>)> = (0..shard_count)
        .map(|index| (Some(index), Vec::new()))
        .collect();
    for (bucket_index, _) in PREFIX_SHARD_SECONDARY_BUCKETS.iter().enumerate() {
        shards[bucket_index % shard_count].1.push(bucket_index);
    }
    shards
}

/// `oneCharacterPrefixShardPlan(searchTerm, clients)` — the plan rows with
/// their shard labels; `client_roles` are the role names of the pool clients.
pub fn one_character_prefix_shard_plan(
    search_term: &str,
    client_roles: &[String],
) -> Vec<PrefixShard> {
    let compact_term = compact(search_term);
    if compact_term.chars().count() != 1 {
        return Vec::new();
    }
    distribute_prefix_shard_buckets(client_roles.len())
        .into_iter()
        .enumerate()
        .map(|(index, (client, buckets))| {
            let role = client
                .and_then(|client_index| client_roles.get(client_index).cloned())
                .unwrap_or_else(|| "primary".to_owned());
            let label = buckets
                .iter()
                .map(|bucket_index| {
                    shard_label_for_bucket(
                        &compact_term,
                        &PREFIX_SHARD_SECONDARY_BUCKETS[*bucket_index],
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            PrefixShard {
                index,
                role,
                buckets,
                label,
            }
        })
        .collect()
}

// --- supabase name-token prediction scoring (pure parts) ---

/// `supabasePredictedNameConfidence(row, compactQuery)`.
pub fn supabase_predicted_name_confidence(row: &Value, compact_query: &str) -> f64 {
    let compact_name = str_field(row, &["compact_name"]);
    let tokens: Vec<String> = match get(row, "name_tokens") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| compact(&super::normalize::js_str_or(Some(item))))
            .collect(),
        _ => Vec::new(),
    };
    if compact_query.is_empty() {
        return 0.0;
    }
    if compact_name == compact_query || tokens.iter().any(|token| token == compact_query) {
        return 100.0;
    }
    if compact_name.starts_with(compact_query) {
        let extra = (compact_name.chars().count() - compact_query.chars().count()) as f64;
        return (72.0f64).max(96.0 - extra);
    }
    if tokens.iter().any(|token| token.starts_with(compact_query)) {
        return 84.0;
    }
    let query_len = compact_query.chars().count();
    let two_prefix: String = compact_query.chars().take(2).collect();
    if query_len >= 3
        && tokens.iter().any(|token| {
            token.starts_with(&two_prefix) && {
                let sliced: String = token.chars().take(query_len).collect();
                bounded_distance(&sliced, compact_query, 1) <= 1
            }
        })
    {
        return 76.0;
    }
    if query_len >= 4 && compact_name.starts_with(&two_prefix) && {
        let sliced: String = compact_name.chars().take(query_len).collect();
        bounded_distance(&sliced, compact_query, 2) <= 2
    } {
        return 68.0;
    }
    0.0
}

/// `cardIdsFromNameTokenRow(row, limit)`.
pub fn card_ids_from_name_token_row(row: &Value, limit: usize) -> Vec<String> {
    let ids: Vec<String> = match get(row, "card_ids") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| super::normalize::js_str_or(Some(item)))
            .collect(),
        _ => match get(row, "representative_card_ids") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| super::normalize::js_str_or(Some(item)))
                .collect(),
            _ => vec![str_field(row, &["card_id"])],
        },
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in ids {
        let id = raw.trim().to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        seen.insert(id.clone());
        out.push(id);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// `nameTokenPopularityCount(row)`.
pub fn name_token_popularity_count(row: &Value) -> f64 {
    let card_ids_count = match get_any(row, &["card_ids", "representative_card_ids"]) {
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| !super::normalize::js_str_or(Some(item)).trim().is_empty())
            .count() as f64,
        _ => 0.0,
    };
    let row_count = num_field(row, &["row_count"]);
    row_count.max(card_ids_count)
}

/// `nameTokenIdsCount(row)`.
pub fn name_token_ids_count(row: &Value) -> f64 {
    if let Some(Value::Array(items)) = get(row, "card_ids") {
        return items
            .iter()
            .filter(|item| !super::normalize::js_str_or(Some(item)).trim().is_empty())
            .count() as f64;
    }
    if let Some(Value::Array(items)) = get(row, "representative_card_ids") {
        return items
            .iter()
            .filter(|item| !super::normalize::js_str_or(Some(item)).trim().is_empty())
            .count() as f64;
    }
    if !str_field(row, &["card_id"]).trim().is_empty() {
        1.0
    } else {
        0.0
    }
}

/// `nameTokenPopularityBoost(row, compactQuery)`.
pub fn name_token_popularity_boost(row: &Value, compact_query: &str) -> f64 {
    let count = name_token_popularity_count(row);
    if count <= 0.0 {
        return 0.0;
    }
    let prefix_length = compact(compact_query).chars().count();
    let multiplier = match prefix_length {
        0 | 1 => 900.0,
        2 => 320.0,
        _ => 80.0,
    };
    count.min(1000.0) * multiplier
}

/// `nameTokenPopularityConfidenceBoost(row, compactQuery)`.
pub fn name_token_popularity_confidence_boost(row: &Value, compact_query: &str) -> f64 {
    let count = name_token_popularity_count(row);
    if count <= 1.0 {
        return 0.0;
    }
    let prefix_length = compact(compact_query).chars().count();
    if prefix_length > 2 {
        return 0.0;
    }
    let max_boost: f64 = if prefix_length <= 1 { 8.0 } else { 3.0 };
    max_boost.min(((count + 1.0).log2()) * 1.2)
}

/// `predictionLanguage(row, fallbackLanguage)`.
pub fn prediction_language(row: &Value, fallback_language: &str) -> String {
    super::normalize::clean_language(
        get_any(row, &["language", "search_language"])
            .or(Some(&Value::String(fallback_language.to_owned()))),
    )
}

/// `predictionDisplayToken(row)`.
pub fn prediction_display_token(row: &Value) -> String {
    str_field(row, &["canonical_name", "name", "display_name"])
        .trim()
        .to_owned()
}

/// `representativeLabelsFromNameTokenRow(row, limit)`.
pub fn representative_labels_from_name_token_row(row: &Value, limit: usize) -> Vec<Value> {
    let raw_labels: Vec<Value> = match get(row, "representative_labels") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let mut labels: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    for raw_label in raw_labels {
        if !raw_label.is_object() {
            continue;
        }
        let id = str_field(&raw_label, &["id", "card_id"]).trim().to_owned();
        let name = {
            let own = str_field(&raw_label, &["name"]);
            if own.trim().is_empty() {
                str_field(row, &["display_name", "search_name"])
            } else {
                own
            }
        }
        .trim()
        .to_owned();
        if id.is_empty() || name.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        seen.insert(id.clone());
        let item_kind = {
            let own = str_field(&raw_label, &["item_kind"]);
            if own.is_empty() {
                "single".to_owned()
            } else {
                own
            }
        };
        let product_type = {
            let own = str_field(&raw_label, &["product_type"]);
            if own.is_empty() {
                "card".to_owned()
            } else {
                own
            }
        };
        labels.push(json!({
            "id": id,
            "name": name,
            "item_kind": item_kind,
            "product_type": product_type,
            "set_name": str_field(&raw_label, &["set_name"]),
            "card_number": str_field(&raw_label, &["card_number"]),
            "rarity": str_field(&raw_label, &["rarity"]),
            "product_variant": str_field(&raw_label, &["product_variant"]),
            "trainer_name": str_field(&raw_label, &["trainer_name"]),
        }));
        if labels.len() >= limit {
            break;
        }
    }
    labels
}

/// Score/confidence order of `normalizePredictionRows`, without the prefix
/// family rule: a total order, safe for `sort_by`.
fn compare_prediction_token_rank(left: &Value, right: &Value, broad_prefix: bool) -> Ordering {
    let by = |key: &str| cmp_f64_nan_last(num_field(left, &[key]), num_field(right, &[key]), true);
    let (first, second) = if broad_prefix {
        ("score", "confidence")
    } else {
        ("confidence", "score")
    };
    by(first).then_with(|| by(second)).then_with(|| {
        locale_cmp(
            &str_field(left, &["display"]),
            &str_field(right, &["display"]),
        )
    })
}

/// The JS comparator put a prefix token before its extensions when the prefix
/// is at least as confident (`pika` before `pikachu`) but answered 0 for
/// unrelated tokens and fell through to score. That is not transitive (pika <
/// pikachu by family, pikachu < zz and zz < pika by score), and Rust's
/// `sort_by` panics on it. Apply the family rule as a pass over the rank order
/// instead: each entry is emitted right after any not-yet-emitted prefix that
/// is at least as confident, those in rank order too.
fn order_prediction_token_families(entries: Vec<Value>) -> Vec<Value> {
    let tokens: Vec<String> = entries
        .iter()
        .map(|entry| str_field(entry, &["normalized"]))
        .collect();
    let confidence: Vec<f64> = entries
        .iter()
        .map(|entry| num_field(entry, &["confidence"]))
        .collect();
    let is_family_parent = |parent: usize, child: usize| {
        let (p, c) = (&tokens[parent], &tokens[child]);
        !p.is_empty()
            && p != c
            && c.starts_with(p.as_str())
            && confidence[parent] >= confidence[child]
    };
    fn emit(
        index: usize,
        emitted: &mut [bool],
        order: &mut Vec<usize>,
        is_parent: &dyn Fn(usize, usize) -> bool,
    ) {
        // Marked before the parents so a (impossible: strict prefixes) cycle
        // could never recurse forever.
        emitted[index] = true;
        for parent in 0..emitted.len() {
            if !emitted[parent] && is_parent(parent, index) {
                emit(parent, emitted, order, is_parent);
            }
        }
        order.push(index);
    }
    let mut emitted = vec![false; entries.len()];
    let mut order = Vec::with_capacity(entries.len());
    for index in 0..entries.len() {
        if !emitted[index] {
            emit(index, &mut emitted, &mut order, &is_family_parent);
        }
    }
    let mut slots: Vec<Option<Value>> = entries.into_iter().map(Some).collect();
    order
        .into_iter()
        .filter_map(|index| slots[index].take())
        .collect()
}

/// `normalizePredictionRows(rows, compactQuery, searchLanguage, limit)`.
pub fn normalize_prediction_rows(
    rows: &[Value],
    compact_query: &str,
    search_language: &str,
    limit: usize,
) -> Vec<Value> {
    let mut by_token: Vec<(String, Value)> = Vec::new();
    let mut index_of: HashMap<String, usize> = HashMap::new();
    let broad_prefix = compact(compact_query).chars().count() <= 2;
    for row in rows {
        let display_token = prediction_display_token(row);
        let normalized_token = {
            let from_display = compact(&display_token);
            if from_display.is_empty() {
                compact(&str_field(row, &["compact_name"]))
            } else {
                from_display
            }
        };
        if display_token.is_empty() || normalized_token.is_empty() {
            continue;
        }
        let popularity_count = name_token_popularity_count(row);
        let confidence = {
            let direct = num_field(row, &["confidence"]);
            let compact_name_value = {
                let own = str_field(row, &["compact_name"]);
                if own.is_empty() {
                    normalized_token.clone()
                } else {
                    own
                }
            };
            let derived = supabase_predicted_name_confidence(
                &json!({
                    "compact_name": compact_name_value,
                    "name_tokens": get(row, "name_tokens").cloned().unwrap_or(Value::Null),
                }),
                compact_query,
            );
            (direct.max(derived) + name_token_popularity_confidence_boost(row, compact_query))
                .min(100.0)
        };
        if confidence <= 0.0 {
            continue;
        }
        let popularity_boost = name_token_popularity_boost(row, compact_query);
        let representative_card_ids = card_ids_from_name_token_row(row, 64);
        let ids_count = name_token_ids_count(row);
        let card_count = popularity_count.max(ids_count);
        let representative_labels = representative_labels_from_name_token_row(row, 8);
        let fallback_labels: Vec<Value> = if !representative_labels.is_empty() {
            representative_labels.clone()
        } else {
            let label_name = {
                let own = str_field(row, &["display_name", "name"]);
                if own.trim().is_empty() {
                    display_token.clone()
                } else {
                    own
                }
            };
            let label_item_kind = {
                let own = str_field(row, &["item_kind"]);
                if own.is_empty() {
                    "single".to_owned()
                } else {
                    own
                }
            };
            let label_product_type = {
                let own = str_field(row, &["product_type"]);
                if own.is_empty() {
                    "card".to_owned()
                } else {
                    own
                }
            };
            let label = json!({
                "id": str_field(row, &["card_id"]),
                "name": label_name,
                "item_kind": label_item_kind,
                "product_type": label_product_type,
                "set_name": str_field(row, &["set_name"]),
                "card_number": str_field(row, &["card_number"]),
                "trainer_name": str_field(row, &["trainer_name"]),
            });
            if !str_field(&label, &["id"]).is_empty() && !str_field(&label, &["name"]).is_empty() {
                vec![label]
            } else {
                Vec::new()
            }
        };
        let score = {
            let search_rank = js_num_or(
                get_any(row, &["search_rank", "name_score", "search_weight"]),
                0.0,
            );
            let chosen = js_num_or(get(row, "score"), f64::NAN);
            let chosen = if chosen.is_finite() && chosen != 0.0 {
                chosen
            } else if search_rank != 0.0 {
                search_rank
            } else {
                confidence * 100.0
            };
            chosen + popularity_boost
        };
        let next = json!({
            "normalized": normalized_token,
            "normalized_token": normalized_token,
            "display": display_token,
            "display_token": display_token,
            "language": prediction_language(row, search_language),
            "confidence": confidence,
            "score": score,
            "source_rank": 0,
            "popularity_count": popularity_count,
            "matched_prefix": compact_query,
            "ids_count": ids_count,
            "card_count": card_count,
            "representative_card_ids": representative_card_ids,
            "candidate_card_ids": representative_card_ids.iter().take(32).cloned().collect::<Vec<_>>(),
            "representative_labels": fallback_labels,
        });
        match index_of.get(&normalized_token).copied() {
            None => {
                index_of.insert(normalized_token.clone(), by_token.len());
                by_token.push((normalized_token, next));
            }
            Some(index) => {
                let existing = &mut by_token[index].1;
                let existing: &mut Value = existing;
                let merged_popularity =
                    num_field(existing, &["popularity_count"]) + popularity_count;
                let merged_ids = num_field(existing, &["ids_count"]) + ids_count;
                let merged_card_count = num_field(existing, &["card_count"])
                    .max(merged_popularity)
                    .max(merged_ids);
                let merged_confidence = (num_field(existing, &["confidence"]).max(confidence)
                    + name_token_popularity_confidence_boost(
                        &json!({"row_count": merged_popularity}),
                        compact_query,
                    ))
                .min(100.0);
                let merged_score = num_field(existing, &["score"]).max(score)
                    + name_token_popularity_boost(
                        &json!({"row_count": merged_popularity}),
                        compact_query,
                    );
                let mut merged_ids_list: Vec<String> =
                    card_ids_from_name_token_row(existing, usize::MAX);
                for id in &representative_card_ids {
                    if !merged_ids_list.contains(id) {
                        merged_ids_list.push(id.clone());
                    }
                }
                merged_ids_list.truncate(8);
                let mut candidate_list: Vec<String> =
                    card_ids_from_name_token_row(existing, usize::MAX);
                for id in &representative_card_ids {
                    if !candidate_list.contains(id) {
                        candidate_list.push(id.clone());
                    }
                }
                candidate_list.truncate(32);
                let mut label_map = existing["representative_labels"].clone();
                if let Value::Array(items) = &mut label_map {
                    let known: HashSet<String> = items
                        .iter()
                        .map(|label| str_field(label, &["id"]))
                        .collect();
                    for label in &representative_labels {
                        if items.len() >= 8 {
                            break;
                        }
                        if known.contains(&str_field(label, &["id"])) {
                            continue;
                        }
                        items.push(label.clone());
                    }
                }
                if let Value::Object(map) = existing {
                    map.insert("popularity_count".into(), json!(merged_popularity));
                    map.insert("ids_count".into(), json!(merged_ids));
                    map.insert("card_count".into(), json!(merged_card_count));
                    map.insert("confidence".into(), json!(merged_confidence));
                    map.insert("score".into(), json!(merged_score));
                    map.insert("representative_card_ids".into(), json!(merged_ids_list));
                    map.insert("candidate_card_ids".into(), json!(candidate_list));
                    map.insert("representative_labels".into(), label_map);
                }
            }
        }
    }
    let mut entries: Vec<Value> = by_token.into_iter().map(|(_, value)| value).collect();
    entries.sort_by(|left, right| compare_prediction_token_rank(left, right, broad_prefix));
    let mut entries = order_prediction_token_families(entries);
    entries.truncate(limit);
    entries
        .into_iter()
        .enumerate()
        .map(|(index, mut entry)| {
            if let Value::Object(map) = &mut entry {
                map.remove("popularity_count");
                map.insert("source_rank".into(), json!((index + 1) as f64));
            }
            entry
        })
        .collect()
}

/// `nameTokenSearchRank(row, compactQuery)`.
pub fn name_token_search_rank(row: &Value, compact_query: &str) -> f64 {
    let compact_name = str_field(row, &["compact_name"]);
    let tokens: Vec<String> = match get(row, "name_tokens") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| compact(&super::normalize::js_str_or(Some(item))))
            .collect(),
        _ => Vec::new(),
    };
    let base = if compact_name == compact_query {
        240_000.0
    } else if compact_name.starts_with(compact_query) {
        120_000.0
    } else if tokens.iter().any(|token| token == compact_query) {
        60_000.0
    } else {
        2_500.0
    };
    let display_bonus = if str_field(row, &["display_name"]) == str_field(row, &["canonical_name"])
    {
        100_000.0
    } else {
        0.0
    };
    let capped_weight = num_field(row, &["search_weight"]).clamp(0.0, 5000.0);
    base + display_bonus + capped_weight + name_token_popularity_boost(row, compact_query)
}

/// `supabaseRestFuzzyNameTokenRows(rows, compactQuery)` — pure row filter.
pub fn supabase_rest_fuzzy_name_token_rows(rows: &[Value], compact_query: &str) -> Vec<Value> {
    let normalized_query = compact(compact_query);
    let query_len = normalized_query.chars().count();
    if query_len < 3 {
        return rows.to_vec();
    }
    let max_distance = if query_len >= 6 { 2 } else { 1 };
    let prefix: String = normalized_query.chars().take(2).collect();
    rows.iter()
        .filter(|row| {
            let mut candidates: Vec<String> = Vec::new();
            if let Some(value) = get(row, "compact_name") {
                candidates.push(compact(&super::normalize::js_str_or(Some(value))));
            }
            if let Some(Value::Array(items)) = get(row, "name_tokens") {
                for item in items {
                    candidates.push(compact(&super::normalize::js_str_or(Some(item))));
                }
            }
            candidates.retain(|candidate| !candidate.is_empty());
            candidates.iter().any(|candidate| {
                if !candidate.starts_with(&prefix) {
                    return false;
                }
                if candidate.chars().count().abs_diff(query_len) > max_distance + 1 {
                    return false;
                }
                let candidate_prefix: String = candidate
                    .chars()
                    .take(candidate.chars().count().min(query_len))
                    .collect();
                bounded_distance(&candidate_prefix, &normalized_query, max_distance) <= max_distance
            })
        })
        .cloned()
        .collect()
}

/// `hydratedNameRankBonus(row, compactQuery)`.
pub fn hydrated_name_rank_bonus(row: &Value, compact_query: &str) -> f64 {
    let compact_name = compact(&str_field(row, &["name", "display_name", "canonical_name"]));
    if compact_name.is_empty() || compact_query.is_empty() {
        return 0.0;
    }
    if compact_name == compact_query {
        return 2000.0;
    }
    if compact_name.starts_with(compact_query) {
        return 900.0;
    }
    0.0
}

/// `expandSupabaseNameIndexRows(rows, limit)`.
pub fn expand_supabase_name_index_rows(rows: &[Value], limit: usize) -> Vec<Value> {
    let mut expanded: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let card_id = str_field(row, &["card_id"]);
        if !card_id.is_empty() {
            if seen.insert(card_id) {
                expanded.push(row.clone());
            }
            continue;
        }
        let ids = card_ids_from_name_token_row(row, limit);
        for id in ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let display_name = str_field(row, &["display_name", "search_name", "canonical_name"]);
            let canonical_name = str_field(row, &["canonical_name", "display_name"]);
            expanded.push(json!({
                "card_id": id,
                "name": display_name,
                "set_name": "",
                "card_number": "",
                "product_variant": "",
                "rarity": "",
                "card_type": "",
                "item_kind": "single",
                "product_type": "card",
                "trainer_name": "",
                "canonical_name": canonical_name,
                "image_url": Value::Null,
                "cdn_image_url": Value::Null,
                "preview_image_url": Value::Null,
                "card_palette": Value::Null,
                "emoji": "",
                "imported_at": get_any(row, &["updated_at"]).cloned().unwrap_or(Value::Null),
                "search_rank": num_field(row, &["search_rank"]) - expanded.len() as f64 * 0.01,
            }));
            if expanded.len() >= limit {
                return expanded;
            }
        }
    }
    expanded
}

/// `expandNameTokenRowsToCandidateIds(rows, compactQuery, poolLimit)`.
pub fn expand_name_token_rows_to_candidate_ids(
    rows: &[Value],
    compact_query: &str,
    pool_limit: usize,
) -> Vec<Value> {
    let limit = (pool_limit.max(1)).min(AUTOCOMPLETE_SQL_SAFE_POOL_CAP);
    let mut candidates: Vec<Value> = Vec::new();
    let mut seen_ids = HashSet::new();
    for row in rows {
        let name_rank = js_num_or(
            get_any(row, &["search_rank", "score"]),
            name_token_search_rank(row, compact_query),
        );
        let card_ids = card_ids_from_name_token_row(row, limit);
        let representative_labels = representative_labels_from_name_token_row(row, 64);
        for (index, card_id) in card_ids.iter().enumerate() {
            if seen_ids.contains(card_id) || candidates.len() >= limit {
                continue;
            }
            seen_ids.insert(card_id.clone());
            let label = representative_labels
                .iter()
                .find(|entry| str_field(entry, &["id"]) == *card_id);
            let predicted_display =
                str_field(row, &["display_name", "canonical_name", "search_name"]);
            let predicted_language = prediction_language(row, "en");
            let predicted_representative: Vec<String> = card_ids.iter().take(8).cloned().collect();
            candidates.push(json!({
                "card_id": card_id,
                "name": label
                    .map(|label| str_field(label, &["name"]))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| str_field(row, &["display_name"])),
                "canonical_name": get_any(row, &["canonical_name"]).cloned().unwrap_or(Value::Null),
                "display_name": get_any(row, &["display_name"]).cloned().unwrap_or(Value::Null),
                "search_name": get_any(row, &["search_name"]).cloned().unwrap_or(Value::Null),
                "language": get_any(row, &["language"]).cloned().unwrap_or(Value::Null),
                "set_name": label.map(|label| str_field(label, &["set_name"])).unwrap_or_default(),
                "card_number": label.map(|label| str_field(label, &["card_number"])).unwrap_or_default(),
                "product_variant": label.map(|label| str_field(label, &["product_variant"])).unwrap_or_default(),
                "rarity": label.map(|label| str_field(label, &["rarity"])).unwrap_or_default(),
                "card_type": "",
                "item_kind": label
                    .map(|label| str_field(label, &["item_kind"]))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "single".to_owned()),
                "product_type": label
                    .map(|label| str_field(label, &["product_type"]))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "card".to_owned()),
                "trainer_name": label.map(|label| str_field(label, &["trainer_name"])).unwrap_or_default(),
                "image_url": Value::Null,
                "cdn_image_url": Value::Null,
                "preview_image_url": Value::Null,
                "card_palette": Value::Null,
                "emoji": "",
                "imported_at": get_any(row, &["updated_at"]).cloned().unwrap_or(Value::Null),
                "search_rank": name_rank - index as f64 * 0.01,
                "predicted_name": {
                    "normalized": str_field(row, &["compact_name"]),
                    "display": predicted_display,
                    "score": name_rank,
                    "source_rank": 0,
                    "language": predicted_language,
                    "representative_card_ids": predicted_representative,
                },
            }));
        }
        if candidates.len() >= limit {
            break;
        }
    }
    candidates
}

/// A first-name anchor resolved from the client prediction context or Supabase
/// (`firstNameAnchorForPredictivePlan`).
#[derive(Clone, Debug)]
pub struct NameAnchor {
    pub prefix_length: usize,
    pub name_fragment: String,
    pub name_terms: Vec<String>,
    pub predictions: Value,
    pub source: String,
}

/// `anchoredPredictionSets(anchor, tokens)`.
pub fn anchored_prediction_sets(
    anchor: Option<NameAnchor>,
    tokens: &[Token],
) -> Option<Vec<Value>> {
    let anchor = anchor?;
    let prefix_length = anchor.prefix_length;
    let dimension_tokens: Vec<Token> = tokens[prefix_length..]
        .iter()
        .map(|token| {
            if token.kind == "text" && token.source_hint.is_none() {
                Token {
                    source_hint: Some("expansion".to_owned()),
                    ..token.clone()
                }
            } else {
                token.clone()
            }
        })
        .collect();
    Some(vec![json!({
        "nameFragment": anchor.name_fragment,
        "nameTerms": anchor.name_terms,
        "nameTokenIndexes": (0..prefix_length).collect::<Vec<_>>(),
        "dimensionTokens": Token::tokens_json(&dimension_tokens),
        "reason": "first_name_anchor",
        "predictionContextSource": anchor.source,
        "predictions": anchor.predictions,
    })])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autocomplete::analytics::empty_analytics_boosts;

    fn row(name: &str, set: &str, number: &str, rarity: &str) -> Value {
        serde_json::json!({
            "card_id": 25, "name": name, "set_name": set, "card_number": number,
            "rarity": rarity, "card_type": "Trading card", "item_kind": "single",
            "product_type": "card", "search_rank": 40.0,
        })
    }

    #[test]
    fn token_kinds() {
        assert_eq!(token_kind("25"), "number");
        assert_eq!(token_kind("ex"), "variation");
        assert_eq!(token_kind("vmax"), "variation");
        assert_eq!(token_kind("sir"), "rarity");
        assert_eq!(token_kind("sv"), "expansion");
        assert_eq!(token_kind("pikachu"), "text");
    }

    #[test]
    fn intersection_plan_needs_text_plus_structured() {
        assert!(intersection_token_plan("pikachu").is_none());
        assert!(intersection_token_plan("sv 25").is_none()); // no text token
        let plan = intersection_token_plan("charizard ex").unwrap();
        assert_eq!(plan.tokens.len(), 2);
        assert_eq!(plan.tokens[0].term, "charizard");
        assert!(intersection_token_plan("charizard sir").is_none()); // rarity skipped
    }

    #[test]
    fn fanout_plan_probes_name_tokens() {
        let plan = candidate_fanout_plan("umbreon vmax").unwrap();
        assert_eq!(plan.name_probe_tokens.len(), 1);
        assert_eq!(plan.name_probe_tokens[0].term, "umbreon");
        assert!(candidate_fanout_plan("pikachu").is_none());
    }

    #[test]
    fn energy_plan_needs_only_generic_tokens() {
        assert!(generic_energy_expansion_plan("sv energy").is_some());
        assert!(generic_energy_expansion_plan("sv basic energy").is_some());
        assert!(generic_energy_expansion_plan("sv grass energy deck").is_none());
        assert!(generic_energy_expansion_plan("pikachu").is_none());
    }

    #[test]
    fn variation_matchers() {
        let v_row = row("Charizard V", "Base Set", "25/102", "Rare");
        assert!(row_has_variation(&v_row, "v"));
        assert!(!row_has_variation(&v_row, "ex"));
        let gx_row = row("Zacian & Zamazenta GX", "", "", "");
        assert!(row_has_variation(&gx_row, "tagteam"));
        assert!(row_has_variation(&gx_row, "gx"));
        // `lv\.?x` needs the compact "LV.X" spelling; "LV. X" does not match (JS parity).
        assert!(row_has_variation(&row("Charizard LV.X", "", "", ""), "lvx"));
        assert!(!row_has_variation(
            &row("Charizard LV. X", "", "", ""),
            "lvx"
        ));
        assert!(row_has_variation(&row("Mewtwo M", "", "", ""), "mega"));
    }

    #[test]
    fn rarity_matchers() {
        assert!(row_has_rarity(
            &row("x", "y", "Special Illustration Rare | 090/087", ""),
            "sir"
        ));
        assert!(!row_has_rarity(
            &row("x", "y", "Special Art Rare | 090/087", ""),
            "sir"
        ));
        assert!(!row_has_rarity(&row("x", "y", "Rare | 090/087", ""), "sir"));
        assert!(!row_has_rarity(
            &row("x", "y", "Holo Rare", "Holo Rare"),
            "ur"
        ));
        assert!(row_has_rarity(&row("x", "y", "", "Ultra Rare"), "ultra"));
    }

    #[test]
    fn expansion_alias_matchers() {
        // compact() turns `&` into tagteam, so the JS matcher only hits
        // set names whose compact form really starts with the target.
        assert!(row_has_expansion_alias(
            &row("x", "Scarlet Violet", "", ""),
            "sv"
        ));
        assert!(row_has_expansion_alias(
            &row("x", "Scarlet Violet Base Set", "", ""),
            "sv"
        ));
        assert!(!row_has_expansion_alias(
            &row("x", "Obsidian Flames", "", ""),
            "sv"
        ));
        assert!(row_has_expansion_alias(
            &row("x", "Call of Legends", "", ""),
            "col"
        ));
    }

    #[test]
    fn name_token_confidence_ladder() {
        assert_eq!(
            name_token_confidence("pikachu", &["pikachu".to_owned()], "pikachu"),
            100
        );
        assert_eq!(
            name_token_confidence("pikachu", &["pikachu".to_owned()], "pika"),
            90
        );
        assert_eq!(
            name_token_confidence("pikaachu", &["pikaachu".to_owned()], "pikachu"),
            76
        );
        assert_eq!(
            name_token_confidence("Raichu", &["raichu".to_owned()], "chu"),
            60
        );
        assert_eq!(
            name_token_confidence("Diglett", &["diglett".to_owned()], "zard"),
            0
        );
    }

    #[test]
    fn score_row_matches_the_live_debug_fixture() {
        // live fixture (debug charizard ex): relevanceScore 8830.
        let charizard_ex = serde_json::json!({
            "card_id": 276450,
            "name": "Charizard EX",
            "set_name": "Expansion Pack 20th Anniversary",
            "card_number": "Secret Rare | 090/087",
            "rarity": "Card",
            "product_variant": "",
            "item_kind": "single",
            "product_type": "card",
            "card_type": "Trading card",
            "search_rank": 24,
        });
        assert_eq!(score_row(&charizard_ex, "charizard ex"), 8830.0);
    }

    #[test]
    fn score_row_single_text_term_exact_match() {
        let pikachu = row("Pikachu", "Base Set", "58/102", "Common");
        let score = score_row(&pikachu, "pikachu");
        // exact name + identity bonus; remote 40 * 0.35 stays below
        assert!(score >= 5200.0, "score {score}");
        let partial = row("Pikachu V", "Base Set", "1/102", "Rare");
        assert!(score_row(&partial, "pika") > 4000.0);
    }

    #[test]
    fn score_row_structured_intent_requires_matches() {
        let charizard = row("Charizard", "Base Set", "4/102", "Rare");
        // number without name match zeroes the row
        assert_eq!(score_row(&charizard, "diglett 4/102"), 0.0);
        // name + number match boosts hard
        let score = score_row(&charizard, "charizard 4/102");
        assert!(score > 5000.0, "score {score}");
    }

    #[test]
    fn rank_entries_order_by_depth_then_score() {
        let rows = vec![
            serde_json::json!({"card_id": 1, "name": "Pikachu", "search_rank": 4.0}),
            serde_json::json!({"card_id": 2, "name": "Pikachu V", "search_rank": 4.0}),
        ];
        let mut depth_scores = DepthMap::new();
        depth_scores.insert("1".into(), 3.0);
        let mut latest_depths = DepthMap::new();
        latest_depths.insert("1".into(), 3.0);
        latest_depths.insert("2".into(), 2.0);
        let mut orders = DepthMap::new();
        orders.insert("1".into(), 1.0);
        orders.insert("2".into(), 0.0);
        let ranked = rank_autocomplete_entries(
            rows,
            "pikachu",
            10,
            &empty_analytics_boosts(),
            &depth_scores,
            &latest_depths,
            &orders,
        );
        assert_eq!(str_field(&ranked[0].row, &["card_id"]), "1");
        assert_eq!(ranked[0].latest_depth, 3.0);
        assert_eq!(ranked[0].depth_weight, 3.0);
        assert_eq!(
            ranked[0].depth_boost,
            3.0 * 1200.0 + 3.0f64 * 45.0_f64.min(900.0)
        );
    }

    #[test]
    fn intersect_rows_keeps_first_group_order() {
        let group_a = vec![
            json!({"card_id": "1"}),
            json!({"card_id": "2"}),
            json!({"card_id": "3"}),
        ];
        let group_b = vec![json!({"card_id": "3"}), json!({"card_id": "1"})];
        let merged = intersect_rows(&[group_a, group_b], 10);
        assert_eq!(
            merged
                .iter()
                .map(|row| str_field(row, &["card_id"]))
                .collect::<Vec<_>>(),
            vec!["1", "3"]
        );
    }

    #[test]
    fn merge_preserves_the_best_rank() {
        let merged = merge_rows_preserving_best(
            vec![
                vec![json!({"card_id": "1", "name": "A", "search_rank": 10.0})],
                vec![
                    json!({"card_id": "1", "name": "A", "search_rank": 30.0}),
                    json!({"card_id": "2", "name": "B", "search_rank": 5.0}),
                ],
            ],
            10,
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(num_field(&merged[0], &["search_rank"]), 30.0);
    }

    #[test]
    fn predictive_merge_accumulates_source_scores() {
        let source_results = vec![
            (
                "name".to_owned(),
                vec![serde_json::json!({
                    "card_id": 7, "name": "Pikachu", "search_rank": 100.0,
                    "predicted_name_confidence": 90.0,
                    "predicted_name": {"normalized": "pikachu"},
                    "predictive_dimension_match_count": 1,
                })],
            ),
            (
                "expansion".to_owned(),
                vec![serde_json::json!({
                    "card_id": 7, "name": "Pikachu", "search_rank": 40.0,
                })],
            ),
        ];
        let merged = merge_predictive_pool_rows(&source_results, "pikachu", 100);
        assert_eq!(merged.len(), 1);
        let flags = source_flags_for(&merged[0]);
        assert!(flags.contains(&"name".to_owned()));
        assert!(flags.contains(&"expansion".to_owned()));
        assert!(num_field(&merged[0], &["search_rank"]) > 700_000.0);
    }

    #[test]
    fn shard_plan_covers_all_buckets() {
        let plan = one_character_prefix_shard_plan(
            "p",
            &["name_search".to_owned(), "variation_search".to_owned()],
        );
        assert_eq!(plan.len(), 2);
        let buckets: Vec<usize> = plan
            .iter()
            .flat_map(|shard| shard.buckets.clone())
            .collect();
        assert_eq!(buckets, vec![0, 2, 4, 1, 3]); // round robin over 2 shards
        assert!(plan[0].label.contains("pa-pg"));
        // the round robin puts the non_alpha bucket on the first shard
        assert!(plan[0].label.contains("+numeric"));
        assert!(one_character_prefix_shard_plan("pi", &[]).is_empty());
    }

    #[test]
    fn predicted_confidence_bands() {
        assert_eq!(
            supabase_predicted_name_confidence(&json!({"compact_name": "pika"}), "pika"),
            100.0
        );
        assert_eq!(
            supabase_predicted_name_confidence(&json!({"compact_name": "pikach"}), "pika"),
            94.0
        ); // 96 - 2
           // an equal name token scores 100; a token merely starting with the
           // query scores 84
        assert_eq!(
            supabase_predicted_name_confidence(
                &json!({"compact_name": "x", "name_tokens": ["pika"]}),
                "pika"
            ),
            100.0
        );
        assert_eq!(
            supabase_predicted_name_confidence(
                &json!({"compact_name": "x", "name_tokens": ["pikachu"]}),
                "pika"
            ),
            84.0
        );
    }

    #[test]
    fn normalize_predictions_dedupes_by_token() {
        let rows = vec![
            json!({
                "compact_name": "pika", "display_name": "Pika", "canonical_name": "Pika",
                "name_tokens": ["pika"], "card_ids": ["1", "2"], "row_count": 4,
                "search_weight": 300, "language": "en",
            }),
            json!({
                "compact_name": "pika", "display_name": "Pika", "canonical_name": "Pika",
                "name_tokens": ["pika"], "card_ids": ["2", "3"], "row_count": 2,
                "search_weight": 500, "language": "en",
            }),
        ];
        let predictions = normalize_prediction_rows(&rows, "pika", "en", 20);
        assert_eq!(predictions.len(), 1);
        assert_eq!(predictions[0]["normalized"], "pika");
        assert_eq!(predictions[0]["source_rank"], 1.0);
        assert!(predictions[0]["confidence"].as_f64().unwrap() > 100.0 - 0.001);
        let ids = card_ids_from_name_token_row(&predictions[0], 64);
        assert_eq!(ids, vec!["1", "2", "3"]);
    }

    fn token_row(name: &str, score: f64) -> Value {
        json!({
            "compact_name": compact(name), "display_name": name, "canonical_name": name,
            "name_tokens": [compact(name)], "confidence": 90, "score": score, "language": "en",
        })
    }

    #[test]
    fn prefix_family_cycle_keeps_prefix_first() {
        // Old comparator: pika < pikachu (prefix family), pikachu < psyduck and
        // psyduck < pika (score) — a cycle, so the order was undefined.
        let rows = vec![
            token_row("Pika", 10.0),
            token_row("Pikachu", 100.0),
            token_row("Psyduck", 50.0),
        ];
        let names: Vec<String> = normalize_prediction_rows(&rows, "p", "en", 20)
            .iter()
            .map(|p| str_field(p, &["normalized"]))
            .collect();
        assert_eq!(names, vec!["pika", "pikachu", "psyduck"]);
    }

    #[test]
    fn first_char_warmup_rows_sort_without_panicking() {
        // The REST first-char warmup sorts up to 500 unordered rows for one
        // letter; prefix families plus unrelated scores tripped the sort's
        // total-order check on the Pi about once an hour.
        let stems = [
            "pi",
            "pika",
            "pikachu",
            "pikachuex",
            "pid",
            "pidge",
            "pidgey",
            "pidgeotto",
            "po",
            "pon",
            "ponyta",
        ];
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut rows = Vec::new();
        for i in 0..500 {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let stem = stems[(seed >> 33) as usize % stems.len()];
            let name = if i % 3 == 0 {
                stem.to_owned()
            } else {
                format!("{stem}{}", (b'a' + (i % 26) as u8) as char)
            };
            rows.push(token_row(&name, ((seed >> 40) % 1000) as f64 + 1.0));
        }
        let predictions = normalize_prediction_rows(&rows, "p", "en", 500);
        let tokens: Vec<String> = predictions
            .iter()
            .map(|p| str_field(p, &["normalized"]))
            .collect();
        let confidence: Vec<f64> = predictions
            .iter()
            .map(|p| num_field(p, &["confidence"]))
            .collect();
        for (child, token) in tokens.iter().enumerate() {
            for (parent, prefix) in tokens.iter().enumerate() {
                if prefix != token
                    && token.starts_with(prefix.as_str())
                    && confidence[parent] >= confidence[child]
                {
                    assert!(parent < child, "{prefix} should precede {token}");
                }
            }
        }
    }

    #[test]
    fn nan_sorts_last_in_a_total_order() {
        let mut values = vec![3.0, f64::NAN, 1.0, f64::NAN, 2.0];
        values.sort_by(|a, b| cmp_f64_nan_last(*a, *b, true));
        assert_eq!(&values[..3], &[3.0, 2.0, 1.0]);
        assert!(values[3].is_nan() && values[4].is_nan());
    }

    #[test]
    fn fuzzy_name_token_rows_keep_near_prefixes() {
        let rows = vec![json!({"compact_name": "pikachu", "name_tokens": ["pikachu"]})];
        let kept = supabase_rest_fuzzy_name_token_rows(&rows, "pikachy");
        assert_eq!(kept.len(), 1);
        let dropped = supabase_rest_fuzzy_name_token_rows(&rows, "squir");
        assert!(dropped.is_empty());
    }
}
