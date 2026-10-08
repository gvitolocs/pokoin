//! CardTrader integration, inventory reconcile, webhook and Zero routes.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use serde_json::{json, Value};

use crate::cardtrader::{client, integration, sync, webhook, zero};
use crate::cardtrader_live;
use crate::cardtrader_listings;
use crate::error::{clean_text, header_value, json_response, ApiError, ApiResult};
use crate::routes::util::{body_json, not_implemented, query_first, query_pairs, require_token};
use crate::state::DomainState;

const IMPORT_DRY_RUN_LIMIT: i64 = 5;

/// `POST /api/cardtrader-connect` — validate + store a seller API token and
/// register the per-seller webhook URL. `DELETE` is the same as disconnect.
pub async fn connect(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = body_json(&body).await?;
    let token = client::clean_token(payload.get("token").and_then(Value::as_str).unwrap_or_default());
    if token.len() < 16 {
        return Err(ApiError::bad_request("Enter a valid CardTrader API token.")
            .with_code("cardtrader_token_invalid"));
    }
    let info = state.cardtrader.validate_token(&token).await?;
    let email = identity.email.clone().unwrap_or_default();
    integration::store_connected_integration(
        state.firestore.as_ref(),
        &identity.uid,
        &email,
        &token,
        &info,
    )
    .await?;

    // Webhook registration is best-effort telemetry: a CardTrader outage must
    // not fail an otherwise valid connect.
    let webhook_url = state.webhook_url_for_uid(&identity.uid);
    let registration = state
        .cardtrader
        .update_app_webhook_url(&token, &webhook_url)
        .await;
    let (ok, error) = match registration {
        Ok(_) => (true, String::new()),
        Err(err) => (false, err.message.clone()),
    };
    integration::record_webhook_registration(
        state.firestore.as_ref(),
        &identity.uid,
        &webhook_url,
        ok,
        &error,
    )
    .await;

    let doc = integration::read_integration_doc(state.firestore.as_ref(), &identity.uid).await?;
    let status = integration::safe_status_from_doc(&doc);
    Ok(json_response(200, json!({ "ok": true, "integration": status })))
}

/// `POST /api/cardtrader-disconnect` (and the DELETE half of connect).
pub async fn disconnect(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    integration::disconnect_integration(state.firestore.as_ref(), &identity.uid).await?;
    Ok(json_response(200, json!({ "ok": true, "connected": false })))
}

/// `GET /api/cardtrader-status`.
pub async fn status(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let doc = integration::read_integration_doc(state.firestore.as_ref(), &identity.uid).await?;
    Ok(json_response(200, integration::safe_status_from_doc(&doc)))
}

/// `POST /api/cardtrader-import-dry-run` — read the seller export and return a
/// redacted summary. Never writes inventory.
pub async fn import_dry_run(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let token = state.require_cardtrader_token(&identity.uid).await?;
    let products = state.cardtrader.fetch_products_export(&token).await?;
    let mut summary = client::import_dry_run_summary(&products);
    summary["dryRun"] = json!(true);
    summary["sampleLimit"] = json!(IMPORT_DRY_RUN_LIMIT);
    Ok(json_response(200, summary))
}

/// `GET /api/cardtrader-sync` — last known sync state for the seller.
pub async fn sync_status(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let running = state.sync_jobs.is_running(&identity.uid).await;
    let stored = sync::read_seller_sync(&state.db, &identity.uid).await?;
    Ok(json_response(
        200,
        json!({
            "running": running,
            "sync": stored.unwrap_or(Value::Null),
        }),
    ))
}

/// `POST /api/cardtrader-sync` — enqueue the background reconcile.
pub async fn sync_start(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let (started, already_running) = state.enqueue_cardtrader_sync(&identity.uid).await?;
    Ok(json_response(
        200,
        json!({
            "ok": true,
            "started": started,
            "alreadyRunning": already_running,
        }),
    ))
}

/// `GET /api/cardtrader-assets` — 1-Day Ready inventory as dashboard assets.
pub async fn assets(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let rows = sync::read_one_day_ready_assets(&state.db, &identity.uid, 500).await?;
    Ok(json_response(
        200,
        json!({
            "ok": true,
            "assets": rows,
        }),
    ))
}

/// `GET /api/cardtrader-zero` — weekly merged Zero picking list.
pub async fn zero(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let list = zero::zero_list(
        &state.cardtrader,
        state.firestore.as_ref(),
        &state.db,
        &state.powertools,
        &identity.uid,
    )
    .await?;
    Ok(json_response(200, list))
}

/// `POST /api/cardtrader-clean-listings` — deactivate CardTrader-linked stock.
pub async fn clean_listings(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let deactivated = sync::hide_imported_cardtrader_listings(&state.db, &identity.uid, false).await?;
    Ok(json_response(200, json!({ "ok": true, "deactivated": deactivated })))
}

/// `POST /api/cardtrader-webhook/:uid` — HMAC-verified order webhook.
pub async fn webhook(
    State(state): State<DomainState>,
    Path(uid): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let signature = header_value(&headers, "signature");
    let payload: Option<Value> = serde_json::from_slice(&body).ok();
    let out = webhook::handle_webhook(
        state.firestore.as_ref(),
        &state.db,
        &uid,
        &body,
        &signature,
        payload.as_ref(),
    )
    .await?;
    Ok(json_response(200, out))
}

/// `GET /api/cardtrader-blueprint-listings` — historical daily snapshots.
pub async fn blueprint_listings(
    State(state): State<DomainState>,
    uri: Uri,
) -> ApiResult<Response> {
    let request = cardtrader_listings::parse_request(&query_pairs(&uri))?;
    match cardtrader_listings::read_blueprint_listings(&state.db, &request).await {
        Ok(payload) => {
            let mut response = json_response(200, payload);
            response.headers_mut().insert(
                "Cache-Control",
                "public, max-age=15, s-maxage=120".parse().unwrap(),
            );
            Ok(response)
        }
        Err(error) if error.is_table_missing() => Ok(json_response(
            503,
            json!({
                "error": "CardTrader global market listing Oracle table is not installed yet.",
                "setupRequired": true,
                "migration": "oracle-postgres/schema/012_cardtrader_market_listings.sql",
                "code": error.code,
            }),
        )),
        Err(error) => Err(error),
    }
}

/// `GET /api/cardtrader-live-listings` — live on-demand CardTrader listings.
pub async fn live_listings(
    State(state): State<DomainState>,
    uri: Uri,
) -> ApiResult<Response> {
    let request = cardtrader_live::parse_request(&query_pairs(&uri))?;
    let game = query_first(&uri, "game").unwrap_or_else(|| "pokemon".to_string());
    let payload = cardtrader_live::read_live_listings(
        &state.db,
        &state.cardtrader,
        state.redis.as_ref(),
        &request,
        &game,
    )
    .await?;
    let mut response = json_response(200, payload);
    let expose = response
        .headers()
        .get("Access-Control-Expose-Headers")
        .cloned();
    let _ = expose;
    response
        .headers_mut()
        .insert("Access-Control-Allow-Origin", "*".parse().unwrap());
    Ok(response)
}

/// `GET|POST /api/cardtrader-daily-listings-refresh` — secret-gated admin trigger.
pub async fn daily_refresh(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let provided = secret_from(&headers);
    if !state.config.secret_matches(&provided) {
        return Err(ApiError::new(401, "Invalid refresh secret.").with_code("invalid_secret"));
    }
    not_implemented(
        "/api/cardtrader-daily-listings-refresh",
        "Secret gate is implemented; the bounded global snapshot ingest SQL/worker is not ported yet.",
    )
}

/// `GET|POST /api/cardtrader-game-ingest` — satellite-game ingest control.
pub async fn game_ingest(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let provided = secret_from(&headers);
    if !state.config.game_secret_matches(&provided) {
        return Err(ApiError::new(401, "Invalid game ingest secret.").with_code("invalid_secret"));
    }
    not_implemented(
        "/api/cardtrader-game-ingest",
        "Secret gate is implemented; multi-game discover/apply importer SQL is owned by another workstream.",
    )
}

/// Accept either `Authorization: Bearer <secret>` or `x-cron-secret`.
fn secret_from(headers: &HeaderMap) -> String {
    let header = header_value(headers, "authorization");
    let bearer = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .unwrap_or("")
        .trim()
        .to_string();
    if !bearer.is_empty() {
        return clean_text(Some(&bearer), 200);
    }
    clean_text(Some(&header_value(headers, "x-cron-secret")), 200)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn secret_header_accepts_bearer_and_cron_header() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer top-secret"));
        assert_eq!(secret_from(&headers), "top-secret");

        let mut headers = HeaderMap::new();
        headers.insert("x-cron-secret", HeaderValue::from_static("cron-secret"));
        assert_eq!(secret_from(&headers), "cron-secret");

        assert_eq!(secret_from(&HeaderMap::new()), "");
    }
}
