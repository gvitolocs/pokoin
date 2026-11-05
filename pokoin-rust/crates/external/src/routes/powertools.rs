//! Power Tools session + pricer routes.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::Uri;
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{json, Value};

use crate::error::{clean_text, json_response, ApiError, ApiResult};
use crate::powertools as pt;
use crate::pricing;
use crate::pricing_store;
use crate::pricing_strategies;
use crate::routes::util::{body_json, query_first, require_token};
use crate::state::DomainState;
use crate::time_util;

/// `GET /api/powertools-connect` — safe status + CardTrader account match.
pub async fn status(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    Ok(json_response(200, json!({ "ok": true, "status": status_for(&state, &identity.uid).await? })))
}

async fn status_for(state: &DomainState, uid: &str) -> ApiResult<Value> {
    let doc = pt::read_power_tools_doc(state.firestore.as_ref(), uid).await?;
    let mut result = pt::safe_power_tools_status(&doc);
    let connected = result.get("connected") == Some(&Value::Bool(true));
    let account = result.get("account").cloned().unwrap_or(Value::Null);
    result["cardtraderMatch"] = if connected {
        pt::cardtrader_match(state.firestore.as_ref(), uid, &account).await?
    } else {
        Value::Null
    };
    Ok(result)
}

/// `POST /api/powertools-connect` — password sign-in or a pasted session jwt.
pub async fn connect(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = body_json(&body).await?;
    let using_password = payload
        .get("session")
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);

    let jwt = if using_password {
        let doc = pt::read_power_tools_doc(state.firestore.as_ref(), &identity.uid).await?;
        let data = if doc.exists { doc.data.clone() } else { json!({}) };
        let (blocked, window_start, failed) = pt::login_throttle(&data, time_util::now_ms());
        if blocked {
            return Err(ApiError::new(
                429,
                "Too many Power Tools sign-in attempts. Try again in an hour.",
            )
            .with_code("powertools_login_throttled"));
        }
        let email = payload.get("email").and_then(Value::as_str).unwrap_or_default();
        let password = payload.get("password").and_then(Value::as_str).unwrap_or_default();
        match state.powertools.login_with_password(email, password).await {
            Ok(jwt) => jwt,
            Err(error) => {
                if error.code.as_deref() == Some("powertools_invalid_credentials") {
                    pt::record_failed_login(
                        state.firestore.as_ref(),
                        &identity.uid,
                        window_start,
                        failed,
                    )
                    .await;
                }
                return Err(error);
            }
        }
    } else {
        let raw = payload.get("session").and_then(Value::as_str).unwrap_or_default();
        pt::clean_session_token(raw)?
    };

    let account = state.powertools.fetch_user(&jwt).await.map_err(|mut error| {
        if error.code.as_deref() == Some("powertools_session_expired") {
            error.status = 401;
            error.message = "Power Tools did not accept that session.".into();
        }
        error
    })?;
    pt::store_power_tools_session(state.firestore.as_ref(), &identity.uid, &jwt, &account).await?;
    let status = status_for(&state, &identity.uid).await?;
    Ok(json_response(200, json!({ "ok": true, "status": status })))
}

/// `DELETE /api/powertools-connect` — forget the stored session.
pub async fn disconnect(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    pt::disconnect_power_tools(state.firestore.as_ref(), &identity.uid).await?;
    let status = status_for(&state, &identity.uid).await?;
    Ok(json_response(200, json!({ "ok": true, "status": status })))
}

/// The seller's strategies as stored, upgraded to named strategies without
/// scope (`pricing::upgrade_stored_strategy`), and the raw user document.
async fn read_strategies(state: &DomainState, uid: &str) -> ApiResult<(Value, Vec<Value>)> {
    pricing_strategies::read(state.firestore.as_ref(), uid).await
}

async fn write_strategies(state: &DomainState, uid: &str, strategies: &[Value], extra: Value) -> ApiResult<()> {
    pricing_strategies::write(state.firestore.as_ref(), uid, strategies, extra).await
}

/// Once per seller: every strategy saved with a scope (game, live/paused,
/// condition, language) becomes a pricing group of the same name, holding
/// the listings that scope takes today, and loses its `legacyScope`.
/// Strategies without a scope get no group. Idempotent: the scope is
/// dropped only after its group is written.
async fn migrate_scoped_strategies(state: &DomainState, uid: &str, strategies: &mut [Value]) -> ApiResult<bool> {
    if !strategies.iter().any(|s| s.get("legacyScope").is_some()) {
        return Ok(false);
    }
    let db = state.db.writer()?;
    let rows = pricing_store::seller_rows(&db, uid).await?;
    let mut groups = pricing_store::list_groups(&db, uid).await?;
    let snapshot: Vec<Value> = strategies.to_vec();
    for strategy in strategies.iter_mut() {
        let Some(scope) = strategy.get("legacyScope").cloned() else { continue };
        let base = strategy["name"].as_str().unwrap_or("Strategy").to_string();
        let mut name = base.clone();
        let mut n = 2;
        while groups.iter().any(|g| g["name"].as_str().is_some_and(|other| other.to_lowercase() == name.to_lowercase())) {
            name = format!("{base} ({n})");
            n += 1;
        }
        let group = pricing::sanitize_group(&json!({ "name": name, "strategyId": strategy["id"] }), None, &snapshot, &groups)?;
        pricing_store::upsert_group(&db, uid, &group).await?;
        let ids: Vec<uuid::Uuid> = rows
            .iter()
            .filter(|row| pricing::legacy_scope_matches(&scope, row))
            .filter_map(|row| uuid::Uuid::parse_str(row["id"].as_str()?).ok())
            .collect();
        pricing_store::add_members(&db, uid, group["id"].as_str().unwrap_or(""), &ids).await?;
        groups.push(group);
        if let Some(object) = strategy.as_object_mut() {
            object.remove("legacyScope");
        }
    }
    Ok(true)
}

/// Strategies (each with its one-line summary and the groups using it),
/// groups and pricer settings.
async fn read_profile(state: &DomainState, uid: &str) -> ApiResult<Value> {
    let (data, mut strategies) = read_strategies(state, uid).await?;
    if migrate_scoped_strategies(state, uid, &mut strategies).await? {
        write_strategies(state, uid, &strategies, json!({ "pricingMigratedAt": time_util::iso_from_ms(time_util::now_ms()) })).await?;
    }
    let groups = match state.db.writer() {
        Ok(db) => pricing_store::list_groups(&db, uid).await?,
        Err(_) => Vec::new(),
    };
    let strategies: Vec<Value> = strategies
        .into_iter()
        .map(|mut strategy| {
            strategy["summary"] = json!(pricing::strategy_summary(&strategy));
            strategy["groupNames"] = json!(groups
                .iter()
                .filter(|g| g["strategyId"] == strategy["id"])
                .map(|g| g["name"].clone())
                .collect::<Vec<_>>());
            strategy
        })
        .collect();
    Ok(json!({
        "strategies": strategies,
        "groups": groups,
        "pricerSettings": pricing::sanitize_settings(data.get("pricerSettings")),
    }))
}

/// `GET /api/marketplace-pricing-strategies` — strategies, groups, settings.
pub async fn strategies_get(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    Ok(json_response(200, read_profile(&state, &identity.uid).await?))
}

/// `POST /api/marketplace-pricing-strategies` — `{ strategy }` creates or
/// edits a named strategy, `{ pricerSettings }` saves the board defaults.
pub async fn strategies_post(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = body_json(&body).await?;
    let mut extra = serde_json::Map::new();
    if let Some(settings) = payload.get("pricerSettings") {
        extra.insert("pricerSettings".into(), pricing::sanitize_settings(Some(settings)));
    }
    let mut saved_id = Value::Null;
    if let Some(strategy) = payload.get("strategy") {
        let (saved, _) = pricing_strategies::save(state.firestore.as_ref(), &identity.uid, strategy, Value::Object(extra)).await?;
        saved_id = saved["id"].clone();
    } else if extra.is_empty() {
        return Err(ApiError::bad_request("strategy or pricerSettings body required."));
    } else {
        extra.insert("updatedAt".into(), json!(time_util::iso_from_ms(time_util::now_ms())));
        state.firestore.merge_doc("users", &identity.uid, Value::Object(extra)).await?;
    }
    let mut profile = read_profile(&state, &identity.uid).await?;
    profile["savedId"] = saved_id;
    Ok(json_response(200, profile))
}

/// `DELETE /api/marketplace-pricing-strategies?id=...` — refused (409
/// `strategy_in_use`) while a group uses it.
pub async fn strategies_delete(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let id = clean_text(Some(&query_first(&uri, "id").unwrap_or_default()), 40);
    if id.is_empty() {
        return Err(ApiError::bad_request("Strategy id is required."));
    }
    pricing_strategies::delete(state.firestore.as_ref(), &state.db.writer()?, &identity.uid, &id).await?;
    Ok(json_response(200, read_profile(&state, &identity.uid).await?))
}

/// `GET /api/marketplace-pricing-groups` — `{ groups, memberships:
/// [[listingId, groupId]] }`.
pub async fn groups_get(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let db = state.db.writer()?;
    let groups = pricing_store::list_groups(&db, &identity.uid).await?;
    let memberships = pricing_store::memberships(&db, &identity.uid).await?;
    Ok(json_response(200, json!({ "groups": groups, "memberships": memberships })))
}

/// `POST /api/marketplace-pricing-groups` — `{ group: { id?, name,
/// strategyId, autoDaily } }` creates or edits a group; with `add` (listing
/// ids) a new group starts with those listings. `{ groupId, add, remove }`
/// moves listings: `add` into the group (out of any other), `remove` out of
/// their group.
pub async fn groups_post(State(state): State<DomainState>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let uid = identity.uid.as_str();
    let payload = body_json(&body).await?;
    let db = state.db.writer()?;
    let mut group_id = clean_text(payload.get("groupId").and_then(Value::as_str), 40);
    if let Some(input) = payload.get("group") {
        let (_, strategies) = read_strategies(&state, uid).await?;
        let groups = pricing_store::list_groups(&db, uid).await?;
        let id = clean_text(input.get("id").and_then(Value::as_str), 40);
        let existing = groups.iter().find(|g| !id.is_empty() && g["id"] == id.as_str()).cloned();
        if !id.is_empty() && existing.is_none() {
            return Err(ApiError::not_found("Pricing group not found.").with_code("pricing_group_unknown"));
        }
        if existing.is_none() && groups.len() >= pricing::MAX_GROUPS {
            return Err(ApiError::bad_request(format!("You can keep up to {} groups.", pricing::MAX_GROUPS)));
        }
        let others: Vec<Value> = groups.iter().filter(|g| g["id"] != id.as_str() || id.is_empty()).cloned().collect();
        let group = pricing::sanitize_group(input, existing.as_ref(), &strategies, &others)?;
        pricing_store::upsert_group(&db, uid, &group).await?;
        group_id = group["id"].as_str().unwrap_or("").to_string();
    }
    let add = pricing_store::listing_ids(payload.get("add").unwrap_or(&Value::Null));
    let remove = pricing_store::listing_ids(payload.get("remove").unwrap_or(&Value::Null));
    let mut added = 0;
    if !add.is_empty() {
        if pricing_store::group(&db, uid, &group_id).await?.is_none() {
            return Err(ApiError::not_found("Pricing group not found.").with_code("pricing_group_unknown"));
        }
        added = pricing_store::add_members(&db, uid, &group_id, &add).await?;
    }
    let removed = pricing_store::remove_members(&db, uid, &remove).await?;
    if payload.get("group").is_none() && add.is_empty() && remove.is_empty() {
        return Err(ApiError::bad_request("group, add or remove body required."));
    }
    let groups = pricing_store::list_groups(&db, uid).await?;
    let memberships = pricing_store::memberships(&db, uid).await?;
    Ok(json_response(200, json!({
        "groupId": if group_id.is_empty() { Value::Null } else { json!(group_id) },
        "added": added, "removed": removed, "groups": groups, "memberships": memberships,
    })))
}

/// `DELETE /api/marketplace-pricing-groups?id=pg_…` — its listings leave it
/// and keep their prices.
pub async fn groups_delete(State(state): State<DomainState>, headers: HeaderMap, uri: Uri) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let id = clean_text(Some(&query_first(&uri, "id").unwrap_or_default()), 40);
    if id.is_empty() {
        return Err(ApiError::bad_request("Group id is required."));
    }
    let db = state.db.writer()?;
    if !pricing_store::delete_group(&db, &identity.uid, &id).await? {
        return Err(ApiError::not_found("Pricing group not found.").with_code("pricing_group_unknown"));
    }
    let groups = pricing_store::list_groups(&db, &identity.uid).await?;
    let memberships = pricing_store::memberships(&db, &identity.uid).await?;
    Ok(json_response(200, json!({ "groups": groups, "memberships": memberships })))
}

/// `GET /api/marketplace-price-check` — per-listing market comps.
pub async fn price_check(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let items = query_first(&uri, "items").unwrap_or_default();
    let game = pokoin_api_common::game::parse_game_from_request(
        &pokoin_api_common::http::header_pairs(&headers),
        query_first(&uri, "game").as_deref(),
        query_first(&uri, "marketplaceGame").as_deref(),
    );
    // Comps net of this seller's own CardTrader commission when connected.
    let channel = crate::ct_fees::seller_channel_cached(state.firestore.as_ref(), &state.db, &identity.uid).await;
    let payload = crate::price_check::handle_for(&state.db, &game, &items, &identity.uid, channel).await?;
    let mut response = json_response(200, payload);
    response
        .headers_mut()
        .insert("Cache-Control", "private, max-age=30".parse().unwrap());
    Ok(response)
}

