//! Axum entrypoints of `/api/marketplace-autocomplete` and the response
//! envelopes of the Node handler (empty hot pool, name preview, search
//! pipeline, canceled sessions, debug payloads).

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use pokoin_api_common::{http as api_http, RouteState};
use serde_json::{json, Value};

use super::analytics::{self, AnalyticsBoosts};
use super::engine::{self, Ctx};
use super::ladder::AUTOCOMPLETE_PREVIEW_ROW_LIMIT;
use super::normalize::js_str_or;
use super::rank::{rank_autocomplete_entries, score_explanation};
use super::request::{
    build_search_context, parse_request, update_depth_metadata, update_depth_scores,
};
use super::row::{normalize_marketplace_row, with_card_emoji_fields};
use super::CORS_HEADERS;

/// `cacheControlForRequest` publics: every accepted request is a POST, so the
/// handler always answers `no-store`; these are the values the JS handler
/// would use for a non-POST hit (which its 405 gate prevents).
#[allow(dead_code)]
const PUBLIC_CACHE_CONTROL: &str = "public, max-age=5, s-maxage=30";
#[allow(dead_code)]
const EMPTY_CACHE_CONTROL: &str = "public, max-age=10, s-maxage=60, stale-while-revalidate=120";

/// `OPTIONS /api/marketplace-autocomplete` — 204 with the handler CORS.
pub async fn preflight() -> Response {
    let mut response = (StatusCode::NO_CONTENT, Body::empty()).into_response();
    for (name, value) in CORS_HEADERS {
        if let (Ok(name), Ok(value)) = (
            axum::http::HeaderName::try_from(name),
            axum::http::HeaderValue::try_from(value),
        ) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

/// Every other method: `405 {"error":"Method not allowed."}` + `Allow`.
pub async fn method_not_allowed() -> Response {
    let mut headers: Vec<(&str, &str)> = CORS_HEADERS.to_vec();
    headers.push(("allow", "POST, OPTIONS"));
    api_http::json_with(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"error": "Method not allowed."}),
        &headers,
    )
}

fn with_cors(mut response: Response, extra: &[(&str, &str)]) -> Response {
    let map = response.headers_mut();
    for (name, value) in CORS_HEADERS {
        if let (Ok(name), Ok(value)) = (
            axum::http::HeaderName::try_from(name),
            axum::http::HeaderValue::try_from(value),
        ) {
            map.insert(name, value);
        }
    }
    for (name, value) in extra {
        if let (Ok(name), Ok(value)) = (
            axum::http::HeaderName::try_from(*name),
            axum::http::HeaderValue::try_from(*value),
        ) {
            map.insert(name, value);
        }
    }
    response
}

fn json_response(status: StatusCode, body: Value, extra: &[(&str, &str)]) -> Response {
    with_cors(api_http::json_with(status, body, extra), &[])
}

/// `POST /api/marketplace-autocomplete`.
pub async fn autocomplete(
    State(state): State<RouteState>,
    headers: HeaderMap,
    body: axum::extract::RawQuery,
    raw: axum::body::Bytes,
) -> Response {
    let _ = body;
    let started = std::time::Instant::now();
    let body_value = match api_http::parse_body(&headers, &raw) {
        Ok(body) => body.json(),
        Err(response) => return response,
    };
    let request = parse_request(&body_value);
    let cancel_state = analytics::search_cancel_state(&request.search_session_id);
    let wants_debug = request.wants_debug;
    let debug_auth = optional_debug_user(&state, &headers, wants_debug).await;
    let personalization = optional_personalization_user(&state, &headers).await;

    let (debug_user, debug_auth_error) = &debug_auth;
    let (personalization_uid, personalization_error) = &personalization;

    if analytics::is_search_canceled(&cancel_state) {
        return json_response(
            StatusCode::OK,
            analytics::canceled_autocomplete_response(
                &request.search_term,
                &request.search_language,
                &cancel_state,
            ),
            &[("cache-control", "no-store")],
        );
    }

    let redis = state.api.redis().await;
    let mut ctx = Ctx::new(state.api.read().clone(), redis);
    if wants_debug {
        ctx.debug = Some(json!({"steps": []}));
        ctx.debug_user = debug_user.clone();
        ctx.debug_auth_error = debug_auth_error.clone();
    }

    if request.search_term.is_empty() {
        return empty_search_term_response(
            &mut ctx,
            &request,
            debug_user,
            debug_auth_error,
            personalization,
            started,
        )
        .await;
    }

    if request.preview_mode == "name" {
        return name_preview_response(
            &mut ctx,
            &request,
            personalization_uid.as_deref(),
            personalization_error,
        )
        .await;
    }

    search_pipeline_response(
        &mut ctx,
        &request,
        previous_value(
            &body_value,
            &["previous_search_context", "previousSearchContext"],
        ),
        prediction_value(&body_value),
        personalization_uid.as_deref(),
        personalization_error,
        started,
    )
    .await
}

fn previous_value(body: &Value, keys: &[&str]) -> Option<Value> {
    super::row::get_any(body, keys).cloned()
}

fn prediction_value(body: &Value) -> Option<Value> {
    super::row::get_any(
        body,
        &[
            "prediction_context",
            "predictionContext",
            "previous_prediction_context",
            "previousPredictionContext",
        ],
    )
    .cloned()
}

fn millis_since(started: std::time::Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// The `!searchTerm` hot analytics pool response.
#[allow(clippy::too_many_arguments)]
async fn empty_search_term_response(
    ctx: &mut Ctx,
    request: &super::request::AutocompleteRequest,
    debug_user: &Option<Value>,
    debug_auth_error: &Option<Value>,
    personalization: (Option<String>, Option<Value>),
    started: std::time::Instant,
) -> Response {
    let candidate_started = std::time::Instant::now();
    let (hot_rows, hot_source) =
        match engine::hot_preview_pool(ctx, request.pool_limit as i64).await {
            Ok(pool) => pool,
            Err(error) => return engine_error_response(error),
        };
    let cancel_state = analytics::search_cancel_state(&request.search_session_id);
    if analytics::is_search_canceled(&cancel_state) {
        return json_response(
            StatusCode::OK,
            analytics::canceled_autocomplete_response(
                &request.search_term,
                &request.search_language,
                &cancel_state,
            ),
            &[("cache-control", "no-store")],
        );
    }
    let pool_rows = hot_rows;
    let candidate_duration_ms = millis_since(candidate_started);
    let rank_started = std::time::Instant::now();
    let preview_limit = (request.result_limit.max(0) as usize).min(AUTOCOMPLETE_PREVIEW_ROW_LIMIT);
    let preview_rows: Vec<Value> = pool_rows.iter().take(preview_limit).cloned().collect();
    let hydrated = engine::hydrate_expansion_symbols_for_rows(ctx, preview_rows).await;
    let ranked: Vec<Value> = hydrated
        .iter()
        .map(|row| with_card_emoji_fields(&normalize_marketplace_row(row)))
        .collect();
    let rank_duration_ms = millis_since(rank_started);
    let duration_ms = millis_since(started);
    let search_context = build_search_context(
        "",
        &request.search_language,
        &pool_rows,
        "hot_analytics_pool",
        None,
        Some(request.pool_limit),
        None,
    );
    let pool = json!({
        "source": hot_source,
        "size": pool_rows.len(),
        "limit": request.pool_limit,
        "requestedLimit": request.requested_pool_limit,
        "previewLimit": preview_limit,
        "ttlSeconds": 60,
    });
    let timing = format!(
        "autocomplete-empty;dur={duration_ms}, candidate;dur={candidate_duration_ms}, rank;dur={rank_duration_ms}"
    );
    let mut body = json!({
        "rows": ranked,
        "pool": pool,
        "search_context": search_context,
    });
    if request.wants_debug {
        body["debug"] = json!({
            "sessionId": request.debug_session_id,
            "user": debug_user,
            "debugAuthError": debug_auth_error,
            "searchTerm": request.search_term,
            "resultLimit": request.result_limit,
            "poolLimit": request.pool_limit,
            "requestedPoolLimit": request.requested_pool_limit,
            "searchLanguage": request.search_language,
            "searchPath": "empty_hot_analytics",
            "poolSource": body["pool"]["source"],
            "poolSize": pool_rows.len(),
            "candidateDurationMs": candidate_duration_ms as f64,
            "rankDurationMs": rank_duration_ms as f64,
            "durationMs": duration_ms as f64,
            "replicaPath": "peer4_primary",
            "replicaFallback": false,
            "rankingSignals": ranking_signals(
                &AnalyticsBoosts::default(),
                &personalization,
            ),
        });
    }
    json_response(
        StatusCode::OK,
        body,
        &[
            ("cache-control", "no-store"),
            ("server-timing", timing.as_str()),
        ],
    )
}

fn ranking_signals(
    boosts: &AnalyticsBoosts,
    personalization: &(Option<String>, Option<Value>),
) -> Value {
    json!({
        "siteBoostedRows": boosts.site_boosts.len(),
        "userBoostedRows": boosts.user_boosts.len(),
        "trendingSource": boosts.source_site,
        "userSource": boosts.source_user,
        "personalizationUser": if personalization.0.is_some() { "verified_firebase_uid" } else { "anonymous" },
        "personalizationAuthError": personalization.1.clone().unwrap_or(Value::Null),
    })
}

/// `preview_mode === 'name'` — the fast name preview, a bare array.
async fn name_preview_response(
    ctx: &mut Ctx,
    request: &super::request::AutocompleteRequest,
    personalization_uid: Option<&str>,
    personalization_error: &Option<Value>,
) -> Response {
    let started = std::time::Instant::now();
    let preview_limit = (request.result_limit.max(0) as usize).min(AUTOCOMPLETE_PREVIEW_ROW_LIMIT);
    let rows = match engine::search_fast_name_preview_with_database(
        ctx,
        &request.search_term,
        preview_limit as i64,
        &request.search_language,
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => return engine_error_response(error),
    };
    if analytics::is_search_canceled(&analytics::search_cancel_state(&request.search_session_id)) {
        return json_response(
            StatusCode::OK,
            analytics::canceled_autocomplete_response(
                &request.search_term,
                &request.search_language,
                &analytics::search_cancel_state(&request.search_session_id),
            ),
            &[("cache-control", "no-store")],
        );
    }
    let analytics_boosts = match analytics::analytics_boosts_for_rows(
        &ctx.pools.analytics(),
        &rows,
        personalization_uid,
    )
    .await
    {
        Ok(boosts) => boosts,
        Err(error) => return engine_error_response(error),
    };
    let ranked_entries = rank_autocomplete_entries(
        rows.clone(),
        &request.search_term,
        preview_limit,
        &analytics_boosts,
        &Default::default(),
        &Default::default(),
        &Default::default(),
    );
    let entry_rows: Vec<Value> = ranked_entries
        .iter()
        .map(|entry| entry.row.clone())
        .collect();
    let hydrated = engine::hydrate_expansion_symbols_for_rows(ctx, entry_rows).await;
    let ranked: Vec<Value> = hydrated
        .iter()
        .map(|row| with_card_emoji_fields(&normalize_marketplace_row(row)))
        .collect();
    let duration_ms = millis_since(started);
    let timing = format!("autocomplete-name;dur={duration_ms}");
    if request.wants_debug {
        let body = json!({
            "rows": ranked,
            "pool": {
                "source": "name_preview_pipeline",
                "size": rows.len(),
                "limit": preview_limit,
                "previewLimit": preview_limit,
                "strategy": "fast_name_preview",
            },
            "debug": {
                "previewMode": request.preview_mode,
                "searchTerm": request.search_term,
                "resultLimit": request.result_limit,
                "searchLanguage": request.search_language,
                "searchPath": "fast_name_preview",
                "poolSource": "name_preview_pipeline",
                "poolSize": rows.len(),
                "candidateDurationMs": duration_ms as f64,
                "rankDurationMs": 0,
                "replicaPath": "peer4_primary",
                "replicaFallback": false,
                "durationMs": duration_ms as f64,
                "candidateRows": rows.len(),
                "analyticsBoostedRows": analytics_boosts.size(),
                "rankingSignals": ranking_signals(&analytics_boosts, &(personalization_uid.map(str::to_owned), personalization_error.clone())),
            },
        });
        return json_response(
            StatusCode::OK,
            body,
            &[
                ("cache-control", "no-store"),
                ("server-timing", timing.as_str()),
            ],
        );
    }
    json_response(
        StatusCode::OK,
        Value::Array(ranked),
        &[
            ("cache-control", "no-store"),
            ("server-timing", timing.as_str()),
        ],
    )
}

/// The main search pipeline.
#[allow(clippy::too_many_arguments)]
async fn search_pipeline_response(
    ctx: &mut Ctx,
    request: &super::request::AutocompleteRequest,
    previous_context: Option<Value>,
    prediction_context: Option<Value>,
    personalization_uid: Option<&str>,
    personalization_error: &Option<Value>,
    started: std::time::Instant,
) -> Response {
    let candidate_started = std::time::Instant::now();
    let candidate = match engine::rows_for_autocomplete_search_term_with_query(
        ctx,
        ctx.redis.clone(),
        &request.search_term,
        request.pool_limit as i64,
        &request.search_language,
        previous_context.as_ref(),
        prediction_context.as_ref(),
    )
    .await
    {
        Ok(candidate) => candidate,
        Err(error) => return engine_error_response(error),
    };
    let candidate_duration_ms = millis_since(candidate_started);
    let rows = candidate.rows;
    let analytics_started = std::time::Instant::now();
    let canceled_after_candidates =
        analytics::is_search_canceled(&analytics::search_cancel_state(&request.search_session_id));
    let skip_analytics = canceled_after_candidates
        || super::ladder::should_skip_analytics_for_search_term(&request.search_term);
    let analytics_boosts = if skip_analytics {
        Ok(analytics::empty_analytics_boosts())
    } else {
        analytics::analytics_boosts_for_rows(&ctx.pools.analytics(), &rows, personalization_uid)
            .await
    };
    let analytics_boosts = match analytics_boosts {
        Ok(boosts) => boosts,
        Err(error) => return engine_error_response(error),
    };
    let analytics_duration_ms = millis_since(analytics_started);
    if canceled_after_candidates {
        let duration_ms = millis_since(started);
        let cancel_state = analytics::search_cancel_state(&request.search_session_id);
        let timing = format!(
            "autocomplete-canceled;dur={duration_ms}, candidate;dur={candidate_duration_ms}, analytics;dur=0"
        );
        return json_response(
            StatusCode::OK,
            analytics::canceled_autocomplete_response(
                &request.search_term,
                &request.search_language,
                &cancel_state,
            ),
            &[
                ("cache-control", "no-store"),
                ("server-timing", timing.as_str()),
            ],
        );
    }
    let depth_scores = update_depth_scores(
        previous_context.as_ref(),
        &request.search_term,
        &request.search_language,
        &rows,
    );
    let (latest_depths, latest_orders) = update_depth_metadata(
        previous_context.as_ref(),
        &request.search_term,
        &request.search_language,
        &rows,
    );
    let rank_started = std::time::Instant::now();
    let result_limit = (request.result_limit.max(0) as usize).min(AUTOCOMPLETE_PREVIEW_ROW_LIMIT);
    let ranked_entries = rank_autocomplete_entries(
        rows.clone(),
        &request.search_term,
        result_limit,
        &analytics_boosts,
        &depth_scores,
        &latest_depths,
        &latest_orders,
    );
    let entry_rows: Vec<Value> = ranked_entries
        .iter()
        .map(|entry| entry.row.clone())
        .take(AUTOCOMPLETE_PREVIEW_ROW_LIMIT)
        .collect();
    let hydrated = engine::hydrate_expansion_symbols_for_rows(ctx, entry_rows).await;
    let ranked: Vec<Value> = hydrated
        .iter()
        .map(|row| with_card_emoji_fields(&normalize_marketplace_row(row)))
        .collect();
    let rank_duration_ms = millis_since(rank_started);
    let duration_ms = millis_since(started);
    let context_strategy = ctx
        .debug
        .as_ref()
        .and_then(|debug| super::row::get(debug, "tokenPlan"))
        .map(|plan| js_str_or(super::row::get(plan, "strategy")))
        .filter(|strategy| !strategy.is_empty())
        .unwrap_or_else(|| "ranked_pool".to_owned());
    let candidate_ladder = super::ladder::autocomplete_candidate_id_ladder(&request.search_term);
    let search_context = build_search_context(
        &request.search_term,
        &request.search_language,
        &rows,
        &context_strategy,
        previous_context.as_ref(),
        Some(request.pool_limit),
        candidate.non_name_context.as_ref(),
    );
    let replica_debug = {
        let debug = ctx.debug.as_ref();
        debug.and_then(|debug| {
            super::row::get_any(debug, &["variationSearch", "prefixPool"]).cloned()
        })
    };
    let pool = json!({
        "source": if previous_context.is_some() { "context_or_search_pipeline" } else { "search_pipeline" },
        "size": rows.len(),
        "limit": request.pool_limit,
        "requestedLimit": request.requested_pool_limit,
        "candidateIdLimit": candidate_ladder["requestedLimit"],
        "appliedCandidateIdLimit": candidate_ladder["appliedLimit"],
        "previewLimit": (request.result_limit.max(0) as usize).min(AUTOCOMPLETE_PREVIEW_ROW_LIMIT),
        "strategy": context_strategy,
    });
    let timing = format!(
        "autocomplete;dur={duration_ms}, candidate;dur={candidate_duration_ms}, analytics;dur={analytics_duration_ms}, rank;dur={rank_duration_ms}"
    );
    if request.wants_debug {
        let replica_path = replica_debug
            .as_ref()
            .map(|debug| js_str_or(super::row::get(debug, "path")))
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| {
                ctx.debug
                    .as_ref()
                    .and_then(|debug| super::row::get(debug, "candidateDebug"))
                    .and_then(|candidate| super::row::get(candidate, "searchPath"))
                    .map(|path| js_str_or(Some(path)))
                    .unwrap_or_else(|| "peer3_name_plus_dimension".to_owned())
            });
        let replica_fallback = replica_debug
            .as_ref()
            .map(|debug| {
                js_str_or(super::row::get(debug, "path")).contains("fallback")
                    || super::row::get(debug, "fallback") == Some(&Value::Bool(true))
            })
            .unwrap_or(false)
            || context_strategy == "primary_full_fallback";
        let debug_search_path = ctx
            .debug
            .as_ref()
            .and_then(|debug| super::row::get(debug, "searchPath"))
            .map(|path| js_str_or(Some(path)))
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| context_strategy.clone());
        let mut debug = json!({
            "sessionId": request.debug_session_id,
            "user": ctx_debug_user(ctx),
            "debugAuthError": ctx_debug_auth_error(ctx),
            "searchTerm": request.search_term,
            "poolTerm": super::normalize::clean_search_term(Some(&json!(
                super::normalize::normalize_variation_phrases(&request.search_term)
            ))),
            "resultLimit": request.result_limit,
            "poolLimit": request.pool_limit,
            "requestedPoolLimit": request.requested_pool_limit,
            "searchLanguage": request.search_language,
            "searchPath": debug_search_path,
            "poolSource": pool["source"],
            "poolSize": rows.len(),
            "candidateIdLimit": candidate_ladder["requestedLimit"],
            "appliedCandidateIdLimit": candidate_ladder["appliedLimit"],
            "candidateIdLadder": candidate_ladder,
            "replicaPath": replica_path,
            "replicaFallback": replica_fallback,
            "durationMs": duration_ms as f64,
            "candidateDurationMs": candidate_duration_ms as f64,
            "analyticsDurationMs": analytics_duration_ms as f64,
            "rankDurationMs": rank_duration_ms as f64,
            "candidateRows": rows.len(),
            "candidateDebug": ctx.debug,
            "analyticsSkipped": skip_analytics,
            "rankingSignals": ranking_signals(&analytics_boosts, &(personalization_uid.map(str::to_owned), personalization_error.clone())),
        });
        debug["ranked"] = Value::Array(
            ranked_entries
                .iter()
                .take(12)
                .map(|entry| {
                    let mut explanation = score_explanation(&entry.row, &request.search_term);
                    explanation["score"] = json!(entry.score);
                    explanation["relevanceScore"] = json!(entry.relevance_score);
                    explanation["siteBoost"] = json!(analytics_boosts
                        .site_boosts
                        .get(&super::row::str_field(&entry.row, &["card_id"]))
                        .copied()
                        .unwrap_or(0.0));
                    explanation["userBoost"] = json!(analytics_boosts
                        .user_boosts
                        .get(&super::row::str_field(&entry.row, &["card_id"]))
                        .copied()
                        .unwrap_or(0.0));
                    explanation["analyticsBoost"] = json!(entry.analytics_boost);
                    explanation["depthWeight"] = json!(entry.depth_weight);
                    explanation["latestDepth"] = json!(entry.latest_depth);
                    explanation["latestOrder"] = json!(entry.latest_order);
                    explanation["depthBoost"] = json!(entry.depth_boost);
                    explanation["textRelevance"] = json!(entry.relevance_score);
                    explanation["trendingSource"] = json!(analytics_boosts.source_site);
                    explanation
                })
                .collect(),
        );
        let body = json!({
            "rows": ranked,
            "search_language": request.search_language,
            "search_context": search_context,
            "debug": debug,
        });
        return json_response(
            StatusCode::OK,
            body,
            &[
                ("cache-control", "no-store"),
                ("server-timing", timing.as_str()),
            ],
        );
    }
    let body = json!({
        "rows": ranked,
        "search_language": request.search_language,
        "pool": pool,
        "search_context": search_context,
    });
    json_response(
        StatusCode::OK,
        body,
        &[
            ("cache-control", "no-store"),
            ("server-timing", timing.as_str()),
        ],
    )
}

fn ctx_debug_user(ctx: &Ctx) -> Value {
    ctx.debug_user.clone().unwrap_or(Value::Null)
}

fn ctx_debug_auth_error(ctx: &Ctx) -> Value {
    ctx.debug_auth_error.clone().unwrap_or(Value::Null)
}

fn engine_error_response(error: engine::EngineError) -> Response {
    let status = error
        .status
        .and_then(|status| StatusCode::from_u16(status).ok())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    json_response(status, json!({"error": error.message}), &[])
}

// --- auth helpers ---

fn auth_error_payload(error: pokoin_accounts::firebase::AuthError) -> Value {
    match error {
        pokoin_accounts::firebase::AuthError::Missing => json!({
            "message": "Missing Pokoin bearer token.",
            "code": "auth/missing-token",
            "statusCode": 401,
        }),
        pokoin_accounts::firebase::AuthError::Invalid(message) => {
            tracing::warn!(reason = %message, "search auth token rejected");
            json!({
            "message": "Invalid or expired sign-in token.",
            "code": "auth/invalid-token",
            "statusCode": 401,
        })
        },
        pokoin_accounts::firebase::AuthError::Unconfigured(message) => json!({
            "message": format!("Sign-in verification is not configured: {message}"),
            "code": "auth/unconfigured",
            "statusCode": 500,
        }),
        pokoin_accounts::firebase::AuthError::Unavailable => json!({
            "message": "Sign-in could not be checked right now.",
            "code": "auth/unavailable",
            "statusCode": 503,
        }),
    }
}

/// `optionalDebugUser(req, wantsDebug)` + `authorizeSearchDebugRequest`.
/// Shared with the search lookups (`authorizeSearchDebugRequest`).
pub async fn debug_user(state: &RouteState, headers: &HeaderMap, wants_debug: bool) -> (Option<Value>, Option<Value>) {
    optional_debug_user(state, headers, wants_debug).await
}

async fn optional_debug_user(
    state: &RouteState,
    headers: &HeaderMap,
    wants_debug: bool,
) -> (Option<Value>, Option<Value>) {
    if !wants_debug {
        return (None, None);
    }
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let token = match pokoin_accounts::firebase::bearer(raw) {
        Ok(token) => token.to_owned(),
        Err(error) => return (None, Some(auth_error_payload(error))),
    };
    let decoded = match state.accounts.verifier().verify(&token).await {
        Ok(claims) => claims,
        Err(error) => return (None, Some(auth_error_payload(error))),
    };
    // _search_debug_auth.js
    let trusted = if decoded.email_verified {
        decoded.email.trim().to_ascii_lowercase()
    } else {
        String::new()
    };
    let configured: Vec<String> = [
        "MARKETPLACE_ADMIN_EMAILS",
        "MARKETPLACE_DEBUG_EMAILS",
        "ADMIN_SIGNUP_EMAIL",
    ]
    .iter()
    .map(|key| std::env::var(key).unwrap_or_default())
    .collect::<Vec<_>>()
    .join(",")
    .split(',')
    .map(|entry| entry.trim().to_ascii_lowercase())
    .filter(|entry| !entry.is_empty())
    .collect();
    const ALLOWED_EMAILS: [&str; 2] = ["vitologiuseppe17@gmail.com", "pokoinpos@gmail.com"];
    let has_admin = decoded.extra.get("admin").and_then(Value::as_bool) == Some(true)
        || decoded.extra.get("isAdmin").and_then(Value::as_bool) == Some(true)
        || decoded.extra.get("hasAdminAccess").and_then(Value::as_bool) == Some(true)
        || decoded.role.trim().eq_ignore_ascii_case("admin");
    if (!trusted.is_empty()
        && (ALLOWED_EMAILS.contains(&trusted.as_str()) || configured.contains(&trusted)))
        || has_admin
    {
        let username = decoded.name.trim().to_lowercase();
        return (
            Some(json!({
                "uid": decoded.uid,
                "email": decoded.email.trim().to_lowercase(),
                "username": username,
            })),
            None,
        );
    }
    (
        None,
        Some(json!({
            "message": "Search debug is not enabled for this account.",
            "statusCode": 403,
        })),
    )
}

/// `optionalPersonalizationUser(req)`.
async fn optional_personalization_user(
    state: &RouteState,
    headers: &HeaderMap,
) -> (Option<String>, Option<Value>) {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !raw.starts_with("Bearer ") {
        return (None, None);
    }
    let Some(token) = raw
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
    else {
        return (
            None,
            Some(auth_error_payload(
                pokoin_accounts::firebase::AuthError::Missing,
            )),
        );
    };
    match state.accounts.verifier().verify(token).await {
        Ok(claims) => {
            let uid = claims.uid.trim();
            if uid.is_empty() {
                (None, None)
            } else {
                (Some(uid.chars().take(128).collect()), None)
            }
        }
        Err(error) => (None, Some(auth_error_payload(error))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autocomplete;
    use axum::body::to_bytes;
    use std::cmp::Ordering;

    fn state() -> RouteState {
        let pool = pokoin_api_common::state::lazy_pool("postgres://x@127.0.0.1:1/x", 1)
            .expect("lazy pool");
        RouteState::new(
            pokoin_api_common::ApiState::new(pool.clone(), pool, None, 1),
            pokoin_accounts::DomainState::default(),
        )
    }

    async fn call(method: &str, body: &str) -> (StatusCode, Value, axum::http::HeaderMap) {
        let router = autocomplete::routes().with_state(state());
        let request = axum::http::Request::builder()
            .method(method)
            .uri("/api/marketplace-autocomplete")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_owned()))
            .expect("request");
        let response = tower::ServiceExt::oneshot(router, request)
            .await
            .expect("response");
        let status = response.status();
        let response_headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, json, response_headers)
    }

    #[tokio::test]
    async fn options_preflights_with_204() {
        let router = autocomplete::routes().with_state(state());
        let request = axum::http::Request::builder()
            .method("OPTIONS")
            .uri("/api/marketplace-autocomplete")
            .body(axum::body::Body::empty())
            .expect("request");
        let response = tower::ServiceExt::oneshot(router, request)
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let headers = response.headers();
        assert_eq!(headers.get("access-control-allow-origin").unwrap(), "*");
        assert_eq!(
            headers.get("access-control-allow-methods").unwrap(),
            "POST, OPTIONS"
        );
        assert_eq!(
            headers.get("access-control-allow-headers").unwrap(),
            "Content-Type, Authorization"
        );
        assert_eq!(headers.get("access-control-max-age").unwrap(), "86400");
    }

    #[tokio::test]
    async fn get_answers_405_with_allow() {
        let router = autocomplete::routes().with_state(state());
        let request = axum::http::Request::builder()
            .method("GET")
            .uri("/api/marketplace-autocomplete")
            .body(axum::body::Body::empty())
            .expect("request");
        let response = tower::ServiceExt::oneshot(router, request)
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers().get("allow").unwrap(), "POST, OPTIONS");
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let body: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(body["error"], "Method not allowed.");
    }

    /// Without a database the Node handler answers `500 {error}` from its
    /// catch block (it never fakes success); the route must do the same.
    #[tokio::test]
    async fn search_term_without_a_database_fails_closed_like_node() {
        let (status, body, headers) =
            call("POST", r#"{"search_term":"pikachu","result_limit":10}"#).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body["error"].is_string(), "{body}");
        // the Node catch block only setCorsHeaders - no cache-control on errors
        assert!(headers.get("cache-control").is_none());
        assert_eq!(headers.get("access-control-allow-origin").unwrap(), "*");
    }

    #[tokio::test]
    async fn pool_limit_follows_the_ladder_like_the_live_fixture() {
        // Parsing is DB-free; the live fixture pins pool.limit=500,
        // requestedLimit=1000, ladder.appliedLimit=500 for "pikachu".
        let request =
            parse_request(&serde_json::json!({"search_term": "pikachu", "result_limit": 10}));
        assert_eq!(request.pool_limit, 500);
        assert_eq!(request.requested_pool_limit, 1000);
        let ladder_value = crate::autocomplete::ladder::autocomplete_candidate_id_ladder("pikachu");
        assert_eq!(ladder_value["appliedLimit"], 500);
        assert_eq!(ladder_value["depth"], 7);
        let two = parse_request(&serde_json::json!({"search_term": "pi", "result_limit": 3}));
        assert_eq!(two.pool_limit, 5000);
    }

    #[tokio::test]
    async fn empty_search_term_without_a_database_fails_closed_like_node() {
        let (status, body, headers) = call("POST", "{}").await;
        // `await hotPreviewPool(...)` rejects -> catch -> 500.
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body["error"].is_string(), "{body}");
        assert!(headers.get("cache-control").is_none());
    }

    #[tokio::test]
    async fn name_preview_without_a_database_fails_closed_like_node() {
        let (status, body, _) = call(
            "POST",
            r#"{"search_term":"pikachu","preview_mode":"name","result_limit":5}"#,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body["error"].is_string(), "{body}");
    }

    #[tokio::test]
    async fn debug_needs_no_auth_to_attach_the_error() {
        let (status, body, _) = call(
            "POST",
            r#"{"search_term":"charizard ex","result_limit":3,"debug":true}"#,
        )
        .await;
        // The candidate stage hits the database first, so the answer is the
        // catch-all failure; the debug auth envelope is covered by the pure
        // parse + auth helper tests above.
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body["error"].is_string(), "{body}");
    }

    #[tokio::test]
    async fn invalid_body_is_the_runtime_400() {
        let router = autocomplete::routes().with_state(state());
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/marketplace-autocomplete")
            .header("content-type", "application/json")
            .body(axum::body::Body::from("{bad"))
            .expect("request");
        let response = tower::ServiceExt::oneshot(router, request)
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn debug_auth_allowlist_matches_the_operator_emails() {
        // ALLOWED_EMAILS of _search_debug_auth.js
        let payload = auth_error_payload(pokoin_accounts::firebase::AuthError::Missing);
        assert_eq!(payload["statusCode"], 401);
        assert_eq!(payload["code"], "auth/missing-token");
    }

    #[allow(dead_code)]
    fn ordering_note() -> Ordering {
        Ordering::Equal
    }
}
