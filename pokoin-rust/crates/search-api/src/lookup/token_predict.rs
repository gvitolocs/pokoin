//! `GET|POST|OPTIONS /api/searchbar-token-predict` — port of `searchbar-token-predict.js`.
//!
//! Meilisearch is retired: the Node `meiliPredictedNameTokens` attempt always
//! fails over to the Supabase name-token index, so this port goes straight to
//! that index over Supabase REST.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures_util::{stream, StreamExt, TryStreamExt};
use pokoin_api_common::{http, RouteState};
use pokoin_catalog_api::shared::js;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::autocomplete::engine::{self, Ctx, EngineError};
use crate::autocomplete::normalize::{self, cmp_f64_nan_last, compact, locale_cmp};

const ENDPOINT: &str = "/api/searchbar-token-predict";
const DEFAULT_LIMIT: i64 = 5;
const MAX_LIMIT: i64 = 20;
const PREDICTION_CONTEXT_MAX_CANDIDATES: usize = 20;
const PUBLIC_PREDICTION_CANDIDATE_ID_LIMIT: usize = 24;
const PREDICTION_CONTEXT_CANDIDATE_ID_LIMIT: usize = 32;
const CONTEXT_WEAK_MATCH_CONFIDENCE: f64 = 75.0;
const PREDICTION_CONTEXT_TTL_MS: f64 = 60_000.0;
const FIRST_CHAR_PREDICTION_CACHE_TTL_MS: u64 = 5 * 60_000;
const FIRST_CHAR_WARMUP_CACHE_TTL_MS: u64 = 5 * 60_000;
/// A failed warmup answers from this cache instead of retrying every letter
/// for each visitor (the SPA sends the warmup on every home paint).
const FIRST_CHAR_WARMUP_FAILURE_TTL_MS: u64 = 30_000;
/// Bound on the whole warmup (26 REST lookups) so a slow index fails fast.
const FIRST_CHAR_WARMUP_TIMEOUT_MS: u64 = 8_000;
const WARMUP_LETTER_CONCURRENCY: usize = 6;
const DEFAULT_WARMUP_LIMIT: i64 = 1;
const MAX_WARMUP_LIMIT: i64 = 5;
const ANCHOR_MIN_CONFIDENCE: f64 = 60.0;
const ANCHOR_CACHE_MAX: usize = 20_000;
const CORS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, POST, OPTIONS"),
    ("access-control-allow-headers", "Content-Type, Authorization"),
    ("access-control-max-age", "86400"),
];
const MODIFIER_ONLY_ANCHOR_WORDS: [&str; 14] =
    ["ex", "v", "vmax", "vstar", "gx", "lvx", "lv", "mega", "break", "radiant", "shining", "shiny", "prime", "tagteam"];

struct AliasCompletion {
    display_token: &'static str,
    normalized_token: &'static str,
    alias: &'static str,
    prefixes: &'static [&'static str],
}

const EXPANSION_ALIAS_COMPLETIONS: [AliasCompletion; 4] = [
    AliasCompletion {
        display_token: "HeartGold & SoulSilver",
        normalized_token: "heartgoldsoulsilver",
        alias: "heartgold",
        prefixes: &["h", "he", "hea", "hear", "heart", "hearth", "heartg", "heartgo", "heartgol", "heartgold"],
    },
    AliasCompletion {
        display_token: "HeartGold & SoulSilver",
        normalized_token: "heartgoldsoulsilver",
        alias: "heart gold",
        prefixes: &["heart g", "heart go", "heart gol", "heart gold"],
    },
    AliasCompletion {
        display_token: "HeartGold & SoulSilver",
        normalized_token: "heartgoldsoulsilver",
        alias: "hearth gold",
        prefixes: &["hearth g", "hearth go", "hearth gol", "hearth gold"],
    },
    AliasCompletion { display_token: "HGSS", normalized_token: "hgss", alias: "hgss", prefixes: &["hg", "hgs", "hgss"] },
];

const WORD: &str = r"[A-Za-z0-9\x{C0}-\x{FF}][A-Za-z0-9\x{C0}-\x{FF}'’_.&()\[\]\-]*";
static WORD_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(WORD).unwrap());
static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"({WORD})\s*$")).unwrap());

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn num(value: Option<&Value>) -> f64 {
    if js::truthy(value) {
        let n = js::number(value);
        if n.is_nan() { f64::NAN } else { n }
    } else {
        0.0
    }
}

fn jn(n: f64) -> Value {
    js::js_json_number(n)
}

fn term(text: &str) -> String {
    normalize::clean_search_term(Some(&Value::String(text.to_owned())))
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn is_modifier(word: &str) -> bool {
    MODIFIER_ONLY_ANCHOR_WORDS.contains(&word)
}

/// `cleanLimit` of marketplace-search-candidates (`value ?? x` callers).
fn clean_limit_value(value: Option<&Value>) -> i64 {
    normalize::clean_limit(value)
}

fn nullish<'a>(source: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| source.get(*k)).find(|v| !v.is_null())
}

fn is_blank(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null)) || matches!(value, Some(Value::String(s)) if s.is_empty())
}

pub fn clean_token_predict_limit(value: Option<&Value>) -> i64 {
    let cleaned = if is_blank(value) { DEFAULT_LIMIT } else { clean_limit_value(value) };
    cleaned.clamp(1, MAX_LIMIT)
}

pub fn clean_warmup_limit(value: Option<&Value>) -> i64 {
    let cleaned = if is_blank(value) { DEFAULT_WARMUP_LIMIT } else { clean_limit_value(value) };
    cleaned.clamp(1, MAX_WARMUP_LIMIT)
}

fn debug_flag(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::String(s)) => s == "true" || s == "1",
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        _ => false,
    }
}

#[derive(Clone)]
pub struct Input {
    pub query: String,
    pub fragment: String,
    pub prediction_fragment: String,
    pub search_language: String,
    pub limit: i64,
    pub previous_prediction_context: Option<Value>,
    pub debug: bool,
}

fn parse_prediction_context(value: Option<&Value>) -> Option<Value> {
    if !js::truthy(value) {
        return None;
    }
    match value? {
        v @ Value::Object(_) => Some(v.clone()),
        Value::Array(_) => {
            // JSON.parse(String(array)) is never a plain object.
            None
        }
        other => serde_json::from_str::<Value>(&js::js_string(other)).ok().filter(Value::is_object),
    }
}

pub fn input_from_source(source: &Value) -> Input {
    let raw = nullish(source, &["fragment", "query", "search_term", "searchTerm", "current_token", "currentToken"]);
    let query = normalize::clean_search_term(raw);
    Input {
        fragment: trailing_token_fragment(&query),
        prediction_fragment: prediction_fragment_for_query(&query),
        search_language: normalize::clean_language(nullish(source, &["search_language", "language", "lang"])),
        limit: clean_token_predict_limit(nullish(source, &["limit", "result_limit", "resultLimit"])),
        previous_prediction_context: parse_prediction_context(nullish(
            source,
            &["previous_prediction_context", "previousPredictionContext", "prediction_context", "predictionContext"],
        )),
        debug: debug_flag(source.get("debug")),
        query,
    }
}

fn request_wants_warmup(source: &Value) -> bool {
    let mode_raw = [source.get("mode"), source.get("intent")].into_iter().flatten().find(|v| js::truthy(Some(v)));
    let mode = mode_raw.map(js::js_string).unwrap_or_default().trim().to_lowercase();
    let flag = |key: &str| match source.get(key) {
        Some(Value::Bool(true)) => true,
        Some(Value::String(s)) => s == "true" || s == "1",
        _ => false,
    };
    mode == "warmup" || mode == "first_char_warmup" || flag("warmup") || flag("first_char_warmup") || flag("firstCharWarmup")
}

pub fn trailing_token_fragment(value: &str) -> String {
    let text = term(value);
    match TRAILING.captures(&text).and_then(|c| c.get(1)) {
        Some(m) if !m.as_str().is_empty() => term(m.as_str()),
        _ => term(&text),
    }
}

fn query_words(value: &str) -> Vec<String> {
    WORD_PATTERN.find_iter(&term(value)).map(|m| m.as_str().to_owned()).collect()
}

fn is_anchor_prefix_candidate(words: &[String]) -> bool {
    if words.len() == 1 && is_modifier(&compact(&words[0])) {
        return false;
    }
    words.iter().all(|w| {
        let n = compact(w);
        !n.is_empty() && !is_digits(&n)
    })
}

fn is_modifier_only_trailing_words(words: &[String]) -> bool {
    !words.is_empty() && words.iter().all(|w| is_modifier(&compact(w)))
}

fn is_variation_prefix_trailing_words(words: &[String]) -> bool {
    !words.is_empty()
        && words.iter().all(|w| {
            let n = compact(w);
            if n.is_empty() {
                return false;
            }
            if n == "g" || n == "e" || is_modifier(&n) {
                return true;
            }
            n.len() >= 2 && MODIFIER_ONLY_ANCHOR_WORDS.iter().any(|m| m.starts_with(n.as_str()))
        })
}

pub fn prediction_fragment_for_query(value: &str) -> String {
    let text = term(value);
    let words = query_words(&text);
    if words.len() <= 1 {
        return trailing_token_fragment(&text);
    }
    let name_words: Vec<&String> = words.iter().filter(|w| !is_digits(w)).collect();
    if name_words.len() != words.len() || name_words.len() <= 1 {
        return trailing_token_fragment(&text);
    }
    term(&name_words.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" "))
}

#[derive(Clone)]
struct Anchor {
    display: Value,
    normalized: String,
    confidence: f64,
    trailing_words: Vec<String>,
    source: &'static str,
}

struct AliasPrediction {
    completion: &'static AliasCompletion,
    anchor: Value,
    fragment: String,
    normalized_fragment: String,
    confidence: f64,
}

fn anchored_alias_prediction_for_query(value: &str, anchor: Option<&Anchor>) -> Option<AliasPrediction> {
    let words = query_words(value);
    let anchor = anchor?;
    if words.len() < 2 {
        return None;
    }
    let trailing = anchor.trailing_words.clone();
    let mut length = trailing.len().min(2);
    while length >= 1 {
        let fragment = term(&trailing[..length].join(" "));
        let normalized_fragment = compact(&fragment);
        length -= 1;
        if normalized_fragment.is_empty() {
            continue;
        }
        let Some(completion) = EXPANSION_ALIAS_COMPLETIONS.iter().find(|e| e.prefixes.iter().any(|p| compact(p) == normalized_fragment)) else {
            continue;
        };
        let confidence = if normalized_fragment == compact(completion.alias) { 100.0 } else { 96.0 };
        return Some(AliasPrediction { completion, anchor: anchor.display.clone(), fragment, normalized_fragment, confidence });
    }
    None
}

fn prediction_from_expansion_alias(alias: Option<&AliasPrediction>) -> Option<Value> {
    let alias = alias?;
    let score = 600000.0 + alias.normalized_fragment.len() as f64 * 1000.0;
    Some(json!({
        "display_token": alias.completion.display_token,
        "display": alias.completion.display_token,
        "normalized_token": alias.completion.normalized_token,
        "normalized": alias.completion.normalized_token,
        "confidence": jn(alias.confidence),
        "score": jn(score),
        "source_rank": 1,
        "language": "en",
        "matched_prefix": alias.normalized_fragment,
        "card_count": 0,
        "ids_count": 0,
        "alias": alias.completion.alias,
        "anchor": alias.anchor,
        "source": "oracle_dimension_alias",
        "token_type": "dimension_alias",
        "dimension": "expansion",
    }))
}

fn prediction_fragment_alternates(value: &str, primary_fragment: &str) -> Vec<String> {
    let primary = term(primary_fragment);
    let words = query_words(value);
    if words.len() <= 1 {
        return Vec::new();
    }
    let mut alternates = Vec::new();
    let mut seen: HashSet<String> = HashSet::from([compact(&primary)]);
    let entries: Vec<String> = words.iter().map(|w| term(w)).filter(|w| !w.is_empty() && !is_digits(w)).collect();
    for start in entries.len().saturating_sub(2)..entries.len() {
        let fragment = term(&entries[start..].join(" "));
        let normalized = compact(&fragment);
        if normalized.is_empty() || seen.contains(&normalized) {
            continue;
        }
        seen.insert(normalized);
        alternates.push(fragment);
    }
    for word in entries.iter().rev() {
        let normalized = compact(word);
        if normalized.is_empty() || seen.contains(&normalized) {
            continue;
        }
        seen.insert(normalized);
        alternates.push(word.clone());
    }
    alternates.truncate(3);
    alternates
}

fn id_list(value: Option<&Value>) -> Option<&Vec<Value>> {
    value.and_then(Value::as_array)
}

fn candidate_card_ids_from_prediction(prediction: &Value, limit: usize) -> Vec<String> {
    let ids = id_list(prediction.get("candidate_card_ids"))
        .or_else(|| id_list(prediction.get("candidateCardIds")))
        .or_else(|| id_list(prediction.get("representative_card_ids")))
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in &ids {
        let id = js::string_or_empty(Some(raw)).trim().to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        out.push(id);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn str_or(prediction: &Value, keys: &[&str]) -> String {
    keys.iter().filter_map(|k| prediction.get(*k)).find(|v| js::truthy(Some(v))).map(js::js_string).unwrap_or_default()
}

fn count_chain(values: &[f64]) -> f64 {
    values.iter().copied().find(|v| *v != 0.0 && !v.is_nan()).unwrap_or(0.0)
}

fn public_prediction(prediction: &Value, fallback_fragment: &str) -> Value {
    let candidate_ids = candidate_card_ids_from_prediction(prediction, PUBLIC_PREDICTION_CANDIDATE_ID_LIMIT);
    let representative: Vec<String> = candidate_ids.iter().take(3).cloned().collect();
    let matched = {
        let m = str_or(prediction, &["matched_prefix"]);
        if m.is_empty() { compact(fallback_fragment) } else { m }
    };
    let mut out = Map::new();
    out.insert("display_token".into(), json!(str_or(prediction, &["display_token", "display"])));
    out.insert("normalized_token".into(), json!(str_or(prediction, &["normalized_token", "normalized"])));
    out.insert("confidence".into(), jn(num(prediction.get("confidence"))));
    out.insert("score".into(), jn(num(prediction.get("score"))));
    out.insert("source_rank".into(), jn(num(prediction.get("source_rank"))));
    out.insert("language".into(), json!(str_or(prediction, &["language"])));
    out.insert("matched_prefix".into(), json!(matched));
    out.insert(
        "card_count".into(),
        jn(count_chain(&[num(prediction.get("card_count")), num(prediction.get("ids_count")), candidate_ids.len() as f64, representative.len() as f64])),
    );
    out.insert("ids_count".into(), jn(count_chain(&[num(prediction.get("ids_count")), candidate_ids.len() as f64, representative.len() as f64])));
    for key in ["source", "token_type", "dimension", "alias", "anchor"] {
        if let Some(v) = prediction.get(key).filter(|v| js::truthy(Some(v))) {
            out.insert(key.into(), v.clone());
        }
    }
    if !representative.is_empty() {
        out.insert("representative_card_ids".into(), json!(representative));
    }
    if !candidate_ids.is_empty() {
        out.insert("candidate_card_ids".into(), json!(candidate_ids));
    }
    Value::Object(out)
}

fn public_context_candidate(prediction: &Value, fallback_fragment: &str, order: usize) -> Option<Value> {
    if prediction.get("token_type").and_then(Value::as_str) == Some("dimension_alias") {
        return None;
    }
    let candidate_ids = candidate_card_ids_from_prediction(prediction, PREDICTION_CONTEXT_CANDIDATE_ID_LIMIT);
    let representative = candidate_card_ids_from_prediction(prediction, 8);
    let source_rank = {
        let n = num(prediction.get("source_rank"));
        if n != 0.0 && !n.is_nan() { n } else { (order + 1) as f64 }
    };
    let matched = {
        let m = str_or(prediction, &["matched_prefix"]);
        if m.is_empty() { compact(fallback_fragment) } else { m }
    };
    let mut out = Map::new();
    out.insert("display_token".into(), json!(str_or(prediction, &["display_token", "display"])));
    out.insert("normalized_token".into(), json!(str_or(prediction, &["normalized_token", "normalized"])));
    out.insert("confidence".into(), jn(num(prediction.get("confidence"))));
    out.insert("score".into(), jn(num(prediction.get("score"))));
    out.insert("source_rank".into(), jn(source_rank));
    out.insert("order".into(), json!(order));
    out.insert("language".into(), json!(str_or(prediction, &["language"])));
    out.insert("matched_prefix".into(), json!(matched));
    out.insert(
        "card_count".into(),
        jn(count_chain(&[num(prediction.get("card_count")), num(prediction.get("ids_count")), candidate_ids.len() as f64, representative.len() as f64])),
    );
    out.insert("ids_count".into(), jn(count_chain(&[num(prediction.get("ids_count")), candidate_ids.len() as f64, representative.len() as f64])));
    if !representative.is_empty() {
        out.insert("representative_card_ids".into(), json!(representative));
    }
    if !candidate_ids.is_empty() {
        out.insert("candidate_card_ids".into(), json!(candidate_ids));
    }
    Some(Value::Object(out))
}

fn prediction_context_from_tokens(input: &Input, prediction_fragment: &str, normalized_fragment: &str, tokens: &[Value], source: &str) -> Value {
    let candidates: Vec<Value> = tokens
        .iter()
        .take(PREDICTION_CONTEXT_MAX_CANDIDATES)
        .enumerate()
        .filter_map(|(i, p)| public_context_candidate(p, prediction_fragment, i))
        .filter(|c| !str_or(c, &["display_token"]).is_empty() && !str_or(c, &["normalized_token"]).is_empty())
        .collect();
    json!({
        "query": input.query,
        "fragment": input.fragment,
        "prediction_fragment": prediction_fragment,
        "normalized_fragment": normalized_fragment,
        "language": input.search_language,
        "depth": normalized_fragment.len(),
        "created_at_ms": now_ms(),
        "source": source,
        "candidates": candidates,
    })
}

fn clean_ids(value: Option<&Value>, max: usize) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items.iter().map(|id| js::string_or_empty(Some(id)).trim().to_owned()).filter(|id| !id.is_empty()).take(max).collect()
    })
}

fn nullish_str(value: &Value, keys: &[&str]) -> String {
    nullish(value, keys).map(js::js_string).unwrap_or_default()
}

fn prediction_context_candidate_from_json(value: &Value, index: usize) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let display = nullish_str(value, &["display_token", "display"]).trim().to_owned();
    let normalized = compact(&nullish(value, &["normalized_token", "normalized"]).map(js::js_string).unwrap_or_else(|| display.clone()));
    if display.is_empty() || normalized.is_empty() {
        return None;
    }
    let candidate_ids = clean_ids(value.get("candidate_card_ids"), PREDICTION_CONTEXT_CANDIDATE_ID_LIMIT)
        .or_else(|| clean_ids(value.get("candidateCardIds"), PREDICTION_CONTEXT_CANDIDATE_ID_LIMIT))
        .unwrap_or_default();
    let representative = clean_ids(value.get("representative_card_ids"), 8).unwrap_or_else(|| candidate_ids.iter().take(8).cloned().collect());
    let order = match nullish(value, &["order"]) {
        Some(v) => js::number(Some(v)),
        None => index as f64,
    };
    let source_rank = count_chain(&[num(value.get("source_rank")), num(value.get("sourceRank")), (index + 1) as f64]);
    Some(json!({
        "display_token": display,
        "display": display,
        "normalized_token": normalized,
        "normalized": normalized,
        "confidence": jn(num(value.get("confidence"))),
        "score": jn(num(value.get("score"))),
        "source_rank": jn(source_rank),
        "order": jn(order),
        "language": str_or(value, &["language"]).trim(),
        "matched_prefix": str_or(value, &["matched_prefix", "matchedPrefix"]).trim(),
        "card_count": jn(count_chain(&[num(value.get("card_count")), num(value.get("cardCount")), num(value.get("ids_count")), num(value.get("idsCount")), candidate_ids.len() as f64, representative.len() as f64])),
        "ids_count": jn(count_chain(&[num(value.get("ids_count")), num(value.get("idsCount")), candidate_ids.len() as f64, representative.len() as f64])),
        "representative_card_ids": representative,
        "candidate_card_ids": if candidate_ids.is_empty() { representative.clone() } else { candidate_ids },
    }))
}

enum Previous {
    Invalid(&'static str),
    Valid(Vec<Value>),
}

fn clean_previous_prediction_context(value: Option<&Value>, input: &Input, normalized_fragment: &str) -> Previous {
    let Some(value) = value.filter(|v| v.is_object()) else {
        return Previous::Invalid("missing_context");
    };
    let previous_language = normalize::clean_language(nullish(value, &["language", "search_language"]));
    if previous_language != input.search_language {
        return Previous::Invalid("language_changed");
    }
    let previous_fragment = compact(&nullish(value, &["normalized_fragment", "normalizedFragment", "prediction_fragment", "predictionFragment", "fragment", "query"]).map(js::js_string).unwrap_or_default());
    if previous_fragment.is_empty() || !normalized_fragment.starts_with(&previous_fragment) || normalized_fragment == previous_fragment {
        return Previous::Invalid("fragment_not_extended");
    }
    let created = match nullish(value, &["created_at_ms", "createdAtMs"]) {
        Some(v) => js::number(Some(v)),
        None => 0.0,
    };
    if !created.is_finite() || created <= 0.0 || now_ms() as f64 - created > PREDICTION_CONTEXT_TTL_MS {
        return Previous::Invalid("context_expired");
    }
    let raw = value.get("candidates").and_then(Value::as_array).or_else(|| value.get("predictions").and_then(Value::as_array)).cloned().unwrap_or_default();
    let candidates: Vec<Value> = raw.iter().enumerate().filter_map(|(i, c)| prediction_context_candidate_from_json(c, i)).take(PREDICTION_CONTEXT_MAX_CANDIDATES).collect();
    if candidates.is_empty() {
        return Previous::Invalid("empty_candidates");
    }
    Previous::Valid(candidates)
}

/// JS `boundedDistance` on UTF-16 code units.
fn bounded_distance(left: &str, right: &str, max_distance: usize) -> usize {
    let a: Vec<u16> = left.encode_utf16().collect();
    let b: Vec<u16> = right.encode_utf16().collect();
    if a.len().abs_diff(b.len()) > max_distance {
        return max_distance + 1;
    }
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut current = vec![i; b.len() + 1];
        let mut row_min = current[0];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let value = (current[j - 1] + 1).min(previous[j] + 1).min(previous[j - 1] + cost);
            current[j] = value;
            row_min = row_min.min(value);
        }
        if row_min > max_distance {
            return max_distance + 1;
        }
        previous = current;
    }
    previous[b.len()]
}

fn fuzzy_distance_limit(fragment: &str) -> usize {
    if fragment.len() <= 3 {
        0
    } else if fragment.len() >= 6 {
        2
    } else {
        1
    }
}

fn near_prefix_distance(token: &str, fragment: &str, max_distance: usize) -> usize {
    let len = fragment.len() as i64;
    let mut lengths = Vec::new();
    for l in [len, len - 1, len + 1] {
        if !lengths.contains(&l) {
            lengths.push(l);
        }
    }
    let mut best = max_distance + 1;
    for l in lengths {
        if l <= 0 {
            continue;
        }
        let cut = (l as usize).min(token.len());
        best = best.min(bounded_distance(&token[..cut], fragment, max_distance));
    }
    best
}

fn with_fields(base: &Value, fields: &[(&str, Value)]) -> Value {
    let mut map = base.as_object().cloned().unwrap_or_default();
    for (k, v) in fields {
        map.insert((*k).into(), v.clone());
    }
    Value::Object(map)
}

fn rescore_context_candidate(candidate: &Value, fragment: &str) -> Option<Value> {
    let token = {
        let t = str_or(candidate, &["normalized_token", "normalized"]);
        if t.is_empty() { compact(&str_or(candidate, &["display_token"])) } else { t }
    };
    if token.is_empty() || fragment.is_empty() {
        return None;
    }
    let base = num(candidate.get("score"));
    let source_rank = count_chain(&[num(candidate.get("source_rank")), num(candidate.get("order"))]);
    let confidence = num(candidate.get("confidence"));
    if token == fragment {
        return Some(with_fields(candidate, &[("confidence", jn(confidence.max(100.0))), ("score", jn(base + 500000.0)), ("matched_prefix", json!(fragment))]));
    }
    if token.starts_with(fragment) {
        let c = confidence.max(76f64.max(98.0 - (token.len() as f64 - fragment.len() as f64).max(0.0)));
        return Some(with_fields(candidate, &[("confidence", jn(c)), ("score", jn(base + 300000.0 - source_rank)), ("matched_prefix", json!(fragment))]));
    }
    let max_distance = fuzzy_distance_limit(fragment);
    let head: String = fragment.chars().take(2).collect();
    if max_distance > 0 && token.starts_with(&head) {
        let distance = near_prefix_distance(&token, fragment, max_distance);
        if distance <= max_distance {
            let d = distance as f64;
            return Some(with_fields(
                candidate,
                &[
                    ("confidence", jn(confidence.max(86.0 - d * 7.0))),
                    ("score", jn(base + 160000.0 - d * 25000.0 - source_rank)),
                    ("matched_prefix", json!(fragment)),
                    ("fuzzy_distance", json!(distance)),
                ],
            ));
        }
    }
    None
}

fn display_of(v: &Value) -> String {
    str_or(v, &["display_token", "display"])
}

/// `num` is NaN for a non-numeric string (client `previous_prediction_context`
/// can carry one), so the keys sort NaN-last to stay a total order.
fn compare_tokens(left: &Value, right: &Value, tie: &str) -> std::cmp::Ordering {
    let by = |key: &str, descending: bool| cmp_f64_nan_last(num(left.get(key)), num(right.get(key)), descending);
    by("confidence", true)
        .then_with(|| by("score", true))
        .then_with(|| by(tie, false))
        .then_with(|| locale_cmp(&display_of(left), &display_of(right)))
}

struct Refinement {
    tokens: Option<Vec<Value>>,
    meta: Value,
}

fn refine_tokens_from_previous_context(input: &Input, fragment: &str) -> Refinement {
    let candidates = match clean_previous_prediction_context(input.previous_prediction_context.as_ref(), input, fragment) {
        Previous::Invalid(reason) => return Refinement { tokens: None, meta: json!({ "used": false, "reason": reason }) },
        Previous::Valid(c) => c,
    };
    let search_count = if fragment.len() <= 3 { 1.max(candidates.len().div_ceil(2)) } else { candidates.len() };
    let searched = &candidates[..search_count.min(candidates.len())];
    let mut refined: Vec<Value> = searched.iter().filter_map(|c| rescore_context_candidate(c, fragment)).collect();
    refined.sort_by(|a, b| compare_tokens(a, b, "order"));
    let refined: Vec<Value> = refined
        .into_iter()
        .take(PREDICTION_CONTEXT_MAX_CANDIDATES)
        .enumerate()
        .map(|(i, c)| {
            let display = c.get("display_token").cloned().unwrap_or(Value::Null);
            let normalized = c.get("normalized_token").cloned().unwrap_or(Value::Null);
            with_fields(&c, &[("display", display), ("normalized", normalized), ("source_rank", json!(i + 1))])
        })
        .collect();
    let meta = json!({
        "used": true,
        "previous_candidate_count": candidates.len(),
        "searched_candidate_count": searched.len(),
        "matched_candidate_count": refined.len(),
        "mode": if fragment.len() > 3 { "context_fuzzy" } else { "context_prefix_narrow" },
    });
    Refinement { tokens: Some(refined), meta }
}

fn context_fallback_reason(refinement: &Refinement) -> Option<&'static str> {
    let tokens = refinement.tokens.as_ref()?;
    if tokens.is_empty() {
        return Some("no_context_matches");
    }
    let top = tokens.iter().map(|t| num(t.get("confidence"))).fold(f64::NEG_INFINITY, f64::max);
    if top < CONTEXT_WEAK_MATCH_CONFIDENCE { Some("weak_context_matches") } else { None }
}

fn prediction_token_key(prediction: &Value) -> String {
    compact(&nullish(prediction, &["normalized_token", "normalized", "display_token", "display"]).map(js::js_string).unwrap_or_default())
}

struct CacheEntry<T> {
    created: u64,
    value: T,
}

static FIRST_CHAR_CACHE: LazyLock<Mutex<HashMap<String, CacheEntry<(String, Vec<Value>)>>>> = LazyLock::new(Default::default);
static WARMUP_CACHE: LazyLock<Mutex<HashMap<String, CacheEntry<Value>>>> = LazyLock::new(Default::default);
static WARMUP_FAILURES: LazyLock<Mutex<HashMap<String, CacheEntry<EngineError>>>> = LazyLock::new(Default::default);
static ANCHOR_CACHE: LazyLock<Mutex<HashMap<String, Option<Anchor>>>> = LazyLock::new(Default::default);

fn first_char_cache_key(input: &Input, fragment: &str) -> String {
    if fragment.len() != 1 || input.previous_prediction_context.is_some() {
        return String::new();
    }
    let language = if input.search_language.is_empty() { "en" } else { &input.search_language };
    format!("{language}:{fragment}")
}

fn first_char_cache_get(key: &str) -> Option<(String, Vec<Value>)> {
    let mut cache = FIRST_CHAR_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let entry = cache.get(key)?;
    if now_ms().saturating_sub(entry.created) > FIRST_CHAR_PREDICTION_CACHE_TTL_MS {
        cache.remove(key);
        return None;
    }
    Some(entry.value.clone())
}

fn first_char_cache_put(key: &str, source: &str, tokens: &[Value]) {
    let mut cache = FIRST_CHAR_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.insert(key.to_owned(), CacheEntry { created: now_ms(), value: (source.to_owned(), tokens.to_vec()) });
}

struct Fetched {
    source: String,
    tokens: Vec<Value>,
    first_char_cache: Value,
    alternate_fragments: Vec<Value>,
}

fn first_char_meta(key: &str, hit: bool) -> Value {
    if key.is_empty() {
        json!({ "used": false })
    } else {
        json!({ "used": true, "hit": hit, "ttl_ms": FIRST_CHAR_PREDICTION_CACHE_TTL_MS })
    }
}

fn not_configured(message: &str) -> EngineError {
    let mut error = EngineError::new(message).with_code("SUPABASE_NAME_INDEX_NOT_CONFIGURED");
    error.status = Some(503);
    error
}

async fn fetch_supabase_prediction_tokens(ctx: &Ctx, input: &Input, prediction_fragment: &str) -> Result<Fetched, EngineError> {
    let fragment = compact(prediction_fragment);
    let key = first_char_cache_key(input, &fragment);
    if !key.is_empty() {
        if let Some((source, tokens)) = first_char_cache_get(&key) {
            return Ok(Fetched { source, tokens, first_char_cache: first_char_meta(&key, true), alternate_fragments: Vec::new() });
        }
    }
    if !engine::supabase_rest_name_index_configured() {
        return Err(not_configured("Supabase name-token index is not configured for token prediction."));
    }
    let tokens = engine::supabase_rest_predicted_name_tokens(ctx.api_http(), prediction_fragment, &input.search_language, PREDICTION_CONTEXT_MAX_CANDIDATES)
        .await
        .map_err(|mut error| {
            error.status = error.status.or(Some(503));
            error
        })?;
    let source = "supabase_rest";
    if !key.is_empty() {
        first_char_cache_put(&key, source, &tokens);
    }
    Ok(Fetched { source: source.into(), tokens, first_char_cache: first_char_meta(&key, false), alternate_fragments: Vec::new() })
}

async fn fetch_with_alternates(ctx: &Ctx, input: &Input, prediction_fragment: &str) -> Result<Fetched, EngineError> {
    let primary = fetch_supabase_prediction_tokens(ctx, input, prediction_fragment).await?;
    if !primary.tokens.is_empty() {
        return Ok(primary);
    }
    let alternates = prediction_fragment_alternates(&input.query, prediction_fragment);
    for alternate in &alternates {
        let result = fetch_supabase_prediction_tokens(ctx, input, alternate).await?;
        if !result.tokens.is_empty() {
            let count = result.tokens.len();
            return Ok(Fetched {
                source: format!("{}_alternate_fragment", result.source),
                tokens: result.tokens,
                first_char_cache: if js::truthy(Some(&primary.first_char_cache)) { primary.first_char_cache } else { result.first_char_cache },
                alternate_fragments: vec![json!({ "fragment": alternate, "normalized_fragment": compact(alternate), "returned_candidate_count": count })],
            });
        }
    }
    Ok(Fetched {
        alternate_fragments: alternates.iter().map(|f| json!({ "fragment": f, "normalized_fragment": compact(f), "returned_candidate_count": 0 })).collect(),
        ..primary
    })
}

fn anchor_from_prediction(prediction: Option<&Value>, words: &[String], prefix_word_count: usize, source: &'static str) -> Option<Anchor> {
    let prediction = prediction?;
    let prefix = term(&words[..prefix_word_count].join(" "));
    let normalized_prefix = compact(&prefix);
    let normalized_prediction = prediction_token_key(prediction);
    let confidence = num(prediction.get("confidence"));
    let matched_prefix = compact(&str_or(prediction, &["matched_prefix", "matchedPrefix"]));
    if normalized_prefix.is_empty()
        || (normalized_prediction != normalized_prefix && !normalized_prediction.starts_with(&normalized_prefix))
        || (!matched_prefix.is_empty() && matched_prefix != normalized_prefix)
        || confidence < ANCHOR_MIN_CONFIDENCE
        || confidence.is_nan()
    {
        return None;
    }
    let display = prediction
        .get("display_token")
        .filter(|v| js::truthy(Some(v)))
        .or_else(|| prediction.get("display").filter(|v| js::truthy(Some(v))))
        .cloned()
        .unwrap_or(json!(prefix));
    Some(Anchor { display, normalized: normalized_prediction, confidence, trailing_words: words[prefix_word_count..].to_vec(), source })
}

fn anchor_from_previous_prediction_context(input: &Input) -> Option<Anchor> {
    let words = query_words(&input.query);
    if words.len() < 2 {
        return None;
    }
    let candidates = input.previous_prediction_context.as_ref().and_then(|c| c.get("candidates")).and_then(Value::as_array).cloned().unwrap_or_default();
    for count in (1..words.len()).rev() {
        if !is_anchor_prefix_candidate(&words[..count]) || is_modifier_only_trailing_words(&words[count..]) {
            continue;
        }
        for candidate in &candidates {
            let parsed = prediction_context_candidate_from_json(candidate, 0);
            if let Some(anchor) = anchor_from_prediction(parsed.as_ref(), &words, count, "previous_prediction_context") {
                return Some(anchor);
            }
        }
    }
    None
}

async fn anchor_from_supabase_name_prefixes(ctx: &Ctx, input: &Input) -> Option<Anchor> {
    let words = query_words(&input.query);
    if words.len() < 2 {
        return None;
    }
    for count in (1..words.len()).rev() {
        if !is_anchor_prefix_candidate(&words[..count]) || is_modifier_only_trailing_words(&words[count..]) {
            continue;
        }
        let prefix = term(&words[..count].join(" "));
        if compact(&prefix).is_empty() {
            continue;
        }
        let Ok(result) = fetch_supabase_prediction_tokens(ctx, input, &prefix).await else {
            continue;
        };
        for prediction in &result.tokens {
            if let Some(anchor) = anchor_from_prediction(Some(prediction), &words, count, "supabase_name_prefix") {
                return Some(anchor);
            }
        }
    }
    None
}

async fn first_name_anchor_for_query(ctx: &Ctx, input: &Input) -> Option<Anchor> {
    let language = if input.search_language.is_empty() { "en" } else { &input.search_language };
    let key = format!("{language}:{}", compact(&input.query));
    if let Some(cached) = ANCHOR_CACHE.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return cached.clone();
    }
    let anchor = match anchor_from_previous_prediction_context(input) {
        Some(anchor) => Some(anchor),
        None => anchor_from_supabase_name_prefixes(ctx, input).await,
    };
    let mut cache = ANCHOR_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if cache.len() >= ANCHOR_CACHE_MAX {
        cache.clear();
    }
    cache.insert(key, anchor.clone());
    anchor
}

fn merge_prediction_tokens(primary: &[Value], fallback: &[Value]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_token: HashMap<String, Value> = HashMap::new();
    for prediction in primary.iter().chain(fallback.iter()) {
        let key = prediction_token_key(prediction);
        if key.is_empty() {
            continue;
        }
        let replace = match by_token.get(&key) {
            None => true,
            Some(existing) => {
                let (pc, ec) = (num(prediction.get("confidence")), num(existing.get("confidence")));
                pc > ec || (pc == ec && num(prediction.get("score")) > num(existing.get("score")))
            }
        };
        if replace {
            if !by_token.contains_key(&key) {
                order.push(key.clone());
            }
            by_token.insert(key, prediction.clone());
        }
    }
    let mut values: Vec<Value> = order.into_iter().filter_map(|k| by_token.remove(&k)).collect();
    values.sort_by(|a, b| compare_tokens(a, b, "source_rank"));
    values.into_iter().take(PREDICTION_CONTEXT_MAX_CANDIDATES).enumerate().map(|(i, p)| with_fields(&p, &[("source_rank", json!(i + 1))])).collect()
}

pub async fn predict_name_tokens(ctx: &Ctx, input: &Input) -> Result<Value, EngineError> {
    let prediction_fragment = term(if input.prediction_fragment.is_empty() { &input.fragment } else { &input.prediction_fragment });
    if prediction_fragment.is_empty() || compact(&prediction_fragment).is_empty() {
        return Ok(json!({
            "ok": true, "endpoint": ENDPOINT, "query": input.query, "fragment": input.fragment, "normalized_fragment": "",
            "search_language": input.search_language, "limit": input.limit, "predictions": [], "meta": { "source": "empty_fragment" },
        }));
    }
    let normalized_fragment = compact(&prediction_fragment);
    let anchor = first_name_anchor_for_query(ctx, input).await;
    let alias_prediction = anchored_alias_prediction_for_query(&input.query, anchor.as_ref());
    let alias_token = prediction_from_expansion_alias(alias_prediction.as_ref());
    let suppress = anchor.as_ref().is_some_and(|a| !a.trailing_words.is_empty() && !is_variation_prefix_trailing_words(&a.trailing_words));
    let started = std::time::Instant::now();
    let mut source = "supabase_postgres".to_owned();
    let mut tokens: Option<Vec<Value>> = None;
    let mut full_table_fallback = json!({ "used": false });
    let mut first_char_cache = json!({ "used": false });
    let refinement = refine_tokens_from_previous_context(input, &normalized_fragment);
    let fallback_reason = context_fallback_reason(&refinement);
    let mode = refinement.meta.get("mode").and_then(Value::as_str).unwrap_or("").to_owned();
    if suppress {
        let a = anchor.as_ref().expect("anchor");
        tokens = Some(alias_token.clone().into_iter().collect());
        source = if alias_token.is_some() { "anchored_dimension_alias" } else { "anchored_first_name" }.into();
        full_table_fallback = json!({
            "used": false,
            "reason": "first_name_anchor_established",
            "anchor": { "display": a.display, "normalized": a.normalized, "confidence": jn(a.confidence), "source": a.source },
        });
    } else if refinement.tokens.is_some() && fallback_reason.is_none() {
        tokens = refinement.tokens.clone();
        source = mode.clone();
    }
    if (tokens.is_none() || fallback_reason.is_some()) && !suppress {
        let result = fetch_with_alternates(ctx, input, &prediction_fragment).await?;
        if js::truthy(Some(&result.first_char_cache)) {
            first_char_cache = result.first_char_cache.clone();
        }
        if let Some(context_tokens) = refinement.tokens.as_ref() {
            tokens = Some(if result.tokens.is_empty() { context_tokens.clone() } else { merge_prediction_tokens(&result.tokens, context_tokens) });
            source = format!("{mode}_with_{}_fallback", result.source);
            full_table_fallback = json!({
                "used": true, "reason": fallback_reason, "source": result.source,
                "returned_candidate_count": result.tokens.len(), "alternate_fragments": result.alternate_fragments,
            });
        } else {
            full_table_fallback = json!({
                "used": !result.alternate_fragments.is_empty(),
                "reason": if result.tokens.is_empty() { "empty_primary_and_alternate_fragments" } else { "primary_fragment_empty" },
                "source": result.source,
                "returned_candidate_count": result.tokens.len(),
                "alternate_fragments": result.alternate_fragments,
            });
            source = result.source;
            tokens = Some(result.tokens);
        }
    }
    let mut tokens = tokens.unwrap_or_default();
    if let (Some(alias_token), false) = (alias_token.as_ref(), suppress) {
        tokens = merge_prediction_tokens(std::slice::from_ref(alias_token), &tokens);
        source = format!("anchored_expansion_alias_with_{source}");
        let alias = alias_prediction.as_ref().expect("alias");
        if let Value::Object(map) = &mut full_table_fallback {
            map.insert(
                "anchored_expansion_alias".into(),
                json!({ "anchor": alias.anchor, "alias": alias.completion.alias, "fragment": alias.fragment, "normalized_fragment": alias.normalized_fragment }),
            );
        }
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    let context = prediction_context_from_tokens(input, &prediction_fragment, &normalized_fragment, &tokens, &source);
    let predictions: Vec<Value> = tokens.iter().take(input.limit.max(0) as usize).map(|p| public_prediction(p, &prediction_fragment)).collect();
    Ok(json!({
        "ok": true,
        "endpoint": ENDPOINT,
        "query": input.query,
        "fragment": input.fragment,
        "prediction_fragment": prediction_fragment,
        "normalized_fragment": normalized_fragment,
        "search_language": input.search_language,
        "limit": input.limit,
        "predictions": predictions,
        "prediction_context": context,
        "meta": {
            "source": source,
            "model": "marketplace_card_name_tokens",
            "duration_ms": duration_ms,
            "row_payload": "tokens_only",
            "context_refinement": refinement.meta,
            "full_table_fallback": full_table_fallback,
            "first_char_cache": first_char_cache,
        },
    }))
}

const LETTERS: &str = "abcdefghijklmnopqrstuvwxyz";

async fn warmup_rest_rows(ctx: &Ctx, language: &str, limit: i64) -> Result<Vec<Value>, EngineError> {
    warmup_rows(|letter| async move { engine::supabase_rest_predicted_name_tokens(ctx.api_http(), &letter, language, limit as usize).await }).await
}

/// One lookup per letter, `WARMUP_LETTER_CONCURRENCY` at a time, rows in
/// letter order; the first failure ends the warmup.
async fn warmup_rows<F, Fut>(fetch: F) -> Result<Vec<Value>, EngineError>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<Value>, EngineError>>,
{
    let per_letter: Vec<(String, Vec<Value>)> = stream::iter(LETTERS.chars().map(|letter| letter.to_string()))
        .map(|letter| {
            let predictions = fetch(letter.clone());
            async move { predictions.await.map(|predictions| (letter, predictions)) }
        })
        .buffered(WARMUP_LETTER_CONCURRENCY)
        .try_collect()
        .await?;
    let mut rows = Vec::new();
    for (letter, predictions) in per_letter {
        for (i, p) in predictions.iter().enumerate() {
            rows.push(with_fields(p, &[("letter", json!(letter)), ("source_rank", json!(i + 1))]));
        }
    }
    Ok(rows)
}

fn warmup_failure_get(key: &str) -> Option<EngineError> {
    let mut failures = WARMUP_FAILURES.lock().unwrap_or_else(|p| p.into_inner());
    let entry = failures.get(key)?;
    if now_ms().saturating_sub(entry.created) > FIRST_CHAR_WARMUP_FAILURE_TTL_MS {
        failures.remove(key);
        return None;
    }
    Some(entry.value.clone())
}

fn warmup_failure_put(key: &str, error: &EngineError) {
    let mut failures = WARMUP_FAILURES.lock().unwrap_or_else(|p| p.into_inner());
    failures.insert(key.to_owned(), CacheEntry { created: now_ms(), value: error.clone() });
}

fn warmup_suggestion_from_row(row: &Value, requested: &str, source_language: &str) -> Option<Value> {
    let display = str_or(row, &["canonical_name", "display_name", "display_token", "display"]).trim().to_owned();
    let normalized = {
        let n = compact(&{
            let t = str_or(row, &["normalized_token", "normalized"]);
            if t.is_empty() { display.clone() } else { t }
        });
        if n.is_empty() { compact(&str_or(row, &["compact_name"])) } else { n }
    };
    let letter = compact(&{
        let l = str_or(row, &["letter", "matched_prefix"]);
        if l.is_empty() { normalized.chars().take(1).collect() } else { l }
    });
    if display.is_empty() || normalized.is_empty() || letter.len() != 1 {
        return None;
    }
    let mut out = Map::new();
    out.insert("display_token".into(), json!(display));
    out.insert("normalized_token".into(), json!(normalized));
    out.insert("confidence".into(), jn(num(row.get("confidence"))));
    out.insert("score".into(), jn(num(row.get("score"))));
    out.insert("source_rank".into(), jn(num(row.get("source_rank"))));
    out.insert("language".into(), json!(requested));
    out.insert("matched_prefix".into(), json!(letter));
    out.insert("card_count".into(), jn(count_chain(&[num(row.get("card_count")), num(row.get("ids_count"))])));
    out.insert("ids_count".into(), jn(count_chain(&[num(row.get("ids_count")), num(row.get("card_count"))])));
    out.insert("source".into(), json!("first_char_warmup"));
    if source_language != requested {
        out.insert("source_language".into(), json!(source_language));
    }
    Some(Value::Object(out))
}

async fn first_char_warmup_suggestions(ctx: &Ctx, language: &str, limit: i64) -> Result<Value, EngineError> {
    let limit = limit.clamp(1, MAX_WARMUP_LIMIT);
    let key = format!("{language}:{limit}");
    {
        let mut cache = WARMUP_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = cache.get(&key) {
            if now_ms().saturating_sub(entry.created) <= FIRST_CHAR_WARMUP_CACHE_TTL_MS {
                let mut payload = entry.value.clone();
                if let Some(Value::Object(meta)) = payload.get_mut("meta") {
                    meta.insert("cache".into(), json!({ "hit": true, "ttl_ms": FIRST_CHAR_WARMUP_CACHE_TTL_MS }));
                }
                return Ok(payload);
            }
            cache.remove(&key);
        }
    }
    if !engine::supabase_rest_name_index_configured() {
        return Err(not_configured("Supabase name-token index is not configured for first-char warmup."));
    }
    if let Some(error) = warmup_failure_get(&key) {
        return Err(error);
    }
    let started = std::time::Instant::now();
    let rows = engine::with_timeout(warmup_rest_rows(ctx, language, limit), FIRST_CHAR_WARMUP_TIMEOUT_MS, "first-char warmup")
        .await
        .map_err(|mut error| {
            error.status = error.status.or(Some(503));
            warmup_failure_put(&key, &error);
            error
        })?;
    let source = "supabase_rest";
    let mut by_letter: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for row in &rows {
        let Some(suggestion) = warmup_suggestion_from_row(row, language, language) else { continue };
        let letter = str_or(&suggestion, &["matched_prefix"]);
        if !LETTERS.contains(letter.as_str()) || letter.len() != 1 {
            continue;
        }
        let list = by_letter.entry(letter).or_default();
        if (list.len() as i64) < limit {
            list.push(suggestion);
        }
    }
    let suggestions: Map<String, Value> = by_letter.iter().filter_map(|(l, list)| list.first().map(|s| (l.clone(), s.clone()))).collect();
    let mut payload = Map::new();
    payload.insert("ok".into(), json!(true));
    payload.insert("endpoint".into(), json!(ENDPOINT));
    payload.insert("mode".into(), json!("first_char_warmup"));
    payload.insert("language".into(), json!(language));
    payload.insert("source_language".into(), json!(language));
    payload.insert("generated_at_ms".into(), json!(now_ms()));
    payload.insert("limit".into(), json!(limit));
    payload.insert("suggestions".into(), Value::Object(suggestions));
    if limit > 1 {
        payload.insert("suggestion_lists".into(), json!(by_letter));
    }
    payload.insert(
        "meta".into(),
        json!({
            "source": source,
            "model": "marketplace_card_name_tokens",
            "cache": { "hit": false, "ttl_ms": FIRST_CHAR_WARMUP_CACHE_TTL_MS },
            "duration_ms": started.elapsed().as_millis() as u64,
            "row_count": rows.len(),
            "fallback_to_english": false,
        }),
    );
    let payload = Value::Object(payload);
    WARMUP_CACHE.lock().unwrap_or_else(|p| p.into_inner()).insert(key, CacheEntry { created: now_ms(), value: payload.clone() });
    Ok(payload)
}

fn with_cors(mut response: Response) -> Response {
    let map = response.headers_mut();
    for (name, value) in CORS {
        if let (Ok(name), Ok(value)) = (axum::http::HeaderName::try_from(name), axum::http::HeaderValue::try_from(value)) {
            map.insert(name, value);
        }
    }
    response
}

fn trim_meta(payload: Value, keys: &[&str]) -> Value {
    let mut payload = payload;
    if let Some(Value::Object(meta)) = payload.get("meta").cloned() {
        let trimmed: Map<String, Value> = keys.iter().filter_map(|k| meta.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect();
        if let Value::Object(map) = &mut payload {
            map.insert("meta".into(), Value::Object(trimmed));
        }
    }
    payload
}

pub async fn handler(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri, raw: Bytes) -> Response {
    if method == Method::OPTIONS {
        return with_cors(StatusCode::NO_CONTENT.into_response());
    }
    if method != Method::GET && method != Method::POST {
        return with_cors(http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &[("allow", "GET, POST, OPTIONS")]));
    }
    let source = if method == Method::GET {
        http::Query::from_uri(&uri).to_json()
    } else {
        match http::parse_body(&headers, &raw) {
            Ok(body) => body.json(),
            Err(response) => return with_cors(response),
        }
    };
    let input = input_from_source(&source);
    let ctx = Ctx::new(state.api.read().clone(), state.api.redis().await);
    let is_post = method == Method::POST;
    if request_wants_warmup(&source) {
        let language = normalize::clean_language(nullish(&source, &["search_language", "language", "lang"]));
        let limit = clean_warmup_limit(nullish(&source, &["limit", "result_limit", "resultLimit"]));
        let debug = debug_flag(source.get("debug"));
        return match first_char_warmup_suggestions(&ctx, &language, limit).await {
            Ok(payload) => {
                let timing = format!("first-char-warmup;dur={}", payload.pointer("/meta/duration_ms").and_then(Value::as_u64).unwrap_or(0));
                let body = if debug { payload } else { trim_meta(payload, &["source", "model", "duration_ms", "cache"]) };
                let cache = if is_post { "no-store" } else { "public, max-age=30, s-maxage=300" };
                with_cors(http::json_with(StatusCode::OK, body, &[("cache-control", cache), ("server-timing", &timing)]))
            }
            Err(error) => with_cors(failure(&input, &error)),
        };
    }
    match predict_name_tokens(&ctx, &input).await {
        Ok(payload) => {
            let timing = format!("token-predict;dur={}", payload.pointer("/meta/duration_ms").and_then(Value::as_u64).unwrap_or(0));
            let body = if input.debug { payload } else { trim_meta(payload, &["source", "model", "duration_ms"]) };
            let cache = if is_post {
                "no-store"
            } else if !input.fragment.is_empty() {
                "public, max-age=5, s-maxage=30"
            } else {
                "public, max-age=10, s-maxage=60"
            };
            with_cors(http::json_with(StatusCode::OK, body, &[("cache-control", cache), ("server-timing", &timing)]))
        }
        Err(error) => with_cors(failure(&input, &error)),
    }
}

fn failure(input: &Input, error: &EngineError) -> Response {
    tracing::error!(message = %error.message, code = ?error.code, "searchbar token predict failed");
    let status = error.status.and_then(|s| StatusCode::from_u16(s).ok()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut body = json!({
        "ok": false,
        "endpoint": ENDPOINT,
        "query": input.query,
        "fragment": input.fragment,
        "normalized_fragment": compact(&input.fragment),
        "search_language": input.search_language,
        "predictions": [],
        "error": error.code.clone().unwrap_or_else(|| "TOKEN_PREDICT_FAILED".into()),
        "message": if error.message.is_empty() { "Token prediction failed.".to_owned() } else { error.message.clone() },
    });
    if input.debug {
        body["debug"] = json!({ "code": error.code, "reason": error.message });
    }
    http::json(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as Atomic};

    #[tokio::test]
    async fn warmup_fetches_letters_concurrently_in_letter_order() {
        let (in_flight, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let rows = warmup_rows(|letter| {
            let (in_flight, peak) = (&in_flight, &peak);
            async move {
                peak.fetch_max(in_flight.fetch_add(1, Atomic::SeqCst) + 1, Atomic::SeqCst);
                // Later letters answer first; rows still come back in letter order.
                let delay = 26 - u64::from(letter.as_bytes()[0] - b'a');
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                in_flight.fetch_sub(1, Atomic::SeqCst);
                Ok(vec![json!({ "display_token": format!("{letter}-name") })])
            }
        })
        .await
        .unwrap();
        let letters: String = rows.iter().map(|row| row["letter"].as_str().unwrap()).collect();
        assert_eq!(letters, LETTERS);
        assert_eq!(rows[0]["source_rank"], json!(1));
        assert_eq!(peak.load(Atomic::SeqCst), WARMUP_LETTER_CONCURRENCY);
    }

    #[tokio::test]
    async fn warmup_stops_at_the_first_failed_letter() {
        let calls = AtomicUsize::new(0);
        let result = warmup_rows(|letter| {
            let calls = &calls;
            async move {
                calls.fetch_add(1, Atomic::SeqCst);
                if letter == "c" {
                    Err(EngineError::new("Network is unreachable (os error 101)"))
                } else {
                    Ok(Vec::new())
                }
            }
        })
        .await;
        assert_eq!(result.unwrap_err().message, "Network is unreachable (os error 101)");
        assert!(calls.load(Atomic::SeqCst) < LETTERS.len());
    }

    #[test]
    fn warmup_failures_are_remembered_briefly() {
        let key = "test-failure:1";
        assert!(warmup_failure_get(key).is_none());
        warmup_failure_put(key, &EngineError::new("down"));
        assert_eq!(warmup_failure_get(key).unwrap().message, "down");
        WARMUP_FAILURES.lock().unwrap().get_mut(key).unwrap().created -= FIRST_CHAR_WARMUP_FAILURE_TTL_MS + 1;
        assert!(warmup_failure_get(key).is_none());
    }

    fn input(query: &str) -> Input {
        input_from_source(&json!({ "query": query }))
    }

    #[test]
    fn fragments() {
        assert_eq!(trailing_token_fragment("charizard e"), "e");
        assert_eq!(trailing_token_fragment("pikachu-ex"), "pikachu-ex");
        assert_eq!(prediction_fragment_for_query("charizard e"), "charizard e");
        assert_eq!(prediction_fragment_for_query("charizard 4"), "4");
        let i = input("pik");
        assert_eq!((i.fragment.as_str(), i.prediction_fragment.as_str(), i.limit), ("pik", "pik", 5));
        assert_eq!(prediction_fragment_alternates("dark charizard e", "dark charizard e"), vec!["charizard e", "e", "charizard"]);
        assert!(is_variation_prefix_trailing_words(&["vm".into()]));
        assert!(!is_variation_prefix_trailing_words(&["base".into()]));
    }

    #[test]
    fn distances_and_alias() {
        assert_eq!(bounded_distance("charz", "chari", 2), 1);
        assert_eq!(near_prefix_distance("charizard", "charzard", 2), 1);
        let anchor = Anchor { display: json!("Lugia"), normalized: "lugia".into(), confidence: 90.0, trailing_words: vec!["hgs".into()], source: "x" };
        let alias = anchored_alias_prediction_for_query("lugia hgs", Some(&anchor)).expect("alias");
        assert_eq!(alias.completion.display_token, "HGSS");
        assert_eq!(alias.confidence, 96.0);
        let token = prediction_from_expansion_alias(Some(&alias)).unwrap();
        assert_eq!(token["score"], json!(603000));
    }

    #[test]
    fn merge_sorts_non_numeric_confidence_last() {
        // `num("high")` is NaN; NaN compared Equal to everything made the
        // comparator non-transitive, which panics `sort_by`.
        let tokens: Vec<Value> = (0..64)
            .map(|i| {
                let confidence = if i % 2 == 0 { json!("high") } else { json!(i) };
                json!({ "display_token": format!("Token{i}"), "normalized_token": format!("token{i}"), "confidence": confidence, "score": 64 - i })
            })
            .collect();
        let merged = merge_prediction_tokens(&tokens, &[]);
        assert_eq!(merged.len(), PREDICTION_CONTEXT_MAX_CANDIDATES.min(64));
        assert_eq!(merged[0]["display_token"], "Token63");
        let first_nan = merged.iter().position(|t| num(t.get("confidence")).is_nan()).unwrap_or(merged.len());
        assert!(merged[first_nan..].iter().all(|t| num(t.get("confidence")).is_nan()));
    }

    #[test]
    fn context_refinement() {
        let mut i = input("chari");
        i.previous_prediction_context = Some(json!({
            "language": "en", "normalized_fragment": "char", "created_at_ms": now_ms(),
            "candidates": [{ "display_token": "Charizard", "normalized_token": "charizard", "confidence": 90, "score": 10 }, { "display_token": "Charmander", "normalized_token": "charmander", "confidence": 90, "score": 20 }],
        }));
        let refined = refine_tokens_from_previous_context(&i, "chari");
        let tokens = refined.tokens.unwrap();
        // charmander stays as a one-edit near-prefix match (charm ~ chari).
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0]["display_token"], "Charizard");
        assert_eq!(tokens[0]["confidence"], json!(94));
        assert_eq!(tokens[1]["fuzzy_distance"], json!(1));
        assert_eq!(refined.meta["mode"], "context_fuzzy");
        assert!(context_fallback_reason(&Refinement { tokens: Some(tokens), meta: Value::Null }).is_none());
    }
}
