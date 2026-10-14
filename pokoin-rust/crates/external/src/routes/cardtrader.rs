//! CardTrader integration, inventory reconcile, webhook and Zero routes.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::cardtrader::{client, integration, link, sync, webhook, zero};
use crate::cardtrader_live;
use crate::cardtrader_listings;
use crate::error::{clean_text, header_value, json_response, ApiError, ApiResult};
use crate::powertools;
use crate::routes::util::{body_json, query_first, query_pairs, require_token};
use crate::state::DomainState;

#[path = "../daily_refresh.rs"]
mod daily_refresh;
#[path = "../game_ingest.rs"]
mod game_ingest;
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
/// Unlinking removes the CardTrader-imported stock from Pokoin for good:
/// imported listings and 1-Day Ready assets are deleted (sold rows stay as
/// sales history); reconnect re-imports from the CardTrader export.
pub async fn disconnect(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    integration::disconnect_integration(state.firestore.as_ref(), &identity.uid).await?;
    let (removed_listings, removed_assets) =
        match sync::delete_imported_cardtrader_stock(&state.db, &identity.uid).await {
            Ok(counts) => counts,
            Err(error) => {
                tracing::warn!(uid = %identity.uid, "cardtrader disconnect stock cleanup failed: {}", error.message);
                (0, 0)
            }
        };
    Ok(json_response(
        200,
        json!({
            "ok": true,
            "connected": false,
            "removedListings": removed_listings,
            "removedAssets": removed_assets,
        }),
    ))
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
    let export = state.cardtrader.fetch_products_export(&token).await?;
    let mut summary = client::import_dry_run_summary(&export);
    summary["dryRun"] = json!(true);
    summary["sampleLimit"] = json!(IMPORT_DRY_RUN_LIMIT);
    Ok(json_response(200, summary))
}

/// `GET /api/cardtrader-sync` — connection, inventory link and last known
/// sync state for the seller (the Node `cardtrader-sync.js` GET shape).
pub async fn sync_status(State(state): State<DomainState>, headers: HeaderMap) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let doc = integration::read_integration_doc(state.firestore.as_ref(), &identity.uid).await?;
    let status = integration::safe_status_from_doc(&doc);
    let progress = state.sync_jobs.progress(&state.db, &identity.uid).await?;
    Ok(json_response(200, sync_status_payload(status, &progress)))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| ApiError::new(500, "Power Tools CSV processing failed."))
}

fn sync_status_payload(status: Value, progress: &Value) -> Value {
    let running = progress["running"] == true;
    let phase = progress["phase"].clone();
    let processed = progress["processed"].clone();
    let total = progress["total"].clone();
    let mut sync = match progress.get("row").filter(|row| row.is_object()) {
        Some(row) => json!({
            "lastSyncAt": row["last_sync_at"],
            "lastSyncOk": row["last_sync_ok"],
            "lastSyncIncomplete": row["last_sync_incomplete"],
            "lastSyncError": row["last_sync_error"],
            "lastCompleteExportAt": row["last_complete_export_at"],
            "lastExportProductCount": row["last_export_product_count"],
            "summary": if row["last_sync_summary"].is_object() { row["last_sync_summary"].clone() } else { json!({}) },
            "running": running,
            "phase": phase,
            "processed": processed,
            "total": total,
        }),
        None => json!({
            "running": running,
            "phase": phase,
            "processed": processed,
            "total": total,
            "summary": progress["summary"],
        }),
    };
    // A job that failed on this instance, or a stored run nobody finished, is
    // a failed sync even when its end could not be written.
    let failure = progress["lastError"].as_str().map(str::to_string).or_else(|| {
        (progress["stale"] == true).then(|| "The last CardTrader sync stopped before it finished.".to_string())
    });
    if let Some(message) = failure.filter(|_| !running) {
        sync["lastSyncOk"] = json!(false);
        sync["lastSyncError"] = json!(message);
        sync["phase"] = json!("failed");
        if sync["summary"].is_object() {
            sync["summary"]["running"] = json!(false);
            sync["summary"]["phase"] = json!("failed");
        }
    }
    json!({
        "ok": true,
        "status": status,
        "running": running,
        "phase": progress["phase"],
        "processed": progress["processed"],
        "total": progress["total"],
        "sync": sync,
    })
}

/// `POST /api/cardtrader-sync` — enqueue the background reconcile. The body
/// may also carry:
///
/// - `direction` (`ct_to_pokoin` | `pokoin_to_ct` | `both`): store which way
///   the inventory link copies new stock, then reconcile with it;
/// - `previewGames: true`: the games in the CardTrader export (no write);
/// - `powerToolsCsv` (`{ game: csv }`, with `stackSize`, `numberedInStack`,
///   `locationParse`): Power Tools locations for the matched listings, or with
///   `previewPowerTools: true` only what that import would do.
pub async fn sync_start(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let identity = require_token(&state, &headers).await?;
    let payload = body_json(&body).await?;
    let mut doc = integration::read_integration_doc(state.firestore.as_ref(), &identity.uid).await?;
    if integration::safe_status_from_doc(&doc)["connected"] != true {
        return Err(ApiError::bad_request("Connect CardTrader before syncing inventory.").with_code("cardtrader_not_connected"));
    }

    if let Some(raw) = payload.get("direction").filter(|value| !value.is_null()) {
        let direction = link::Direction::parse(raw.as_str().unwrap_or_default()).ok_or_else(|| {
            ApiError::bad_request("Choose CardTrader → Pokoin, Pokoin → CardTrader or both ways.")
                .with_code("cardtrader_direction_invalid")
        })?;
        if direction.pushes() && integration::is_one_day_ready_integration(&doc) {
            return Err(ApiError::conflict(
                "CardTrader 1-Day Ready accounts are stocked by CardTrader: their cards can only come to Pokoin.",
            )
            .with_code("cardtrader_one_day_ready"));
        }
        link::store_direction(state.firestore.as_ref(), &identity.uid, direction).await?;
        doc = integration::read_integration_doc(state.firestore.as_ref(), &identity.uid).await?;
    }
    let status = integration::safe_status_from_doc(&doc);

    if payload["previewGames"] == true || payload["previewGamesOnly"] == true {
        let token = state.require_cardtrader_token(&identity.uid).await?;
        let export = state.cardtrader.fetch_products_export(&token).await?;
        return Ok(json_response(
            200,
            json!({
                "ok": true,
                "connected": true,
                "previewGamesOnly": true,
                "games": powertools::games_from_cardtrader_products(&export.products),
                "summary": {},
                "status": status,
            }),
        ));
    }

    // CSV parsing (up to the 10 MB body) is synchronous CPU work: keep it off
    // the API's few async workers.
    let preview_power_tools = payload["previewPowerTools"] == true;
    let import = blocking(move || link::parse_power_tools_body(&payload)).await??;
    if preview_power_tools {
        let Some(import) = import else {
            return Ok(json_response(
                400,
                json!({
                    "ok": false,
                    "error": "Upload at least one Power Tools CSV.",
                    "samples": [], "overflows": [], "occupancy": [],
                    "suggestedStackSize": 1, "locationDetection": Value::Null,
                }),
            ));
        };
        // Without the export the preview still shows how locations read.
        let products = match state.require_cardtrader_token(&identity.uid).await {
            Ok(token) => state.cardtrader.fetch_products_export(&token).await.map(|export| export.products).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        let mut preview = blocking(move || link::power_tools_preview(&import, &products)).await?;
        preview["connected"] = json!(true);
        preview["status"] = status;
        return Ok(json_response(200, preview));
    }

    let overflows = import.as_ref().map(|import| import.overflows.clone()).unwrap_or_default();
    let power_tools = import.is_some();
    let (started, already_running) = state
        .enqueue_cardtrader_sync_with(&identity.uid, import.map(|import| import.by_game))
        .await?;
    Ok(json_response(
        200,
        json!({
            "ok": true,
            "connected": true,
            "async": true,
            "started": started,
            "alreadyRunning": already_running,
            "running": true,
            "incomplete": true,
            "destructiveSkipped": false,
            "powerTools": power_tools,
            "overflows": overflows,
            "error": Value::Null,
            "summary": { "running": true, "phase": "starting", "processed": 0, "total": 0, "overflows": overflows },
            "status": status,
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
    if webhook::wants_fallback_sync(&out) {
        // Best-effort, like Node: the 5-minute timer is the backstop.
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = state.enqueue_cardtrader_sync(&uid).await {
                tracing::warn!(uid, "cardtrader-webhook fallback sync enqueue failed: {}", error.message);
            }
        });
    }
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
    let headers = response.headers_mut();
    headers.insert("Access-Control-Allow-Origin", "*".parse().unwrap());
    headers.insert("Cache-Control", "public, max-age=30, s-maxage=60".parse().unwrap());
    Ok(response)
}

/// `GET|POST /api/cardtrader-daily-listings-refresh` — secret-gated admin trigger.
pub async fn daily_refresh(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let result = async {
        daily_refresh::authorize(&headers)?;
        let payload = body_json(&body).await?;
        let options = daily_refresh::request_options(&uri, &payload);
        let result = daily_refresh::run(&state, &options).await?;
        Ok::<_, ApiError>(daily_refresh::response_metadata(&options, result))
    }.await;
    match result {
        Ok(payload) => json_response(200, payload),
        Err(error) => {
            if matches!(error.code.as_deref(), Some("42P01" | "42883")) {
                return json_response(503, json!({
                    "error": "CardTrader global market listing Oracle tables/functions are not installed yet.",
                    "setupRequired": true,
                    "migration": "oracle-postgres/schema/012_cardtrader_market_listings.sql",
                    "code": error.code,
                }));
            }
            let mut payload = json!({"error": error.message});
            if let Some(code) = error.code { payload["code"] = json!(code); }
            json_response(error.status, payload)
        }
    }
}

/// `GET|POST /api/cardtrader-game-ingest` — satellite-game ingest control.
pub async fn game_ingest(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    method: Method,
    body: Bytes,
) -> Response {
    // The service guard precedes method dispatch, auth and JSON body access.
    let result = async {
        game_ingest::service_guard()?;
        let payload = body_json(&body).await?;
        game_ingest::handle(&state, &headers, &uri, &method, &payload).await
    }.await;
    match result {
        Ok((status, payload, allow)) => {
            let mut response = if status == 204 {
                crate::error::no_store(axum::http::StatusCode::NO_CONTENT.into_response())
            } else { json_response(status, payload) };
            if let Some(allow) = allow {
                response.headers_mut().insert("allow", axum::http::HeaderValue::from_static(allow));
            }
            response
        }
        Err(error) => json_response(error.status, json!({"error": error.message, "code": error.code.unwrap_or_default()})),
    }
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
    fn sync_status_carries_status_and_the_node_sync_shape() {
        let status = json!({"connected": true, "inventorySync": {"direction": "both"}});
        let progress = json!({
            "row": {"last_sync_at": "2026-10-14T10:00:00Z", "last_sync_ok": true, "last_sync_incomplete": false,
                    "last_sync_error": "", "last_sync_summary": {"imported": 3}, "last_complete_export_at": null,
                    "last_export_product_count": 12},
            "running": false, "phase": "done", "processed": 12, "total": 12, "summary": {"imported": 3},
        });
        let payload = sync_status_payload(status, &progress);
        assert_eq!(payload["status"]["inventorySync"]["direction"], "both");
        assert_eq!(payload["sync"]["lastSyncOk"], true);
        assert_eq!(payload["sync"]["summary"]["imported"], 3);
        assert_eq!(payload["running"], false);

        let first = sync_status_payload(json!({"connected": true}), &json!({"row": null, "running": true, "phase": "starting", "processed": 0, "total": 0, "summary": {}}));
        assert_eq!(first["sync"]["running"], true);
        assert_eq!(first["phase"], "starting");

        // The job failed here but its end was never stored (database down).
        let mut failed = progress.clone();
        failed["row"]["last_sync_summary"] = json!({"running": true, "phase": "starting"});
        failed["lastError"] = json!("pool timed out while waiting for an open connection");
        let payload = sync_status_payload(json!({"connected": true}), &failed);
        assert_eq!(payload["sync"]["lastSyncOk"], false);
        assert_eq!(payload["sync"]["lastSyncError"], "pool timed out while waiting for an open connection");
        assert_eq!(payload["sync"]["summary"]["phase"], "failed");

        let mut stale = progress.clone();
        stale["stale"] = json!(true);
        assert_eq!(sync_status_payload(json!({}), &stale)["sync"]["lastSyncOk"], false);
    }

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
