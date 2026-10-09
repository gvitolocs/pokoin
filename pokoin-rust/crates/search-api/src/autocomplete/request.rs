//! Request parsing and session contexts: the body alias reads of the handler,
//! `cleanSearchContext`, `cleanPredictionContext`, `buildSearchContext`,
//! `candidateLabelsForRows`, `updateDepthScores` / `updateDepthMetadata` and
//! `readQueryForAutocomplete`.

use serde_json::{json, Map, Value};
use std::collections::HashSet;

use super::ladder::{
    autocomplete_candidate_id_applied_limit, autocomplete_candidate_id_ladder,
    clean_context_candidate_id_limit,
};
use super::normalize::{
    clean_language, clean_search_term, compact, js_num_or, js_str_or, js_value_number,
    meaningful_search_depth,
};
use super::row::{get, get_any, str_field};
use super::{analytics, ladder, normalize};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Parsed request of the Node handler (every alias of every field).
#[derive(Clone, Debug)]
pub struct AutocompleteRequest {
    pub search_term: String,
    pub result_limit: i64,
    pub requested_pool_limit: i64,
    pub pool_limit: usize,
    pub search_language: String,
    pub preview_mode: String,
    pub previous_search_context: Option<Value>,
    pub prediction_context: Option<Value>,
    pub search_session_id: String,
    pub wants_debug: bool,
    pub debug_session_id: String,
    pub raw: Value,
}

/// `debugEnabled(req)` — `body.debug === true || body.debug === '1'`.
pub fn debug_enabled(body: &Value) -> bool {
    matches!(get(body, "debug"), Some(Value::Bool(true))) || js_str_or(get(body, "debug")) == "1"
}

/// Parse the POST body exactly like the handler preamble.
pub fn parse_request(body: &Value) -> AutocompleteRequest {
    let search_term = clean_search_term(get_any(body, &["search_term", "searchTerm", "query"]));
    let result_limit = normalize::clean_limit(get_any(body, &["result_limit", "limit"]));
    let requested_pool_limit =
        normalize::clean_limit(get_any(body, &["pool_limit"]).or(Some(&json!(1000))));
    let pool_limit = if !search_term.is_empty() {
        let explicit = get(body, "pool_limit");
        let limit = match explicit {
            Some(value) => normalize::clean_limit(Some(value)),
            None => normalize::clean_limit(Some(&json!(ladder::autocomplete_backend_pool_limit(
                &search_term
            )))),
        };
        usize::try_from(limit)
            .unwrap_or(0)
            .min(autocomplete_candidate_id_applied_limit(&search_term))
    } else {
        ladder::clean_autocomplete_pool_limit(get(body, "pool_limit"))
    };
    let search_language =
        normalize::clean_language(get_any(body, &["search_language", "language"]));
    let preview_mode = clean_search_term(get_any(body, &["preview_mode", "previewMode"]));
    let previous_search_context =
        get_any(body, &["previous_search_context", "previousSearchContext"]).cloned();
    let prediction_context = get_any(
        body,
        &[
            "prediction_context",
            "predictionContext",
            "previous_prediction_context",
            "previousPredictionContext",
        ],
    )
    .cloned();
    let search_session_id = analytics::clean_search_session_id(get_any(
        body,
        &[
            "search_session_id",
            "searchSessionId",
            "session_id",
            "sessionId",
        ],
    ));
    AutocompleteRequest {
        search_term,
        result_limit,
        requested_pool_limit,
        pool_limit,
        search_language,
        preview_mode,
        previous_search_context,
        prediction_context,
        search_session_id,
        wants_debug: debug_enabled(body),
        debug_session_id: clean_search_term(get(body, "debug_session_id")),
        raw: body.clone(),
    }
}

/// `readQueryForAutocomplete(searchTerm, query)` — production keeps the primary
/// marketplace pool for the read query; the choice between the name-search
/// query and the variation query mirrors `shouldAvoidPrimarySearchFallback` and
/// the structured-token probe. The selected engine function is returned so the
/// engine routes the SQL like Node does (`marketplaceNameSearchQuery` vs
/// `marketplaceVariationSearchQuery`).
pub fn read_query_for_autocomplete(search_term: &str) -> ReadQuery {
    let terms = normalize::search_terms(search_term);
    let has_structured_token = terms.iter().any(|term| {
        !term.is_empty() && term.bytes().all(|b| b.is_ascii_digit())
            || super::normalize::is_variation_intent_term(term)
            || super::normalize::is_rarity_term(term)
            || super::normalize::is_expansion_alias_term(term)
    });
    if ladder::should_avoid_primary_search_fallback(search_term) || !has_structured_token {
        ReadQuery::NameSearch
    } else {
        ReadQuery::Variation
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadQuery {
    /// `marketplaceNameSearchQuery` (peer3 name pool / primary fallback).
    NameSearch,
    /// `marketplaceVariationSearchQuery` (replica pool).
    Variation,
}

#[derive(Clone, Debug)]
pub struct ValidSearchContext {
    pub query: String,
    pub language: String,
    pub card_ids: Vec<String>,
    pub depth_scores: super::rank::DepthMap,
    pub latest_depths: super::rank::DepthMap,
    pub latest_orders: super::rank::DepthMap,
}

/// `cleanSearchContext(value, searchTerm, searchLanguage)`.
pub fn clean_search_context(
    value: Option<&Value>,
    search_term: &str,
    search_language: &str,
) -> Result<ValidSearchContext, &'static str> {
    let Some(value) = value.filter(|value| value.is_object()) else {
        return Err("missing_context");
    };
    let previous_query = clean_search_term(get(value, "query"));
    let previous_language = clean_language(get(value, "language"));
    let current_query = clean_search_term(Some(&Value::String(search_term.to_owned())));
    let current_language = clean_language(Some(&Value::String(search_language.to_owned())));
    if previous_query.is_empty()
        || !current_query.starts_with(&previous_query)
        || current_query == previous_query
    {
        return Err("query_not_extended");
    }
    if previous_language != current_language {
        return Err("language_changed");
    }
    let created_at_ms = js_num_or(get_any(value, &["created_at_ms", "createdAtMs"]), 0.0);
    if !created_at_ms.is_finite()
        || created_at_ms <= 0.0
        || now_ms() as f64 - created_at_ms > 60_000.0
    {
        return Err("context_expired");
    }
    let raw_ids = get_any(value, &["card_ids", "cardIds"]);
    let card_ids: Vec<f64> = match raw_ids {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_num_or(Some(item), f64::NAN))
            .filter(|id| {
                id.is_finite() && id.fract() == 0.0 && *id > 0.0 && *id <= 9_007_199_254_740_991.0
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut unique_card_ids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in &card_ids {
        let key = format_number(*id);
        if seen.insert(key.clone()) {
            unique_card_ids.push(key);
        }
    }
    unique_card_ids.truncate(ladder::SEARCH_CONTEXT_MAX_CARD_IDS);
    if unique_card_ids.is_empty() {
        return Err("empty_card_ids");
    }
    if card_ids.len() > ladder::SEARCH_CONTEXT_MAX_CARD_IDS {
        return Err("too_many_card_ids");
    }
    let raw_non_name = get_any(value, &["non_name_context", "nonNameContext"]).cloned();
    let read_map = |parent: Option<&Value>, keys: &[&str]| -> Option<Map<String, Value>> {
        let parent = parent?;
        if !parent.is_object() {
            return None;
        }
        let raw = get_any(parent, keys)?;
        raw.as_object().cloned()
    };
    let mut depth_scores = super::rank::DepthMap::new();
    let mut latest_depths = super::rank::DepthMap::new();
    let mut latest_orders = super::rank::DepthMap::new();
    if let Some(map) = read_map(raw_non_name.as_ref(), &["depth_scores", "depthScores"]) {
        for (raw_id, raw_score) in map {
            let id = js_value_number(&Value::String(raw_id));
            let score = js_value_number(&raw_score);
            if let (Some(id), Some(score)) = (id, score) {
                let key = format_number(id);
                if id.fract() == 0.0
                    && id > 0.0
                    && score.is_finite()
                    && score > 0.0
                    && unique_card_ids.contains(&key)
                {
                    depth_scores.insert(key, score.min(512.0));
                }
            }
        }
    }
    if let Some(map) = read_map(raw_non_name.as_ref(), &["latest_depths", "latestDepths"]) {
        for (raw_id, raw_depth) in map {
            let id = js_value_number(&Value::String(raw_id));
            let depth = js_value_number(&raw_depth);
            if let (Some(id), Some(depth)) = (id, depth) {
                let key = format_number(id);
                if id.fract() == 0.0
                    && id > 0.0
                    && depth.is_finite()
                    && depth > 0.0
                    && unique_card_ids.contains(&key)
                {
                    latest_depths.insert(key, depth.trunc().min(512.0));
                }
            }
        }
    }
    if let Some(map) = read_map(raw_non_name.as_ref(), &["latest_orders", "latestOrders"]) {
        for (raw_id, raw_order) in map {
            let id = js_value_number(&Value::String(raw_id));
            let order = js_value_number(&raw_order);
            if let (Some(id), Some(order)) = (id, order) {
                let key = format_number(id);
                if id.fract() == 0.0
                    && id > 0.0
                    && order.is_finite()
                    && order >= 0.0
                    && unique_card_ids.contains(&key)
                {
                    latest_orders.insert(
                        key,
                        order
                            .trunc()
                            .min(ladder::SEARCH_CONTEXT_MAX_CARD_IDS as f64),
                    );
                }
            }
        }
    }
    Ok(ValidSearchContext {
        query: previous_query,
        language: previous_language,
        card_ids: unique_card_ids,
        depth_scores,
        latest_depths,
        latest_orders,
    })
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

/// `updateDepthScores(previousContext, searchTerm, searchLanguage, rows)`.
pub fn update_depth_scores(
    previous_context: Option<&Value>,
    search_term: &str,
    search_language: &str,
    rows: &[Value],
) -> super::rank::DepthMap {
    let previous = clean_search_context(previous_context, search_term, search_language);
    let mut scores = match previous {
        Ok(previous) => previous.depth_scores,
        Err(_) => super::rank::DepthMap::new(),
    };
    let depth = meaningful_search_depth(search_term);
    if depth == 0 {
        return super::rank::DepthMap::new();
    }
    let mut seen = HashSet::new();
    for row in rows {
        let id = str_field(row, &["card_id"]);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let next = scores.get(&id).copied().unwrap_or(0.0) + depth as f64;
        scores.insert(id, next.min(512.0));
        if seen.len() >= ladder::SEARCH_CONTEXT_MAX_CARD_IDS {
            break;
        }
    }
    scores
}

/// `updateDepthMetadata(previousContext, searchTerm, searchLanguage, rows)`.
pub fn update_depth_metadata(
    previous_context: Option<&Value>,
    search_term: &str,
    search_language: &str,
    rows: &[Value],
) -> (super::rank::DepthMap, super::rank::DepthMap) {
    let previous = clean_search_context(previous_context, search_term, search_language);
    let depth = meaningful_search_depth(search_term);
    let (mut latest_depths, mut latest_orders) = match previous {
        Ok(previous) => (previous.latest_depths, previous.latest_orders),
        Err(_) => (super::rank::DepthMap::new(), super::rank::DepthMap::new()),
    };
    if depth == 0 {
        return (latest_depths, latest_orders);
    }
    let mut seen = HashSet::new();
    let mut order = 0.0;
    for row in rows {
        let id = str_field(row, &["card_id"]);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        seen.insert(id.clone());
        latest_depths.insert(id.clone(), depth as f64);
        latest_orders.insert(id, order);
        order += 1.0;
        if seen.len() >= ladder::SEARCH_CONTEXT_MAX_CARD_IDS {
            break;
        }
    }
    (latest_depths, latest_orders)
}

/// `candidateLabelsForRows(rows, limit)`.
pub fn candidate_labels_for_rows(rows: &[Value], limit: usize) -> Option<Value> {
    if limit == 0 {
        return None;
    }
    let mut labels: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let id = str_field(row, &["card_id", "id"]).trim().to_owned();
        let name = str_field(row, &["name"]).trim().to_owned();
        if id.is_empty() || name.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        seen.insert(id.clone());
        let item_kind = {
            let own = str_field(row, &["item_kind"]);
            if own.is_empty() {
                "single".to_owned()
            } else {
                own
            }
        };
        let product_type = {
            let own = str_field(row, &["product_type"]);
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
            "set_name": str_field(row, &["set_name"]),
            "card_number": str_field(row, &["card_number"]),
            "trainer_name": str_field(row, &["trainer_name"]),
        }));
        if labels.len() >= limit {
            break;
        }
    }
    Some(Value::Array(labels))
}

/// `buildSearchContext(searchTerm, searchLanguage, rows, strategy,
/// previousContext, candidateIdLimit)`. `non_name_context` rides in when the
/// candidate stage attached one (predictive pools).
pub fn build_search_context(
    search_term: &str,
    search_language: &str,
    rows: &[Value],
    strategy: &str,
    previous_context: Option<&Value>,
    candidate_id_limit: Option<usize>,
    non_name_context: Option<&Value>,
) -> Value {
    let limit_value = match candidate_id_limit {
        Some(limit) => json!(limit),
        None => json!(autocomplete_candidate_id_applied_limit(search_term)),
    };
    let context_limit = clean_context_candidate_id_limit(Some(&limit_value));
    let mut card_ids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    if context_limit > 0 {
        for row in rows {
            let id = str_field(row, &["card_id"]);
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            seen.insert(id.clone());
            card_ids.push(id);
            if card_ids.len() >= context_limit {
                break;
            }
        }
    }
    let mut context = json!({
        "query": clean_search_term(Some(&Value::String(search_term.to_owned()))),
        "language": clean_language(Some(&Value::String(search_language.to_owned()))),
        "card_ids": card_ids,
        "created_at_ms": now_ms() as f64,
        "strategy": strategy,
        "candidate_id_ladder": autocomplete_candidate_id_ladder(search_term),
    });
    let depth_scores = update_depth_scores(previous_context, search_term, search_language, rows);
    let (latest_depths, latest_orders) =
        update_depth_metadata(previous_context, search_term, search_language, rows);
    let non_name = non_name_context
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut scoped_depth_scores = Map::new();
    let mut scoped_latest_depths = Map::new();
    let mut scoped_latest_orders = Map::new();
    for id in &card_ids {
        if let Some(score) = depth_scores.get(id).filter(|score| **score > 0.0) {
            scoped_depth_scores.insert(id.clone(), json!(score));
        }
        if let Some(depth) = latest_depths.get(id).filter(|depth| **depth > 0.0) {
            scoped_latest_depths.insert(id.clone(), json!(depth));
        }
        if latest_orders.contains_key(id) {
            scoped_latest_orders.insert(id.clone(), json!(latest_orders[id]));
        }
    }
    let mut non_name = Some(non_name);
    if let Some(Value::Object(map)) = non_name.as_mut() {
        if !scoped_depth_scores.is_empty() {
            map.insert("depth_scores".into(), Value::Object(scoped_depth_scores));
            map.insert("depth_unit".into(), json!("meaningful_query_character"));
        }
        if !scoped_latest_depths.is_empty() {
            map.insert("latest_depths".into(), Value::Object(scoped_latest_depths));
        }
        if !scoped_latest_orders.is_empty() {
            map.insert("latest_orders".into(), Value::Object(scoped_latest_orders));
        }
        if map.is_empty() {
            non_name = None;
        }
    }
    let non_name = non_name.unwrap_or(Value::Null);
    if let Value::Object(map) = &mut context {
        let has_non_name = non_name
            .as_object()
            .map(|map| !map.is_empty())
            .unwrap_or(false);
        if has_non_name {
            map.insert("non_name_context".into(), non_name);
        }
    }
    if let Some(labels) =
        candidate_labels_for_rows(rows, if context_limit > 0 { context_limit } else { 0 })
    {
        if labels
            .as_array()
            .map(|labels| !labels.is_empty())
            .unwrap_or(false)
        {
            if let Value::Object(map) = &mut context {
                map.insert("candidate_labels".into(), labels);
            }
        }
    }
    context
}

#[derive(Clone, Debug)]
pub struct ValidPredictionContext {
    pub normalized_fragment: String,
    pub language: String,
    pub candidates: Vec<Value>,
}

/// `cleanPredictionContext(value, searchTerm, searchLanguage)`.
pub fn clean_prediction_context(
    value: Option<&Value>,
    search_term: &str,
    search_language: &str,
) -> Result<ValidPredictionContext, &'static str> {
    let Some(value) = value.filter(|value| value.is_object()) else {
        return Err("missing_context");
    };
    let previous_language = clean_language(get_any(value, &["language", "search_language"]));
    let current_language = clean_language(Some(&Value::String(search_language.to_owned())));
    if previous_language != current_language {
        return Err("language_changed");
    }
    let normalized_fragment = compact(&js_str_or(get_any(
        value,
        &[
            "normalized_fragment",
            "normalizedFragment",
            "prediction_fragment",
            "predictionFragment",
            "fragment",
            "query",
        ],
    )));
    let query_compact = compact(search_term);
    if normalized_fragment.is_empty() || !query_compact.starts_with(&normalized_fragment) {
        return Err("fragment_not_in_query");
    }
    let created_at_ms = js_num_or(get_any(value, &["created_at_ms", "createdAtMs"]), 0.0);
    if !created_at_ms.is_finite()
        || created_at_ms <= 0.0
        || now_ms() as f64 - created_at_ms > 60_000.0
    {
        return Err("context_expired");
    }
    let raw_candidates: Vec<Value> = match get(value, "candidates") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let mut candidates: Vec<Value> = Vec::new();
    for (index, candidate) in raw_candidates.iter().enumerate() {
        if !candidate.is_object() {
            continue;
        }
        let display = js_str_or(get_any(candidate, &["display_token", "display"]))
            .trim()
            .to_owned();
        let normalized = {
            let explicit = js_str_or(get_any(candidate, &["normalized_token", "normalized"]));
            if explicit.is_empty() {
                compact(&display)
            } else {
                compact(&explicit)
            }
        };
        if display.is_empty() || normalized.is_empty() {
            continue;
        }
        let candidate_card_ids = super::rank::prediction_candidate_card_ids(candidate, 64);
        let representative_card_ids: Vec<String> = match get(candidate, "representative_card_ids") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| js_str_or(Some(item)).trim().to_owned())
                .filter(|id| !id.is_empty())
                .take(64)
                .collect(),
            _ => candidate_card_ids.iter().take(8).cloned().collect(),
        };
        let ids_count_default = candidate_card_ids.len().max(representative_card_ids.len()) as f64;
        let candidate_language = {
            let own = js_str_or(get(candidate, "language"));
            if own.is_empty() {
                previous_language.clone()
            } else {
                own
            }
        };
        let candidate_prefix = {
            let own = js_str_or(get(candidate, "matched_prefix"));
            if own.is_empty() {
                normalized_fragment.clone()
            } else {
                own
            }
        };
        candidates.push(json!({
            "normalized": normalized,
            "normalized_token": normalized,
            "display": display,
            "display_token": display,
            "confidence": js_num_or(get(candidate, "confidence"), 0.0),
            "score": js_num_or(get(candidate, "score"), 0.0),
            "source_rank": js_num_or(
                get_any(candidate, &["source_rank", "sourceRank"]),
                (index + 1) as f64,
            ),
            "language": candidate_language,
            "matched_prefix": candidate_prefix,
            "ids_count": js_num_or(
                get_any(candidate, &["ids_count", "idsCount"]),
                ids_count_default,
            ),
            "card_count": js_num_or(
                get_any(candidate, &["card_count", "cardCount"]),
                ids_count_default,
            ),
            "representative_card_ids": representative_card_ids,
            "candidate_card_ids": if candidate_card_ids.is_empty() {
                Value::Array(representative_card_ids.into_iter().map(Value::String).collect())
            } else {
                Value::Array(candidate_card_ids.into_iter().map(Value::String).collect())
            },
        }));
        if candidates.len() >= ladder::SUPABASE_PREDICTED_NAME_TOKEN_LIMIT {
            break;
        }
    }
    if candidates.is_empty() {
        return Err("empty_candidates");
    }
    Ok(ValidPredictionContext {
        normalized_fragment,
        language: previous_language,
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::rank::tokens_for_query;
    use serde_json::json;

    #[test]
    fn request_aliases_and_limits() {
        let request = parse_request(&json!({"search_term": "  pikachu  ", "result_limit": 10}));
        assert_eq!(request.search_term, "pikachu");
        assert_eq!(request.result_limit, 10);
        assert_eq!(request.requested_pool_limit, 1000);
        assert_eq!(request.pool_limit, 500);
        assert_eq!(request.search_language, "en");
        assert!(!request.wants_debug);
    }

    #[test]
    fn request_reads_every_alias() {
        let request = parse_request(&json!({
            "query": "charizard ex",
            "limit": "3",
            "pool_limit": 250,
            "language": "en",
            "previewMode": "name",
            "previousSearchContext": {"query": "char", "card_ids": [1]},
            "predictionContext": {"candidates": []},
            "sessionId": "abcd-1234-abcd",
            "debug": "1",
        }));
        assert_eq!(request.search_term, "charizard ex");
        assert_eq!(request.result_limit, 3);
        assert_eq!(request.pool_limit, 250);
        assert_eq!(request.preview_mode, "name");
        assert!(request.wants_debug);
        assert_eq!(request.search_session_id, "abcd-1234-abcd");
        assert!(request.previous_search_context.is_some());
        assert!(request.prediction_context.is_some());
    }

    #[test]
    fn pool_limit_zero_is_honoured_like_js() {
        // `req.body?.pool_limit ?? backend` keeps an explicit 0 (cleanLimit(0)=1).
        let request = parse_request(&json!({"search_term": "pikachu", "pool_limit": 0}));
        assert_eq!(request.pool_limit, 1);
        let empty = parse_request(&json!({}));
        assert_eq!(empty.pool_limit, 1000);
    }

    #[test]
    fn debug_flag_needs_true_or_one() {
        assert!(debug_enabled(&json!({"debug": true})));
        assert!(debug_enabled(&json!({"debug": "1"})));
        assert!(!debug_enabled(&json!({"debug": "true"})));
        assert!(!debug_enabled(&json!({})));
    }

    #[test]
    fn search_context_validates_extension_and_expiry() {
        let now = now_ms() as f64;
        let context = json!({
            "query": "pika",
            "language": "en",
            "card_ids": [10, 20, 20, 30],
            "created_at_ms": now,
            "non_name_context": {"depth_scores": {"10": 3, "999": 1}, "latest_orders": {"10": 0, "20": 1}},
        });
        let valid = clean_search_context(Some(&context), "pikachu", "en").expect("valid");
        assert_eq!(valid.query, "pika");
        assert_eq!(valid.card_ids, vec!["10", "20", "30"]);
        assert_eq!(valid.depth_scores.get("10"), Some(&3.0));
        assert!(!valid.depth_scores.contains_key("999"));
        assert!(valid.latest_orders.contains_key("10"));
        assert!(valid.latest_orders.contains_key("20"));

        assert_eq!(
            clean_search_context(Some(&context), "pika", "en").unwrap_err(),
            "query_not_extended"
        );
        assert_eq!(
            clean_search_context(Some(&context), "charizard", "en").unwrap_err(),
            "query_not_extended"
        );
        assert_eq!(
            clean_search_context(Some(&context), "pikachu", "ja").unwrap_err(),
            "language_changed"
        );
        let stale = json!({
            "query": "pika", "language": "en", "card_ids": [10], "created_at_ms": now - 120_000.0,
        });
        assert_eq!(
            clean_search_context(Some(&stale), "pikachu", "en").unwrap_err(),
            "context_expired"
        );
        assert_eq!(
            clean_search_context(None, "pikachu", "en").unwrap_err(),
            "missing_context"
        );
        let no_ids =
            json!({"query": "pika", "language": "en", "card_ids": [], "created_at_ms": now});
        assert_eq!(
            clean_search_context(Some(&no_ids), "pikachu", "en").unwrap_err(),
            "empty_card_ids"
        );
    }

    #[test]
    fn depth_updates_accumulate_with_a_cap() {
        let now = now_ms() as f64;
        let context = json!({
            "query": "pika", "language": "en", "card_ids": [10, 20],
            "created_at_ms": now,
            "non_name_context": {"depth_scores": {"10": 510}},
        });
        let rows = vec![json!({"card_id": 10}), json!({"card_id": 30})];
        let scores = update_depth_scores(Some(&context), "pikachu", "en", &rows);
        assert_eq!(scores.get("10"), Some(&(512.0))); // 510 + 7 capped
        assert_eq!(scores.get("30"), Some(&7.0));
        let (depths, orders) = update_depth_metadata(Some(&context), "pikachu", "en", &rows);
        assert_eq!(depths.get("10"), Some(&7.0));
        assert_eq!(orders.get("30"), Some(&1.0));
    }

    #[test]
    fn prediction_context_requires_fragment_and_candidates() {
        let now = now_ms() as f64;
        let context = json!({
            "language": "en",
            "normalized_fragment": "pika",
            "created_at_ms": now,
            "candidates": [
                {"display": "Pikachu", "normalized": "pikachu", "confidence": 90,
                 "representative_card_ids": ["11", "22"]},
                {"display_token": "", "normalized": "x"},
            ],
        });
        let valid = clean_prediction_context(Some(&context), "pikachu vmax", "en").expect("valid");
        assert_eq!(valid.normalized_fragment, "pika");
        assert_eq!(valid.candidates.len(), 1);
        assert_eq!(valid.candidates[0]["source_rank"], 1.0);
        assert_eq!(valid.candidates[0]["matched_prefix"], "pika");
        assert_eq!(
            clean_prediction_context(Some(&context), "charizard", "en").unwrap_err(),
            "fragment_not_in_query"
        );
        assert_eq!(
            clean_prediction_context(Some(&context), "pikachu", "ja").unwrap_err(),
            "language_changed"
        );
    }

    #[test]
    fn context_builds_card_ids_ladder_and_labels() {
        let rows = (1..=5)
            .map(|index| json!({"card_id": index, "name": format!("Card {index}")}))
            .collect::<Vec<_>>();
        let context =
            build_search_context("pikachu", "en", &rows, "ranked_pool", None, Some(3), None);
        assert_eq!(context["card_ids"], json!(["1", "2", "3"]));
        assert_eq!(context["strategy"], "ranked_pool");
        assert_eq!(context["candidate_id_ladder"]["appliedLimit"], 500);
        assert_eq!(
            context["candidate_labels"]
                .as_array()
                .map(|labels| labels.len()),
            Some(3)
        );
        assert_eq!(
            context["non_name_context"]["depth_unit"],
            "meaningful_query_character"
        );
    }

    #[test]
    fn read_query_follows_the_structured_probe() {
        assert_eq!(
            read_query_for_autocomplete("pikachu"),
            ReadQuery::NameSearch
        );
        assert_eq!(read_query_for_autocomplete("p"), ReadQuery::NameSearch);
        // depth > 2 + a variation token selects the variation query (JS parity).
        assert_eq!(
            read_query_for_autocomplete("charizard ex"),
            ReadQuery::Variation
        );
        assert_eq!(
            read_query_for_autocomplete("charizard vmax"),
            ReadQuery::Variation
        );
        assert_eq!(
            read_query_for_autocomplete("151 pikachu"),
            ReadQuery::Variation
        );
        assert_eq!(read_query_for_autocomplete("ex p"), ReadQuery::Variation);
        // depth <= 2 always avoids the variation query
        assert_eq!(read_query_for_autocomplete("e p"), ReadQuery::NameSearch);
        assert_eq!(read_query_for_autocomplete("v 2"), ReadQuery::NameSearch);
    }

    #[test]
    fn labels_never_exceed_the_limit() {
        let rows: Vec<Value> = (0..10)
            .map(|index| json!({"card_id": index, "name": format!("N{index}")}))
            .collect();
        let labels = candidate_labels_for_rows(&rows, 4).expect("labels");
        assert_eq!(labels.as_array().unwrap().len(), 4);
        assert!(candidate_labels_for_rows(&rows, 0).is_none());
    }

    #[test]
    fn tokens_plan_reuses_the_kind_table() {
        let tokens = tokens_for_query("charizard ex");
        assert_eq!(tokens[0].kind, "text");
        assert_eq!(tokens[1].kind, "variation");
    }

}
