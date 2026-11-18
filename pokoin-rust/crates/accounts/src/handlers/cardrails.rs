//! Card Rails sign-in routes:
//! `cardrails-authorize` (the consent page's browser call) and
//! `cardrails-token` (the Card Rails API's server-to-server code exchange,
//! which also hands over a seller grant when asked — see
//! [`crate::domain::cardrails`]) and `cardrails-membership` (the Card Rails
//! API's server-to-server Silver lookup, so Pokoin Silver members get Card
//! Rails Pro for as long as they stay Silver).
//!
//! The one-time code is stored only as its SHA-256 hash, shared by every API
//! instance through the marketplace **writer** database
//! (`MARKETPLACE_WRITER_DATABASE_URL` — the Pi read pool is a read-only
//! standby; see [`crate::domain::cardrails`]); the client secret lives in
//! `POKOIN_CARDRAILS_CLIENT_SECRET`. Neither the code, the verifier nor the
//! secret is ever logged.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value as JsonValue};

use crate::domain::cardrails as domain;
use crate::error::{ApiError, Result};
use crate::rate_limit::RateLimitRequest;
use crate::state::DomainState;

use super::{authorization, parse_body, require_claims, string_field};

fn no_store_json(status: StatusCode, body: JsonValue, cors: bool) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if cors {
        super::apply_cors(response.headers_mut());
    }
    response
}

/// `POST /api/cardrails-authorize` — the consent tap. Requires the Pokoin
/// Firebase bearer, validates the PKCE parameters and mints a one-time code
/// that redirects back into the Card Rails app.
pub async fn cardrails_authorize(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match cardrails_authorize_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn cardrails_authorize_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let body = parse_body(body);

    // Rate limit before any validation or storage work, keyed by the verified uid.
    let verdict = state
        .limiter()
        .check(RateLimitRequest {
            scope: "cardrails-authorize",
            identity: &claims.uid,
            limit: domain::AUTHORIZE_RATE_LIMIT,
            window_seconds: domain::AUTHORIZE_RATE_WINDOW_SECONDS,
        })
        .await;
    if !verdict.allowed {
        return Err(ApiError::too_many_requests("rate_limited").with_field(
            "retryAfterSec",
            json!(verdict.retry_after_sec.unwrap_or(domain::AUTHORIZE_RATE_WINDOW_SECONDS)),
        ));
    }

    let request_state = string_field(&body, "state");
    let code_challenge = string_field(&body, "code_challenge");
    let code_challenge_method = string_field(&body, "code_challenge_method");
    if !domain::is_valid_state(&request_state)
        || !domain::is_valid_code_challenge(&code_challenge)
        || !domain::is_valid_code_challenge_method(&code_challenge_method)
    {
        return Err(ApiError::bad_request("invalid_request"));
    }

    let email = claims.email.trim().to_string();
    if email.is_empty() {
        return Err(ApiError::forbidden("email_required"));
    }

    let store = state.cardrails_store()?;
    let code = domain::new_code();
    let expires_at = state.clock().now() + chrono::Duration::seconds(domain::CODE_TTL_SECONDS);
    store
        .insert(domain::NewCardRailsCode {
            code_hash: domain::code_hash(&code),
            uid: claims.uid.clone(),
            email: email.clone(),
            email_verified: claims.email_verified,
            code_challenge,
            expires_at,
        })
        .await?;

    Ok(no_store_json(
        StatusCode::OK,
        json!({
            "code": code,
            "redirect": domain::redirect_url(&code, &request_state),
        }),
        true,
    ))
}

/// `POST /api/cardrails-token` — server-to-server. No CORS is mounted: only
/// the Card Rails API, authenticated by the shared secret, exchanges codes.
pub async fn cardrails_token(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match cardrails_token_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn cardrails_token_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let secret = state
        .config()
        .cardrails_client_secret
        .as_deref()
        .filter(|secret| !secret.is_empty());
    let Some(secret) = secret else {
        return Err(ApiError::unavailable("not_configured"));
    };
    // Constant time on the bytes; a length mismatch leaks nothing usable.
    let provided = bearer_value(authorization(headers)).unwrap_or_default();
    if !super::poko::timing_safe_equal_text(provided, secret) {
        return Err(ApiError::unauthorized("invalid_client"));
    }

    let body = parse_body(body);
    let code = string_field(&body, "code");
    let code_verifier = string_field(&body, "code_verifier");
    if code.is_empty() || code_verifier.is_empty() {
        return Err(ApiError::bad_request("invalid_grant"));
    }

    let store = state.cardrails_store()?;
    // Consume first: a code is single use even when this first attempt fails
    // PKCE, so a replay can never retry with a corrected verifier.
    let Some(consumed) = store.consume(&domain::code_hash(&code)).await? else {
        return Err(ApiError::bad_request("invalid_grant"));
    };
    let domain::ConsumedCardRailsCode {
        uid,
        email,
        email_verified,
        code_challenge,
        live,
    } = consumed;
    if !live {
        return Err(ApiError::bad_request("invalid_grant"));
    }
    if !constant_time_eq(&domain::pkce_challenge(&code_verifier), &code_challenge) {
        return Err(ApiError::bad_request("invalid_grant"));
    }

    let mut identity = json!({ "uid": uid, "email": email, "email_verified": email_verified });
    if body.get("grant").and_then(JsonValue::as_bool) == Some(true) {
        if let Some(grant) = sign_in_grant(state, store.as_ref(), &uid).await {
            identity["grant"] = json!(grant);
        }
    }
    Ok(no_store_json(StatusCode::OK, identity, false))
}

/// `GET /api/cardrails-membership?uid=<uid>` (or `?email=<email>`) —
/// server-to-server, bearer `POKOIN_CARDRAILS_CLIENT_SECRET` like the token
/// exchange, no CORS. Answers whether the Pokoin account is Silver, by the
/// site's own rule (`users/{uid}.role` is `silver`/`admin`, or `silverUntil`
/// lies in the future): `{uid, email, silver, silverUntil, role, profile}`.
/// Card Rails grants its Pro features on `silver` and re-asks at least daily.
pub async fn cardrails_membership(
    State(state): State<DomainState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    match cardrails_membership_inner(&state, &headers, &params).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn cardrails_membership_inner(
    state: &DomainState,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> Result<Response> {
    let secret = state
        .config()
        .cardrails_client_secret
        .as_deref()
        .filter(|secret| !secret.is_empty());
    let Some(secret) = secret else {
        return Err(ApiError::unavailable("not_configured"));
    };
    let provided = bearer_value(authorization(headers)).unwrap_or_default();
    if !super::poko::timing_safe_equal_text(provided, secret) {
        return Err(ApiError::unauthorized("invalid_client"));
    }

    let uid = params.get("uid").map(|v| v.trim()).unwrap_or_default();
    let email = params
        .get("email")
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if (uid.is_empty() && email.is_empty()) || uid.len() > 128 || email.len() > 254 {
        return Err(ApiError::bad_request("invalid_request"));
    }

    // An email resolves to the Pokoin uid first; unknown emails are 404 so
    // Card Rails can tell "not a Pokoin user" from "not Silver".
    let (uid, email) = if uid.is_empty() {
        match state.auth()?.get_user_by_email(&email).await {
            Ok(user) => (user.uid, user.email.to_ascii_lowercase()),
            Err(error) if error.code == "auth/user-not-found" => {
                return Err(ApiError::not_found("user_not_found"));
            }
            Err(error) => {
                tracing::error!(code = %error.code, status = error.status, "cardrails membership: identity lookup failed");
                return Err(ApiError::unavailable("identity_unavailable"));
            }
        }
    } else {
        (uid.to_string(), email)
    };

    let firestore = state.firestore()?;
    let document = firestore.doc(format!("users/{uid}")).get().await?;
    let now_ms = state.clock().now().timestamp_millis();
    let membership = match &document {
        Some(document) => domain::membership_from_profile(
            &document.get_str("role"),
            document.get_timestamp_millis("silverUntil"),
            now_ms,
        ),
        None => domain::Membership::default(),
    };
    let email = if email.is_empty() {
        document
            .as_ref()
            .map(|document| document.get_str("email").trim().to_ascii_lowercase())
            .unwrap_or_default()
    } else {
        email
    };
    let silver_until = membership
        .silver_until_ms
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    Ok(no_store_json(
        StatusCode::OK,
        json!({
            "uid": uid,
            "email": email,
            "silver": membership.silver,
            "silverUntil": silver_until,
            "role": membership.role,
            "profile": document.is_some(),
        }),
        false,
    ))
}

/// The seller grant for a Card Rails sign-in, replacing the previous one. The
/// sign-in itself never fails on it: Card Rails only loses the stock mirror.
async fn sign_in_grant(
    state: &DomainState,
    store: &dyn domain::CardRailsCodeStore,
    uid: &str,
) -> Option<String> {
    let Some(key) = state.config().seller_grant_key.as_deref() else {
        tracing::warn!("cardrails sign-in grant skipped: no seller grant key");
        return None;
    };
    let Some((token, grant)) = domain::new_seller_grant(key) else {
        tracing::error!("cardrails sign-in grant skipped: unusable seller grant key");
        return None;
    };
    match store.replace_sign_in_grant(uid, grant).await {
        Ok(true) => Some(token),
        Ok(false) => {
            tracing::warn!("cardrails sign-in grant skipped: seller at the live grant limit");
            None
        }
        Err(error) => {
            tracing::error!(?error, "cardrails sign-in grant could not be stored");
            None
        }
    }
}

/// The value after a `Bearer `/`bearer `/`BEARER ` prefix, like the Poko
/// service-auth extraction (`isServiceAuthorized`).
fn bearer_value(authorization: Option<&str>) -> Option<&str> {
    let header = authorization?;
    header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .or_else(|| header.strip_prefix("BEARER "))
        .map(str::trim)
}

/// Constant-time equality for the PKCE comparison, so the challenge check does
/// not leak how much of the hash matched.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_comparison_is_constant_time_and_exact() {
        let challenge = domain::pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXm");
        assert!(constant_time_eq(&challenge, &challenge));
        assert!(!constant_time_eq(&challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!constant_time_eq(&challenge, ""));
        assert!(!constant_time_eq("", &challenge));
    }
}
