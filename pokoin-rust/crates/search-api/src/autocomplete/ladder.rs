//! Candidate-id ladder, analytics gating and timeout budgets
//! (`autocompleteCandidateId*`, `shouldSkipAnalyticsForSearchTerm`,
//! `shouldAvoidPrimarySearchFallback`, `cleanAutocompletePoolLimit`,
//! `nameSearchTimeoutMs`, `nameSearchCircuitMs`, `dimensionSearchTimeoutMs`).

use serde_json::json;

use super::normalize::meaningful_search_depth;

pub const AUTOCOMPLETE_PREVIEW_ROW_LIMIT: usize = 20;
pub const AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT: usize = 500;
pub const AUTOCOMPLETE_CANDIDATE_ID_FLOOR: usize = 500;
pub const AUTOCOMPLETE_SQL_SAFE_POOL_CAP: usize = 5_000;
pub const SEARCH_CONTEXT_MAX_CARD_IDS: usize = 10_000;
pub const SHORT_PREFIX_ANALYTICS_MAX_DEPTH: i64 = 1;
pub const SUPABASE_NAME_INDEX_MAX_DEPTH: usize = 12;
pub const SUPABASE_VISIBLE_HYDRATION_LIMIT: usize = 60;
pub const SUPABASE_PREDICTED_NAME_TOKEN_LIMIT: usize = 20;
pub const SUPABASE_PREDICTED_NAME_SCAN_LIMIT: usize = 240;
pub const SUPABASE_ONE_CHAR_NAME_SCAN_LIMIT: usize = 1000;
pub const HOT_PREVIEW_POOL_TTL_MS: u64 = 60_000;

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name).ok().and_then(|raw| {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        pokoin_api_common::http::js_number(raw).filter(|value| value.is_finite())
    })
}

fn clamp_f64(value: f64, min: i64, max: i64) -> i64 {
    (value.trunc() as i64).clamp(min, max)
}

/// `autocompleteCandidateIdRequestedLimit(searchTerm)`.
pub fn autocomplete_candidate_id_requested_limit(search_term: &str) -> usize {
    let depth = meaningful_search_depth(search_term);
    match depth {
        0 | 1 => 0,
        2 => 5_000,
        3 => 2_500,
        4 => 1_250,
        _ => AUTOCOMPLETE_CANDIDATE_ID_FLOOR,
    }
}

/// `autocompleteBackendPoolLimit(searchTerm)`.
pub fn autocomplete_backend_pool_limit(search_term: &str) -> usize {
    let requested = autocomplete_candidate_id_requested_limit(search_term);
    if requested > 0 {
        requested
    } else {
        AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT
    }
}

/// `autocompleteCandidateIdAppliedLimit(searchTerm)`.
pub fn autocomplete_candidate_id_applied_limit(search_term: &str) -> usize {
    autocomplete_backend_pool_limit(search_term).min(AUTOCOMPLETE_SQL_SAFE_POOL_CAP)
}

/// `autocompleteCandidateIdLadder(searchTerm)` — the JSON shape the handler
/// returns in `search_context.candidate_id_ladder` and `debug`.
pub fn autocomplete_candidate_id_ladder(search_term: &str) -> serde_json::Value {
    json!({
        "depth": meaningful_search_depth(search_term),
        "requestedLimit": autocomplete_candidate_id_requested_limit(search_term),
        "appliedLimit": autocomplete_candidate_id_applied_limit(search_term),
        "floor": AUTOCOMPLETE_CANDIDATE_ID_FLOOR,
        "safeCap": AUTOCOMPLETE_SQL_SAFE_POOL_CAP,
    })
}

/// `shouldSkipAnalyticsForSearchTerm(searchTerm)` — depth 1 by default,
/// env-clamped to 0..=2.
pub fn should_skip_analytics_for_search_term(search_term: &str) -> bool {
    let depth = meaningful_search_depth(search_term) as i64;
    let configured = env_f64("MARKETPLACE_SHORT_PREFIX_ANALYTICS_MAX_DEPTH")
        .map(|max| clamp_f64(max, 0, 2))
        .unwrap_or(SHORT_PREFIX_ANALYTICS_MAX_DEPTH);
    depth > 0 && depth <= configured
}

/// `shouldAvoidPrimarySearchFallback(searchTerm)` — depths 1..=2.
pub fn should_avoid_primary_search_fallback(search_term: &str) -> bool {
    let depth = meaningful_search_depth(search_term) as i64;
    depth > 0 && depth <= 2
}

/// `cleanAutocompletePoolLimit(value)` — `cleanLimit(value ?? 1000)` clamped to
/// 100..=5000.
pub fn clean_autocomplete_pool_limit(value: Option<&serde_json::Value>) -> usize {
    // `cleanLimit(value ?? 1000)`: an absent field is 1000; an explicit null
    // is Number(null)=0 -> 1.
    let fallback = match value {
        None => serde_json::json!(1000),
        Some(value) => value.clone(),
    };
    let limit = super::normalize::clean_limit(Some(&fallback));
    limit.clamp(100, AUTOCOMPLETE_SQL_SAFE_POOL_CAP as i64) as usize
}

/// `structuredAutocompleteTokenLimit(value)`.
pub fn structured_autocomplete_token_limit(value: Option<&serde_json::Value>) -> i64 {
    super::normalize::clean_limit(value.or(Some(&json!(15_874))))
}

/// `cleanContextCandidateIdLimit(value)`.
pub fn clean_context_candidate_id_limit(value: Option<&serde_json::Value>) -> usize {
    let raw = match value {
        None | Some(serde_json::Value::Null) => return SEARCH_CONTEXT_MAX_CARD_IDS,
        Some(value) => super::normalize::js_value_number(value),
    };
    match raw {
        Some(limit) if limit.is_finite() => {
            limit.trunc().clamp(0.0, SEARCH_CONTEXT_MAX_CARD_IDS as f64) as usize
        }
        _ => SEARCH_CONTEXT_MAX_CARD_IDS,
    }
}

/// `nameSearchTimeoutMs()` — production runs 4000.
pub fn name_search_timeout_ms() -> u64 {
    env_f64("MARKETPLACE_NAME_SEARCH_TIMEOUT_MS")
        .map(|value| clamp_f64(value, 250, 5000) as u64)
        .unwrap_or(1500)
}

/// `nameSearchCircuitMs()` — production runs 60000.
pub fn name_search_circuit_ms() -> u64 {
    env_f64("MARKETPLACE_NAME_SEARCH_CIRCUIT_MS")
        .map(|value| clamp_f64(value, 5_000, 300_000) as u64)
        .unwrap_or(60_000)
}

/// `dimensionSearchTimeoutMs()`.
pub fn dimension_search_timeout_ms() -> u64 {
    env_f64("MARKETPLACE_DIMENSION_SEARCH_TIMEOUT_MS")
        .map(|value| clamp_f64(value, 250, 5000) as u64)
        .unwrap_or(1200)
}

/// `variationSearchTimeoutMs()` of `marketplace-search-candidates.js`.
pub fn variation_search_timeout_ms() -> u64 {
    env_f64("MARKETPLACE_VARIATION_SEARCH_TIMEOUT_MS")
        .map(|value| clamp_f64(value, 250, 5000) as u64)
        .unwrap_or(1500)
}

/// `variationSearchCircuitMs()`.
pub fn variation_search_circuit_ms() -> u64 {
    env_f64("MARKETPLACE_VARIATION_SEARCH_CIRCUIT_MS")
        .map(|value| clamp_f64(value, 5_000, 300_000) as u64)
        .unwrap_or(60_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ladder_matches_the_depth_bands() {
        assert_eq!(autocomplete_candidate_id_requested_limit(""), 0);
        assert_eq!(autocomplete_candidate_id_requested_limit("p"), 0);
        assert_eq!(autocomplete_candidate_id_requested_limit("pi"), 5_000);
        assert_eq!(autocomplete_candidate_id_requested_limit("151"), 2_500);
        assert_eq!(autocomplete_candidate_id_requested_limit("sv 25"), 1_250);
        assert_eq!(autocomplete_candidate_id_requested_limit("pikachu"), 500);
        assert_eq!(
            autocomplete_candidate_id_requested_limit("charizard ex"),
            500
        );
        let ladder = autocomplete_candidate_id_ladder("pikachu");
        assert_eq!(ladder["depth"], 7);
        assert_eq!(ladder["requestedLimit"], 500);
        assert_eq!(ladder["appliedLimit"], 500);
        assert_eq!(ladder["floor"], 500);
        assert_eq!(ladder["safeCap"], 5000);
    }

    #[test]
    fn backend_pool_limit_falls_back_to_one_char_floor() {
        assert_eq!(autocomplete_backend_pool_limit("p"), 500);
        assert_eq!(autocomplete_backend_pool_limit("pika"), 1_250);
        assert_eq!(
            autocomplete_candidate_id_applied_limit("pi"),
            AUTOCOMPLETE_SQL_SAFE_POOL_CAP.min(5_000)
        );
    }

    #[test]
    fn pool_limit_clamps_to_100_5000() {
        assert_eq!(clean_autocomplete_pool_limit(Some(&json!(1000))), 1000);
        assert_eq!(clean_autocomplete_pool_limit(Some(&json!(10))), 100);
        assert_eq!(clean_autocomplete_pool_limit(Some(&json!(99_999))), 5000);
        assert_eq!(clean_autocomplete_pool_limit(Some(&json!("bad"))), 100); // Number("bad")=NaN -> 20 -> clamp 100
        assert_eq!(clean_autocomplete_pool_limit(None), 1000);
    }

    #[test]
    fn timeout_budgets_read_the_production_env() {
        // Production: MARKETPLACE_NAME_SEARCH_TIMEOUT_MS=4000, CIRCUIT=60000.
        let budget = if std::env::var("MARKETPLACE_NAME_SEARCH_TIMEOUT_MS").is_ok() {
            name_search_timeout_ms()
        } else {
            1500
        };
        assert!((250..=5000).contains(&budget));
        assert!(name_search_circuit_ms() >= 5000);
        assert!(dimension_search_timeout_ms() >= 250);
    }

    #[test]
    fn context_limit_keeps_the_cap() {
        assert_eq!(clean_context_candidate_id_limit(Some(&json!(50))), 50);
        assert_eq!(
            clean_context_candidate_id_limit(Some(&json!(999_999))),
            10_000
        );
        assert_eq!(clean_context_candidate_id_limit(Some(&json!(-4))), 0);
        assert_eq!(clean_context_candidate_id_limit(Some(&json!("x"))), 10_000);
        assert_eq!(clean_context_candidate_id_limit(None), 10_000);
    }
}
