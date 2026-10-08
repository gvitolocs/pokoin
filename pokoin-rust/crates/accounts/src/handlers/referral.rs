//! `marketplace-referral` — Pokoin Invite & Earn plus Ambassador progress.
//!
//! `GET` returns your invite code, invited collectors, rewards and ambassador
//! tier. `POST {action:'claim', code}` attaches this new account to an inviter.
//! Both need a Firebase bearer. Rewards (20 PKN each side) are paid by
//! [`crate::domain::referral::settle_referral`], only when something is
//! pending: the caller's own reward inline, their invites in the background.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value as Json};

use crate::domain::ambassador::{ambassador_progress, roster_from_row, Roster};
use crate::domain::referral::{
    claim_referral, referral_summary, settle_pending, settle_referral, SettleOutcome,
};
use crate::error::{ApiError, Result};
use crate::firestore::Firestore;
use crate::sql::SqlParam;
use crate::state::DomainState;

use super::{
    apply_cors, json_with_cors, method_not_allowed, parse_body, require_claims, string_field,
};

/// The roster/contributions lookup. Missing tables (before migration 093) must
/// not break Invite & Earn, so `42P01` and `42703` are tolerated.
async fn roster_and_contributions(
    state: &DomainState,
    email: &str,
) -> (Option<Roster>, Vec<Json>) {
    let clean = email.trim().to_ascii_lowercase();
    if clean.is_empty() {
        return (None, Vec::new());
    }
    let Ok(db) = state.marketplace_db() else {
        return (None, Vec::new());
    };
    let roster = db
        .query_json(
            "select role, display_name, city, active from public.marketplace_associates \
             where lower(email) = $1 limit 1",
            &[SqlParam::Text(clean.clone())],
        )
        .await;
    let contributions = db
        .query_json(
            "select mission, note, link, verified_at from public.marketplace_ambassador_contributions \
             where lower(email) = $1 order by verified_at desc limit 100",
            &[SqlParam::Text(clean)],
        )
        .await;
    match (roster, contributions) {
        (Ok(roster), Ok(contributions)) => (
            roster.first().map(roster_from_row),
            contributions,
        ),
        (roster, contributions) => {
            // A missing table is a deployment state, not an error.
            let tolerated = |error: &crate::sql::SqlError| {
                error.undefined_table() || error.code.as_deref() == Some("42703")
            };
            if let Err(error) = &roster {
                if !tolerated(error) {
                    tracing::error!(%error, "referral ambassador lookup failed");
                }
            }
            if let Err(error) = &contributions {
                if !tolerated(error) {
                    tracing::error!(%error, "referral ambassador contribution lookup failed");
                }
            }
            (None, Vec::new())
        }
    }
}

fn contributions_json(rows: &[Json]) -> Vec<Json> {
    rows.iter()
        .take(20)
        .map(|row| {
            let verified_at = row
                .get("verified_at")
                .and_then(Json::as_str)
                .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                .map(|parsed| {
                    parsed
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                });
            json!({
                "mission": row.get("mission").cloned().unwrap_or(Json::Null),
                "note": row.get("note").and_then(Json::as_str).unwrap_or(""),
                "link": row.get("link").and_then(Json::as_str).unwrap_or(""),
                "verifiedAt": verified_at,
            })
        })
        .collect()
}

/// The GET payload (also returned after a successful claim).
///
/// The roster/contributions lookup and the referral summary run concurrently,
/// exactly like the Node `Promise.all` shape.
pub async fn referral_payload(
    state: &DomainState,
    firestore: &Firestore,
    uid: &str,
    email: &str,
    now_ms: i64,
) -> Result<Json> {
    let (summary_result, (roster, contributions)) = tokio::join!(
        referral_summary(firestore, uid),
        roster_and_contributions(state, email),
    );
    let mut summary = summary_result?;
    let pending = summary
        .get("stats")
        .and_then(|stats| stats.get("pending"))
        .and_then(Json::as_i64)
        .unwrap_or(0);

    // Settle only what is actually pending. The caller's own reward is awaited
    // below; their invites settle in the background, and every 10 minutes from
    // referral-reconcile.js on the Pi.
    if pending > 0 {
        let firestore = firestore.clone();
        let uid = uid.to_string();
        tokio::spawn(async move {
            if let Err(error) = settle_pending(&firestore, now_ms, 50, &uid).await {
                tracing::error!(%error, "referral settle (invited) failed");
            }
        });
    }

    let referred_pending = summary
        .get("referredBy")
        .and_then(|referred| referred.get("status"))
        .and_then(Json::as_str)
        == Some("pending");
    if referred_pending {
        match settle_referral(firestore, uid, now_ms).await {
            Ok(SettleOutcome::Rewarded { .. }) => {
                summary = referral_summary(firestore, uid).await?;
            }
            Ok(_) => {}
            Err(error) => tracing::error!(%error, "referral settle (self) failed"),
        }
    }

    let activated = summary
        .get("stats")
        .and_then(|stats| stats.get("activated"))
        .and_then(Json::as_i64)
        .unwrap_or(0);
    let progress = ambassador_progress(activated, &contributions, roster.as_ref());

    let mut body = summary;
    if let Some(object) = body.as_object_mut() {
        let mut ambassador = progress;
        if let Some(ambassador_object) = ambassador.as_object_mut() {
            ambassador_object
                .insert("contributions".into(), Json::Array(contributions_json(&contributions)));
        }
        object.insert("ok".into(), json!(true));
        object.insert("ambassador".into(), ambassador);
    }
    Ok(body)
}

/// `GET|POST /api/marketplace-referral`.
pub async fn marketplace_referral(
    State(state): State<DomainState>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match marketplace_referral_inner(&state, &method, &headers, &body).await {
        Ok(response) => response,
        Err(error) => referral_error(error),
    }
}

async fn marketplace_referral_inner(
    state: &DomainState,
    method: &axum::http::Method,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    // An auth failure keeps the Node `authErrorResponse` shape: `{error}` with
    // no machine `code`, unlike the referral errors below.
    let claims = match require_claims(state, headers).await {
        Ok(claims) => claims,
        Err(error) => return Ok(auth_response(error)),
    };
    let firestore = state.firestore()?;
    let now_ms = state.clock().now().timestamp_millis();

    if method == axum::http::Method::POST {
        let body = parse_body(body);
        let action = string_field(&body, "action").trim().to_string();
        if action != "claim" {
            return Err(ApiError::bad_request("Unknown action."));
        }
        let auth = state.auth()?;
        let account_created_ms = auth
            .get_user(&claims.uid)
            .await
            .map(|user| user.created_at_millis())
            .unwrap_or(0);
        let claim = claim_referral(
            &firestore,
            &claims.uid,
            &string_field(&body, "code"),
            account_created_ms,
            now_ms,
        )
        .await?;
        let mut payload =
            referral_payload(state, &firestore, &claims.uid, &claims.email, now_ms).await?;
        if let Some(object) = payload.as_object_mut() {
            object.insert("claim".into(), json!(claim.status));
        }
        return Ok(referral_ok(state, payload));
    }

    let payload =
        referral_payload(state, &firestore, &claims.uid, &claims.email, now_ms).await?;
    Ok(referral_ok(state, payload))
}

fn referral_ok(state: &DomainState, body: Json) -> Response {
    let _ = state;
    let mut response = json_with_cors(StatusCode::OK, body);
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response
}

/// `authErrorResponse(error)` — status plus a bare `{error}` body.
fn auth_response(error: ApiError) -> Response {
    let status = error.status();
    let mut response = json_with_cors(
        status,
        json!({ "error": if error.message().is_empty() { "Sign in first." } else { error.message() } }),
    );
    apply_cors(response.headers_mut());
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response
}

/// The Node error mapping: `statusCode` plus a machine `code`.
fn referral_error(error: ApiError) -> Response {
    let status = error.status();
    let status = if status.is_client_error() || status.is_server_error() {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    if status.is_server_error() {
        tracing::error!(%error, "marketplace-referral failed");
    }
    let body = json!({
        "error": if error.message().is_empty() { "Invite & Earn failed." } else { error.message() },
        "code": error.code().unwrap_or(""),
    });
    let mut response = json_with_cors(status, body);
    apply_cors(response.headers_mut());
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("Authorization, Content-Type"),
    );
    response
}

/// `Allow: GET, POST, OPTIONS`.
pub async fn marketplace_referral_options() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors(response.headers_mut());
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("Authorization, Content-Type"),
    );
    response
}

use axum::response::IntoResponse;

/// `Allow: GET, POST, OPTIONS`.
pub async fn marketplace_referral_other() -> Response {
    method_not_allowed("GET, POST, OPTIONS")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contribution_rows_are_trimmed_to_public_facts() {
        let rows = vec![
            json!({
                "mission": "content",
                "note": "wrote a guide",
                "link": "https://pokoin.com/guide",
                "verified_at": "2026-10-08T00:00:00Z"
            }),
            json!({ "mission": "feedback" }),
        ];
        let mapped = contributions_json(&rows);
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0]["mission"], json!("content"));
        assert_eq!(mapped[0]["verifiedAt"], json!("2026-10-08T00:00:00.000Z"));
        // Absent optional fields become empty strings / null.
        assert_eq!(mapped[1]["note"], json!(""));
        assert_eq!(mapped[1]["link"], json!(""));
        assert_eq!(mapped[1]["verifiedAt"], Json::Null);
    }

    #[test]
    fn at_most_twenty_contributions_are_returned() {
        let rows: Vec<Json> = (0..25).map(|_| json!({ "mission": "content" })).collect();
        assert_eq!(contributions_json(&rows).len(), 20);
    }

    #[test]
    fn referral_errors_keep_the_machine_code() {
        let response = referral_error(
            ApiError::bad_request("That invite link is not valid.").with_code("invalid_code"),
        );
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = referral_error(ApiError::conflict("nope").with_code("not_new"));
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let response = referral_error(ApiError::internal("boom"));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
