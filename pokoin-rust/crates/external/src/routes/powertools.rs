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
use crate::routes::util::{body_json, not_implemented, query_first, require_token};
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

/// Read + sanitize `users/{uid}` pricer state.
async fn read_profile(state: &DomainState, uid: &str) -> ApiResult<Value> {
    let doc = state.firestore.get_doc("users", uid).await?;
    let data = if doc.exists { doc.data } else { json!({}) };
    let now = time_util::iso_from_ms(time_util::now_ms());
    let mut strategies = Vec::new();
    if let Some(rows) = data.get("pricingStrategies").and_then(Value::as_array) {
        for row in rows {
            strategies.push(pricing::sanitize_strategy(row, Some(row), &now)?);
        }
    }
    Ok(json!({
        "strategies": strategies,
        "pricerSettings": pricing::sanitize_settings(data.get("pricerSettings")),
    }))
}

/// `GET /api/marketplace-pricing-strategies`.
pub async fn strategies_get(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    Ok(json_response(200, read_profile(&state, &identity.uid).await?))
}

/// `POST /api/marketplace-pricing-strategies`.
pub async fn strategies_post(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = body_json(&body).await?;
    let mut patch = serde_json::Map::new();
    if let Some(settings) = payload.get("pricerSettings") {
        patch.insert("pricerSettings".into(), pricing::sanitize_settings(Some(settings)));
    }
    if let Some(strategy) = payload.get("strategy") {
        let current = read_profile(&state, &identity.uid).await?;
        let rows = current.get("strategies").and_then(Value::as_array).cloned().unwrap_or_default();
        let provided_id = clean_text(strategy.get("id").and_then(Value::as_str), 40);
        let existing = rows
            .iter()
            .find(|row| clean_text(row.get("id").and_then(Value::as_str), 40) == provided_id && !provided_id.is_empty())
            .cloned();
        let now = time_util::iso_from_ms(time_util::now_ms());
        let sanitized = pricing::sanitize_strategy(strategy, existing.as_ref(), &now)?;
        let mut next: Vec<Value> = rows
            .iter()
            .filter(|row| row.get("id") != sanitized.get("id"))
            .cloned()
            .collect();
        next.push(sanitized);
        patch.insert("pricingStrategies".into(), Value::Array(next));
    }
    if patch.is_empty() {
        return Err(ApiError::bad_request("strategy or pricerSettings body required."));
    }
    patch.insert(
        "updatedAt".into(),
        json!(time_util::iso_from_ms(time_util::now_ms())),
    );
    state
        .firestore
        .merge_doc("users", &identity.uid, Value::Object(patch))
        .await?;
    Ok(json_response(200, read_profile(&state, &identity.uid).await?))
}

/// `DELETE /api/marketplace-pricing-strategies?id=...`.
pub async fn strategies_delete(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let id = query_first(&uri, "id").unwrap_or_default();
    let id = clean_text(Some(&id), 40);
    if id.is_empty() {
        return Err(ApiError::bad_request("Strategy id is required."));
    }
    let current = read_profile(&state, &identity.uid).await?;
    let rows = current.get("strategies").and_then(Value::as_array).cloned().unwrap_or_default();
    let next: Vec<Value> = rows
        .into_iter()
        .filter(|row| row.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();
    state
        .firestore
        .merge_doc(
            "users",
            &identity.uid,
            json!({
                "pricingStrategies": next,
                "updatedAt": time_util::iso_from_ms(time_util::now_ms()),
            }),
        )
        .await?;
    Ok(json_response(200, json!({ "strategies": next })))
}

/// `GET /api/marketplace-price-check` — per-listing market comps.
pub async fn price_check(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let items = query_first(&uri, "items").unwrap_or_default();
    let payload = crate::price_check::handle(&state.db, &items, &identity.uid).await?;
    let mut response = json_response(200, payload);
    response
        .headers_mut()
        .insert("Cache-Control", "private, max-age=30".parse().unwrap());
    Ok(response)
}

/// `GET /api/marketplace-listings-csv` — PowerTools/Cardmarket/CardTrader export.
pub async fn listings_csv_get(State(_state): State<DomainState>) -> ApiResult<Response> {
    not_implemented(
        "/api/marketplace-listings-csv",
        "CSV export/import needs the listing CSV serializer + stock matcher SQL wiring that is not ported yet.",
    )
}

/// `POST /api/marketplace-listings-csv` — preview/import a stock CSV.
pub async fn listings_csv_post(State(_state): State<DomainState>, _body: Bytes) -> ApiResult<Response> {
    not_implemented(
        "/api/marketplace-listings-csv",
        "CSV import needs the stock_csv matcher + marketplace writer path that is not ported yet.",
    )
}
