//! Account and identity routes:
//! `auth-login`, `ensure-username`, `signup-notification`, `register-email`,
//! `verify-email-signup`.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value as JsonValue};

use crate::domain::pending_signup::{
    decrypt_password, encrypt_password, hash_value, new_signup_token, safe_redirect_path,
};
use crate::email::{
    send_signup_notification_once, verification_email, welcome_email, SignupNotification,
};
use crate::error::{ApiError, Result};
use crate::firestore::DocData;
use crate::identity::EMAIL_ALREADY_EXISTS;
use crate::state::DomainState;
use crate::username::{
    assign_unique_username, claim_exact_username, normalize_requested_username,
    pok_email_verified_claims, username_for_request,
};

use super::{
    bool_field, iso_from_seconds, json_cached, method_not_allowed, ok, parse_body, require_claims,
    string_field,
};

const PENDING_TTL_MS: i64 = 60 * 60 * 1000;
const RESEND_COOLDOWN_MS: i64 = 60 * 1000;
const RESEND_MAX_SENDS: i64 = 10;

/// `EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/`.
pub fn is_valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    if local.is_empty() || local.contains(char::is_whitespace) || local.contains('@') {
        return false;
    }
    if domain.contains(char::is_whitespace) || domain.contains('@') {
        return false;
    }
    // `[^@\s]+\.[^@\s]+` after the first `@`: at least one dot with content
    // on both sides. Multiple dots are fine (sub.domain.co).
    if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return false;
    }
    let mut parts = domain.split('.');
    let host = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    !host.is_empty() && rest.iter().all(|part| !part.is_empty())
}

/// `/api/auth-login` — validate the bearer and return safe auth metadata.
pub async fn auth_login(State(state): State<DomainState>, headers: HeaderMap) -> Response {
    match require_claims(&state, &headers).await {
        Ok(claims) => ok(json!({
            "ok": true,
            "auth": {
                "tokenType": "Bearer",
                "uid": claims.uid,
                "email": claims.email,
                "emailVerified": claims.email_verified,
                "expiresAt": iso_from_seconds(claims.exp),
                "authTime": iso_from_seconds(claims.auth_time),
            }
        })),
        Err(error) => error.into_response(),
    }
}

/// `/api/ensure-username` — return the caller's handle, or claim the requested
/// one (409 when another account owns it).
pub async fn ensure_username(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = parse_body(&body);
    match ensure_username_inner(&state, &headers, &body).await {
        Ok(username) => json_cached(StatusCode::OK, json!({ "username": username }), "no-store"),
        Err(error) => error.into_response(),
    }
}

async fn ensure_username_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &JsonValue,
) -> Result<String> {
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;
    let requested = string_field(body, "username");
    let requested = if requested.trim().is_empty() {
        None
    } else {
        Some(requested)
    };
    username_for_request(
        &firestore,
        &claims.uid,
        &claims.email,
        &claims.name,
        requested.as_deref(),
    )
    .await
}

/// `/api/signup-notification` — admin notification, idempotent per account.
pub async fn signup_notification(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match signup_notification_inner(&state, &headers, &body).await {
        Ok(delivery) => ok(json!({ "ok": true, "signupNotification": delivery })),
        Err(error) => error.into_response(),
    }
}

async fn signup_notification_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<crate::email::EmailDelivery> {
    let claims = require_claims(state, headers).await?;
    let body = parse_body(body);
    let provider = {
        let raw = string_field(&body, "provider");
        if raw.is_empty() {
            "unknown".to_string()
        } else {
            raw
        }
    };
    let auth = state.auth()?;
    let firestore = state.firestore()?;
    let user_record = auth.get_user(&claims.uid).await.map_err(identity_to_api)?;
    let user_doc = firestore.doc(format!("users/{}", claims.uid)).get().await?;

    let email = if !user_record.email.is_empty() {
        user_record.email.clone()
    } else if !claims.email.is_empty() {
        claims.email.clone()
    } else {
        user_doc
            .as_ref()
            .map(|document| document.get_str("email"))
            .unwrap_or_default()
    };
    let username = user_doc
        .as_ref()
        .map(|document| document.get_str("username"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| user_record.display_name.clone());

    let notification = SignupNotification {
        uid: claims.uid.clone(),
        provider,
        email,
        username,
        wallet_address: user_doc
            .as_ref()
            .map(|document| document.get_str("walletAddress"))
            .unwrap_or_default(),
        email_verified: user_record.email_verified || claims.email_verified,
    };
    let now = state
        .clock()
        .now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    send_signup_notification_once(
        &firestore,
        state.emails(),
        state.email_config(),
        &notification,
        &now,
    )
    .await
}

/// `/api/register-email` — start or resume a pending email signup.
pub async fn register_email(
    State(state): State<DomainState>,
    body: Bytes,
) -> Response {
    match register_email_inner(&state, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn register_email_inner(state: &DomainState, body: &Bytes) -> Result<Response> {
    let body = parse_body(body);
    let email = string_field(&body, "email").trim().to_ascii_lowercase();
    if !is_valid_email(&email) {
        return Err(ApiError::bad_request("Enter a valid email address."));
    }
    if bool_field(&body, "resend") {
        return resend_verification(state, &email).await;
    }

    let raw_username = string_field(&body, "username");
    let username = if raw_username.trim().is_empty() {
        String::new()
    } else {
        normalize_requested_username(&raw_username)?
    };
    let password = string_field(&body, "password");
    let redirect_path = safe_redirect_path(&string_field(&body, "redirectPath"));

    if password.chars().count() < 6 {
        return Err(ApiError::bad_request(
            "Password must be at least 6 characters.",
        ));
    }

    let auth = state.auth()?;
    let firestore = state.firestore()?;
    if !username.is_empty() {
        let existing = firestore.doc(format!("usernames/{username}")).get().await?;
        if existing.is_some() {
            return Err(ApiError::conflict("Username is already taken."));
        }
    }

    match auth.get_user_by_email(&email).await {
        Ok(_) => return Err(ApiError::conflict("Email is already registered.")),
        Err(error) if error.not_found() => {}
        Err(error) => return Err(identity_to_api(error)),
    }

    let secret = state.pending_signup_secret()?;
    let token = new_signup_token();
    let token_hash = hash_value(&token);
    let now_ms = state.clock().now().timestamp_millis();

    firestore
        .doc(format!("pending_email_signups/{token_hash}"))
        .set(
            DocData::new()
                .string("email", email.clone())
                .string("username", username.clone())
                .string("passwordPayload", encrypt_password(&secret, &password)?)
                .string("redirectPath", redirect_path)
                .string("status", "pending")
                .server_timestamp("createdAt")
                .timestamp("expiresAt", now_ms + PENDING_TTL_MS)
                .int("sentCount", 1)
                .server_timestamp("lastSentAt"),
            false,
        )
        .await?;
    firestore
        .doc(format!(
            "pending_email_signups_by_email/{}",
            hash_value(&email)
        ))
        .set(
            DocData::new()
                .string("email", email.clone())
                .string("tokenHash", token_hash)
                .server_timestamp("updatedAt"),
            true,
        )
        .await?;

    let link = format!(
        "{}/auth?signupToken={}",
        state.email_config().site_url,
        crate::firebase::urlencode(&token)
    );
    let message = verification_email(state.email_config(), &email, &username, &link);
    let delivery = state.emails().send(message).await?;

    Ok(ok(json!({
        "ok": true,
        "pending": true,
        "username": username,
        "verificationEmail": delivery,
    })))
}

async fn resend_verification(state: &DomainState, email: &str) -> Result<Response> {
    let firestore = state.firestore()?;
    let pointer = firestore
        .doc(format!(
            "pending_email_signups_by_email/{}",
            hash_value(email)
        ))
        .get()
        .await?;
    let token_hash = pointer
        .as_ref()
        .map(|document| document.get_str("tokenHash"))
        .unwrap_or_default();
    if token_hash.is_empty() {
        return Err(ApiError::not_found(
            "No pending verification found for this email.",
        ));
    }

    let pending_ref = firestore.doc(format!("pending_email_signups/{token_hash}"));
    let pending = pending_ref.get().await?;
    let Some(pending) = pending else {
        return Err(ApiError::not_found(
            "No pending verification found for this email.",
        ));
    };
    if pending.get_str("status") != "pending" {
        return Err(ApiError::not_found(
            "No pending verification found for this email.",
        ));
    }

    let now_ms = state.clock().now().timestamp_millis();
    let last_sent_ms = pending.get_timestamp_millis("lastSentAt").unwrap_or(0);
    let cooldown_remaining = RESEND_COOLDOWN_MS - (now_ms - last_sent_ms);
    if cooldown_remaining > 0 {
        return Err(ApiError::too_many_requests(
            "A verification email was just sent. Try again in a minute.",
        )
        .with_field(
            "retryAfterSec",
            json!((cooldown_remaining as f64 / 1000.0).ceil() as i64),
        ));
    }
    let sent_count = pending.get_i64("sentCount").unwrap_or(0);
    if sent_count >= RESEND_MAX_SENDS {
        return Err(ApiError::too_many_requests(
            "Too many verification emails requested. Sign up again later.",
        ));
    }

    // The raw token only ever existed in the first email, so a resend mints a
    // fresh token and supersedes the previous pending doc: one active token per
    // email at any time.
    let password_payload = pending
        .get("passwordPayload")
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let username = pending.get_str("username");
    let redirect_path = safe_redirect_path(&pending.get_str("redirectPath"));

    let token = new_signup_token();
    let token_hash = hash_value(&token);
    firestore
        .doc(format!("pending_email_signups/{token_hash}"))
        .set(
            DocData::new()
                .string("email", email.to_string())
                .string("username", username.clone())
                .string("passwordPayload", password_payload)
                .string("redirectPath", redirect_path)
                .string("status", "pending")
                .server_timestamp("createdAt")
                .timestamp("expiresAt", now_ms + PENDING_TTL_MS)
                .int("sentCount", sent_count + 1)
                .server_timestamp("lastSentAt"),
            false,
        )
        .await?;
    pending_ref
        .set(DocData::new().string("status", "superseded"), true)
        .await?;
    firestore
        .doc(format!(
            "pending_email_signups_by_email/{}",
            hash_value(email)
        ))
        .set(
            DocData::new()
                .string("email", email.to_string())
                .string("tokenHash", token_hash)
                .server_timestamp("updatedAt"),
            true,
        )
        .await?;

    let link = format!(
        "{}/auth?signupToken={}",
        state.email_config().site_url,
        crate::firebase::urlencode(&token)
    );
    let message = verification_email(state.email_config(), email, &username, &link);
    let delivery = state.emails().send(message).await?;

    Ok(ok(json!({
        "ok": true,
        "pending": true,
        "resent": true,
        "verificationEmail": delivery,
    })))
}

/// `/api/verify-email-signup` — finalize a verified signup exactly once.
pub async fn verify_email_signup(State(state): State<DomainState>, body: Bytes) -> Response {
    match verify_email_signup_inner(&state, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn verify_email_signup_inner(state: &DomainState, body: &Bytes) -> Result<Response> {
    let body = parse_body(body);
    let token = string_field(&body, "token").trim().to_string();
    if token.is_empty() {
        return Err(ApiError::bad_request("Verification token is missing."));
    }

    let auth = state.auth()?;
    let firestore = state.firestore()?;
    let pending_ref = firestore.doc(format!("pending_email_signups/{}", hash_value(&token)));
    let pending = pending_ref.get().await?;
    let Some(pending) = pending else {
        return Err(
            ApiError::bad_request("This verification link is invalid or already used.")
                .with_code("invalid_token"),
        );
    };
    match pending.get_str("status").as_str() {
        "completed" => {
            return Err(ApiError::bad_request(
                "This email is already verified. Please sign in.",
            )
            .with_code("already_verified"))
        }
        "pending" => {}
        _ => {
            return Err(
                ApiError::bad_request("This verification link is invalid or already used.")
                    .with_code("invalid_token"),
            )
        }
    }

    let now_ms = state.clock().now().timestamp_millis();
    let expires_at_ms = pending.get_timestamp_millis("expiresAt").unwrap_or(0);
    if expires_at_ms == 0 || now_ms > expires_at_ms {
        pending_ref
            .set(DocData::new().string("status", "expired"), true)
            .await?;
        return Err(ApiError::bad_request(
            "This verification link has expired. Sign up again to get a fresh one.",
        )
        .with_code("expired_token"));
    }

    let redirect_path = safe_redirect_path(&pending.get_str("redirectPath"));
    finalize_verified_user(
        state,
        &auth,
        &firestore,
        &pending,
        &pending_ref,
        &redirect_path,
    )
    .await
}

async fn finalize_verified_user(
    state: &DomainState,
    auth: &crate::identity::FirebaseAuth,
    firestore: &crate::firestore::Firestore,
    pending: &crate::firestore::Document,
    pending_ref: &crate::firestore::DocumentRef,
    redirect_path: &str,
) -> Result<Response> {
    let email = pending.get_str("email").trim().to_ascii_lowercase();
    let username = pending.get_str("username").trim().to_ascii_lowercase();
    let secret = state.pending_signup_secret()?;
    let password_payload = pending
        .get("passwordPayload")
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let password = decrypt_password(&secret, &password_payload)?;

    match auth.get_user_by_email(&email).await {
        Ok(_) => {
            pending_ref
                .set(DocData::new().string("status", "email_exists"), true)
                .await?;
            return Err(ApiError::conflict("Email is already registered."));
        }
        Err(error) if error.not_found() => {}
        Err(error) => return Err(identity_to_api(error)),
    }

    let user_record = auth
        .create_user(crate::identity::CreateUser {
            uid: None,
            email: email.clone(),
            password: Some(password),
            display_name: if username.is_empty() {
                None
            } else {
                Some(username.clone())
            },
            photo_url: None,
            email_verified: true,
        })
        .await
        .map_err(|error| {
            if error.is(EMAIL_ALREADY_EXISTS) {
                ApiError::conflict("This email was just verified. Please sign in.")
                    .with_code("already_verified")
            } else {
                identity_to_api(error)
            }
        })?;
    let uid = user_record.uid.clone();

    // Anything after user creation must either succeed or delete the identity
    // again, so the verification link stays valid for a clean retry.
    let outcome = finalize_account(
        state,
        auth,
        firestore,
        &uid,
        &email,
        &username,
        pending_ref,
        redirect_path,
    )
    .await;
    match outcome {
        Ok(response) => Ok(response),
        Err(error) => {
            if let Err(cleanup) = auth.delete_user(&uid).await {
                tracing::error!(%cleanup, uid, "could not roll back the created Firebase user");
            }
            Err(error)
        }
    }
}

async fn finalize_account(
    state: &DomainState,
    auth: &crate::identity::FirebaseAuth,
    firestore: &crate::firestore::Firestore,
    uid: &str,
    email: &str,
    username: &str,
    pending_ref: &crate::firestore::DocumentRef,
    redirect_path: &str,
) -> Result<Response> {
    auth.set_custom_user_claims(uid, Some(&pok_email_verified_claims()))
        .await
        .map_err(identity_to_api)?;

    let display_name = username.to_string();
    firestore
        .doc(format!("users/{uid}"))
        .set(
            DocData::new()
                .string("uid", uid.to_string())
                .string("email", email.to_string())
                .string("displayName", display_name.clone())
                .server_timestamp("createdAt")
                .server_timestamp("updatedAt"),
            true,
        )
        .await?;

    let effective_username = if username.is_empty() {
        assign_unique_username(firestore, uid, email, "", "").await?
    } else {
        match claim_exact_username(firestore, uid, username, username, email, "").await {
            Ok(claimed) => claimed,
            // The name was free at register time and got claimed meanwhile:
            // verification must still succeed, so fall back to a unique handle.
            Err(error) if error.status() == StatusCode::CONFLICT => {
                assign_unique_username(firestore, uid, username, username, "").await?
            }
            Err(error) => return Err(error),
        }
    };

    firestore
        .doc(format!("balances/{uid}"))
        .set(
            DocData::new()
                .increment("availablePkn", 0)
                .increment("lockedPkn", 0)
                .server_timestamp("updatedAt"),
            true,
        )
        .await?;
    pending_ref
        .set(
            DocData::new()
                .string("status", "completed")
                .string("uid", uid.to_string())
                .server_timestamp("completedAt"),
            true,
        )
        .await?;

    let now = state
        .clock()
        .now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let notification = SignupNotification {
        uid: uid.to_string(),
        provider: "email_password".into(),
        email: email.to_string(),
        username: effective_username.clone(),
        wallet_address: String::new(),
        email_verified: true,
    };
    // Both notifications are best-effort: a delivery failure must not undo a
    // verified account, exactly like the Node `.catch()` handlers.
    let notification_delivery = send_signup_notification_once(
        firestore,
        state.emails(),
        state.email_config(),
        &notification,
        &now,
    )
    .await
    .unwrap_or_else(|error| {
        tracing::error!(%error, "signup notification failed");
        crate::email::EmailDelivery {
            ok: false,
            id: None,
            skipped: false,
            reason: Some(error.message().to_string()),
        }
    });
    let welcome_delivery = state
        .emails()
        .send(welcome_email(
            state.email_config(),
            email,
            &effective_username,
        ))
        .await
        .unwrap_or_else(|error| {
            tracing::error!(%error, "welcome email failed");
            crate::email::EmailDelivery {
                ok: false,
                id: None,
                skipped: false,
                reason: Some(error.message().to_string()),
            }
        });

    let custom_token = state
        .service_account()
        .ok_or_else(|| ApiError::internal("Firebase Auth is not configured."))?
        .create_custom_token(uid, None)
        .map_err(ApiError::from)?;

    // Node kept the redirect path from the pending doc loaded before the
    // transaction, then only checked `startsWith('/')`.
    let redirect_path = if redirect_path.starts_with('/') && !redirect_path.is_empty() {
        redirect_path.to_string()
    } else {
        "/".to_string()
    };

    Ok(ok(json!({
        "customToken": custom_token,
        "uid": uid,
        "username": effective_username,
        "redirectPath": redirect_path,
        "signupNotification": notification_delivery,
        "welcomeEmail": welcome_delivery,
    })))
}

/// Map an Identity Toolkit failure onto the Node status codes.
pub fn identity_to_api(error: crate::identity::IdentityError) -> ApiError {
    use crate::identity::{EMAIL_ALREADY_EXISTS, INVALID_PASSWORD, USER_NOT_FOUND};
    match error.code.as_str() {
        EMAIL_ALREADY_EXISTS => ApiError::conflict("Email is already registered."),
        USER_NOT_FOUND => ApiError::not_found(error.message),
        INVALID_PASSWORD => ApiError::bad_request(error.message),
        _ => {
            if (400..500).contains(&error.status) {
                ApiError::bad_request(error.message)
            } else {
                ApiError::internal(error.message)
            }
        }
    }
}

/// `OPTIONS` for the two routes that emitted CORS headers.
pub async fn register_email_options() -> Response {
    super::preflight().await
}

/// Method guards kept explicit so the router reads like the Node `Allow` lists.
pub async fn post_only_405() -> Response {
    method_not_allowed("POST")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation_matches_the_node_regex() {
        assert!(is_valid_email("a@b.co"));
        assert!(is_valid_email("first.last+tag@sub.domain.co"));
        assert!(!is_valid_email("a@b"));
        assert!(!is_valid_email("a@b."));
        assert!(!is_valid_email("a@.co"));
        assert!(!is_valid_email("@b.co"));
        assert!(!is_valid_email("a b@c.co"));
        assert!(!is_valid_email("a@@b.co"));
        // `[^@\s]+\.[^@\s]+` allows multi-dot domains.
        assert!(is_valid_email("a@b.c.d"));
        assert!(is_valid_email("a@b.c.d.e"));
        assert!(!is_valid_email(""));
    }

}
