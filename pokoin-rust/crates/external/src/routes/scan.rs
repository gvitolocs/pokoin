//! `/api/scan/*` recognition proxies and the Scan Connect gap markers.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::Uri;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::error::{no_store, header_value, json_response, scan_client_ip, set_cors_open, ApiError, ApiResult};
use crate::routes::util::{body_json, query_first, query_pairs, require_token};
use crate::scan::WorkerReply;
use crate::state::DomainState;

/// Node verifyDesktop intentionally gives the same response for every failed
/// verification. The underlying verifier still checks signature, issuer and expiry.
fn scan_error(mut error: ApiError) -> ApiError {
    if error.status >= 500 { error.message = "Scan service error.".into(); error.code = None; }
    error
}

async fn require_desktop(state: &DomainState, headers: &HeaderMap) -> ApiResult<crate::firebase::DecodedToken> {
    require_token(state, headers).await
        .and_then(|identity| if identity.uid.is_empty() { Err(ApiError::new(401, "Sign in again to use Scan.").with_code("auth")) } else { Ok(identity) })
        .map_err(|_| ApiError::new(401, "Sign in again to use Scan.").with_code("auth"))
}

const MAX_UPLOAD_BYTES: usize = 12 * 1024 * 1024;

fn content_type(headers: &HeaderMap) -> Option<String> {
    headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
}

fn worker_response(reply: WorkerReply) -> Response {
    let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::builder()
        .status(status)
        .header("Content-Type", reply.content_type)
        .header("X-Scan-Worker", reply.worker)
        .body(axum::body::Body::from(reply.body))
        .unwrap_or_else(|_| json_response(502, json!({ "error": "Recognition worker reply failed." })));
    set_cors_open(&mut response);
    no_store(response)
}

/// `POST /api/scan/identify` — forward one multipart photo to the worker.
pub async fn identify(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    forward_upload(&state, &headers, &uri, "/identify", body).await
}

/// `POST /api/scan/identify-album` — several photos of one album page.
pub async fn identify_album(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    forward_upload(&state, &headers, &uri, "/identify-album", body).await
}

async fn forward_upload(
    state: &DomainState,
    headers: &HeaderMap,
    uri: &Uri,
    route: &str,
    body: Bytes,
) -> ApiResult<Response> {
    if body.is_empty() {
        return Err(ApiError::bad_request("Send the photo as multipart field \"file\"."));
    }
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError::new(413, "Photo too large."));
    }
    let reply = state
        .recognition
        .forward(
            route,
            "POST",
            &query_pairs(uri),
            Some(body),
            content_type(headers).as_deref(),
            &scan_client_ip(headers),
        )
        .await.map_err(|_| ApiError::unavailable("Card recognition is unavailable right now. Try again in a moment."))?;
    Ok(worker_response(reply))
}

/// `GET /api/scan/print` — print-strip second pass.
pub async fn print(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    forward_get(&state, &headers, &uri, "/print").await
}

/// `GET /api/scan/catalogs` — recognition catalogs switch list.
pub async fn catalogs(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    forward_get(&state, &headers, &uri, "/catalogs").await
}

async fn forward_get(
    state: &DomainState,
    headers: &HeaderMap,
    uri: &Uri,
    route: &str,
) -> ApiResult<Response> {
    let reply = state
        .recognition
        .forward(route, "GET", &query_pairs(uri), None, None, &scan_client_ip(headers))
        .await.map_err(|_| ApiError::unavailable("Card recognition is unavailable right now. Try again in a moment."))?;
    Ok(worker_response(reply))
}

/// `GET /api/scan/health` — which recognition workers answer.
pub async fn health(State(state): State<DomainState>) -> ApiResult<Response> {
    let (ok, payload) = state.recognition.health().await;
    let mut response = json_response(if ok { 200 } else { 503 }, payload);
    set_cors_open(&mut response);
    Ok(response)
}

/// `OPTIONS` for every public scan route.
pub async fn preflight() -> Response {
    let mut response = json_response(204, json!({}));
    set_cors_open(&mut response);
    response
}

/// `GET|POST /api/scan-batch` — staged batch snapshot, image and row actions.
pub async fn batch(state: State<DomainState>, headers: HeaderMap, uri: Uri, body: Bytes) -> ApiResult<Response> {
    batch_inner(state, headers, uri, body).await.map_err(scan_error)
}

async fn batch_inner(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let identity = require_desktop(&state, &headers).await?;
    let method_post = !body.is_empty() || query_first(&uri, "action").is_some() && query_first(&uri, "batchId").is_none();
    let payload = if body.is_empty() { json!({}) } else { body_json(&body).await? };
    let batch_id = query_first(&uri, "batchId")
        .or_else(|| payload.get("batchId").and_then(Value::as_str).map(|s| s.to_string()))
        .unwrap_or_default();
    let action = query_first(&uri, "action")
        .or_else(|| payload.get("action").and_then(Value::as_str).map(|s| s.to_string()))
        .unwrap_or_default();
    let _ = method_post;

    if action == "image" {
        let item_id = query_first(&uri, "itemId").unwrap_or_default();
        let Some(bytes) = crate::scan_store::read_image(&state.db, &identity.uid, &item_id).await? else {
            return Err(ApiError::not_found("Scan image not found."));
        };
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "private, max-age=300")
            .body(axum::body::Body::from(bytes))
            .map_err(|_| ApiError::new(500, "Image response failed."))?;
        set_cors_open(&mut response);
        return Ok(response);
    }

    if batch_id.is_empty() && query_first(&uri, "list").as_deref() == Some("open") {
        let batches = crate::scan_store::list_open_batches(&state.db, &identity.uid).await?;
        return Ok(json_response(200, json!({ "ok": true, "batches": batches })));
    }
    if batch_id.is_empty() {
        return Err(ApiError::bad_request("batchId is required."));
    }
    if action.is_empty() {
        let snapshot = crate::scan_store::read_batch_snapshot(&state.db, &identity.uid, &batch_id).await?;
        return Ok(json_response(200, snapshot));
    }
    crate::scan_store::mutate_batch(&state.db, state.scan_ownership.as_ref(), &identity.uid, &batch_id, &action, &payload)
        .await
        .map(|payload| json_response(200, payload))
}

/// `POST /api/scan-pair` — phone claims a PIN/QR and receives a phone token.
pub async fn pair(state: State<DomainState>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    pair_inner(state, headers, body).await.map_err(scan_error)
}

async fn pair_inner(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let payload = body_json(&body).await?;
    let pin = payload.get("pin").and_then(Value::as_str).unwrap_or_default();
    let qr = payload.get("qr").and_then(Value::as_str).unwrap_or_default();
    let device = payload.get("device").and_then(Value::as_str).unwrap_or_default();
    let ip = scan_client_ip(&headers);
    let user_agent = header_value(&headers, "user-agent");
    let out = crate::scan_store::claim_pairing(&state.db, pin, qr, &ip, &user_agent, device).await?;
    let mut response = json_response(200, out);
    set_cors_open(&mut response);
    Ok(response)
}

/// `POST /api/scan-phone` — heartbeat / idempotent scan event / leave.
pub async fn phone(state: State<DomainState>, headers: HeaderMap, uri: Uri, body: Bytes) -> ApiResult<Response> {
    phone_inner(state, headers, uri, body).await.map_err(scan_error)
}

async fn phone_inner(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let authorization = header_value(&headers, "authorization");
    let token = authorization
        .strip_prefix("Scan ")
        .or_else(|| authorization.strip_prefix("scan "))
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(ApiError::new(401, "This scanner is no longer connected.")
            .with_code("session_ended"));
    }
    let action = query_first(&uri, "action").unwrap_or_else(|| "heartbeat".to_string());
    let payload = if body.is_empty() { json!({}) } else { body_json(&body).await? };
    let out = match action.as_str() {
        "heartbeat" => crate::scan_store::heartbeat(&state.db, &token).await?,
        "scan" => crate::scan_store::ingest_scan(&state.db, &token, &payload).await?,
        "leave" => crate::scan_store::leave(&state.db, &token).await?,
        _ => return Err(ApiError::bad_request("Unknown action.")),
    };
    let mut response = json_response(200, out);
    set_cors_open(&mut response);
    Ok(response)
}

/// `GET|POST /api/scan-session` — desktop session lifecycle.
pub async fn session(state: State<DomainState>, headers: HeaderMap, uri: Uri, body: Bytes) -> ApiResult<Response> {
    session_inner(state, headers, uri, body).await.map_err(scan_error)
}

async fn session_inner(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let identity = require_desktop(&state, &headers).await?;
    if body.is_empty() && query_first(&uri, "action").is_none() {
        let session_id = query_first(&uri, "sessionId").unwrap_or_default();
        let out = crate::scan_store::get_session(&state.db, &identity.uid, &session_id).await?;
        return Ok(json_response(200, out));
    }
    let payload = if body.is_empty() { json!({}) } else { body_json(&body).await? };
    let action = query_first(&uri, "action")
        .or_else(|| payload.get("action").and_then(Value::as_str).map(|s| s.to_string()))
        .unwrap_or_default();
    let session_id = query_first(&uri, "sessionId")
        .or_else(|| payload.get("sessionId").and_then(Value::as_str).map(|s| s.to_string()))
        .unwrap_or_default();
    let out = match action.as_str() {
        "start" => {
            let batch_id = payload.get("batchId").and_then(Value::as_str).unwrap_or_default();
            crate::scan_store::start_session(&state.db, &identity.uid, batch_id).await?
        }
        "pairing" => crate::scan_store::regenerate_pairing(&state.db, &identity.uid, &session_id).await?,
        "disconnect" | "pause" | "end" => {
            let reason = payload.get("reason").and_then(Value::as_str).unwrap_or_default();
            let paused = payload.get("paused") == Some(&Value::Bool(true));
            crate::scan_store::update_session(&state.db, &identity.uid, &session_id, &action, reason, paused).await?
        }
        _ => return Err(ApiError::bad_request("Unknown action.")),
    };
    Ok(json_response(200, out))
}

/// `GET /api/scan-stream` — SSE change stream, closes after 55 s.
pub async fn stream(state: State<DomainState>, headers: HeaderMap, uri: Uri) -> ApiResult<Response> {
    stream_inner(state, headers, uri).await.map_err(scan_error)
}

async fn stream_inner(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use std::convert::Infallible;
    use std::time::{Duration, Instant};

    let identity = require_desktop(&state, &headers).await?;
    let batch_id = query_first(&uri, "batchId").unwrap_or_default();
    if batch_id.is_empty() {
        return Err(ApiError::bad_request("batchId is required."));
    }
    let cursor = crate::routes::util::query_i64(&uri, "after", 0, 0, i64::MAX);
    let db = state.db.clone();
    let uid = identity.uid.clone();
    let deadline = Instant::now() + Duration::from_secs(55);
    let initial = json!({ "batchId": batch_id, "after": cursor });
    let stream = futures_util::stream::unfold(
        (db, uid, batch_id, cursor, deadline, Some(initial)),
        |(db, uid, batch_id, mut cursor, deadline, initial)| async move {
            if let Some(initial) = initial {
                let event = Event::default().event("hello").data(initial.to_string());
                return Some((Ok::<Event, Infallible>(event), (db, uid, batch_id, cursor, deadline, None)));
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(1000)).await;
            let batch = crate::scan_store::read_batch_snapshot(&db, &uid, &batch_id)
                .await
                .ok()
                .and_then(|snapshot| snapshot.get("batch").cloned())
                .unwrap_or(Value::Null);
            let items = crate::scan_store::items_after(&db, &batch_id, cursor, 500)
                .await
                .unwrap_or_else(|_| json!([]));
            let session = crate::scan_store::latest_session(&db, &batch_id)
                .await
                .ok()
                .flatten()
                .map(|row| crate::scan_connect::session_view(&row, crate::time_util::now_ms()))
                .unwrap_or(Value::Null);
            if let Some(rows) = items.as_array() {
                if let Some(last) = rows.iter().filter_map(|row| row.get("seq").and_then(Value::as_i64)).max() {
                    cursor = cursor.max(last);
                }
            }
            let payload = json!({
                "batchId": batch_id,
                "batch": batch,
                "items": items,
                "session": session,
                "cursor": cursor,
            });
            let event = Event::default().event("change").data(payload.to_string());
            Some((Ok::<Event, Infallible>(event), (db, uid, batch_id, cursor, deadline, None)))
        },
    );
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response())
}
