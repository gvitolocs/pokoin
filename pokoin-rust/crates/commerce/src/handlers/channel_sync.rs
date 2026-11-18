//! TCGplayer sync box.
//!
//! `GET|POST /api/channel-sync` and `GET /api/channel-orders` — Firebase
//! sign-in. The seller registers a device, flips the switch, and reads orders.
//!
//! `POST /api/channel-sync/device` — `Bearer pkn_…` with scope
//! `channel:tcgplayer`. Heartbeat, claim, complete, and orders. A stock-API
//! token is refused.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;

use super::{parse_json_body, private_json, text_field};
use crate::channel_sync;
use crate::error::ApiError;
use crate::seller_api::{self, SCOPE_CHANNEL_TCGPLAYER};
use crate::state::{AuthedUser, DomainState};

fn query_value(query: &HashMap<String, String>, key: &str) -> String {
    query.get(key).map(|value| value.trim().to_string()).unwrap_or_default()
}

fn query_limit(query: &HashMap<String, String>) -> i64 {
    query_value(query, "limit").parse().unwrap_or(50)
}

/// `GET /api/channel-sync?channel=tcgplayer`
pub async fn channel_sync_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let channel = channel_sync::channel_of(&query_value(&query, "channel"), None)?;
    Ok(private_json(channel_sync::status(&state, &claims.uid, channel).await?))
}

/// `POST /api/channel-sync` — `{ action, … }`
pub async fn channel_sync_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let body = parse_json_body(&bytes)?;
    let channel = channel_sync::channel_of(&query_value(&query, "channel"), Some(&body))?;
    let out = match text_field(&body, &["action"], 40).as_str() {
        "register-device" => {
            channel_sync::register_device(&state, &claims.uid, channel, &text_field(&body, &["label"], 80)).await?
        }
        "revoke-device" => channel_sync::revoke_device(&state, &claims.uid, channel).await?,
        "enable" => channel_sync::enable(&state, &claims.uid, channel).await?,
        "disable" => channel_sync::disable(&state, &claims.uid, channel).await?,
        "price-rule" => channel_sync::set_price_rule(&state, &claims.uid, channel, &body).await?,
        "sync-now" => channel_sync::sync_now(&state, &claims.uid, channel).await?,
        _ => return Err(ApiError::bad_request("Unknown action.").with_code("channel_sync/unknown-action")),
    };
    Ok(private_json(out))
}

/// `GET /api/channel-orders?channel=tcgplayer&limit=`
pub async fn channel_orders_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let channel = channel_sync::channel_of(&query_value(&query, "channel"), None)?;
    let limit = query_limit(&query);
    Ok(private_json(channel_sync::list_orders(&state, &claims.uid, channel, limit).await?))
}

/// `POST /api/channel-sync/device` — the box.
pub async fn channel_sync_device(
    State(state): State<DomainState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let grant = seller_api::authenticate(&state, &headers).await?;
    if grant.scope != SCOPE_CHANNEL_TCGPLAYER {
        return Err(ApiError::forbidden("This token is not a TCGplayer sync box grant.").with_code("channel_sync/wrong-scope"));
    }
    let body = parse_json_body(&bytes)?;
    let out = match text_field(&body, &["action"], 20).as_str() {
        "heartbeat" => channel_sync::heartbeat(&state, &grant, &body).await?,
        "claim" => channel_sync::claim(&state, &grant, &body).await?,
        "complete" => channel_sync::complete(&state, &grant, &body).await?,
        "orders" => channel_sync::ingest_orders(&state, &grant, &body).await?,
        _ => return Err(ApiError::bad_request("Unknown action.").with_code("channel_sync/unknown-action")),
    };
    Ok(private_json(out))
}
