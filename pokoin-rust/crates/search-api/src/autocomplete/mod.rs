//! `POST, OPTIONS /api/marketplace-autocomplete` — native port of the live
//! Node handler `.reference-node/api/marketplace-autocomplete.js` (and the
//! helpers it requires: `_marketplace_row.js`, `_marketplace_canonical_path.js`,
//! `_marketplace_card_emoji.js`, `_searchbar_session.js`, `_search_debug_auth.js`,
//! `_marketplace_search_engine.js`, the `_marketplace_db` pools it reads through
//! and the redis-engine path of `marketplace-search-candidates.js`).
//!
//! Production runs `MARKETPLACE_SEARCH_ENGINE=redis`, so the engine branch the
//! handler actually serves (`useMeiliSearchForLanguage`) queries RediSearch and
//! hydrates the candidate ids from `marketplace_search_candidates`; the Meili
//! HTTP path is dead code in production and is intentionally absent.
//!
//! File map (mirrors the sections of the 7k-line JS file):
//! - `normalize` — `compact`, `searchTerms`, variation/rarity/expansion vocab,
//!   fuzzy distance, n-gram chunks (`cleanSearchTerm`/`cleanLimit`/`cleanLanguage`
//!   of `marketplace-search-candidates.js`).
//! - `ladder` — candidate-id ladder + analytics skip + timeout budgets.
//! - `row` — `normalizeMarketplaceRow`, canonical paths, card emoji fields,
//!   theme packs (`vt`).
//! - `rank` — token plans, `scoreRow`, ranking, predictive merges, shard plans.
//! - `request` — body parsing, search/prediction contexts, depth bookkeeping.
//! - `engine` — pools, SQL, RediSearch, Supabase (Postgres + REST), circuits.
//! - `analytics` — searchbar session cancel state, personalization, boosts.
//! - `handler` — axum entrypoints and the response envelopes.

pub mod analytics;
pub mod engine;
pub mod handler;
pub mod ladder;
pub mod normalize;
pub mod rank;
pub mod request;
pub mod row;

use axum::{routing::post, Router};
use pokoin_api_common::RouteState;

/// Routes owned by this module: `POST, OPTIONS /api/marketplace-autocomplete`.
pub fn routes() -> Router<RouteState> {
    Router::new().route(
        "/api/marketplace-autocomplete",
        post(handler::autocomplete)
            .options(handler::preflight)
            .fallback(handler::method_not_allowed),
    )
}

/// CORS headers of the Node handler (`setCorsHeaders`).
pub const CORS_HEADERS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "POST, OPTIONS"),
    (
        "access-control-allow-headers",
        "Content-Type, Authorization",
    ),
    ("access-control-max-age", "86400"),
];

#[cfg(test)]
mod fixture_parity {
    //! Parity tests against answers captured from the live endpoint
    //! (`https://api.pokoin.com/api/marketplace-autocomplete`, 2026-10-08).
    //! Production runs the redis engine; the fixtures pin the request
    //! parsing/limits, the response envelope and the ranking of the live
    //! candidate rows.

    use crate::autocomplete::ladder::autocomplete_candidate_id_ladder;
    use crate::autocomplete::rank::{rank_autocomplete_rows, score_row};
    use crate::autocomplete::request::parse_request;
    use crate::autocomplete::row::str_field;
    use serde_json::Value;

    fn live_fixture(file: &str) -> Value {
        let embedded: &[(&str, &str)] = &[
            (
                "live-pikachu.json",
                include_str!("fixtures/live-pikachu.json"),
            ),
            (
                "live-charizard_ex.json",
                include_str!("fixtures/live-charizard_ex.json"),
            ),
            (
                "live-umbreon_vmax.json",
                include_str!("fixtures/live-umbreon_vmax.json"),
            ),
            ("live-151.json", include_str!("fixtures/live-151.json")),
            ("live-sv_25.json", include_str!("fixtures/live-sv_25.json")),
            (
                "live-moonbreon.json",
                include_str!("fixtures/live-moonbreon.json"),
            ),
            ("live-pika.json", include_str!("fixtures/live-pika.json")),
            (
                "live-empty-body.json",
                include_str!("fixtures/live-empty-body.json"),
            ),
            (
                "live-preview-name.json",
                include_str!("fixtures/live-preview-name.json"),
            ),
            ("live-ja.json", include_str!("fixtures/live-ja.json")),
            (
                "live-debug-unauth.json",
                include_str!("fixtures/live-debug-unauth.json"),
            ),
            (
                "score-parity.json",
                include_str!("fixtures/score-parity.json"),
            ),
        ];
        let raw = embedded
            .iter()
            .find(|(name, _)| *name == file)
            .unwrap_or_else(|| panic!("unknown fixture {file}"))
            .1;
        serde_json::from_str(raw).unwrap_or_else(|error| panic!("fixture {file}: {error}"))
    }

    fn envelope(file: &str, search_term: &str, result_limit: i64) {
        let body = live_fixture(file);
        // The exact response envelope of the search pipeline (non-debug).
        let mut keys: Vec<&str> = body
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["pool", "rows", "search_context", "search_language"],
            "{file}"
        );
        assert_eq!(body["search_language"], "en");
        let rows = body["rows"].as_array().expect("rows");
        assert!(rows.len() <= result_limit as usize, "{file}");
        // pool limits follow the candidate ladder
        let request = parse_request(&serde_json::json!({
            "search_term": search_term, "result_limit": result_limit,
        }));
        assert_eq!(request.pool_limit, body["pool"]["limit"], "{file}");
        assert_eq!(
            request.requested_pool_limit, body["pool"]["requestedLimit"],
            "{file}"
        );
        let ladder = autocomplete_candidate_id_ladder(search_term);
        assert_eq!(
            ladder["requestedLimit"], body["pool"]["candidateIdLimit"],
            "{file}"
        );
        assert_eq!(
            ladder["appliedLimit"], body["pool"]["appliedCandidateIdLimit"],
            "{file}"
        );
        assert_eq!(
            ladder["depth"], body["search_context"]["candidate_id_ladder"]["depth"],
            "{file}"
        );
        assert_eq!(
            (result_limit as usize)
                .min(crate::autocomplete::ladder::AUTOCOMPLETE_PREVIEW_ROW_LIMIT),
            body["pool"]["previewLimit"],
            "{file}"
        );
        // context shape
        assert_eq!(body["search_context"]["query"], search_term);
        assert_eq!(body["search_context"]["language"], "en");
        assert!(
            body["search_context"]["created_at_ms"]
                .as_f64()
                .unwrap_or(0.0)
                > 0.0
        );
        // every row carries the stamped identity fields
        for row in rows {
            assert!(row["cardIdentityEmojis"].is_array(), "{file}");
            assert!(row["isMarketAvailable"].is_boolean(), "{file}");
            assert!(
                row["canonicalPath"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("/marketplace/en/cards/"),
                "{file}"
            );
        }
    }

    #[test]
    fn pikachu_envelope_and_ladder() {
        envelope("live-pikachu.json", "pikachu", 10);
    }

    #[test]
    fn charizard_ex_envelope_and_ladder() {
        envelope("live-charizard_ex.json", "charizard ex", 10);
    }

    #[test]
    fn umbreon_vmax_envelope_and_ladder() {
        envelope("live-umbreon_vmax.json", "umbreon vmax", 10);
    }

    #[test]
    fn numeric_151_envelope_and_ladder() {
        envelope("live-151.json", "151", 10);
    }

    #[test]
    fn pika_envelope_and_ladder() {
        envelope("live-pika.json", "pika", 10);
    }

    #[test]
    fn empty_pools_for_sv_25_and_moonbreon() {
        for (file, term) in [
            ("live-sv_25.json", "sv 25"),
            ("live-moonbreon.json", "moonbreon"),
        ] {
            let body = live_fixture(file);
            assert_eq!(body["rows"], serde_json::json!([]), "{file}");
            assert_eq!(body["pool"]["size"], 0, "{file}");
            assert_eq!(body["pool"]["source"], "search_pipeline", "{file}");
            let request =
                parse_request(&serde_json::json!({"search_term": term, "result_limit": 10}));
            assert_eq!(request.pool_limit, body["pool"]["limit"], "{file}");
            assert_eq!(
                autocomplete_candidate_id_ladder(term)["depth"],
                body["search_context"]["candidate_id_ladder"]["depth"],
                "{file}"
            );
        }
    }

    #[test]
    fn ranked_order_is_consistent_with_the_live_rows() {
        // The live order ranks by relevanceScore + analyticsBoost (boost
        // capped at 1800) + depth boosts. With no previous context the depth
        // terms are zero, so for every adjacent live pair:
        //   relevance[i] >= relevance[i+1] - 1800.
        // Relevance ties may still be reordered by live boosts, so exact
        // order is only asserted where the score gap exceeds the cap.
        for (file, term) in [
            ("live-pikachu.json", "pikachu"),
            ("live-charizard_ex.json", "charizard ex"),
            ("live-umbreon_vmax.json", "umbreon vmax"),
            ("live-151.json", "151"),
            ("live-pika.json", "pika"),
        ] {
            let body = live_fixture(file);
            let rows: Vec<Value> = body["rows"].as_array().expect("rows").clone();
            if rows.len() < 2 {
                continue;
            }
            let normalized_query =
                crate::autocomplete::normalize::normalize_variation_phrases(term).to_lowercase();
            let scores: Vec<f64> = rows
                .iter()
                .map(|row| score_row(row, &normalized_query))
                .collect();
            for index in 0..rows.len() - 1 {
                assert!(
                    scores[index] >= scores[index + 1] - 1800.0,
                    "{file}: live order contradicts relevance at {index} ({} >= {} - 1800)",
                    scores[index],
                    scores[index + 1]
                );
                if scores[index] - scores[index + 1] > 1800.0 {
                    let live_first = str_field(&rows[index], &["card_id"]);
                    let my_first = {
                        let ranked = rank_autocomplete_rows(
                            rows.clone(),
                            term,
                            1,
                            &crate::autocomplete::analytics::empty_analytics_boosts(),
                            &Default::default(),
                            &Default::default(),
                            &Default::default(),
                        );
                        str_field(&ranked[0], &["card_id"])
                    };
                    assert_eq!(
                        live_first, my_first,
                        "{file}: unambiguous top row reordered"
                    );
                    break;
                }
            }
        }
    }

    #[test]
    fn score_row_matches_the_live_debug_ranked_entries() {
        // score-parity.json rows come from the live `debug.ranked` payload of
        // `{"search_term":"charizard ex","result_limit":3,"debug":true}`
        // (captured unauthenticated: relevanceScore is auth-independent).
        let entries = live_fixture("score-parity.json");
        for entry in entries.as_array().expect("entries") {
            let row = serde_json::json!({
                "card_id": entry["card_id"],
                "name": entry["name"],
                "set_name": entry["set_name"],
                "card_number": entry["card_number"],
                "rarity": entry["rarity"],
                "product_variant": entry["product_variant"],
                "item_kind": entry["item_kind"],
                "product_type": "card",
                "card_type": "Trading card",
                "search_rank": entry["db_rank"],
            });
            let expected = entry["relevanceScore"].as_f64().expect("relevanceScore");
            assert_eq!(
                score_row(&row, "charizard ex"),
                expected,
                "score mismatch for {}",
                entry["card_id"]
            );
        }
    }

    #[test]
    fn debug_envelope_keys_match_the_live_debug_capture() {
        let body = live_fixture("live-debug-unauth.json");
        let mut keys: Vec<&str> = body
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["debug", "rows", "search_context", "search_language"]
        );
        let debug_keys: Vec<&str> = body["debug"]
            .as_object()
            .expect("debug")
            .keys()
            .map(String::as_str)
            .collect();
        for expected in [
            "sessionId",
            "user",
            "debugAuthError",
            "searchTerm",
            "poolTerm",
            "resultLimit",
            "poolLimit",
            "requestedPoolLimit",
            "searchLanguage",
            "searchPath",
            "poolSource",
            "poolSize",
            "candidateIdLimit",
            "appliedCandidateIdLimit",
            "candidateIdLadder",
            "replicaPath",
            "replicaFallback",
            "durationMs",
            "candidateDurationMs",
            "analyticsDurationMs",
            "rankDurationMs",
            "candidateRows",
            "candidateDebug",
            "analyticsSkipped",
            "ranked",
            "rankingSignals",
        ] {
            assert!(
                debug_keys.contains(&expected),
                "debug payload misses {expected}: {debug_keys:?}"
            );
        }
        assert_eq!(
            body["debug"]["debugAuthError"]["message"],
            "Missing Pokoin bearer token."
        );
        assert_eq!(
            body["debug"]["debugAuthError"]["code"],
            "auth/missing-token"
        );
        assert_eq!(body["debug"]["debugAuthError"]["statusCode"], 401);
        assert_eq!(
            body["debug"]["candidateDebug"]["searchPath"],
            "meili_en_candidates"
        );
        assert_eq!(
            body["debug"]["candidateDebug"]["tokenPlan"]["strategy"],
            "meili_en_candidates"
        );
        assert_eq!(body["debug"]["searchPath"], "meili_en_candidates");
        assert_eq!(body["debug"]["poolTerm"], "charizard ex");
        assert_eq!(body["debug"]["poolLimit"], 500);
        assert_eq!(body["debug"]["analyticsSkipped"], false);
        // depth math: latestDepth*1200 + min(depthWeight*45, cap)
        for entry in body["debug"]["ranked"].as_array().expect("ranked") {
            let relevance = entry["relevanceScore"].as_f64().unwrap();
            let cap = if relevance >= 5000.0 {
                900.0
            } else if relevance >= 4200.0 {
                650.0
            } else {
                360.0
            };
            let expected = entry["latestDepth"].as_f64().unwrap() * 1200.0
                + (entry["depthWeight"].as_f64().unwrap() * 45.0).min(cap);
            assert_eq!(entry["depthBoost"].as_f64().unwrap(), expected);
            assert_eq!(
                entry["score"].as_f64().unwrap(),
                relevance + entry["analyticsBoost"].as_f64().unwrap() + expected
            );
        }
    }

    #[test]
    fn name_preview_and_empty_body_captures() {
        // preview_mode "name" answered a bare empty array for pikachu.
        let preview = live_fixture("live-preview-name.json");
        assert_eq!(preview, serde_json::json!([]));
        // `{}` answered the hot analytics pool envelope.
        let empty = live_fixture("live-empty-body.json");
        let mut keys: Vec<&str> = empty
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["pool", "rows", "search_context"]);
        assert_eq!(empty["pool"]["requestedLimit"], 1000);
        assert_eq!(empty["pool"]["previewLimit"], 20);
        assert_eq!(empty["pool"]["ttlSeconds"], 60);
        assert_eq!(empty["pool"]["limit"], 1000);
        assert_eq!(empty["search_context"]["strategy"], "hot_analytics_pool");
        assert_eq!(
            empty["search_context"]["candidate_id_ladder"]["appliedLimit"],
            500
        );
        assert!(empty["rows"].as_array().expect("rows").len() <= 20);
    }

    #[test]
    fn ja_language_takes_the_same_engine_gate() {
        let body = live_fixture("live-ja.json");
        assert_eq!(body["search_language"], "ja");
        assert_eq!(body["pool"]["source"], "search_pipeline");
    }
}
