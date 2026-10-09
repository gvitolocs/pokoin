//! `GET|POST /api/searchbar-cancel` and `/api/searchbar-cards` — ports of
//! `searchbar-cancel.js` and `searchbar-cards.js` (the latter wraps the
//! autocomplete handler in-process like the Node `responseRecorder`).

use axum::body::{to_bytes, Bytes};
use axum::extract::{RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::{http, RouteState};
use pokoin_catalog_api::shared::js;
use serde_json::{json, Map, Value};

use crate::autocomplete::{analytics, handler as autocomplete, normalize};

/// `req.method === 'GET' ? req.query : req.body`.
async fn source(method: &Method, headers: &HeaderMap, uri: &Uri, body: &Bytes) -> Result<Value, Response> {
    if *method == Method::GET {
        return Ok(http::Query::from_uri(uri).to_json());
    }
    Ok(http::parse_body(headers, body)?.json())
}

fn first<'a>(source: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| source.get(*k)).find(|v| !v.is_null())
}

pub async fn cancel(method: Method, headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    if method != Method::GET && method != Method::POST {
        return http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &[("allow", "GET, POST")]);
    }
    let source = match source(&method, &headers, &uri, &body).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let session_id = analytics::clean_search_session_id(first(&source, &["search_session_id", "searchSessionId", "session_id", "sessionId"]));
    let query = normalize::clean_search_term(first(&source, &["query", "last_query", "lastQuery"]));
    let reason_raw = source.get("reason").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!("exit"));
    let reason = normalize::clean_search_term(Some(&reason_raw));
    let entry = analytics::cancel_search_session(Some(&json!(session_id)), Some(&json!({ "query": query, "reason": reason })));
    http::json_with(StatusCode::OK, json!({ "ok": true, "canceled": entry.is_some(), "session_id": session_id }), &[("cache-control", "no-store")])
}

fn boolean_param(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true))) || matches!(v, Some(Value::String(s)) if s == "true" || s == "1") || matches!(v, Some(Value::Number(n)) if n.as_f64() == Some(1.0))
}

/// `parseContext(value)`: falsy -> null, objects pass, strings are JSON-parsed.
fn parse_context(v: Option<&Value>) -> Value {
    if !js::truthy(v) {
        return Value::Null;
    }
    match v {
        Some(v @ Value::Object(_)) | Some(v @ Value::Array(_)) => v.clone(),
        Some(other) => serde_json::from_str(&js::js_string(other)).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

fn clean_limit(v: Option<&Value>) -> i64 {
    normalize::clean_limit(v)
}

pub async fn cards(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    if method != Method::GET && method != Method::POST {
        return http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &[("allow", "GET, POST")]);
    }
    let source = match source(&method, &headers, &uri, &body).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let query = normalize::clean_search_term(first(&source, &["query", "search_term", "searchTerm"]));
    let language = normalize::clean_language(first(&source, &["search_language", "language"]));
    let limit = clean_limit(Some(first(&source, &["limit", "result_limit"]).unwrap_or(&json!(20))));
    let pool_limit = clean_limit(Some(first(&source, &["pool_limit", "poolLimit"]).unwrap_or(&json!(1000))));
    let mode_raw = source.get("mode").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!("autocomplete"));
    let mode = match normalize::clean_search_term(Some(&mode_raw)).as_str() {
        "full" => "full",
        "benchmark_step" => "benchmark_step",
        _ => "autocomplete",
    };
    let previous = parse_context(first(&source, &["previous_search_context", "previousSearchContext"]));
    let prediction = parse_context(first(&source, &["prediction_context", "predictionContext", "previous_prediction_context", "previousPredictionContext"]));
    let debug = boolean_param(source.get("debug"));
    let debug_session = normalize::clean_search_term(first(&source, &["debug_session_id", "debugSessionId"]));
    let session = analytics::clean_search_session_id(first(&source, &["search_session_id", "searchSessionId", "session_id", "sessionId"]));
    if analytics::is_search_session_cancelled(&session) {
        return http::json_with(
            StatusCode::OK,
            json!({
                "ok": true, "endpoint": "/api/searchbar-cards", "canceled": true, "query": query, "search_session_id": session,
                "rows": [], "search_context": null, "meta": { "visible_row_count": 0, "search_path": "session_canceled" },
            }),
            &[("cache-control", "no-store")],
        );
    }
    let inner_body = json!({
        "search_term": query, "result_limit": limit, "pool_limit": pool_limit, "search_language": language,
        "previous_search_context": previous, "prediction_context": prediction, "debug": debug,
        "debug_session_id": debug_session, "search_session_id": session,
    });
    let mut inner_headers = headers.clone();
    inner_headers.remove(header::CONTENT_LENGTH);
    inner_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let inner = autocomplete::autocomplete(State(state), inner_headers, RawQuery(None), Bytes::from(inner_body.to_string())).await;
    let status = inner.status();
    let server_timing = inner.headers().get("server-timing").cloned();
    let bytes = to_bytes(inner.into_body(), usize::MAX).await.unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let with_timing = |mut response: Response| {
        if let Some(v) = server_timing.clone() {
            response.headers_mut().insert("server-timing", v);
        }
        response
    };
    if status.as_u16() >= 400 {
        return with_timing(http::json(status, body));
    }
    let rows = match &body {
        Value::Array(items) => Value::Array(items.clone()),
        other => other.get("rows").cloned().unwrap_or(json!([])),
    };
    let is_array = body.is_array();
    let get = |k: &str| if is_array { Value::Null } else { body.get(k).cloned().unwrap_or(Value::Null) };
    let search_context = get("search_context");
    let dbg = get("debug");
    let pool = get("pool");
    let candidate_ladder = [search_context.get("candidate_id_ladder"), dbg.get("candidateIdLadder")]
        .into_iter()
        .flatten()
        .find(|v| js::truthy(Some(v)))
        .cloned()
        .unwrap_or_else(|| if pool.is_null() { Value::Null } else { json!({ "requestedLimit": pool.get("candidateIdLimit"), "appliedLimit": pool.get("appliedCandidateIdLimit") }) });
    let predictive = [
        dbg.get("candidateDebug").and_then(|c| c.get("predictivePool")),
        dbg.get("predictivePool"),
        search_context.get("non_name_context").and_then(|c| c.get("predictive_pool")),
        search_context.get("nonNameContext").and_then(|c| c.get("predictivePool")),
    ]
    .into_iter()
    .flatten()
    .find(|v| js::truthy(Some(v)))
    .cloned()
    .unwrap_or(Value::Null);
    let predicted_tokens = [predictive.get("predictedTokens"), predictive.get("predicted_tokens")].into_iter().flatten().find(|v| js::truthy(Some(v))).cloned().unwrap_or(json!([]));
    let row_count = rows.as_array().map_or(0, Vec::len);
    let len_of = |v: Option<&Value>| v.and_then(Value::as_array).map_or(0, Vec::len);
    let timing_or = |v: Option<&Value>| v.filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null);
    let mut out = Map::new();
    out.insert("ok".into(), json!(true));
    out.insert("endpoint".into(), json!("/api/searchbar-cards"));
    out.insert("mode".into(), json!(mode));
    out.insert("query".into(), json!(query));
    out.insert("search_language".into(), json!(language));
    out.insert("search_session_id".into(), json!(session));
    out.insert("limit".into(), json!(limit));
    out.insert("pool_limit".into(), json!(pool_limit));
    out.insert("rows".into(), rows);
    out.insert("search_context".into(), search_context.clone());
    out.insert(
        "meta".into(),
        json!({
            "visible_row_count": row_count,
            "rows_capped_by_limit": row_count as i64 <= limit,
            "rows_capped_by_preview_limit": row_count <= 20,
            "pool": pool,
            "candidate_id_ladder": candidate_ladder,
            "candidate_counts": {
                "visible_rows": row_count,
                "pool_size": pool.get("size").filter(|v| !v.is_null()).or(dbg.get("poolSize")).cloned().unwrap_or(Value::Null),
                "context_card_ids": len_of(search_context.get("card_ids")),
                "context_candidate_labels": len_of(search_context.get("candidate_labels")),
            },
            "prediction_context": if !js::truthy(Some(&prediction)) { Value::Null } else { json!({
                "candidate_count": len_of(prediction.get("candidates")),
                "normalized_fragment": ([prediction.get("normalized_fragment"), prediction.get("normalizedFragment")].into_iter().flatten().find(|v| js::truthy(Some(v))).cloned().unwrap_or(Value::Null)),
            }) },
            "search_path": ([dbg.get("searchPath"), pool.get("strategy")].into_iter().flatten().find(|v| js::truthy(Some(v))).cloned().unwrap_or(Value::Null)),
            "predictive": if predictive.is_null() { Value::Null } else { json!({
                "model": predictive.get("model").filter(|v| js::truthy(Some(v))).or(predictive.get("strategy")).cloned().unwrap_or(Value::Null),
                "predicted_tokens": predicted_tokens,
                "sources": predictive.get("sources").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!([])),
                "failed_source_count": predictive.get("failedSourceCount").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!(0)),
            }) },
            "timings": {
                "server_timing": server_timing.as_ref().and_then(|v| v.to_str().ok().map(str::to_owned)),
                "duration_ms": timing_or(dbg.get("durationMs")),
                "candidate_ms": timing_or(dbg.get("candidateDurationMs")),
                "analytics_ms": timing_or(dbg.get("analyticsDurationMs")),
                "rank_ms": timing_or(dbg.get("rankDurationMs")),
            },
        }),
    );
    if debug && !dbg.is_null() {
        out.insert("debug".into(), dbg);
    }
    let cache = if method == Method::POST {
        "no-store"
    } else if !query.is_empty() {
        "public, max-age=5, s-maxage=30"
    } else {
        "public, max-age=10, s-maxage=60, stale-while-revalidate=120"
    };
    with_timing(http::json_with(StatusCode::OK, Value::Object(out), &[("cache-control", cache)]))
}
