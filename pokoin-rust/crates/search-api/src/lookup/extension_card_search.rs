//! `POST|OPTIONS /api/extension-card-search` — port of `extension-card-search.js`.

use std::collections::HashSet;
use std::sync::LazyLock;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use pokoin_api_common::{http, RouteState};
use pokoin_catalog_api::shared::js;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::autocomplete::engine::{self, Ctx};
use crate::autocomplete::rank::{rank_autocomplete_entries, score_explanation, RankedEntry};
use crate::autocomplete::{analytics, ladder, normalize, CORS_HEADERS};

use super::search_candidates::engine_error;

const POKOIN_BASE_URL: &str = "https://pokoin.com";

fn with_cors(mut response: Response) -> Response {
    let map = response.headers_mut();
    for (name, value) in CORS_HEADERS {
        if let (Ok(name), Ok(value)) = (axum::http::HeaderName::try_from(name), axum::http::HeaderValue::try_from(value)) {
            map.insert(name, value);
        }
    }
    response
}

static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// `String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength)`.
fn clean_text(value: Option<&Value>, max: usize) -> String {
    let text = js::string_or_empty(value);
    js::slice_utf16(&WS.replace_all(text.trim(), " "), max)
}

static ILLUS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        Regex::new(r"(?i)^illus\.?(?:\s|:|$)").unwrap(),
        Regex::new(r"(?i)^illustrator(?:\s|:|$)").unwrap(),
        Regex::new(r"(?i)^artist(?:\s|:|$)").unwrap(),
    ]
});

pub fn is_illustrator_credit(value: Option<&Value>) -> bool {
    let text = clean_text(value, 120);
    ILLUS.iter().any(|re| re.is_match(&text))
}

fn clean_searchable(value: Option<&Value>, max: usize) -> String {
    if is_illustrator_credit(value) {
        return String::new();
    }
    clean_text(value, max)
}

fn clean_rarity_aliases(value: Option<&Value>) -> Vec<String> {
    let aliases: Vec<Value> = match value {
        Some(Value::Array(items)) => items.clone(),
        Some(other) => other.get("aliases").and_then(Value::as_array).cloned().unwrap_or_default(),
        None => Vec::new(),
    };
    let mut seen = HashSet::new();
    aliases
        .iter()
        .map(|a| clean_searchable(Some(a), 60))
        .filter(|a| !a.is_empty())
        .filter(|a| seen.insert(a.clone()))
        .take(6)
        .collect()
}

static CREDIT_TAILS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        Regex::new(r"(?i)(?-u:\b)illus\.?(?:\s*:?\s*)[a-z][a-z .'-]{1,80}$").unwrap(),
        Regex::new(r"(?i)(?-u:\b)illustrator(?:\s*:?\s*)[a-z][a-z .'-]{1,80}$").unwrap(),
        Regex::new(r"(?i)(?-u:\b)artist(?:\s*:?\s*)[a-z][a-z .'-]{1,80}$").unwrap(),
    ]
});

pub fn clean_extension_query(value: Option<&Value>) -> String {
    let mut text = clean_text(value, 240);
    for re in CREDIT_TAILS.iter() {
        text = re.replacen(&text, 1, " ").into_owned();
    }
    normalize::clean_search_term(Some(&Value::String(text)))
}

fn nullish<'a>(body: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| body.get(*k)).find(|v| !v.is_null())
}

#[derive(Default)]
struct Parts {
    name: String,
    collector_number: String,
    expansion: String,
    rarity: String,
    variation: String,
    rarity_aliases: Vec<String>,
}

impl Parts {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("name".into(), json!(self.name));
        out.insert("collectorNumber".into(), json!(self.collector_number));
        out.insert("expansion".into(), json!(self.expansion));
        out.insert("rarity".into(), json!(self.rarity));
        out.insert("variation".into(), json!(self.variation));
        if !self.rarity_aliases.is_empty() {
            out.insert("rarityAliases".into(), json!(self.rarity_aliases));
        }
        Value::Object(out)
    }
}

fn cleaned_parts(raw: &Value) -> Parts {
    Parts {
        rarity_aliases: clean_rarity_aliases(nullish(raw, &["rarityAliases", "rarity_aliases", "cardRarityAliases"])),
        name: clean_text(nullish(raw, &["name", "cardName", "pokemonName"]), 80),
        collector_number: clean_text(nullish(raw, &["collectorNumber", "collectionNumber", "number", "cardNumber"]), 40),
        expansion: clean_text(nullish(raw, &["expansion", "expansionName", "set", "setName"]), 80),
        rarity: clean_searchable(nullish(raw, &["rarity", "cardRarity"]), 60),
        variation: clean_searchable(nullish(raw, &["variation", "variant", "cardVariant"]), 60),
    }
}

static CARD_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)card(?-u:\b)").unwrap());

fn compact_part(value: &str) -> String {
    let text = clean_text(Some(&Value::String(value.to_owned())), 80);
    WS.replace_all(&CARD_WORD.replace_all(&text, " "), " ").trim().to_owned()
}

fn term(value: String) -> String {
    normalize::clean_search_term(Some(&Value::String(value)))
}

fn search_term_variants(search_term: &str, parts: &Parts) -> Vec<String> {
    let base = term(search_term.to_owned());
    let mut variants = if base.is_empty() { Vec::new() } else { vec![base.clone()] };
    if !parts.rarity_aliases.is_empty() {
        let stem = [compact_part(&parts.name), compact_part(&parts.variation), compact_part(&parts.collector_number), compact_part(&parts.expansion)]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let source = term(if stem.is_empty() { base.clone() } else { stem });
        for alias in &parts.rarity_aliases {
            let alias_term = term([source.clone(), compact_part(alias)].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" "));
            if !alias_term.is_empty() {
                variants.push(alias_term);
            }
        }
    }
    let mut seen = HashSet::new();
    variants.into_iter().filter(|v| seen.insert(v.clone())).take(8).collect()
}

struct SearchInput {
    search_term: String,
    search_terms: Vec<String>,
    parts: Parts,
    source: &'static str,
}

fn build_extension_search_term(body: &Value) -> SearchInput {
    let parts = cleaned_parts(body);
    let explicit = clean_extension_query(nullish(body, &["search_term", "searchTerm", "query"]));
    if !explicit.is_empty() {
        let search_terms = search_term_variants(&explicit, &parts);
        return SearchInput { search_term: explicit, search_terms, parts, source: "query" };
    }
    let tokens = [compact_part(&parts.name), compact_part(&parts.variation), compact_part(&parts.collector_number), compact_part(&parts.expansion), compact_part(&parts.rarity)]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let search_term = term(tokens);
    let search_terms = search_term_variants(&search_term, &parts);
    SearchInput { search_term, search_terms, parts, source: "structured_fields" }
}

static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

fn slug_part(value: &str) -> String {
    NON_ALNUM.replace_all(&value.trim().to_lowercase(), "-").trim_matches('-').to_owned()
}

fn clean_collector_number_for_slug(value: Option<&Value>) -> String {
    clean_text(value, 80).split('|').map(str::trim).filter(|p| !p.is_empty()).last().unwrap_or("").to_owned()
}

fn id_string(row: &Value) -> String {
    let id = row.get("card_id").filter(|v| js::truthy(Some(v))).or_else(|| row.get("id").filter(|v| js::truthy(Some(v))));
    id.map(js::js_string).unwrap_or_default()
}

pub fn marketplace_path_for_row(row: &Value, language: &str) -> String {
    let public_id = id_string(row).trim().to_owned();
    let lang = {
        let slug = slug_part(language);
        if slug.is_empty() { "en".to_owned() } else { slug }
    };
    let rarity = row.get("rarity").filter(|v| js::truthy(Some(v))).map(js::js_string).unwrap_or_else(|| "Card".into());
    let slug = [rarity, js::string_or_empty(row.get("name")), clean_collector_number_for_slug(row.get("card_number")), js::string_or_empty(row.get("set_name"))]
        .iter()
        .map(|p| slug_part(p))
        .map(|s| if s == "trading-card" { String::new() } else { s })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if public_id.is_empty() || !public_id.bytes().all(|b| b.is_ascii_digit()) || slug.is_empty() {
        return String::new();
    }
    format!("/marketplace/{lang}/cards/{public_id}/{slug}")
}

fn or_empty(row: &Value, keys: &[&str]) -> Value {
    keys.iter().filter_map(|k| row.get(*k)).find(|v| js::truthy(Some(v))).cloned().unwrap_or(json!(""))
}

fn match_from_entry(entry: &RankedEntry, language: &str) -> Value {
    let row = &entry.row;
    let path = marketplace_path_for_row(row, language);
    let url = if path.is_empty() { String::new() } else { format!("{POKOIN_BASE_URL}{path}") };
    json!({
        "cardId": id_string(row),
        "name": or_empty(row, &["name"]),
        "expansionName": or_empty(row, &["set_name"]),
        "collectorNumber": or_empty(row, &["card_number"]),
        "rarity": or_empty(row, &["rarity"]),
        "cardType": or_empty(row, &["card_type"]),
        "itemKind": or_empty(row, &["item_kind"]),
        "productType": or_empty(row, &["product_type"]),
        "trainerName": or_empty(row, &["trainer_name"]),
        "imageUrl": or_empty(row, &["cdn_image_url", "image_url"]),
        "previewImageUrl": or_empty(row, &["preview_image_url", "cdn_image_url", "image_url"]),
        "cardPalette": row.get("card_palette").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!({})),
        "emoji": or_empty(row, &["emoji"]),
        "marketplacePath": path,
        "marketplaceUrl": url,
        "canonicalPath": path,
        "canonicalUrl": url,
        "score": js::js_json_number(entry.score),
        "relevanceScore": js::js_json_number(entry.relevance_score),
        "analyticsBoost": js::js_json_number(entry.analytics_boost),
    })
}

async fn search_extension_card(state: &RouteState, body: &Value) -> Result<Value, Response> {
    let input = build_extension_search_term(body);
    let limit = normalize::clean_limit(Some(nullish(body, &["limit", "result_limit", "resultLimit"]).unwrap_or(&json!(8))));
    let result_limit = limit.min(50) as usize;
    let pool_limit = ladder::clean_autocomplete_pool_limit(Some(nullish(body, &["pool_limit", "poolLimit"]).unwrap_or(&json!(420))));
    let language = normalize::clean_language(nullish(body, &["language", "search_language", "lang"]));
    let wants_debug = super::search_candidates::strict_debug(body);
    let mut out = Map::new();
    out.insert("query".into(), json!(input.search_term));
    out.insert("input".into(), input.parts.to_json());
    out.insert("source".into(), json!(input.source));
    out.insert("language".into(), json!(language));
    if input.search_term.is_empty() {
        out.insert("matches".into(), json!([]));
        if wants_debug {
            out.insert("debug".into(), json!({ "reason": "empty_search_term" }));
        }
        return Ok(Value::Object(out));
    }
    let redis = state.api.redis().await;
    let mut ctx = Ctx::new(state.api.read().clone(), redis);
    if wants_debug {
        ctx.debug = Some(json!({ "steps": [] }));
    }
    let candidate_started = std::time::Instant::now();
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for term in &input.search_terms {
        let found = engine::rows_for_autocomplete_search_term(&mut ctx, term, pool_limit as i64, &language, None, false)
            .await
            .map_err(|e| engine_error(&e, "Extension card search failed."))?;
        for row in found {
            let id = id_string(&row);
            if !id.is_empty() && seen.insert(id) {
                rows.push(row);
            }
        }
    }
    let candidate_ms = candidate_started.elapsed().as_millis() as u64;
    let analytics_started = std::time::Instant::now();
    let boosts = analytics::analytics_boosts_for_rows(&ctx.pools.analytics(), &rows, None)
        .await
        .map_err(|e| engine_error(&e, "Extension card search failed."))?;
    let analytics_ms = analytics_started.elapsed().as_millis() as u64;
    let rank_started = std::time::Instant::now();
    let candidate_rows = rows.len();
    let ranked = rank_autocomplete_entries(rows, &input.search_term, result_limit, &boosts, &Default::default(), &Default::default(), &Default::default());
    let rank_ms = rank_started.elapsed().as_millis() as u64;
    out.insert("matches".into(), Value::Array(ranked.iter().map(|e| match_from_entry(e, &language)).collect()));
    if wants_debug {
        let ranked_debug: Vec<Value> = ranked
            .iter()
            .take(12)
            .map(|entry| {
                let mut explanation = score_explanation(&entry.row, &input.search_term);
                if let Value::Object(map) = &mut explanation {
                    map.insert("score".into(), js::js_json_number(entry.score));
                    map.insert("relevanceScore".into(), js::js_json_number(entry.relevance_score));
                    map.insert("analyticsBoost".into(), js::js_json_number(entry.analytics_boost));
                }
                explanation
            })
            .collect();
        out.insert(
            "debug".into(),
            json!({
                "searchTerms": input.search_terms,
                "candidateRows": candidate_rows,
                "boostedRows": boosts.size(),
                "candidateDurationMs": candidate_ms,
                "analyticsDurationMs": analytics_ms,
                "rankDurationMs": rank_ms,
                "candidateDebug": ctx.debug.take().unwrap_or(Value::Null),
                "ranked": ranked_debug,
            }),
        );
    }
    Ok(Value::Object(out))
}

pub async fn handler(State(state): State<RouteState>, method: Method, headers: HeaderMap, raw: Bytes) -> Response {
    if method == Method::OPTIONS {
        return with_cors(StatusCode::NO_CONTENT.into_response());
    }
    if method != Method::POST {
        return with_cors(http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &[("allow", "POST, OPTIONS")]));
    }
    let body = match http::parse_body(&headers, &raw) {
        Ok(body) => body.json(),
        Err(response) => return with_cors(response),
    };
    let body = if js::truthy(Some(&body)) { body } else { json!({}) };
    let started = std::time::Instant::now();
    match search_extension_card(&state, &body).await {
        Ok(payload) => {
            let timing = format!("extension-card-search;dur={}", started.elapsed().as_millis());
            with_cors(http::json_with(StatusCode::OK, payload, &[("cache-control", "public, max-age=5, s-maxage=30"), ("server-timing", &timing)]))
        }
        Err(response) => with_cors(response),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_terms_and_paths() {
        let input = build_extension_search_term(&json!({ "name": "Pikachu card", "collectorNumber": "025/165", "expansion": "151", "rarity": "Illus. Mitsuhiro Arita", "rarityAliases": ["SIR", "Special Illustration Rare"] }));
        assert_eq!(input.source, "structured_fields");
        assert_eq!(input.search_term, "Pikachu 025/165 151");
        assert_eq!(input.search_terms, vec!["Pikachu 025/165 151", "Pikachu 025/165 151 SIR", "Pikachu 025/165 151 Special Illustration Rare"]);
        assert_eq!(clean_extension_query(Some(&json!("Charizard ex Illus. Mitsuhiro Arita"))), "Charizard ex");
        let row = json!({ "card_id": "123", "rarity": "Rare | Holo", "name": "Mew ex", "card_number": "Rare | 151/165", "set_name": "151" });
        assert_eq!(marketplace_path_for_row(&row, "EN"), "/marketplace/en/cards/123/rare-holo-mew-ex-151-165-151");
    }
}
