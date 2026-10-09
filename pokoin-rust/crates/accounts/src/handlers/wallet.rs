//! Wallet routes: `wallet-auth/nonce`, `wallet-auth/verify`, `wallet-link`,
//! `wallet-link/session`, `wallet-link/complete`.
//!
//! All five keep the Node semantics exactly: the nonce is single-use, expires
//! after 10 minutes, is validated *again* inside the transaction, and the wallet
//! registry can never end up pointing at two accounts. A wallet-only account
//! (`wallet:0x…`) is claimed and merged on link, including its PKN balance.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{json, Value as Json};

use crate::domain::crypto::{
    is_session_id, is_signature_shaped, normalize_address, random_nonce,
    random_session_id, recover_address, wallet_sign_in_message,
};
use crate::error::{ApiError, Result};
use crate::email::{send_signup_notification_once, SignupNotification};
use crate::firestore::{DocData, Document, Firestore, Query};
use crate::state::DomainState;
use crate::username::ensure_unique_username;

use super::{object, ok, parse_body, require_claims, string_field};

pub const NONCE_COLLECTION: &str = "wallet_auth_nonces";
pub const REGISTRY_COLLECTION: &str = "wallet_addresses";
pub const SESSION_COLLECTION: &str = "wallet_link_sessions";
const NONCE_TTL_MS: i64 = 10 * 60 * 1000;
const SESSION_TTL_MS: i64 = 10 * 60 * 1000;

fn wallet_only_uid(address: &str) -> String {
    format!("wallet:{address}")
}

fn wallet_only_email(address: &str) -> String {
    format!("{}@wallet.pokoin.local", &address[2..])
}

fn placeholder_display_name(address: &str) -> String {
    format!("{}...{}", &address[..6], &address[address.len() - 4..])
}

/// `POST /api/wallet-auth/nonce` — issue a single-use sign-in message.
pub async fn wallet_auth_nonce(State(state): State<DomainState>, body: Bytes) -> Response {
    match wallet_auth_nonce_inner(&state, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn wallet_auth_nonce_inner(state: &DomainState, body: &Bytes) -> Result<Response> {
    let body = parse_body(body);
    let Some(normalized) = normalize_address(&string_field(&body, "address")) else {
        return Err(ApiError::bad_request("Enter a valid wallet address."));
    };
    let firestore = state.firestore()?;
    let nonce = random_nonce();
    let issued_at = state
        .clock()
        .now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let message = wallet_sign_in_message(&normalized, &nonce, &issued_at);

    firestore
        .doc(format!("{NONCE_COLLECTION}/{normalized}"))
        .set(
            DocData::new()
                .string("address", normalized.clone())
                .string("nonce", nonce)
                .string("message", message.clone())
                .string("issuedAt", issued_at)
                .bool("used", false)
                .server_timestamp("createdAt"),
            false,
        )
        .await?;

    Ok(ok(json!({ "address": normalized, "message": message })))
}

/// Load the nonce doc and enforce every Node guard, returning the message that
/// was signed.
async fn load_verified_nonce(
    firestore: &Firestore,
    normalized: &str,
    signature: &str,
) -> Result<()> {
    let expired = || ApiError::bad_request("Wallet sign-in nonce expired. Try again.");
    let document = firestore
        .doc(format!("{NONCE_COLLECTION}/{normalized}"))
        .get()
        .await?
        .ok_or_else(expired)?;
    let message = document.get_str("message");
    if message.is_empty() || document.get_bool("used").unwrap_or(false) {
        return Err(expired());
    }
    let issued_at_ms = issued_at_millis(&document).ok_or_else(expired)?;
    if chrono::Utc::now().timestamp_millis() - issued_at_ms > NONCE_TTL_MS {
        return Err(expired());
    }
    let recovered = recover_address(&message, signature)
        .map_err(|_| ApiError::unauthorized("Wallet signature did not match address."))?;
    if recovered != normalized {
        return Err(ApiError::unauthorized(
            "Wallet signature did not match address.",
        ));
    }
    Ok(())
}

fn issued_at_millis(document: &Document) -> Option<i64> {
    document
        .get("issuedAt")
        .and_then(|value| value.as_timestamp_millis())
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(&document.get_str("issuedAt"))
                .ok()
                .map(|parsed| parsed.timestamp_millis())
        })
}

fn validate_wallet_inputs(body: &Json) -> Result<(String, String)> {
    let normalized = normalize_address(&string_field(body, "address"))
        .ok_or_else(|| ApiError::bad_request("Enter a valid wallet address."))?;
    let signature = string_field(body, "signature").trim().to_string();
    if !is_signature_shaped(&signature) {
        return Err(ApiError::bad_request("Missing wallet signature."));
    }
    Ok((normalized, signature))
}

/// `POST /api/wallet-auth/verify` — sign in (or create) a wallet account.
pub async fn wallet_auth_verify(State(state): State<DomainState>, body: Bytes) -> Response {
    match wallet_auth_verify_inner(&state, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn wallet_auth_verify_inner(state: &DomainState, body: &Bytes) -> Result<Response> {
    let body = parse_body(body);
    let (normalized, signature) = validate_wallet_inputs(&body)?;

    let auth = state.auth()?;
    let firestore = state.firestore()?;
    load_verified_nonce(&firestore, &normalized, &signature).await?;

    let registry_ref = firestore.doc(format!("{REGISTRY_COLLECTION}/{normalized}"));
    let registry = registry_ref.get().await?;
    let existing_owner = registry
        .as_ref()
        .map(|document| document.get_str("uid"))
        .filter(|uid| !uid.is_empty());
    let uid = existing_owner
        .clone()
        .unwrap_or_else(|| wallet_only_uid(&normalized));
    let is_new_wallet_account = existing_owner.is_none();

    let mut email = wallet_only_email(&normalized);
    let mut display_name = placeholder_display_name(&normalized);
    match auth.get_user(&uid).await {
        Ok(record) => {
            if !record.email.is_empty() {
                email = record.email;
            }
            if !record.display_name.is_empty() {
                display_name = record.display_name;
            }
        }
        Err(error) if error.not_found() => {
            auth.create_user(crate::identity::CreateUser {
                uid: Some(uid.clone()),
                email: email.clone(),
                password: None,
                display_name: Some(display_name.clone()),
                photo_url: None,
                email_verified: false,
            })
            .await
            .map_err(super::auth::identity_to_api)?;
        }
        Err(error) => return Err(super::auth::identity_to_api(error)),
    }

    let username = ensure_unique_username(&firestore, &uid, &email, &display_name, true).await?;
    display_name = username.clone();
    if let Err(error) = auth
        .update_user(
            &uid,
            crate::identity::UpdateUser {
                display_name: Some(display_name.clone()),
                ..Default::default()
            },
        )
        .await
    {
        tracing::warn!(%error, uid, "wallet display name auth update failed");
    }

    let uid_owned = uid.clone();
    let normalized_owned = normalized.clone();
    let email_owned = email.clone();
    let display_owned = display_name.clone();
    let username_owned = username.clone();
    firestore
        .run_transaction(|transaction| {
            let uid = uid_owned.clone();
            let normalized = normalized_owned.clone();
            let email = email_owned.clone();
            let display_name = display_owned.clone();
            let username = username_owned.clone();
            Box::pin(async move {
                let nonce_ref = transaction.doc(&format!("{NONCE_COLLECTION}/{normalized}"));
                let fresh_nonce = transaction.get_doc(&nonce_ref).await?;
                match fresh_nonce {
                    Some(document) if !document.get_bool("used").unwrap_or(false) => {}
                    _ => {
                        return Err(ApiError::bad_request(
                            "Wallet sign-in nonce expired. Try again.",
                        ))
                    }
                }

                let registry_ref =
                    transaction.doc(&format!("{REGISTRY_COLLECTION}/{normalized}"));
                let fresh_registry = transaction.get_doc(&registry_ref).await?;
                let fresh_owner = fresh_registry
                    .as_ref()
                    .map(|document| document.get_str("uid"))
                    .unwrap_or_default();
                if fresh_registry.is_some() && !fresh_owner.is_empty() && fresh_owner != uid {
                    return Err(ApiError::conflict(
                        "This wallet is already linked to another account.",
                    ));
                }

                transaction.set(
                    &nonce_ref,
                    DocData::new()
                        .bool("used", true)
                        .server_timestamp("usedAt"),
                    true,
                )?;
                transaction.set(
                    &transaction.doc(&format!("users/{uid}")),
                    DocData::new()
                        .string("email", email.clone())
                        .string("displayName", display_name.clone())
                        .string("username", username.clone())
                        .string("usernameLower", username.clone())
                        .string("walletAddress", normalized.clone())
                        .string("authProvider", "wallet")
                        .server_timestamp("updatedAt")
                        .server_timestamp("lastLoginAt"),
                    true,
                )?;
                transaction.set(
                    &registry_ref,
                    DocData::new()
                        .string("uid", uid.clone())
                        .string("email", email.clone())
                        .string("address", normalized.clone())
                        .server_timestamp("verifiedAt")
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                transaction.set(
                    &transaction.doc(&format!("balances/{uid}")),
                    DocData::new()
                        .increment("availablePkn", 0)
                        .increment("lockedPkn", 0)
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                Ok(())
            })
        })
        .await?;

    let custom_token = state
        .service_account()
        .ok_or_else(|| ApiError::internal("Firebase Auth is not configured."))?
        .create_custom_token(
            &uid,
            Some(json!({ "walletAddress": normalized, "provider": "metamask" })),
        )
        .map_err(ApiError::from)?;

    if is_new_wallet_account {
        let notification = SignupNotification {
            uid: uid.clone(),
            provider: "crypto_wallet".into(),
            email: email.clone(),
            username: username.clone(),
            wallet_address: normalized.clone(),
            email_verified: true,
        };
        let now = state
            .clock()
            .now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        if let Err(error) = send_signup_notification_once(
            &firestore,
            state.emails(),
            state.email_config(),
            &notification,
            &now,
        )
        .await
        {
            tracing::error!(%error, "wallet signup notification failed");
        }
    }

    Ok(ok(json!({
        "customToken": custom_token,
        "uid": uid,
        "email": email,
        "displayName": display_name,
        "username": username,
        "walletAddress": normalized,
    })))
}

/// `POST /api/wallet-link` — link a wallet to the signed-in account.
pub async fn wallet_link(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match wallet_link_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn wallet_link_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let body = parse_body(body);
    let (normalized, signature) = validate_wallet_inputs(&body)?;

    let firestore = state.firestore()?;
    load_verified_nonce(&firestore, &normalized, &signature).await?;

    let uid = claims.uid.clone();
    let email = claims.email.trim().to_ascii_lowercase();
    let wallet_only = wallet_only_uid(&normalized);
    ensure_unique_username(&firestore, &uid, &email, &claims.name, false).await?;

    let uid_owned = uid.clone();
    let normalized_owned = normalized.clone();
    let email_owned = email.clone();
    let wallet_only_owned = wallet_only.clone();
    firestore
        .run_transaction(|transaction| {
            let uid = uid_owned.clone();
            let normalized = normalized_owned.clone();
            let email = email_owned.clone();
            let wallet_only = wallet_only_owned.clone();
            Box::pin(async move {
                let nonce_ref = transaction.doc(&format!("{NONCE_COLLECTION}/{normalized}"));
                let fresh_nonce = transaction.get_doc(&nonce_ref).await?;
                match fresh_nonce {
                    Some(document) if !document.get_bool("used").unwrap_or(false) => {}
                    _ => {
                        return Err(ApiError::bad_request(
                            "Wallet sign-in nonce expired. Try again.",
                        ))
                    }
                }

                let registry_ref =
                    transaction.doc(&format!("{REGISTRY_COLLECTION}/{normalized}"));
                let registry = transaction.get_doc(&registry_ref).await?;
                let owner_uid = registry
                    .as_ref()
                    .map(|document| document.get_str("uid"))
                    .unwrap_or_default();
                let can_claim_wallet_only = owner_uid == wallet_only;
                if registry.is_some()
                    && !owner_uid.is_empty()
                    && owner_uid != uid
                    && !can_claim_wallet_only
                {
                    return Err(ApiError::conflict(
                        "This wallet is already linked to another account.",
                    ));
                }

                let user_ref = transaction.doc(&format!("users/{uid}"));
                let user_doc = transaction.get_doc(&user_ref).await?;
                let existing_wallet = user_doc
                    .as_ref()
                    .map(|document| {
                        document.get_str("walletAddress").trim().to_ascii_lowercase()
                    })
                    .unwrap_or_default();
                if !existing_wallet.is_empty() && existing_wallet != normalized {
                    return Err(ApiError::conflict(
                        "This account already has a linked wallet. Switch MetaMask accounts to sign in as a wallet-only user, or disconnect the current wallet first.",
                    ));
                }

                let linked_wallets = transaction
                    .get_query(
                        &Query::collection(REGISTRY_COLLECTION)
                            .where_eq("uid", uid.clone())
                            .limit(2),
                    )
                    .await?;
                let other_linked = linked_wallets
                    .iter()
                    .map(|document| document.id())
                    .find(|address| *address != normalized);
                if other_linked.is_some() {
                    return Err(ApiError::conflict(
                        "This account already has a linked wallet. Switch MetaMask accounts to sign in as a wallet-only user, or disconnect the current wallet first.",
                    ));
                }

                let wallet_only_user_ref = transaction.doc(&format!("users/{wallet_only}"));
                let wallet_only_balance_ref =
                    transaction.doc(&format!("balances/{wallet_only}"));
                let wallet_only_user = if can_claim_wallet_only {
                    transaction.get_doc(&wallet_only_user_ref).await?
                } else {
                    None
                };
                let wallet_only_balance = if can_claim_wallet_only {
                    transaction.get_doc(&wallet_only_balance_ref).await?
                } else {
                    None
                };

                transaction.set(
                    &nonce_ref,
                    DocData::new()
                        .bool("used", true)
                        .server_timestamp("usedAt"),
                    true,
                )?;
                transaction.set(
                    &user_ref,
                    DocData::new()
                        .string("walletAddress", normalized.clone())
                        .server_timestamp("walletConnectedAt")
                        .server_timestamp("updatedAt"),
                    true,
                )?;

                if can_claim_wallet_only {
                    let source_available = wallet_only_balance
                        .as_ref()
                        .and_then(|document| document.get_i64("availablePkn"))
                        .unwrap_or(0);
                    let source_locked = wallet_only_balance
                        .as_ref()
                        .and_then(|document| document.get_i64("lockedPkn"))
                        .unwrap_or(0);
                    if source_available != 0 || source_locked != 0 {
                        transaction.set(
                            &transaction.doc(&format!("balances/{uid}")),
                            DocData::new()
                                .increment("availablePkn", source_available)
                                .increment("lockedPkn", source_locked)
                                .server_timestamp("updatedAt"),
                            true,
                        )?;
                        transaction.set(
                            &wallet_only_balance_ref,
                            DocData::new()
                                .int("availablePkn", 0)
                                .int("lockedPkn", 0)
                                .string("mergedIntoUid", uid.clone())
                                .server_timestamp("updatedAt"),
                            true,
                        )?;
                    }
                    transaction.set(
                        &wallet_only_user_ref,
                        DocData::new()
                            .string("mergedIntoUid", uid.clone())
                            .server_timestamp("mergedAt")
                            .bool("active", false)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    let wallet_only_username = wallet_only_user
                        .as_ref()
                        .map(|document| {
                            document.get_str("username").trim().to_ascii_lowercase()
                        })
                        .unwrap_or_default();
                    if !wallet_only_username.is_empty() {
                        transaction
                            .delete(&transaction.doc(&format!("usernames/{wallet_only_username}")));
                    }
                }

                transaction.set(
                    &registry_ref,
                    DocData::new()
                        .string("uid", uid.clone())
                        .string("email", email.clone())
                        .string("address", normalized.clone())
                        .server_timestamp("verifiedAt")
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                Ok(())
            })
        })
        .await?;

    Ok(ok(json!({ "ok": true, "walletAddress": normalized })))
}

/// `POST /api/wallet-link/session` — mint the profile-side link session.
pub async fn wallet_link_session(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match wallet_link_session_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn wallet_link_session_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let body = parse_body(body);
    let firestore = state.firestore()?;
    let session_id = random_session_id();
    let now_ms = state.clock().now().timestamp_millis();
    let requested = string_field(&body, "returnPath").trim().to_string();
    let return_path = if requested.starts_with('/') && !requested.starts_with("//") {
        requested
    } else {
        "/profile".to_string()
    };

    firestore
        .doc(format!("{SESSION_COLLECTION}/{session_id}"))
        .set(
            DocData::new()
                .string("uid", claims.uid.clone())
                .string("email", claims.email.trim().to_ascii_lowercase())
                .string("returnPath", return_path)
                .bool("used", false)
                .int("createdAtMs", now_ms)
                .int("expiresAtMs", now_ms + SESSION_TTL_MS)
                .server_timestamp("createdAt"),
            false,
        )
        .await?;

    Ok(ok(json!({
        "sessionId": session_id,
        "expiresAt": super::iso_from_millis(now_ms + SESSION_TTL_MS),
    })))
}

/// `POST /api/wallet-link/complete` — finish the profile-side link and mint a
/// custom token for the linked session.
pub async fn wallet_link_complete(State(state): State<DomainState>, body: Bytes) -> Response {
    match wallet_link_complete_inner(&state, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn wallet_link_complete_inner(state: &DomainState, body: &Bytes) -> Result<Response> {
    let body = parse_body(body);
    let session_id = string_field(&body, "sessionId").trim().to_string();
    let (normalized, signature) = validate_wallet_inputs(&body)?;
    if !is_session_id(&session_id) {
        return Err(ApiError::bad_request("Wallet link session is invalid."));
    }

    let firestore = state.firestore()?;
    let session_ref = firestore.doc(format!("{SESSION_COLLECTION}/{session_id}"));
    let session = session_ref
        .get()
        .await?
        .ok_or_else(|| session_expired_400())?;
    if session.get_bool("used").unwrap_or(false) {
        return Err(session_expired_400());
    }
    let now_ms = state.clock().now().timestamp_millis();
    if now_ms > session.get_i64("expiresAtMs").unwrap_or(0) {
        return Err(ApiError::gone(
            "Wallet link session expired. Start again from your profile.",
        ));
    }

    let uid = session.get_str("uid").trim().to_string();
    let email = session.get_str("email").trim().to_ascii_lowercase();
    let return_path = {
        let raw = session.get_str("returnPath");
        if raw.is_empty() {
            "/profile".to_string()
        } else {
            raw
        }
    };
    if uid.is_empty() {
        return Err(ApiError::bad_request(
            "Wallet link session is missing a profile.",
        ));
    }

    let user_doc = firestore.doc(format!("users/{uid}")).get().await?;
    let display_name = user_doc
        .as_ref()
        .map(|document| document.get_str("displayName"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if email.is_empty() {
                "Pokoin user".to_string()
            } else {
                email.clone()
            }
        });
    let username =
        ensure_unique_username(&firestore, &uid, &email, &display_name, false).await?;

    let wallet_only = wallet_only_uid(&normalized);
    let uid_owned = uid.clone();
    let normalized_owned = normalized.clone();
    let email_owned = email.clone();
    let username_owned = username.clone();
    let wallet_only_owned = wallet_only.clone();
    let session_id_owned = session_id.clone();
    let signature_owned = signature.clone();
    firestore
        .run_transaction(|transaction| {
            let uid = uid_owned.clone();
            let normalized = normalized_owned.clone();
            let email = email_owned.clone();
            let username = username_owned.clone();
            let wallet_only = wallet_only_owned.clone();
            let session_id = session_id_owned.clone();
            let signature = signature_owned.clone();
            Box::pin(async move {
                let session_ref =
                    transaction.doc(&format!("{SESSION_COLLECTION}/{session_id}"));
                let nonce_ref = transaction.doc(&format!("{NONCE_COLLECTION}/{normalized}"));
                let registry_ref =
                    transaction.doc(&format!("{REGISTRY_COLLECTION}/{normalized}"));

                let fresh_session = transaction.get_doc(&session_ref).await?;
                let nonce_doc = transaction.get_doc(&nonce_ref).await?;
                let registry_doc = transaction.get_doc(&registry_ref).await?;

                let Some(fresh_session) = fresh_session else {
                    return Err(session_expired_400());
                };
                if fresh_session.get_bool("used").unwrap_or(false) {
                    return Err(session_expired_400());
                }
                let now = chrono::Utc::now().timestamp_millis();
                if now > fresh_session.get_i64("expiresAtMs").unwrap_or(0) {
                    return Err(ApiError::gone(
                        "Wallet link session expired. Start again from your profile.",
                    ));
                }

                let Some(nonce_doc) = nonce_doc else {
                    return Err(ApiError::bad_request(
                        "Wallet sign-in nonce expired. Try again.",
                    ));
                };
                let message = nonce_doc.get_str("message");
                if message.is_empty() || nonce_doc.get_bool("used").unwrap_or(false) {
                    return Err(ApiError::bad_request(
                        "Wallet sign-in nonce expired. Try again.",
                    ));
                }
                let issued_at_ms = issued_at_millis(&nonce_doc).unwrap_or(0);
                if issued_at_ms == 0 || (now - issued_at_ms).abs() > NONCE_TTL_MS {
                    return Err(ApiError::bad_request(
                        "Wallet sign-in nonce expired. Try again.",
                    ));
                }
                let recovered = recover_address(&message, &signature)
                    .map_err(|_| {
                        ApiError::unauthorized("Wallet signature did not match address.")
                    })?;
                if recovered != normalized {
                    return Err(ApiError::unauthorized(
                        "Wallet signature did not match address.",
                    ));
                }

                let owner_uid = registry_doc
                    .as_ref()
                    .map(|document| document.get_str("uid"))
                    .unwrap_or_default();
                let can_claim_wallet_only = owner_uid == wallet_only;
                if registry_doc.is_some()
                    && !owner_uid.is_empty()
                    && owner_uid != uid
                    && !can_claim_wallet_only
                {
                    return Err(ApiError::conflict(
                        "This wallet is already linked to another account.",
                    ));
                }

                let user_ref = transaction.doc(&format!("users/{uid}"));
                let user = transaction.get_doc(&user_ref).await?;
                let existing_wallet = user
                    .as_ref()
                    .map(|document| {
                        document.get_str("walletAddress").trim().to_ascii_lowercase()
                    })
                    .unwrap_or_default();
                if !existing_wallet.is_empty() && existing_wallet != normalized {
                    return Err(ApiError::conflict(
                        "This profile already has a different linked wallet.",
                    ));
                }

                let linked_wallets = transaction
                    .get_query(
                        &Query::collection(REGISTRY_COLLECTION)
                            .where_eq("uid", uid.clone())
                            .limit(2),
                    )
                    .await?;
                if linked_wallets
                    .iter()
                    .map(|document| document.id())
                    .any(|address| address != normalized)
                {
                    return Err(ApiError::conflict(
                        "This profile already has a different linked wallet.",
                    ));
                }

                let wallet_only_user_ref = transaction.doc(&format!("users/{wallet_only}"));
                let wallet_only_balance_ref =
                    transaction.doc(&format!("balances/{wallet_only}"));
                let wallet_only_user = if can_claim_wallet_only {
                    transaction.get_doc(&wallet_only_user_ref).await?
                } else {
                    None
                };
                let wallet_only_balance = if can_claim_wallet_only {
                    transaction.get_doc(&wallet_only_balance_ref).await?
                } else {
                    None
                };
                let source_available = wallet_only_balance
                    .as_ref()
                    .and_then(|document| document.get_i64("availablePkn"))
                    .unwrap_or(0);
                let source_locked = wallet_only_balance
                    .as_ref()
                    .and_then(|document| document.get_i64("lockedPkn"))
                    .unwrap_or(0);

                transaction.set(
                    &nonce_ref,
                    DocData::new()
                        .bool("used", true)
                        .server_timestamp("usedAt"),
                    true,
                )?;
                transaction.set(
                    &session_ref,
                    DocData::new()
                        .bool("used", true)
                        .server_timestamp("usedAt")
                        .string("walletAddress", normalized.clone())
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                transaction.set(
                    &user_ref,
                    DocData::new()
                        .string("walletAddress", normalized.clone())
                        .server_timestamp("walletConnectedAt")
                        .string("username", username.clone())
                        .string("usernameLower", username.clone())
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                transaction.set(
                    &registry_ref,
                    DocData::new()
                        .string("uid", uid.clone())
                        .string("email", email.clone())
                        .string("address", normalized.clone())
                        .server_timestamp("verifiedAt")
                        .server_timestamp("updatedAt"),
                    true,
                )?;

                if can_claim_wallet_only {
                    if source_available != 0 || source_locked != 0 {
                        transaction.set(
                            &transaction.doc(&format!("balances/{uid}")),
                            DocData::new()
                                .increment("availablePkn", source_available)
                                .increment("lockedPkn", source_locked)
                                .server_timestamp("updatedAt"),
                            true,
                        )?;
                        transaction.set(
                            &wallet_only_balance_ref,
                            DocData::new()
                                .int("availablePkn", 0)
                                .int("lockedPkn", 0)
                                .string("mergedIntoUid", uid.clone())
                                .server_timestamp("updatedAt"),
                            true,
                        )?;
                    }
                    transaction.set(
                        &wallet_only_user_ref,
                        DocData::new()
                            .string("mergedIntoUid", uid.clone())
                            .server_timestamp("mergedAt")
                            .bool("active", false)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    let wallet_only_username = wallet_only_user
                        .as_ref()
                        .map(|document| {
                            document.get_str("username").trim().to_ascii_lowercase()
                        })
                        .unwrap_or_default();
                    if !wallet_only_username.is_empty() {
                        transaction.delete(
                            &transaction.doc(&format!("usernames/{wallet_only_username}")),
                        );
                    }
                }
                Ok(())
            })
        })
        .await?;

    let custom_token = state
        .service_account()
        .ok_or_else(|| ApiError::internal("Firebase Auth is not configured."))?
        .create_custom_token(
            &uid,
            Some(json!({ "walletAddress": normalized, "provider": "metamask_link" })),
        )
        .map_err(ApiError::from)?;

    let return_path = if return_path.starts_with('/') && !return_path.starts_with("//") {
        return_path
    } else {
        "/profile".to_string()
    };
    Ok(ok(json!({
        "customToken": custom_token,
        "uid": uid,
        "walletAddress": normalized,
        "returnPath": return_path,
    })))
}

fn session_expired_400() -> ApiError {
    ApiError::bad_request("Wallet link session expired. Start again from your profile.")
}

/// `object` is used by the shared helpers; keep the import meaningful here.
#[allow(dead_code)]
fn _body_object(body: &Json) -> serde_json::Map<String, Json> {
    object(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_only_helpers_match_node_slicing() {
        let address = "0xabcdef0123456789abcdef0123456789abcdef01";
        assert_eq!(
            wallet_only_uid(address),
            "wallet:0xabcdef0123456789abcdef0123456789abcdef01"
        );
        assert_eq!(
            wallet_only_email(address),
            "abcdef0123456789abcdef0123456789abcdef01@wallet.pokoin.local"
        );
        assert_eq!(placeholder_display_name(address), "0xabcd...ef01");
    }

    #[test]
    fn session_shape_is_validated() {
        assert!(is_session_id(&"a".repeat(48)));
        assert!(is_session_id(&"0123456789abcdef".repeat(3)));
        assert!(!is_session_id(&"a".repeat(47)));
        assert!(!is_session_id(&"A".repeat(48)));
        assert!(!is_session_id("z".repeat(48).as_str()));
    }
}
