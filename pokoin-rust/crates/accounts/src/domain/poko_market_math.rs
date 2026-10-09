//! Poko market analytics — the pure decision layer of `poko-market.js`.
//!
//! This is the part every one of the fifteen tools shares: condition and
//! language normalisation, the sold-slice maths (unit-weighted percentiles over
//! `cardtrader_sold_daily` day slices), the variant snap-back, the liquidity
//! bands, the sell-price ladder, live-ask summarisation and the deal verdict.
//! It is pure over plain JSON rows, so all of it is unit-tested without a
//! database; the SQL and the service-token plumbing live in
//! [`crate::handlers::poko_market`].

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value as Json};

/// PKN per EUR, used for every `…Eur` figure the tools emit.
pub const PKN_EUR_RATE: f64 = 0.005;
pub const MAX_COLLECTION_CARDS: usize = 500;
/// If the weights pipeline stalls, quote bands from fresh sold data instead.
pub const FRESH_WEIGHTS_MAX_AGE_DAYS: f64 = 3.0;
pub const SOLD_ROWS_LIMIT: i64 = 3000;
/// Cap one day-slice's weight so a bulk lot cannot drown every other sale.
pub const MAX_UNITS_PER_ROW: usize = 50;
pub const DEAL_MIN_COMPS: i64 = 2;
pub const FLUCTUATION_PCT: i64 = 15;
pub const MOVERS_MIN_PRICE_PKN: f64 = 400.0;
pub const MOVERS_MAX_CANDIDATES: i64 = 300;
pub const TOP_SELLERS_MAX_SOLD_TO_ASK: f64 = 20.0;
pub const SOLD_REFERENCE_ASK_DAYS: i64 = 180;
pub const SOLD_UNVERIFIED_MAX_PKN: f64 = 200_000.0;
pub const SOLD_HIGH_VALUE_PKN: f64 = 100_000.0;
pub const SOLD_HIGH_VALUE_MAX_TO_ASK: f64 = 3.0;
pub const RECENT_SALE_VERIFY_RATIO: f64 = 3.0;

/// The CardTrader condition scale (`cardtrader_sold_daily`, schema 042).
pub const CONDITIONS: [&str; 5] = ["NM", "SP", "MP", "PL", "Poor"];
/// The language codes the sold table's normalizer accepts.
pub const LANGUAGES: [&str; 14] = [
    "EN", "IT", "FR", "DE", "ES", "JP", "PT", "NL", "PL", "RU", "KO", "ZH", "ZHT", "ID",
];

const DAY_MS: f64 = 86_400_000.0;

// ---------------------------------------------------------------------------
// Small JavaScript-shaped helpers
// ---------------------------------------------------------------------------

fn js_string(value: Option<&Json>) -> String {
    match value {
        None | Some(Json::Null) => String::new(),
        Some(Json::String(text)) => text.clone(),
        Some(Json::Number(number)) => number.to_string(),
        Some(Json::Bool(flag)) => flag.to_string(),
        Some(other) => other.to_string(),
    }
}

fn field_string(row: &Json, key: &str) -> String {
    js_string(row.get(key))
}

/// `row.a ?? row.b` — the first key that is not null or missing.
fn nullish_string(row: &Json, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = row.get(*key) {
            if !value.is_null() {
                return js_string(Some(value));
            }
        }
    }
    String::new()
}

/// `Number(value)` — `None` where JavaScript gives `NaN`.
pub fn js_number(value: Option<&Json>) -> Option<f64> {
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

fn field_number(row: &Json, key: &str) -> Option<f64> {
    js_number(row.get(key))
}

/// `Number(row[key]) || 0`.
fn number_or_zero(row: &Json, key: &str) -> f64 {
    field_number(row, key)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn field_bool(row: &Json, keys: &[&str]) -> bool {
    for key in keys {
        if let Some(value) = row.get(*key) {
            if let Some(flag) = value.as_bool() {
                return flag;
            }
        }
    }
    false
}

/// `cleanText(value, max)` — collapse runs of whitespace, trim, then slice.
pub fn clean_text(value: &str, max: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max).collect()
}

/// `escapeLike(value)` — escape the LIKE metacharacters.
pub fn escape_like(value: &str) -> String {
    let cleaned = clean_text(value, 120);
    let mut out = String::with_capacity(cleaned.len());
    for character in cleaned.chars() {
        if matches!(character, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

/// `fuzzyArtistPattern(value)` — a subsequence pattern over `[a-z0-9]` only.
pub fn fuzzy_artist_pattern(value: &str) -> String {
    let cleaned: String = clean_text(value, 60)
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if cleaned.is_empty() {
        return String::new();
    }
    let joined = cleaned
        .chars()
        .map(|character| character.to_string())
        .collect::<Vec<_>>()
        .join("%");
    format!("%{joined}%")
}

/// `round2(value)` — `None` where JavaScript gives a non-finite number.
pub fn round2_or_none(value: f64) -> Option<f64> {
    if !value.is_finite() {
        None
    } else {
        Some((value * 100.0).round() / 100.0)
    }
}

/// `round2(value)` with a number already known to be finite.
pub fn round2(value: f64) -> f64 {
    round2_or_none(value).unwrap_or(0.0)
}

/// A JS number renders without a decimal point when integral.
pub fn js_num(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `todayIso()` for a millisecond clock.
pub fn today_iso(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// `daysAgoIso(days)`.
pub fn days_ago_iso(now_ms: i64, days: i64) -> String {
    today_iso(now_ms - days * 86_400_000)
}

/// `weightsAreFresh(updatedAt)`.
pub fn weights_are_fresh(updated_at: &str, now_ms: i64) -> bool {
    let Some(at) = parse_iso_millis(updated_at) else {
        return false;
    };
    (now_ms - at) as f64 / DAY_MS <= FRESH_WEIGHTS_MAX_AGE_DAYS
}

/// The millisecond value of an ISO timestamp, as `new Date(value).getTime()`.
pub fn parse_iso_millis(value: &str) -> Option<i64> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
        .or_else(|| {
            // Postgres timestamps arrive without a zone; treat them as UTC.
            chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|naive| naive.and_utc().timestamp_millis())
        })
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|naive| naive.and_utc().timestamp_millis())
        })
}

// ---------------------------------------------------------------------------
// Condition / language normalisation
// ---------------------------------------------------------------------------

fn condition_map() -> &'static [(Regex, &'static str)] {
    static MAP: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    MAP.get_or_init(|| {
        [
            (r"(?i)^(nm|near[ -]?mint|mint|pretty clean|mint condition)$", "NM"),
            (r"(?i)^(sp|slightly[ -]?played|lightly[ -]?played|light play)$", "SP"),
            (r"(?i)^(mp|played|moderately[ -]?played|moderate play)$", "MP"),
            (r"(?i)^(pl|heavily[ -]?played|well[ -]?played|hp|quite played)$", "PL"),
            (
                r"(?i)^(poor|damaged|very[ -]?damaged|really[ -]?damaged|badly[ -]?damaged)$",
                "Poor",
            ),
        ]
        .into_iter()
        .map(|(pattern, code)| (Regex::new(pattern).expect("condition regex"), code))
        .collect()
    })
}

fn vague_condition_res() -> &'static [Regex] {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        [
            r"(?i)a bit (damaged|played|worn)",
            r"(?i)a little (damaged|played|worn)",
            r"(?i)some wear",
            r"(?i)slight(ly)? (wear|damage)",
            r"(?i)un po' (roviniata|usata)",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("vague regex"))
        .collect()
    })
}

fn language_map() -> &'static [(Regex, &'static str)] {
    static MAP: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    MAP.get_or_init(|| {
        [
            (r"(?i)^(en|english|inglese)$", "EN"),
            (r"(?i)^(it|italian|italiano)$", "IT"),
            (r"(?i)^(fr|french|francese)$", "FR"),
            (r"(?i)^(de|german|tedesco)$", "DE"),
            (r"(?i)^(es|spanish|spagnolo)$", "ES"),
            (r"(?i)^(jp|ja|japanese|giapponese)$", "JP"),
            (r"(?i)^(pt|portuguese|portoghese)$", "PT"),
            (r"(?i)^(nl|dutch|olandese)$", "NL"),
            (r"(?i)^(pl|polish|polacco)$", "PL"),
            (r"(?i)^(ru|russian|russo)$", "RU"),
            (r"(?i)^(ko|korean|coreano)$", "KO"),
            (r"(?i)^(zh|chinese|cinese)$", "ZH"),
            (r"(?i)^(zht|traditional chinese|cinese tradizionale)$", "ZHT"),
            (r"(?i)^(id|indonesian|indonesiano)$", "ID"),
        ]
        .into_iter()
        .map(|(pattern, code)| (Regex::new(pattern).expect("language regex"), code))
        .collect()
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionGuess {
    pub primary: &'static str,
    pub alternatives: Vec<&'static str>,
    pub vague: bool,
    pub matched: bool,
}

impl ConditionGuess {
    pub fn to_json(&self) -> Json {
        json!({
            "primary": self.primary,
            "alternatives": self.alternatives,
            "vague": self.vague,
            "matched": self.matched,
        })
    }
}

/// `normalizeCondition(value)` — a vague wear phrase becomes a range, never NM.
pub fn normalize_condition(value: &str) -> ConditionGuess {
    let text = clean_text(value, 60);
    if text.is_empty() {
        return ConditionGuess {
            primary: "NM",
            alternatives: Vec::new(),
            vague: false,
            matched: false,
        };
    }
    for (pattern, code) in condition_map() {
        if pattern.is_match(&text) {
            return ConditionGuess {
                primary: code,
                alternatives: Vec::new(),
                vague: false,
                matched: true,
            };
        }
    }
    if vague_condition_res().iter().any(|pattern| pattern.is_match(&text)) {
        return ConditionGuess {
            primary: "MP",
            alternatives: vec!["PL", "Poor"],
            vague: true,
            matched: true,
        };
    }
    ConditionGuess {
        primary: "NM",
        alternatives: Vec::new(),
        vague: false,
        matched: false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanguageGuess {
    pub code: &'static str,
    pub matched: bool,
}

impl LanguageGuess {
    pub fn to_json(&self) -> Json {
        json!({ "code": self.code, "matched": self.matched })
    }
}

/// `normalizeLanguage(value)`.
pub fn normalize_language(value: &str) -> LanguageGuess {
    let text = clean_text(value, 40);
    if text.is_empty() {
        return LanguageGuess {
            code: "EN",
            matched: false,
        };
    }
    for (pattern, code) in language_map() {
        if pattern.is_match(&text) {
            return LanguageGuess {
                code,
                matched: true,
            };
        }
    }
    let upper = text.to_ascii_uppercase();
    match LANGUAGES.iter().find(|code| **code == upper) {
        Some(code) => LanguageGuess {
            code,
            matched: true,
        },
        None => LanguageGuess {
            code: "EN",
            matched: false,
        },
    }
}

// ---------------------------------------------------------------------------
// Catalog rows
// ---------------------------------------------------------------------------

/// `blueprintIdFromCatalogRow(row)` — only an explicit catalog blueprint id.
pub fn blueprint_id_from_catalog_row(row: &Json) -> Option<i64> {
    let id = js_string(row.get("ct_id"));
    if id.is_empty() {
        return None;
    }
    if !id.bytes().all(|byte| byte.is_ascii_digit()) || id.starts_with('0') {
        return None;
    }
    match id.parse::<i64>() {
        Ok(number) if number > 0 && number <= 9_007_199_254_740_991 => Some(number),
        _ => None,
    }
}

/// `confidenceForSample(sampleSize)`.
pub fn confidence_for_sample(sample_size: f64) -> &'static str {
    if !sample_size.is_finite() || sample_size <= 0.0 {
        return "none";
    }
    if sample_size >= 10.0 {
        return "high";
    }
    if sample_size >= 4.0 {
        return "medium";
    }
    "low"
}

/// `candidateFromRow(row)`.
pub fn candidate_from_row(row: &Json) -> Json {
    let card_id = js_string(row.get("card_id"));
    let path = if card_id.is_empty() {
        String::new()
    } else {
        format!("/marketplace/en/cards/{card_id}")
    };
    let version = if row.get("version").map(|value| !value.is_null()).unwrap_or(false) {
        js_string(row.get("version"))
    } else {
        String::new()
    };
    json!({
        "cardId": card_id,
        "blueprintId": blueprint_id_from_catalog_row(row),
        "name": field_string(row, "name"),
        "setName": field_string(row, "set_name"),
        "cardNumber": field_string(row, "card_number"),
        "artist": field_string(row, "artist"),
        "itemKind": field_string(row, "item_kind"),
        "version": version,
        "path": path,
        "canonicalPath": path,
    })
}

/// `dedupeArtworkVersions(rows)` — one printing per CLIP same-artwork group.
pub fn dedupe_artwork_versions(rows: &[Json]) -> Vec<Json> {
    let mut out: Vec<Json> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for row in rows {
        let version = field_string(row, "version").trim().to_string();
        let key = if !version.is_empty() {
            version
        } else {
            let id = nullish_string(row, &["card_id", "cardId"]);
            if id.is_empty() {
                format!("id:{}", out.len())
            } else {
                format!("id:{id}")
            }
        };
        if !seen.insert(key) {
            continue;
        }
        out.push(row.clone());
    }
    out
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

fn filler_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(hi|hello|hey|please|can|could|tell|me|do|does|did|you|know|i|im|i have|have|has|got|how|much|what|whats|worth|price|prices|priced|cost|costs|value|valued|values|market|sell|selling|sold|sale|buy|buying|for|about|around|roughly|approximately|near|mint|lightly|slightly|played|moderately|heavily|damaged|poor|condition|in|on|of|the|a|an|is|are|was|were|it|its|this|that|and|or|english|italian|french|german|spanish|japanese|from|with|any|some|one|copy|copies|right|now|currently|today|it is|its)\b",
        )
        .expect("filler regex")
    })
}

/// The words a token-AND card search must ignore.
pub fn stopwords() -> &'static HashSet<&'static str> {
    static WORDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| {
        [
            "the", "a", "an", "of", "from", "old", "in", "on", "for", "and", "or", "is", "are",
            "was", "it", "its", "this", "that", "my", "your", "have", "has", "how", "much",
            "what", "worth", "price", "cost", "value", "sell", "sold", "near", "mint", "played",
            "damaged", "condition", "english", "italian", "japanese",
        ]
        .into_iter()
        .collect()
    })
}

/// `queryVariants(rawQuery)` — the cleaned phrase first, then the raw one.
pub fn query_variants(raw_query: &str) -> Vec<String> {
    let text = clean_text(raw_query, 120);
    if text.is_empty() {
        return Vec::new();
    }
    let mut variants: Vec<String> = Vec::new();
    let punct = Regex::new(r"[,.!?;:()]+").expect("punctuation regex");
    let spaced = Regex::new(r"\s+").expect("spaces regex");
    let cleaned = spaced
        .replace_all(
            &filler_regex().replace_all(&punct.replace_all(&text, " "), " "),
            " ",
        )
        .trim()
        .to_string();
    if cleaned.chars().count() >= 4 {
        variants.push(cleaned.clone());
    }
    if text != cleaned && text.chars().count() >= 4 {
        variants.push(text);
    }
    variants.truncate(3);
    variants
}

/// `stripAskingPrices(value)` — seller asking prices are not part of the card.
pub fn strip_asking_prices(value: &str) -> String {
    static PRICE_RE: OnceLock<Regex> = OnceLock::new();
    static SYMBOL_RE: OnceLock<Regex> = OnceLock::new();
    let price_re = PRICE_RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b\d+(?:[.,]\d+)?(?:\s+[A-Za-z]{2,16}){0,2}\s*(?:kr|dkk|kroner|eur|euro|euros|usd|dollars?|pkn)\b",
        )
        .expect("price regex")
    });
    let symbol_re = SYMBOL_RE
        .get_or_init(|| Regex::new(r"(?:€|\$)\s*\d+(?:[.,]\d+)?").expect("symbol regex"));
    let first = price_re.replace_all(value, " ");
    symbol_re.replace_all(&first, " ").to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParentheticalSet {
    pub code: String,
    pub number: String,
    pub raw: String,
    pub index: usize,
}

/// `singleParentheticalSet(value)` — exactly one `(CODE rest)` group.
pub fn single_parenthetical_set(value: &str) -> Option<ParentheticalSet> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\(\s*([A-Za-z0-9]{2,8})\b([^)]*)\)").expect("parenthetical regex")
    });
    let matches: Vec<_> = re.captures_iter(value).collect();
    if matches.len() != 1 {
        return None;
    }
    let captures = &matches[0];
    let whole = captures.get(0)?;
    let code = captures.get(1)?.as_str().to_string();
    let number = captures
        .get(2)
        .map(|group| {
            group
                .as_str()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    Some(ParentheticalSet {
        code,
        number,
        raw: whole.as_str().to_string(),
        index: whole.start(),
    })
}

/// `digitSetCode(value)` — a single short token with both letters and digits.
pub fn digit_set_code(value: &str) -> String {
    let lowered = value.to_ascii_lowercase();
    let mut seen: Vec<String> = Vec::new();
    for token in lowered.split(|character: char| !character.is_ascii_alphanumeric()) {
        if token.is_empty() {
            continue;
        }
        let length = token.chars().count();
        let has_letter = token.chars().any(|character| character.is_ascii_alphabetic());
        let has_digit = token.chars().any(|character| character.is_ascii_digit());
        if (2..=8).contains(&length) && has_letter && has_digit && !seen.iter().any(|seen| seen == token)
        {
            seen.push(token.to_string());
        }
    }
    if seen.len() == 1 {
        seen.remove(0)
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Sold slices
// ---------------------------------------------------------------------------

/// `soldFlag(value)` — `Some(false)` is an explicit "standard copy".
pub fn sold_flag(value: Option<&Json>) -> Option<bool> {
    match value? {
        Json::Bool(flag) => Some(*flag),
        other => {
            let text = clean_text(&js_string(Some(other)), 40).to_ascii_lowercase();
            if text.is_empty() {
                return None;
            }
            const TRUE_WORDS: [&str; 13] = [
                "1", "true", "yes", "y", "si", "sì", "on", "reverse", "reverse holo", "graded",
                "slab", "first", "1st",
            ];
            const FALSE_WORDS: [&str; 9] = [
                "0", "false", "no", "n", "off", "standard", "unlimited", "raw", "ungraded",
            ];
            let extra_true = ["1st edition", "first edition", "prima edizione"];
            let extra_false = ["normal"];
            if TRUE_WORDS.contains(&text.as_str()) || extra_true.contains(&text.as_str()) {
                return Some(true);
            }
            if FALSE_WORDS.contains(&text.as_str()) || extra_false.contains(&text.as_str()) {
                return Some(false);
            }
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facet {
    pub reverse: bool,
    pub first_edition: bool,
    pub graded: bool,
    pub explicit: bool,
}

/// `soldFacetFromParams(params)` — unstated flags mean a standard copy.
pub fn sold_facet_from_params(params: &Json) -> Facet {
    let reverse = sold_flag(params.get("reverse"));
    let first_edition = sold_flag(
        params
            .get("firstEdition")
            .or_else(|| params.get("first_edition"))
            .or_else(|| params.get("edition")),
    );
    let graded = sold_flag(params.get("graded"));
    Facet {
        reverse: reverse.unwrap_or(false),
        first_edition: first_edition.unwrap_or(false),
        graded: graded.unwrap_or(false),
        explicit: reverse.is_some() || first_edition.is_some() || graded.is_some(),
    }
}

/// `facetKey(row)`.
pub fn facet_key(row: &Json) -> String {
    format!(
        "{}|{}|{}",
        field_bool(row, &["reverse"]),
        field_bool(row, &["first_edition", "firstEdition"]),
        field_bool(row, &["graded"])
    )
}

/// `facetLabel(facet)`.
pub fn facet_label(facet: Facet) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if facet.first_edition {
        parts.push("1st Edition");
    }
    if facet.reverse {
        parts.push("Reverse Holo");
    }
    if facet.graded {
        parts.push("Graded");
    }
    if parts.is_empty() {
        "Standard (unlimited, non-reverse, ungraded)".to_string()
    } else {
        parts.join(" + ")
    }
}

/// `rowMatchesFacet(row, facet)`.
pub fn row_matches_facet(row: &Json, facet: Facet) -> bool {
    field_bool(row, &["reverse"]) == facet.reverse
        && field_bool(row, &["first_edition", "firstEdition"]) == facet.first_edition
        && field_bool(row, &["graded"]) == facet.graded
}

/// `rowMatchesSlice(row, {facet, condition, language})`.
pub fn row_matches_slice(
    row: &Json,
    facet: Option<Facet>,
    condition: Option<&str>,
    language: Option<&str>,
) -> bool {
    if let Some(facet) = facet {
        if !row_matches_facet(row, facet) {
            return false;
        }
    }
    if let Some(condition) = condition {
        if field_string(row, "condition") != condition {
            return false;
        }
    }
    if let Some(language) = language {
        if field_string(row, "language").to_ascii_uppercase() != language {
            return false;
        }
    }
    true
}

/// `dayOf(value)` — the first ten characters, or nothing.
pub fn day_of(value: Option<&Json>) -> Option<String> {
    let text = match value? {
        Json::Null => return None,
        Json::String(text) => text.clone(),
        other => js_string(Some(other)),
    };
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(10).collect())
}

/// `percentileOf(sorted, p)` — linear interpolation, `None` when empty.
pub fn percentile_of(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let pos = (sorted.len() as f64 - 1.0) * p;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    let lo_value = sorted[lo.min(sorted.len() - 1)];
    let hi_value = sorted[hi.min(sorted.len() - 1)];
    Some(lo_value + (hi_value - lo_value) * (pos - lo as f64))
}

#[derive(Debug, Clone, PartialEq)]
pub struct SoldStats {
    pub sold_qty: i64,
    pub sale_days: usize,
    pub median: Option<f64>,
    pub p25: Option<f64>,
    pub p75: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub last_sale_day: Option<String>,
}

/// `soldStats(rows)` — unit-weighted over day-slice rows.
pub fn sold_stats(rows: &[Json]) -> Option<SoldStats> {
    let mut prices: Vec<f64> = Vec::new();
    let mut sold_qty = 0i64;
    let mut min_pkn = f64::INFINITY;
    let mut max_pkn = 0.0f64;
    let mut last_sale_day: Option<String> = None;
    let mut days: HashSet<String> = HashSet::new();

    for row in rows {
        let qty = number_or_zero(row, "sold_qty").trunc().max(0.0) as i64;
        let median = field_number(row, "median_pkn")
            .filter(|value| value.is_finite())
            .unwrap_or(f64::NAN);
        if qty <= 0 || !(median > 0.0) {
            continue;
        }
        sold_qty += qty;
        for _ in 0..(qty as usize).min(MAX_UNITS_PER_ROW) {
            prices.push(median);
        }
        let row_min = field_number(row, "min_pkn").unwrap_or(0.0);
        min_pkn = min_pkn.min(if row_min > 0.0 { row_min } else { median });
        let row_max = field_number(row, "max_pkn").unwrap_or(0.0);
        max_pkn = max_pkn.max(if row_max > 0.0 { row_max } else { median });
        if let Some(day) = day_of(row.get("observed_day")) {
            if last_sale_day.as_deref().map(|current| day > current.to_string()).unwrap_or(true) {
                last_sale_day = Some(day.clone());
            }
            days.insert(day);
        }
    }
    if sold_qty == 0 {
        return None;
    }
    prices.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(SoldStats {
        sold_qty,
        sale_days: days.len(),
        median: round2_or_none(percentile_of(&prices, 0.5).unwrap_or(0.0)),
        p25: round2_or_none(percentile_of(&prices, 0.25).unwrap_or(0.0)),
        p75: round2_or_none(percentile_of(&prices, 0.75).unwrap_or(0.0)),
        min: round2_or_none(min_pkn),
        max: round2_or_none(max_pkn),
        last_sale_day,
    })
}

/// `soldEstimateFromStats(stats, basis)`.
pub fn sold_estimate_from_stats(stats: Option<&SoldStats>, basis: &str) -> Option<Json> {
    let stats = stats?;
    let median = stats.median?;
    Some(json!({
        "currency": "PKN",
        "pknEurRate": PKN_EUR_RATE,
        "median": stats.median.map(js_num),
        "medianEur": round2_or_none(median * PKN_EUR_RATE).map(js_num),
        "p25": stats.p25.map(js_num),
        "p75": stats.p75.map(js_num),
        "low": stats.min.map(js_num),
        "high": stats.max.map(js_num),
        "sampleSize": stats.sold_qty,
        "saleDays": stats.sale_days,
        "lastSaleDay": stats.last_sale_day,
        "basis": basis,
        "methodology": "unit-weighted median of CardTrader inferred sales (cardtrader_sold_daily), same variant only",
        "confidence": confidence_for_sample(stats.sold_qty as f64),
    }))
}

/// `resolveFacet(rows, params)` — snap to the most-sold variant when the
/// requested one never sold and the caller did not state a flag.
pub fn resolve_facet(rows: &[Json], params: &Json) -> (Facet, bool) {
    let facet = sold_facet_from_params(params);
    let matched = rows.iter().any(|row| row_matches_facet(row, facet));
    if matched || facet.explicit || rows.is_empty() {
        return (facet, false);
    }
    let mut order: Vec<String> = Vec::new();
    let mut units: HashMap<String, f64> = HashMap::new();
    for row in rows {
        let key = facet_key(row);
        *units.entry(key.clone()).or_insert(0.0) += number_or_zero(row, "sold_qty");
        if !order.contains(&key) {
            order.push(key);
        }
    }
    let best = order
        .iter()
        .max_by(|a, b| {
            let left = units.get(*a).copied().unwrap_or(0.0);
            let right = units.get(*b).copied().unwrap_or(0.0);
            // `max_by` keeps the LAST on ties, so compare reversed and keep the
            // first-seen key for equal unit counts.
            right
                .partial_cmp(&left)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    let left_index = order.iter().position(|key| key == *a).unwrap_or(0);
                    let right_index = order.iter().position(|key| key == *b).unwrap_or(0);
                    right_index.cmp(&left_index)
                })
        })
        .cloned()
        .unwrap_or_default();
    let parts: Vec<bool> = best.split('|').map(|part| part == "true").collect();
    (
        Facet {
            reverse: parts.first().copied().unwrap_or(false),
            first_edition: parts.get(1).copied().unwrap_or(false),
            graded: parts.get(2).copied().unwrap_or(false),
            explicit: false,
        },
        true,
    )
}

/// `variantsSold(rows)` — every variant slice, most sold first.
pub fn variants_sold(rows: &[Json]) -> Vec<Json> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Json>> = HashMap::new();
    for row in rows {
        let key = facet_key(row);
        if !order.contains(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(row.clone());
    }
    let mut out: Vec<Json> = order
        .iter()
        .map(|key| {
            let parts: Vec<bool> = key.split('|').map(|part| part == "true").collect();
            let reverse = parts.first().copied().unwrap_or(false);
            let first_edition = parts.get(1).copied().unwrap_or(false);
            let graded = parts.get(2).copied().unwrap_or(false);
            let stats = sold_stats(&groups[key]);
            json!({
                "variant": facet_label(Facet { reverse, first_edition, graded, explicit: false }),
                "reverse": reverse,
                "firstEdition": first_edition,
                "graded": graded,
                "soldQty": stats.as_ref().map(|stats| stats.sold_qty).unwrap_or(0),
                "medianPkn": stats.as_ref().and_then(|stats| stats.median).map(js_num),
                "lastSaleDay": stats.as_ref().and_then(|stats| stats.last_sale_day.clone()),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        let left = a.get("soldQty").and_then(Json::as_i64).unwrap_or(0);
        let right = b.get("soldQty").and_then(Json::as_i64).unwrap_or(0);
        right.cmp(&left)
    });
    out
}

/// `soldByConditionLanguage(rows, limit)`.
pub fn sold_by_condition_language(rows: &[Json], limit: usize) -> Vec<Json> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Json>> = HashMap::new();
    for row in rows {
        let key = format!(
            "{}|{}",
            field_string(row, "condition"),
            field_string(row, "language").to_ascii_uppercase()
        );
        if !order.contains(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(row.clone());
    }
    let mut out: Vec<Json> = order
        .iter()
        .map(|key| {
            let mut parts = key.split('|');
            let condition = parts.next().unwrap_or("").to_string();
            let language = parts.next().unwrap_or("").to_string();
            let stats = sold_stats(&groups[key]);
            json!({
                "condition": condition,
                "language": language,
                "soldQty": stats.as_ref().map(|stats| stats.sold_qty).unwrap_or(0),
                "medianPkn": stats.as_ref().and_then(|stats| stats.median).map(js_num),
                "lowPkn": stats.as_ref().and_then(|stats| stats.min).map(js_num),
                "highPkn": stats.as_ref().and_then(|stats| stats.max).map(js_num),
                "lastSaleDay": stats.as_ref().and_then(|stats| stats.last_sale_day.clone()),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        let left = a.get("soldQty").and_then(Json::as_i64).unwrap_or(0);
        let right = b.get("soldQty").and_then(Json::as_i64).unwrap_or(0);
        right.cmp(&left)
    });
    out.truncate(limit);
    out
}

// ---------------------------------------------------------------------------
// Liquidity, bands and the price ladder
// ---------------------------------------------------------------------------

/// `liquidityBands({daysOfSupply, soldQty7d, listedNow})`.
pub fn liquidity_bands(
    days_of_supply: Option<&Json>,
    sold_qty_7d: Option<&Json>,
    listed_now: Option<&Json>,
) -> Option<Json> {
    let days = js_number(days_of_supply).unwrap_or(f64::NAN);
    if days.is_finite() && days > 0.0 {
        return Some(json!({
            "lowDays": js_num((days * 0.4).round().max(1.0)),
            "typicalDays": js_num(days.round()),
            "highDays": js_num((days * 2.5).round()),
            "methodology": "days_of_supply from marketplace_card_weights",
            "confidence": "medium",
        }));
    }
    let sold = js_number(sold_qty_7d).unwrap_or(f64::NAN);
    let listed = js_number(listed_now).unwrap_or(f64::NAN);
    if sold.is_finite() && sold > 0.0 && listed.is_finite() && listed > 0.0 {
        let typical = (listed / sold * 7.0).round();
        return Some(json!({
            "lowDays": js_num((typical * 0.4).round().max(1.0)),
            "typicalDays": js_num(typical),
            "highDays": js_num((typical * 2.5).round()),
            "methodology": "sell-through: active supply ÷ sold_qty_7d",
            "confidence": "low",
        }));
    }
    None
}

/// `timeRange(fromDays, toDays)`.
pub fn time_range(from_days: f64, to_days: f64) -> String {
    let from = from_days.round().max(1.0);
    let to = to_days.round().max(from);
    if to <= 21.0 {
        format!("{}-{}d", from as i64, to as i64)
    } else {
        format!(
            "{}-{}w",
            (from / 7.0).round().max(1.0) as i64,
            (to / 7.0).round().max(1.0) as i64
        )
    }
}

/// `priceStrategies(summary, asks, liquidity)`.
pub fn price_strategies(
    summary: Option<&Json>,
    asks: Option<&Json>,
    liquidity: Option<&Json>,
) -> Option<Json> {
    let summary = summary?;
    let confidence = summary.get("confidence").and_then(Json::as_str).unwrap_or("");
    if confidence == "none" || confidence == "low" {
        return None;
    }
    let median = summary.get("median").and_then(Json::as_f64);
    let p25 = summary.get("p25").and_then(Json::as_f64);
    let p75 = summary.get("p75").and_then(Json::as_f64);
    let min_ask = asks.and_then(|asks| asks.get("min")).and_then(Json::as_f64);

    let fallback = p25.or(median);
    let quick = match (min_ask, fallback) {
        (Some(min_ask), Some(base)) => base.min(min_ask * 0.95),
        (Some(min_ask), None) => min_ask * 0.95,
        (None, Some(base)) => base,
        (None, None) => return None,
    };
    let low = liquidity
        .and_then(|value| value.get("lowDays"))
        .and_then(Json::as_f64)
        .unwrap_or(f64::NAN);
    let typical = liquidity
        .and_then(|value| value.get("typicalDays"))
        .and_then(Json::as_f64)
        .unwrap_or(f64::NAN);
    let high = liquidity
        .and_then(|value| value.get("highDays"))
        .and_then(Json::as_f64)
        .unwrap_or(f64::NAN);
    let banded = low > 0.0 && typical > 0.0 && high > 0.0;
    Some(json!({
        "quickSale": {
            "price": round2_or_none(quick).map(js_num),
            "expectedTime": if banded { time_range(low, typical) } else { "1-7d".to_string() },
        },
        "market": {
            "price": median.map(js_num),
            "expectedTime": if banded { time_range(typical, high) } else { "1-3w".to_string() },
        },
        "patient": {
            "price": p75.or(median).map(js_num),
            "expectedTime": if banded { time_range(high, high * 2.0) } else { "2-8w".to_string() },
        },
        "expectedTimeBasis": if banded { "card liquidity bands" } else { "generic estimate (no liquidity data for this card)" },
    }))
}

/// `buildSoldSummary(row)` — the weights rollup row.
pub fn build_sold_summary(row: Option<&Json>) -> Option<Json> {
    let row = row?;
    let sold_qty = field_number(row, "sold_qty").unwrap_or(0.0);
    if !(sold_qty > 0.0) {
        return None;
    }
    let last_sale_day = row
        .get("last_sale_day")
        .map(|value| js_string(Some(value)))
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(10).collect::<String>());
    Some(json!({
        "currency": "PKN",
        "pknEurRate": PKN_EUR_RATE,
        "median": round2_or_none(field_number(row, "median_daily").unwrap_or(f64::NAN)).map(js_num),
        "p25": round2_or_none(field_number(row, "p25_daily").unwrap_or(f64::NAN)).map(js_num),
        "p75": round2_or_none(field_number(row, "p75_daily").unwrap_or(f64::NAN)).map(js_num),
        "sampleSize": js_num(sold_qty),
        "lastSaleDay": last_sale_day,
        "methodology": "median of daily sold medians (cardtrader_sold_daily, sanitized inferred sales)",
        "confidence": confidence_for_sample(sold_qty),
    }))
}

// ---------------------------------------------------------------------------
// Live asks
// ---------------------------------------------------------------------------

/// `summarizeLiveAsks(groups)`.
pub fn summarize_live_asks(groups: &[Json]) -> Option<Json> {
    if groups.is_empty() {
        return None;
    }
    let mut min = f64::INFINITY;
    let mut listings = 0i64;
    let mut copies = 0i64;
    let mut medians: Vec<f64> = Vec::new();
    for group in groups {
        let group_min = group.get("minPkn").and_then(Json::as_f64).unwrap_or(0.0);
        min = min.min(group_min);
        let group_listings = group.get("listings").and_then(Json::as_i64).unwrap_or(0);
        listings += group_listings;
        copies += group.get("copies").and_then(Json::as_i64).unwrap_or(0);
        let median = group.get("medianPkn").and_then(Json::as_f64).unwrap_or(0.0);
        for _ in 0..(group_listings as usize).min(MAX_UNITS_PER_ROW) {
            medians.push(median);
        }
    }
    medians.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(json!({
        "min": round2_or_none(min).map(js_num),
        "minEur": round2_or_none(min * PKN_EUR_RATE).map(js_num),
        "median": round2_or_none(percentile_of(&medians, 0.5).unwrap_or(0.0)).map(js_num),
        "listings": listings,
        "copies": copies,
        "currency": "PKN",
        "pknEurRate": PKN_EUR_RATE,
        "basis": "live CardTrader listings, same variant (and condition/language when given)",
        "note": "asking price, not a confirmed sale",
    }))
}

/// `dealVerdict(ask, soldMedian)`.
pub fn deal_verdict(ask: f64, sold_median: f64) -> Option<Json> {
    if !(ask > 0.0) || !(sold_median > 0.0) {
        return None;
    }
    let ratio = ask / sold_median;
    if ratio < 0.35 {
        return Some(json!({
            "verdict": "far_below_sold_median",
            "ratio": round2_or_none(ratio).map(js_num),
            "caution": "Ask is far below recorded sales; those comps may be delisted high asks. Check the listing before calling it a bargain.",
        }));
    }
    if ratio <= 0.8 {
        return Some(json!({ "verdict": "below_sold_median", "ratio": round2_or_none(ratio).map(js_num) }));
    }
    if ratio <= 1.2 {
        return Some(json!({ "verdict": "in_line_with_sales", "ratio": round2_or_none(ratio).map(js_num) }));
    }
    Some(json!({ "verdict": "above_sold_median", "ratio": round2_or_none(ratio).map(js_num) }))
}

/// `askHistoryFromSource(source, days)`.
pub fn ask_history_from_source(source: Option<&Json>, days: i64) -> Json {
    let series: Vec<Json> = source
        .and_then(|source| source.get("days"))
        .and_then(Json::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    json!({
                        "day": row.get("day").cloned().unwrap_or(Json::Null),
                        "min": row.get("lowestAskPkn").cloned().unwrap_or(Json::Null),
                        "sourceTimestamp": row.get("sourceTimestamp").cloned().unwrap_or(Json::Null),
                        "dumpDay": row.get("dumpDay").cloned().unwrap_or(Json::Null),
                    })
                })
                .filter(|row| {
                    row.get("min").and_then(Json::as_f64).unwrap_or(0.0) > 0.0
                })
                .collect()
        })
        .unwrap_or_default();

    let mut fluctuations: Vec<Json> = Vec::new();
    for index in 1..series.len() {
        let previous = series[index - 1]
            .get("min")
            .and_then(Json::as_f64)
            .unwrap_or(0.0);
        let current = series[index].get("min").and_then(Json::as_f64).unwrap_or(0.0);
        if previous == 0.0 {
            continue;
        }
        let change_pct = (((current - previous) / previous) * 100.0).round();
        if change_pct.abs() >= FLUCTUATION_PCT as f64 {
            fluctuations.push(json!({
                "fromDay": series[index - 1].get("day").cloned().unwrap_or(Json::Null),
                "toDay": series[index].get("day").cloned().unwrap_or(Json::Null),
                "from": js_num(previous),
                "to": js_num(current),
                "changePct": js_num(change_pct),
            }));
        }
    }
    let mut trend = "stable";
    if series.len() >= 2 {
        let first = series[0].get("min").and_then(Json::as_f64).unwrap_or(0.0);
        let last = series[series.len() - 1]
            .get("min")
            .and_then(Json::as_f64)
            .unwrap_or(0.0);
        if first != 0.0 {
            let moved = (last - first) / first * 100.0;
            if moved >= 10.0 {
                trend = "rising";
            } else if moved <= -10.0 {
                trend = "falling";
            }
        }
    }
    json!({
        "days": days,
        "series": series,
        "fluctuations": fluctuations,
        "trend": trend,
        "metric": "lowestAsk",
        "source": "cardtrader_listed",
    })
}

/// `requireCard`/`resolveCard` status codes: a not-found or ambiguous match is a
/// 422, a missing argument a 400.
pub fn resolve_status_code(status: &str) -> u16 {
    if status == "invalid" {
        400
    } else {
        422
    }
}

/// Keep the `Map` import meaningful for the JSON builders above.
#[allow(dead_code)]
fn _json_map(entries: Vec<(String, Json)>) -> Json {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Json::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_helpers_match_the_node_shapes() {
        assert_eq!(clean_text("  a   b\tc  ", 200), "a b c");
        assert_eq!(clean_text("abcdef", 3), "abc");
        assert_eq!(clean_text("", 10), "");
        assert_eq!(escape_like("50%_a\\b"), "50\\%\\_a\\\\b");
        assert_eq!(fuzzy_artist_pattern("Yukamori"), "%y%u%k%a%m%o%r%i%");
        assert_eq!(fuzzy_artist_pattern("Yuka mori!"), "%y%u%k%a%m%o%r%i%");
        assert_eq!(fuzzy_artist_pattern("!!!"), "");
        assert_eq!(round2(1.005), 1.0);
        assert_eq!(round2(2.345), 2.35);
        assert_eq!(round2_or_none(f64::NAN), None);
        assert_eq!(js_num(25.0), json!(25));
        assert_eq!(js_num(12.5), json!(12.5));
    }

    #[test]
    fn iso_helpers_and_weight_freshness() {
        let now = 1_791_417_600_000i64;
        assert_eq!(today_iso(now), "2026-10-08");
        assert_eq!(days_ago_iso(now, 7), "2026-10-01");
        assert!(weights_are_fresh("2026-10-07T00:00:00Z", now));
        assert!(weights_are_fresh("2026-10-05T00:00:00Z", now));
        assert!(!weights_are_fresh("2026-09-30T00:00:00Z", now));
        assert!(!weights_are_fresh("nonsense", now));
        assert!(!weights_are_fresh("", now));
        // Postgres timestamps without a zone are read as UTC.
        assert_eq!(
            parse_iso_millis("2026-10-08 00:00:00"),
            Some(1_791_417_600_000)
        );
    }

    #[test]
    fn conditions_normalize_and_vague_wear_becomes_a_range() {
        for (input, expected) in [
            ("NM", "NM"),
            ("near mint", "NM"),
            ("Mint Condition", "NM"),
            ("pretty clean", "NM"),
            ("SP", "SP"),
            ("lightly played", "SP"),
            ("light play", "SP"),
            ("mp", "MP"),
            ("moderate play", "MP"),
            ("PL", "PL"),
            ("hp", "PL"),
            ("well played", "PL"),
            ("poor", "Poor"),
            ("badly damaged", "Poor"),
        ] {
            let guess = normalize_condition(input);
            assert_eq!(guess.primary, expected, "{input}");
            assert!(guess.matched, "{input}");
            assert!(!guess.vague, "{input}");
        }
        // Vague wear is MP with a range, never NM.
        for input in ["a bit damaged", "some wear", "slight wear", "un po' usata"] {
            let guess = normalize_condition(input);
            assert_eq!(guess.primary, "MP", "{input}");
            assert_eq!(guess.alternatives, vec!["PL", "Poor"], "{input}");
            assert!(guess.vague, "{input}");
        }
        // Anything unrecognised is an unmatched NM, empty input an unmatched NM.
        let guess = normalize_condition("banana");
        assert_eq!(guess.primary, "NM");
        assert!(!guess.matched);
        let guess = normalize_condition("");
        assert_eq!(guess.primary, "NM");
        assert!(!guess.matched);
        assert!(!guess.vague);
    }

    #[test]
    fn languages_normalize_with_a_letter_fallback() {
        for (input, expected) in [
            ("en", "EN"),
            ("English", "EN"),
            ("inglese", "EN"),
            ("it", "IT"),
            ("italiano", "IT"),
            ("ja", "JP"),
            ("Japanese", "JP"),
            ("zht", "ZHT"),
            ("cinese tradizionale", "ZHT"),
            ("id", "ID"),
        ] {
            let guess = normalize_language(input);
            assert_eq!(guess.code, expected, "{input}");
            assert!(guess.matched, "{input}");
        }
        // A raw table code is accepted as-is.
        let guess = normalize_language("zht");
        assert!(guess.matched);
        // Empty or unknown falls back to EN, unmatched.
        let guess = normalize_language("");
        assert_eq!(guess.code, "EN");
        assert!(!guess.matched);
        let guess = normalize_language("klingon");
        assert_eq!(guess.code, "EN");
        assert!(!guess.matched);
    }

    #[test]
    fn blueprint_ids_need_an_explicit_positive_ct_id() {
        assert_eq!(blueprint_id_from_catalog_row(&json!({ "ct_id": 109873 })), Some(109873));
        assert_eq!(blueprint_id_from_catalog_row(&json!({ "ct_id": "42" })), Some(42));
        // Zero, negatives, decimals and junk are not a blueprint.
        assert_eq!(blueprint_id_from_catalog_row(&json!({ "ct_id": 0 })), None);
        assert_eq!(blueprint_id_from_catalog_row(&json!({ "ct_id": "007" })), None);
        assert_eq!(blueprint_id_from_catalog_row(&json!({ "ct_id": -1 })), None);
        assert_eq!(blueprint_id_from_catalog_row(&json!({ "ct_id": "1.5" })), None);
        assert_eq!(blueprint_id_from_catalog_row(&json!({ "ct_id": "" })), None);
        assert_eq!(blueprint_id_from_catalog_row(&json!({})), None);
    }

    #[test]
    fn confidence_bands() {
        assert_eq!(confidence_for_sample(0.0), "none");
        assert_eq!(confidence_for_sample(f64::NAN), "none");
        assert_eq!(confidence_for_sample(1.0), "low");
        assert_eq!(confidence_for_sample(3.0), "low");
        assert_eq!(confidence_for_sample(4.0), "medium");
        assert_eq!(confidence_for_sample(9.0), "medium");
        assert_eq!(confidence_for_sample(10.0), "high");
    }

    #[test]
    fn candidates_and_dedupe() {
        let row = json!({
            "card_id": 4242, "ct_id": 2121, "name": "Pikachu", "set_name": "Base",
            "card_number": "58/102", "artist": "Mitsuhiro Arita", "item_kind": "single",
            "version": 7
        });
        let candidate = candidate_from_row(&row);
        assert_eq!(candidate["cardId"], json!("4242"));
        assert_eq!(candidate["blueprintId"], json!(2121));
        assert_eq!(candidate["canonicalPath"], json!("/marketplace/en/cards/4242"));
        assert_eq!(candidate["version"], json!("7"));
        let candidate = candidate_from_row(&json!({ "card_id": "" }));
        assert_eq!(candidate["cardId"], json!(""));
        assert_eq!(candidate["path"], json!(""));
        assert_eq!(candidate["blueprintId"], Json::Null);

        // Same artwork collapses; different versions stay.
        let rows = vec![
            json!({ "card_id": 1, "version": "v1" }),
            json!({ "card_id": 2, "version": "v1" }),
            json!({ "card_id": 3, "version": "v2" }),
            json!({ "card_id": 4 }),
            json!({ "card_id": 4 }),
            json!({ "card_id": 5 }),
        ];
        let deduped = dedupe_artwork_versions(&rows);
        // v1, v2, id:4, id:5 — the repeated version and card_id collapse.
        assert_eq!(deduped.len(), 4);
        assert_eq!(deduped[0]["card_id"], json!(1));
        assert_eq!(deduped[1]["card_id"], json!(3));
        assert_eq!(deduped[2]["card_id"], json!(4));
        assert_eq!(deduped[3]["card_id"], json!(5));
    }

    #[test]
    fn query_variants_drop_chatter_but_keep_the_raw_phrase() {
        let variants = query_variants("how much is Rocky Helmet Boundaries Crossed secret rare 153/149?");
        assert_eq!(variants.len(), 2);
        assert!(variants[0].starts_with("Rocky Helmet Boundaries Crossed secret rare 153/149"));
        assert!(variants[1].starts_with("how much is"));
        // ex/gx/v are part of real names and are deliberately kept.
        let variants = query_variants("claydol ex ex power keepers");
        assert!(variants[0].contains("claydol ex ex power keepers"));
        // Too short after cleaning: only the raw variant, and only if long enough.
        assert!(query_variants("hi").is_empty());
        assert_eq!(query_variants("").len(), 0);
    }

    #[test]
    fn asking_prices_are_stripped_from_seller_lines() {
        assert_eq!(strip_asking_prices("Solgaleo 70kr").trim(), "Solgaleo");
        assert_eq!(strip_asking_prices("Solgaleo 70 Danish kroner").trim(), "Solgaleo");
        assert_eq!(strip_asking_prices("Pikachu 12.50 eur").trim(), "Pikachu");
        assert_eq!(strip_asking_prices("Pikachu €12,50").trim(), "Pikachu");
        assert_eq!(strip_asking_prices("Pikachu $9").trim(), "Pikachu");
        // A collector number has no currency word and stays.
        assert_eq!(strip_asking_prices("Solgaleo GX (30C SUM 89)").trim(), "Solgaleo GX (30C SUM 89)");
    }

    #[test]
    fn parenthetical_sets_and_digit_codes() {
        let paren = single_parenthetical_set("Solgaleo GX (30C SUM 89)").unwrap();
        assert_eq!(paren.code, "30C");
        assert_eq!(paren.number, "SUM 89");
        assert_eq!(paren.raw, "(30C SUM 89)");
        assert_eq!(paren.index, 12);
        // Exactly one group is required.
        assert!(single_parenthetical_set("Lycanroc (30C 138) (SUM 1)").is_none());
        assert!(single_parenthetical_set("Lycanroc 30C 138").is_none());
        // The code must be 2-8 alphanumerics.
        assert!(single_parenthetical_set("X (A 1)").is_none());

        assert_eq!(digit_set_code("Lycanroc 30C 138"), "30c");
        // Letter-only aliases stay in the query.
        assert_eq!(digit_set_code("Lycanroc SUM 138"), "");
        assert_eq!(digit_set_code("Lycanroc ex 138"), "");
        // Two candidate codes are ambiguous.
        assert_eq!(digit_set_code("Lycanroc 30C 12a"), "");
    }

    #[test]
    fn sold_flags_accept_the_documented_vocabulary() {
        assert_eq!(sold_flag(Some(&json!(true))), Some(true));
        assert_eq!(sold_flag(Some(&json!(false))), Some(false));
        for word in ["1", "true", "yes", "y", "si", "sì", "on", "reverse", "reverse holo", "graded", "slab", "first", "1st", "1st edition", "prima edizione"] {
            assert_eq!(sold_flag(Some(&json!(word))), Some(true), "{word}");
        }
        for word in ["0", "false", "no", "n", "off", "standard", "unlimited", "raw", "ungraded", "normal"] {
            assert_eq!(sold_flag(Some(&json!(word))), Some(false), "{word}");
        }
        assert_eq!(sold_flag(Some(&json!("maybe"))), None);
        assert_eq!(sold_flag(Some(&json!(""))), None);
        assert_eq!(sold_flag(None), None);
    }

    #[test]
    fn facets_default_to_standard_and_label_themselves() {
        let facet = sold_facet_from_params(&json!({}));
        assert_eq!(facet, Facet { reverse: false, first_edition: false, graded: false, explicit: false });
        assert_eq!(facet_label(facet), "Standard (unlimited, non-reverse, ungraded)");

        let facet = sold_facet_from_params(&json!({ "reverse": "yes" }));
        assert!(facet.reverse);
        assert!(facet.explicit);
        assert_eq!(facet_label(facet), "Reverse Holo");

        let facet = sold_facet_from_params(&json!({
            "firstEdition": "1st", "reverse": true, "graded": "slab"
        }));
        assert_eq!(facet_label(facet), "1st Edition + Reverse Holo + Graded");

        // The snake_case aliases work too.
        let facet = sold_facet_from_params(&json!({ "first_edition": "yes" }));
        assert!(facet.first_edition);
        let facet = sold_facet_from_params(&json!({ "edition": "1st edition" }));
        assert!(facet.first_edition);
    }

    #[test]
    fn facet_keys_and_row_matching() {
        let row = json!({ "reverse": true, "first_edition": false, "graded": false });
        assert_eq!(facet_key(&row), "true|false|false");
        assert!(row_matches_facet(&row, Facet { reverse: true, first_edition: false, graded: false, explicit: false }));
        assert!(!row_matches_facet(&row, Facet { reverse: false, first_edition: false, graded: false, explicit: false }));
        // The camelCase spelling is honoured.
        let row = json!({ "reverse": false, "firstEdition": true, "graded": false });
        assert_eq!(facet_key(&row), "false|true|false");

        let row = json!({ "condition": "SP", "language": "it", "reverse": false });
        let facet = Facet { reverse: false, first_edition: false, graded: false, explicit: false };
        assert!(row_matches_slice(&row, Some(facet), Some("SP"), Some("IT")));
        assert!(!row_matches_slice(&row, Some(facet), Some("NM"), None));
        assert!(!row_matches_slice(&row, Some(facet), None, Some("EN")));
        // No filters at all matches everything.
        assert!(row_matches_slice(&row, None, None, None));
    }

    #[test]
    fn percentiles_interpolate_like_the_node_helper() {
        assert_eq!(percentile_of(&[], 0.5), None);
        assert_eq!(percentile_of(&[5.0], 0.5), Some(5.0));
        let sorted = vec![10.0, 20.0, 30.0, 40.0];
        assert_eq!(percentile_of(&sorted, 0.0), Some(10.0));
        assert_eq!(percentile_of(&sorted, 0.5), Some(25.0));
        assert_eq!(percentile_of(&sorted, 0.25), Some(17.5));
        assert_eq!(percentile_of(&sorted, 1.0), Some(40.0));
    }

    fn sold_row(day: &str, qty: i64, median: f64) -> Json {
        json!({
            "observed_day": day, "condition": "NM", "language": "EN",
            "reverse": false, "first_edition": false, "graded": false,
            "sold_qty": qty, "median_pkn": median, "min_pkn": median * 0.8, "max_pkn": median * 1.2
        })
    }

    #[test]
    fn sold_stats_are_unit_weighted_and_capped_per_row() {
        assert!(sold_stats(&[]).is_none());
        // Rows without quantity or price are ignored.
        assert!(sold_stats(&[json!({ "sold_qty": 0, "median_pkn": 10 })]).is_none());
        assert!(sold_stats(&[json!({ "sold_qty": 2, "median_pkn": 0 })]).is_none());

        let rows = vec![
            sold_row("2026-10-01", 2, 100.0),
            sold_row("2026-10-03", 3, 200.0),
        ];
        let stats = sold_stats(&rows).unwrap();
        assert_eq!(stats.sold_qty, 5);
        assert_eq!(stats.sale_days, 2);
        assert_eq!(stats.median, Some(200.0));
        assert_eq!(stats.p25, Some(100.0));
        assert_eq!(stats.min, Some(80.0));
        assert_eq!(stats.max, Some(240.0));
        assert_eq!(stats.last_sale_day.as_deref(), Some("2026-10-03"));

        // One bulk row cannot dominate: the weight is capped at 50 units.
        let rows = vec![
            sold_row("2026-10-01", 500, 10.0),
            sold_row("2026-10-02", 1, 1000.0),
        ];
        let stats = sold_stats(&rows).unwrap();
        assert_eq!(stats.sold_qty, 501);
        // 50 copies of 10 and one of 1000 -> the median is 10.
        assert_eq!(stats.median, Some(10.0));

        // A missing min/max falls back to the median.
        let rows = vec![json!({
            "sold_qty": 1, "median_pkn": 50, "observed_day": "2026-10-01"
        })];
        let stats = sold_stats(&rows).unwrap();
        assert_eq!(stats.min, Some(50.0));
        assert_eq!(stats.max, Some(50.0));
    }

    #[test]
    fn sold_estimates_carry_the_documented_fields() {
        let stats = sold_stats(&[sold_row("2026-10-01", 12, 100.0)]).unwrap();
        let estimate = sold_estimate_from_stats(Some(&stats), "Standard (unlimited, non-reverse, ungraded)").unwrap();
        assert_eq!(estimate["currency"], json!("PKN"));
        assert_eq!(estimate["pknEurRate"], json!(0.005));
        assert_eq!(estimate["median"], json!(100));
        assert_eq!(estimate["medianEur"], json!(0.5));
        assert_eq!(estimate["sampleSize"], json!(12));
        assert_eq!(estimate["saleDays"], json!(1));
        assert_eq!(estimate["lastSaleDay"], json!("2026-10-01"));
        assert_eq!(estimate["confidence"], json!("high"));
        assert!(estimate["methodology"].as_str().unwrap().contains("cardtrader_sold_daily"));
        assert!(sold_estimate_from_stats(None, "x").is_none());
    }

    #[test]
    fn resolve_facet_snaps_to_the_most_sold_variant() {
        let reversals = vec![
            json!({ "reverse": true, "sold_qty": 5, "median_pkn": 100 }),
            json!({ "reverse": true, "sold_qty": 4, "median_pkn": 90 }),
        ];
        // The requested standard slice never sold, and no flag was stated.
        let (facet, snapped) = resolve_facet(&reversals, &json!({}));
        assert!(snapped);
        assert!(facet.reverse);
        assert!(!facet.explicit);

        // An explicit flag is respected even when nothing matched.
        let (facet, snapped) = resolve_facet(&reversals, &json!({ "reverse": "no" }));
        assert!(!snapped);
        assert!(!facet.reverse);
        assert!(facet.explicit);

        // When the requested slice does exist nothing snaps.
        let rows = vec![
            json!({ "reverse": false, "sold_qty": 1, "median_pkn": 10 }),
            json!({ "reverse": true, "sold_qty": 9, "median_pkn": 20 }),
        ];
        let (facet, snapped) = resolve_facet(&rows, &json!({}));
        assert!(!snapped);
        assert!(!facet.reverse);

        // Empty rows never snap.
        let (_, snapped) = resolve_facet(&[], &json!({}));
        assert!(!snapped);
    }

    #[test]
    fn variant_and_condition_breakdowns_sort_by_units() {
        let rows = vec![
            sold_row("2026-10-01", 1, 100.0),
            json!({ "observed_day": "2026-10-02", "condition": "NM", "language": "EN",
                    "reverse": true, "sold_qty": 9, "median_pkn": 300 }),
            json!({ "observed_day": "2026-10-02", "condition": "SP", "language": "IT",
                    "sold_qty": 4, "median_pkn": 200, "min_pkn": 160, "max_pkn": 240 }),
        ];
        let variants = variants_sold(&rows);
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0]["variant"], json!("Reverse Holo"));
        assert_eq!(variants[0]["soldQty"], json!(9));
        assert_eq!(variants[0]["medianPkn"], json!(300));
        assert_eq!(variants[1]["variant"], json!("Standard (unlimited, non-reverse, ungraded)"));
        assert_eq!(variants[1]["soldQty"], json!(5));

        let by_condition = sold_by_condition_language(&rows, 10);
        assert_eq!(by_condition[0]["condition"], json!("NM"));
        assert_eq!(by_condition[0]["soldQty"], json!(10));
        assert_eq!(by_condition[1]["condition"], json!("SP"));
        assert_eq!(by_condition[1]["language"], json!("IT"));
        assert_eq!(by_condition[1]["lowPkn"], json!(160));
        assert_eq!(by_condition[1]["highPkn"], json!(240));
        // The limit truncates.
        assert_eq!(sold_by_condition_language(&rows, 1).len(), 1);
    }

    #[test]
    fn liquidity_bands_prefer_weights_then_sell_through() {
        // days_of_supply wins and is medium confidence.
        let bands = liquidity_bands(Some(&json!(10)), Some(&json!(1)), Some(&json!(5))).unwrap();
        assert_eq!(bands["lowDays"], json!(4));
        assert_eq!(bands["typicalDays"], json!(10));
        assert_eq!(bands["highDays"], json!(25));
        assert_eq!(bands["confidence"], json!("medium"));
        assert!(bands["methodology"].as_str().unwrap().contains("marketplace_card_weights"));

        // Without weights the sell-through heuristic applies: 20 listed / 2 sold
        // per week -> 70 days.
        let bands = liquidity_bands(Some(&json!(0)), Some(&json!(2)), Some(&json!(20))).unwrap();
        assert_eq!(bands["typicalDays"], json!(70));
        assert_eq!(bands["lowDays"], json!(28));
        assert_eq!(bands["highDays"], json!(175));
        assert_eq!(bands["confidence"], json!("low"));
        assert!(bands["methodology"].as_str().unwrap().contains("sell-through"));

        // Nothing usable.
        assert!(liquidity_bands(None, None, None).is_none());
        assert!(liquidity_bands(Some(&json!(0)), Some(&json!(0)), Some(&json!(5))).is_none());
        assert!(liquidity_bands(Some(&json!("abc")), Some(&json!(2)), Some(&json!(0))).is_none());
        // A single low band is clamped to one day.
        let bands = liquidity_bands(Some(&json!(1)), None, None).unwrap();
        assert_eq!(bands["lowDays"], json!(1));
        assert_eq!(bands["highDays"], json!(3));
    }

    #[test]
    fn time_ranges_switch_to_weeks_past_three() {
        assert_eq!(time_range(1.0, 3.0), "1-3d");
        assert_eq!(time_range(3.0, 8.0), "3-8d");
        assert_eq!(time_range(5.0, 21.0), "5-21d");
        assert_eq!(time_range(5.0, 22.0), "1-3w");
        assert_eq!(time_range(14.0, 42.0), "2-6w");
        assert_eq!(time_range(0.0, 0.0), "1-1d");
    }

    #[test]
    fn the_price_ladder_uses_card_liquidity_when_known() {
        let summary = json!({ "median": 100, "p25": 80, "p75": 150, "confidence": "high" });
        let liquidity = json!({ "lowDays": 3, "typicalDays": 8, "highDays": 20 });

        // With an ask below the p25 the quick price is 95% of the ask.
        let asks = json!({ "min": 50 });
        let ladder = price_strategies(Some(&summary), Some(&asks), Some(&liquidity)).unwrap();
        assert_eq!(ladder["quickSale"]["price"], json!(47.5));
        assert_eq!(ladder["quickSale"]["expectedTime"], json!("3-8d"));
        assert_eq!(ladder["market"]["price"], json!(100));
        assert_eq!(ladder["market"]["expectedTime"], json!("8-20d"));
        assert_eq!(ladder["patient"]["price"], json!(150));
        // Past 21 days the label switches to weeks: 20d -> 40d is 3-6w.
        assert_eq!(ladder["patient"]["expectedTime"], json!("3-6w"));
        assert_eq!(ladder["expectedTimeBasis"], json!("card liquidity bands"));

        // Without liquidity the generic labels come back.
        let ladder = price_strategies(Some(&summary), None, None).unwrap();
        assert_eq!(ladder["quickSale"]["price"], json!(80));
        assert_eq!(ladder["quickSale"]["expectedTime"], json!("1-7d"));
        assert_eq!(ladder["market"]["expectedTime"], json!("1-3w"));
        assert_eq!(ladder["patient"]["expectedTime"], json!("2-8w"));
        assert_eq!(
            ladder["expectedTimeBasis"],
            json!("generic estimate (no liquidity data for this card)")
        );

        // Low or absent confidence has no ladder at all.
        for confidence in ["low", "none"] {
            let summary = json!({ "median": 100, "confidence": confidence });
            assert!(price_strategies(Some(&summary), None, None).is_none());
        }
        assert!(price_strategies(None, None, None).is_none());
    }

    #[test]
    fn sold_summaries_roll_up_a_weights_row() {
        let row = json!({
            "sold_qty": 5, "median_daily": 100.5, "p25_daily": 80.25,
            "p75_daily": 150.75, "last_sale_day": "2026-10-01T00:00:00.000Z"
        });
        let summary = build_sold_summary(Some(&row)).unwrap();
        assert_eq!(summary["currency"], json!("PKN"));
        assert_eq!(summary["median"], json!(100.5));
        assert_eq!(summary["p25"], json!(80.25));
        assert_eq!(summary["p75"], json!(150.75));
        assert_eq!(summary["sampleSize"], json!(5));
        assert_eq!(summary["lastSaleDay"], json!("2026-10-01"));
        assert_eq!(summary["confidence"], json!("medium"));
        // No sales means no summary.
        assert!(build_sold_summary(Some(&json!({ "sold_qty": 0 }))).is_none());
        assert!(build_sold_summary(None).is_none());
    }

    #[test]
    fn live_asks_summarize_min_median_and_counts() {
        assert!(summarize_live_asks(&[]).is_none());
        let groups = vec![
            json!({ "minPkn": 100, "listings": 2, "copies": 3, "medianPkn": 120 }),
            json!({ "minPkn": 80, "listings": 1, "copies": 2, "medianPkn": 200 }),
        ];
        let summary = summarize_live_asks(&groups).unwrap();
        assert_eq!(summary["min"], json!(80));
        assert_eq!(summary["minEur"], json!(0.4));
        assert_eq!(summary["listings"], json!(3));
        assert_eq!(summary["copies"], json!(5));
        // Medians are weighted by listing count: [120, 120, 200] -> 120.
        assert_eq!(summary["median"], json!(120));
        assert_eq!(summary["currency"], json!("PKN"));
        assert_eq!(summary["note"], json!("asking price, not a confirmed sale"));
    }

    #[test]
    fn deal_verdicts_cover_every_band() {
        assert!(deal_verdict(0.0, 100.0).is_none());
        assert!(deal_verdict(100.0, 0.0).is_none());
        // Far below: the caution is the point.
        let verdict = deal_verdict(30.0, 100.0).unwrap();
        assert_eq!(verdict["verdict"], json!("far_below_sold_median"));
        assert_eq!(verdict["ratio"], json!(0.3));
        assert!(verdict["caution"].as_str().unwrap().contains("delisted high asks"));
        // Exactly at the boundary is still "below".
        assert_eq!(deal_verdict(35.0, 100.0).unwrap()["verdict"], json!("below_sold_median"));
        assert_eq!(deal_verdict(80.0, 100.0).unwrap()["verdict"], json!("below_sold_median"));
        assert_eq!(deal_verdict(100.0, 100.0).unwrap()["verdict"], json!("in_line_with_sales"));
        assert_eq!(deal_verdict(120.0, 100.0).unwrap()["verdict"], json!("in_line_with_sales"));
        assert_eq!(deal_verdict(121.0, 100.0).unwrap()["verdict"], json!("above_sold_median"));
    }

    #[test]
    fn ask_history_reports_series_fluctuations_and_trend() {
        let source = json!({ "days": [
            { "day": "2026-10-01", "lowestAskPkn": 100 },
            { "day": "2026-10-02", "lowestAskPkn": 0 },
            { "day": "2026-10-03", "lowestAskPkn": 130 },
            { "day": "2026-10-04", "lowestAskPkn": 200 }
        ] });
        let history = ask_history_from_source(Some(&source), 14);
        assert_eq!(history["days"], json!(14));
        assert_eq!(history["metric"], json!("lowestAsk"));
        assert_eq!(history["source"], json!("cardtrader_listed"));
        // Zero-ask days are dropped.
        let series = history["series"].as_array().unwrap();
        assert_eq!(series.len(), 3);
        assert_eq!(series[0]["day"], json!("2026-10-01"));
        // 100 -> 130 is a 30% jump; 130 -> 200 is 53%.
        let fluctuations = history["fluctuations"].as_array().unwrap();
        assert_eq!(fluctuations.len(), 2);
        assert_eq!(fluctuations[0]["changePct"], json!(30));
        assert_eq!(fluctuations[0]["from"], json!(100));
        assert_eq!(fluctuations[0]["to"], json!(130));
        // 100 -> 200 is a rise.
        assert_eq!(history["trend"], json!("rising"));

        let falling = json!({ "days": [
            { "day": "2026-10-01", "lowestAskPkn": 100 },
            { "day": "2026-10-02", "lowestAskPkn": 80 }
        ] });
        let history = ask_history_from_source(Some(&falling), 14);
        assert_eq!(history["trend"], json!("falling"));
        assert_eq!(history["fluctuations"].as_array().unwrap().len(), 1);

        // A small move is stable and oscillation under the threshold is quiet.
        let stable = json!({ "days": [
            { "day": "2026-10-01", "lowestAskPkn": 100 },
            { "day": "2026-10-02", "lowestAskPkn": 105 }
        ] });
        let history = ask_history_from_source(Some(&stable), 7);
        assert_eq!(history["trend"], json!("stable"));
        assert_eq!(history["fluctuations"], json!([]));

        // A single day never trends, and no source is an empty series.
        let single = json!({ "days": [{ "day": "2026-10-01", "lowestAskPkn": 100 }] });
        assert_eq!(ask_history_from_source(Some(&single), 14)["trend"], json!("stable"));
        let empty = ask_history_from_source(None, 14);
        assert_eq!(empty["series"], json!([]));
        assert_eq!(empty["trend"], json!("stable"));
    }

    #[test]
    fn resolve_status_codes_map_like_require_card() {
        assert_eq!(resolve_status_code("invalid"), 400);
        assert_eq!(resolve_status_code("not_found"), 422);
        assert_eq!(resolve_status_code("ambiguous"), 422);
    }
}
