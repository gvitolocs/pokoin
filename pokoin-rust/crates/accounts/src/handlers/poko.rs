//! Poko integration routes.
//!
//! * `poko-connect` — Telegram/Discord ↔ Pokoin profile linking. A signed-in
//!   user generates a short-lived code on the website (`create_code`) and
//!   redeems it from Telegram or Discord with `/connect <code>` (`redeem`,
//!   service bearer). Raw codes are never stored: the DB keeps SHA-256 hashes
//!   with a 15-minute expiry and single redemption.
//! * `poko-personal-context` — the authenticated personal marketplace facts
//!   Poko reuses (see [`crate::domain::personal_context`]).
//!
//! The service-authenticated actions share one constant-time token check
//! (`POKO_MARKET_SERVICE_TOKEN` / `POKONTACT_SERVICE_TOKEN`), exactly like Node.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value as Json};
use sha2::{Digest, Sha256};

use crate::error::Result;
use crate::sql::{row_text, MarketplaceDb, SqlParam};
use crate::state::DomainState;

use super::{json_with_cors, parse_body, require_claims, string_field};


// ---------------------------------------------------------------------------
// Shared Poko service authentication
// ---------------------------------------------------------------------------

/// Unambiguous alphabet: no 0/O, 1/I/L.
pub const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const CODE_LENGTH: usize = 8;
pub const CODE_TTL_MINUTES: i64 = 15;
pub const MAX_CODES_PER_UID: i64 = 5;

/// `normalizeCode`: uppercase, strip anything that is not A-Z0-9, cap at 12.
pub fn normalize_code(value: &str) -> String {
    value
        .to_ascii_uppercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect()
}

/// `hashCode`: sha256 hex of `poko-connect:{code}`.
pub fn code_hash(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("poko-connect:{code}").as_bytes());
    hex::encode(hasher.finalize())
}

pub fn generate_code() -> String {
    let bytes: [u8; CODE_LENGTH] = rand::random();
    bytes
        .iter()
        .map(|byte| CODE_ALPHABET[*byte as usize % CODE_ALPHABET.len()] as char)
        .collect()
}

/// `serviceToken()` — the same shared Poko secret as the market API.
pub fn service_token() -> String {
    std::env::var("POKO_MARKET_SERVICE_TOKEN")
        .ok()
        .or_else(|| std::env::var("POKONTACT_SERVICE_TOKEN").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

/// `crypto.timingSafeEqual` on the bearer value.
pub fn timing_safe_equal_text(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// `isServiceAuthorized(req)`: no configured token means never authorized.
pub fn is_service_authorized(authorization: Option<&str>) -> bool {
    let expected = service_token();
    if expected.is_empty() {
        return false;
    }
    let Some(header) = authorization else {
        return false;
    };
    let Some(rest) = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .or_else(|| header.strip_prefix("BEARER "))
    else {
        return false;
    };
    timing_safe_equal_text(rest.trim(), &expected)
}

/// `cleanText(value, max)`: collapse whitespace, trim, cap.
pub fn clean_text(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// `cleanText(value, 40).replace(/[^0-9]/g, '')`.
pub fn clean_digits(value: &str, max: usize) -> String {
    clean_text(value, max)
        .chars()
        .filter(char::is_ascii_digit)
        .collect()
}

fn strip_at(value: &str) -> String {
    value.trim_start_matches('@').to_string()
}

// ---------------------------------------------------------------------------
// poko-connect actions
// ---------------------------------------------------------------------------

async fn create_code(db: &MarketplaceDb, uid: &str) -> Result<Json> {
    let code = generate_code();
    let hash = code_hash(&code);
    // One live code per uid, and expired rows never accumulate.
    db.query_json(
        "delete from poko_telegram_link_codes where firebase_uid = $1 or expires_at < now()",
        &[SqlParam::Text(uid.to_string())],
    )
    .await?;
    let inserted = db
        .query_json(
            "insert into poko_telegram_link_codes (code_hash, firebase_uid, expires_at) \
             values ($1, $2, now() + ($3::int || ' minutes')::interval) returning expires_at",
            &[
                SqlParam::Text(hash),
                SqlParam::Text(uid.to_string()),
                SqlParam::Int(CODE_TTL_MINUTES),
            ],
        )
        .await?;
    let expires_at = inserted
        .first()
        .and_then(|row| row.get("expires_at").cloned())
        .unwrap_or(Json::Null);
    Ok(json!({
        "action": "create_code",
        "code": code,
        "expiresAtMinutes": CODE_TTL_MINUTES,
        "expiresAt": expires_at,
    }))
}

async fn redeem(db: &MarketplaceDb, body: &Json) -> Result<Json> {
    let code = normalize_code(&string_field(body, "code"));
    let telegram_user_id = clean_digits(&string_field(body, "telegramUserId"), 40);
    let discord_user_id = clean_digits(&string_field(body, "discordUserId"), 40);
    let channel = if !discord_user_id.is_empty() {
        "discord"
    } else if !telegram_user_id.is_empty() {
        "telegram"
    } else {
        ""
    };
    if code.len() < 6 || channel.is_empty() {
        return Ok(json!({
            "action": "redeem",
            "linked": false,
            "error": "code and telegramUserId or discordUserId required",
        }));
    }

    // Single redemption: the UPDATE only matches a live, unused code.
    let redeemed = db
        .query_json(
            "update poko_telegram_link_codes set redeemed_at = now() \
             where code_hash = $1 and redeemed_at is null and expires_at > now() \
             returning firebase_uid",
            &[SqlParam::Text(code_hash(&code))],
        )
        .await?;
    let Some(uid) = redeemed.first().map(|row| row_text(row, "firebase_uid")) else {
        return Ok(json!({
            "action": "redeem",
            "linked": false,
            "error": "code invalid, expired, or already used",
        }));
    };
    if uid.is_empty() {
        return Ok(json!({
            "action": "redeem",
            "linked": false,
            "error": "code invalid, expired, or already used",
        }));
    }

    if channel == "telegram" {
        let username = strip_at(&clean_text(&string_field(body, "telegramUsername"), 60));
        let display_name = clean_text(&string_field(body, "telegramDisplayName"), 80);
        // One Pokoin account maps to at most one Telegram user.
        db.query_json(
            "delete from poko_telegram_links where firebase_uid = $1 and telegram_user_id <> $2",
            &[
                SqlParam::Text(uid.clone()),
                SqlParam::Text(telegram_user_id.clone()),
            ],
        )
        .await?;
        db.query_json(
            "insert into poko_telegram_links \
               (firebase_uid, telegram_user_id, telegram_username, telegram_display_name) \
             values ($1, $2, $3, $4) \
             on conflict (telegram_user_id) do update set \
               firebase_uid = excluded.firebase_uid, \
               telegram_username = excluded.telegram_username, \
               telegram_display_name = excluded.telegram_display_name, \
               linked_at = now(), unlinked_at = null",
            &[
                SqlParam::Text(uid.clone()),
                SqlParam::Text(telegram_user_id),
                SqlParam::Text(username),
                SqlParam::Text(display_name),
            ],
        )
        .await?;
    } else {
        let username = strip_at(&clean_text(&string_field(body, "discordUsername"), 60));
        let display_name = clean_text(&string_field(body, "discordDisplayName"), 80);
        db.query_json(
            "delete from poko_discord_links where firebase_uid = $1 and discord_user_id <> $2",
            &[
                SqlParam::Text(uid.clone()),
                SqlParam::Text(discord_user_id.clone()),
            ],
        )
        .await?;
        db.query_json(
            "insert into poko_discord_links \
               (firebase_uid, discord_user_id, discord_username, discord_display_name) \
             values ($1, $2, $3, $4) \
             on conflict (discord_user_id) do update set \
               firebase_uid = excluded.firebase_uid, \
               discord_username = excluded.discord_username, \
               discord_display_name = excluded.discord_display_name, \
               linked_at = now(), unlinked_at = null",
            &[
                SqlParam::Text(uid.clone()),
                SqlParam::Text(discord_user_id),
                SqlParam::Text(username),
                SqlParam::Text(display_name),
            ],
        )
        .await?;
    }
    Ok(json!({
        "action": "redeem",
        "linked": true,
        "firebaseUid": uid,
        "channel": channel,
    }))
}

async fn link_status(db: &MarketplaceDb, body: &Json) -> Result<Json> {
    let discord_user_id = clean_digits(&string_field(body, "discordUserId"), 40);
    if !discord_user_id.is_empty() {
        let rows = db
            .query_json(
                "select firebase_uid, discord_username, discord_display_name, linked_at \
                 from poko_discord_links \
                 where discord_user_id = $1 and unlinked_at is null limit 1",
                &[SqlParam::Text(discord_user_id)],
            )
            .await?;
        let Some(row) = rows.first() else {
            return Ok(json!({ "action": "status", "linked": false, "channel": "discord" }));
        };
        return Ok(json!({
            "action": "status",
            "linked": true,
            "channel": "discord",
            "firebaseUid": row_text(row, "firebase_uid"),
            "discordUsername": row_text(row, "discord_username"),
            "displayName": row_text(row, "discord_display_name"),
            "linkedAt": row.get("linked_at").cloned().unwrap_or(Json::Null),
        }));
    }

    let telegram_user_id = clean_digits(&string_field(body, "telegramUserId"), 40);
    if telegram_user_id.is_empty() {
        return Ok(json!({
            "action": "status",
            "linked": false,
            "error": "telegramUserId or discordUserId required",
        }));
    }
    let rows = db
        .query_json(
            "select firebase_uid, telegram_username, telegram_display_name, linked_at \
             from poko_telegram_links \
             where telegram_user_id = $1 and unlinked_at is null limit 1",
            &[SqlParam::Text(telegram_user_id)],
        )
        .await?;
    let Some(row) = rows.first() else {
        return Ok(json!({ "action": "status", "linked": false, "channel": "telegram" }));
    };
    Ok(json!({
        "action": "status",
        "linked": true,
        "channel": "telegram",
        "firebaseUid": row_text(row, "firebase_uid"),
        "telegramUsername": row_text(row, "telegram_username"),
        "displayName": row_text(row, "telegram_display_name"),
        "linkedAt": row.get("linked_at").cloned().unwrap_or(Json::Null),
    }))
}

async fn my_status(db: &MarketplaceDb, uid: &str) -> Result<Json> {
    let params = [SqlParam::Text(uid.to_string())];
    let (telegram_rows, discord_rows) = tokio::try_join!(
        db.query_json(
            "select telegram_username, linked_at from poko_telegram_links \
             where firebase_uid = $1 and unlinked_at is null limit 1",
            &params,
        ),
        db.query_json(
            "select discord_username, linked_at from poko_discord_links \
             where firebase_uid = $1 and unlinked_at is null limit 1",
            &params,
        ),
    )?;

    let telegram = match telegram_rows.first() {
        Some(row) => json!({
            "linked": true,
            "username": row_text(row, "telegram_username"),
            "linkedAt": row.get("linked_at").cloned().unwrap_or(Json::Null),
        }),
        None => json!({ "linked": false }),
    };
    let discord = match discord_rows.first() {
        Some(row) => json!({
            "linked": true,
            "username": row_text(row, "discord_username"),
            "linkedAt": row.get("linked_at").cloned().unwrap_or(Json::Null),
        }),
        None => json!({ "linked": false }),
    };
    let telegram_username = telegram
        .get("username")
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();
    Ok(json!({
        "action": "my_status",
        // Back-compat: the top-level fields still mean Telegram.
        "linked": telegram.get("linked").and_then(Json::as_bool).unwrap_or(false),
        "telegramUsername": telegram_username,
        "linkedAt": telegram.get("linkedAt").cloned().unwrap_or(Json::Null),
        "telegram": telegram,
        "discord": discord,
    }))
}

async fn unlink_me(db: &MarketplaceDb, uid: &str, body: &Json) -> Result<Json> {
    let channel = clean_text(&string_field(body, "channel"), 20).to_ascii_lowercase();
    if channel.is_empty() || channel == "telegram" || channel == "all" {
        db.query_json(
            "update poko_telegram_links set unlinked_at = now() \
             where firebase_uid = $1 and unlinked_at is null",
            &[SqlParam::Text(uid.to_string())],
        )
        .await?;
    }
    // Default unlink_me (no channel) clears Telegram only for back-compat.
    if channel == "discord" || channel == "all" {
        db.query_json(
            "update poko_discord_links set unlinked_at = now() \
             where firebase_uid = $1 and unlinked_at is null",
            &[SqlParam::Text(uid.to_string())],
        )
        .await?;
    }
    let reported = if channel.is_empty() {
        "telegram".to_string()
    } else {
        channel
    };
    Ok(json!({
        "action": "unlink_me",
        "linked": false,
        "channel": reported,
    }))
}

async fn unlink(db: &MarketplaceDb, body: &Json) -> Result<Json> {
    let discord_user_id = clean_digits(&string_field(body, "discordUserId"), 40);
    if !discord_user_id.is_empty() {
        db.query_json(
            "update poko_discord_links set unlinked_at = now() \
             where discord_user_id = $1 and unlinked_at is null",
            &[SqlParam::Text(discord_user_id)],
        )
        .await?;
        return Ok(json!({ "action": "unlink", "linked": false, "channel": "discord" }));
    }
    let telegram_user_id = clean_digits(&string_field(body, "telegramUserId"), 40);
    if telegram_user_id.is_empty() {
        return Ok(json!({
            "action": "unlink",
            "linked": false,
            "error": "telegramUserId or discordUserId required",
        }));
    }
    db.query_json(
        "update poko_telegram_links set unlinked_at = now() \
         where telegram_user_id = $1 and unlinked_at is null",
        &[SqlParam::Text(telegram_user_id)],
    )
    .await?;
    Ok(json!({ "action": "unlink", "linked": false, "channel": "telegram" }))
}

/// The actions a signed-in website user may call.
pub const FIREBASE_ACTIONS: [&str; 3] = ["create_code", "my_status", "unlink_me"];
/// The actions only the Poko service may call.
pub const SERVICE_ACTIONS: [&str; 3] = ["redeem", "status", "unlink"];

fn unknown_action_error() -> String {
    let all: Vec<&str> = FIREBASE_ACTIONS
        .iter()
        .chain(SERVICE_ACTIONS.iter())
        .copied()
        .collect();
    format!(
        "unknown action; expected one of {}",
        all.join(", ")
    )
}

/// `POST /api/poko-connect`.
pub async fn poko_connect(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = parse_body(&body);
    let action = clean_text(&string_field(&body, "action"), 20);

    if FIREBASE_ACTIONS.contains(&action.as_str()) {
        // The Node handler swallowed the auth error into an empty uid, then
        // answered the generic 401 body.
        let uid = match require_claims(&state, &headers).await {
            Ok(claims) => claims.uid,
            Err(_) => String::new(),
        };
        if uid.is_empty() {
            return json_with_cors(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "unauthorized" }),
            );
        }
        let outcome = run_firebase_action(&state, &action, &uid, &body).await;
        return match outcome {
            Ok(result) => json_with_cors(StatusCode::OK, merge_ok(result)),
            Err(error) => {
                tracing::error!(action, %error, "poko-connect firebase action failed");
                json_with_cors(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "ok": false, "error": "connect action failed" }),
                )
            }
        };
    }

    // Service-authenticated actions (Telegram / Discord side).
    if service_token().is_empty() {
        return json_with_cors(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "poko-connect not configured: service token missing" }),
        );
    }
    if !is_service_authorized(super::authorization(&headers)) {
        return json_with_cors(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    if !SERVICE_ACTIONS.contains(&action.as_str()) {
        return json_with_cors(
            StatusCode::BAD_REQUEST,
            json!({ "error": unknown_action_error() }),
        );
    }

    let db = match state.marketplace_db() {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };
    let outcome = match action.as_str() {
        "redeem" => redeem(&db, &body).await,
        "status" => link_status(&db, &body).await,
        _ => unlink(&db, &body).await,
    };
    match outcome {
        Ok(result) => json_with_cors(StatusCode::OK, merge_ok(result)),
        Err(error) => {
            tracing::error!(action, %error, "poko-connect action failed");
            json_with_cors(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "ok": false, "error": "connect action failed" }),
            )
        }
    }
}

async fn run_firebase_action(
    state: &DomainState,
    action: &str,
    uid: &str,
    body: &Json,
) -> Result<Json> {
    let db = state.marketplace_db()?;
    match action {
        "create_code" => create_code(&db, uid).await,
        "unlink_me" => unlink_me(&db, uid, body).await,
        _ => my_status(&db, uid).await,
    }
}

/// `{ ok: true, ...result }` with `ok` first, like the Node spread order.
fn merge_ok(result: Json) -> Json {
    let mut object = Map::new();
    object.insert("ok".into(), json!(true));
    if let Some(fields) = result.as_object() {
        for (key, value) in fields {
            object.insert(key.clone(), value.clone());
        }
    }
    Json::Object(object)
}

// ---------------------------------------------------------------------------
// poko-personal-context
// ---------------------------------------------------------------------------

/// The authenticated (or service-authenticated) personal marketplace context.
///
/// `GET` is not allowed: the Node handler answers 405 `{error:'POST only'}` for
/// any other verb, and the same body is reused here.
pub async fn poko_personal_context(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = parse_body(&body);
    let action = {
        let raw = clean_text(&string_field(&body, "action"), 20);
        if raw.is_empty() {
            "get".to_string()
        } else {
            raw
        }
    };
    if action != "get" && action != "sync" {
        return personal_context_reject(StatusCode::BAD_REQUEST, "action must be get or sync");
    }

    // Resolve the subject: the Poko service may act for any uid; a web caller is
    // always the bearer's own uid.
    let (uid, persist_overlay) = if is_service_authorized(super::authorization(&headers)) {
        let uid = clean_text(
            &{
                let primary = string_field(&body, "firebaseUid");
                if primary.is_empty() {
                    let secondary = string_field(&body, "uid");
                    if secondary.is_empty() {
                        string_field(&body, "userId")
                    } else {
                        secondary
                    }
                } else {
                    primary
                }
            },
            160,
        );
        if uid.is_empty() {
            return personal_context_reject(
                StatusCode::BAD_REQUEST,
                "firebaseUid required for service personal-context.",
            );
        }
        (uid, false)
    } else {
        match require_claims(&state, &headers).await {
            Ok(claims) => {
                let uid = claims.uid.chars().take(160).collect::<String>();
                if uid.is_empty() {
                    return personal_context_reject(StatusCode::UNAUTHORIZED, "Missing Pokoin user.");
                }
                (uid, true)
            }
            Err(error) => return personal_context_reject(error.status(), error.message()),
        }
    };

    // Firestore is optional: Node wrapped it in a try/catch and passed null.
    let firestore = state.firestore().ok();
    let db = match state.marketplace_db() {
        Ok(db) => db,
        Err(error) => {
            return personal_context_error(
                error.status(),
                "Could not load personal context.",
                error.message(),
            )
        }
    };
    let overlay = crate::domain::personal_context::overlay_from_body(&body);
    let persist = action == "sync" && persist_overlay;

    match crate::domain::personal_context::build_personal_context(
        &db,
        firestore.as_ref(),
        &uid,
        &overlay,
        persist,
    )
    .await
    {
        Ok(personal) => {
            let intent = crate::domain::personal_context::format_personal_intent(&personal);
            let mut response = json_with_cors(
                StatusCode::OK,
                json!({
                    "ok": true,
                    "action": action,
                    "personal": personal,
                    "intent": intent,
                }),
            );
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("private, no-store"),
            );
            response
        }
        Err(error) => {
            tracing::error!(
                message = %error.message().chars().take(300).collect::<String>(),
                "poko-personal-context failed"
            );
            personal_context_error(
                error.status(),
                "Could not load personal context.",
                error.message(),
            )
        }
    }
}

/// The auth/action rejection shape: `authErrorResponse(error)` / `sendJson(400,
/// {error})` — a bare `{error}` body with `private, no-store`.
fn personal_context_reject(status: StatusCode, message: &str) -> Response {
    let status = if status.is_client_error() {
        status
    } else {
        StatusCode::UNAUTHORIZED
    };
    let mut response = json_with_cors(
        status,
        json!({
            "error": if message.is_empty() { "unauthorized" } else { message }
        }),
    );
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}

/// The build-stage rejection: `{ok:false, error}` with a generic message, never
/// the raw internal detail.
fn personal_context_error(
    status: StatusCode,
    reported: &str,
    internal: &str,
) -> Response {
    let status = if status.is_client_error() || status.is_server_error() {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    if status.is_server_error() {
        tracing::error!(%internal, "poko-personal-context rejected");
    }
    let mut response = json_with_cors(status, json!({ "ok": false, "error": reported }));
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}

/// `POST only` — the Node handler answered this body for any other verb.
pub async fn poko_connect_other() -> Response {
    let mut response = json_with_cors(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "POST only" }));
    response.headers_mut().insert(
        axum::http::header::ALLOW,
        axum::http::HeaderValue::from_static("POST"),
    );
    response
}

/// Keep the shared helper import meaningful for the sibling Poko routes.
#[allow(dead_code)]
fn _unused(_: Arc<()>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_use_the_unambiguous_alphabet() {
        for _ in 0..64 {
            let code = generate_code();
            assert_eq!(code.len(), CODE_LENGTH);
            assert!(code
                .bytes()
                .all(|byte| CODE_ALPHABET.contains(&byte)));
            // No look-alike characters ever appear.
            for forbidden in ['0', 'O', '1', 'I', 'L'] {
                assert!(!code.contains(forbidden), "{code}");
            }
        }
    }

    #[test]
    fn normalization_strips_punctuation_and_caps_length() {
        assert_eq!(normalize_code(" ab-cd 12 "), "ABCD12");
        assert_eq!(normalize_code("abcdefghijklmnop"), "ABCDEFGHIJKL");
        assert_eq!(normalize_code(""), "");
        assert_eq!(normalize_code("!!!###"), "");
    }

    #[test]
    fn code_hashes_are_salted_and_stable() {
        assert_eq!(code_hash("ABCD2345"), code_hash("ABCD2345"));
        assert_ne!(code_hash("ABCD2345"), code_hash("ABCD2346"));
        assert_ne!(code_hash("ABCD2345"), code_hash("poko-connect:ABCD2345"));
        assert_eq!(code_hash("ABCD2345").len(), 64);
    }

    #[test]
    fn service_authorization_is_exact_and_constant_time() {
        // No configured token: never authorized, whatever the header says.
        std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
        std::env::remove_var("POKONTACT_SERVICE_TOKEN");
        assert!(service_token().is_empty());
        assert!(!is_service_authorized(Some("Bearer anything")));

        std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "s3cret");
        assert!(!service_token().is_empty());
        assert!(is_service_authorized(Some("Bearer s3cret")));
        assert!(is_service_authorized(Some("Bearer  s3cret ")));
        assert!(is_service_authorized(Some("bearer s3cret")));
        assert!(!is_service_authorized(Some("Bearer s3cre")));
        assert!(!is_service_authorized(Some("Bearer s3crett")));
        assert!(!is_service_authorized(Some("Basic s3cret")));
        assert!(!is_service_authorized(None));
        std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
    }

    #[test]
    fn timing_safe_compare_matches_bytes() {
        assert!(timing_safe_equal_text("abc", "abc"));
        assert!(!timing_safe_equal_text("abc", "abd"));
        assert!(!timing_safe_equal_text("abc", "abcd"));
        assert!(timing_safe_equal_text("", ""));
    }

    #[test]
    fn text_cleaning_matches_the_node_helper() {
        assert_eq!(clean_text("  a   b  ", 80), "a b");
        assert_eq!(clean_text("a\nb", 80), "a b");
        assert_eq!(clean_text(&"x".repeat(90), 80).len(), 80);
        assert_eq!(clean_digits(" +39 333-1234567 ", 40), "393331234567");
        assert_eq!(clean_digits("abc", 40), "");
        assert_eq!(strip_at("@ash"), "ash");
        assert_eq!(strip_at("ash"), "ash");
    }

    #[test]
    fn unknown_action_message_lists_every_action_in_node_order() {
        assert_eq!(
            unknown_action_error(),
            "unknown action; expected one of create_code, my_status, unlink_me, redeem, status, unlink"
        );
    }

    #[test]
    fn ok_is_prepended_to_action_results() {
        let merged = merge_ok(json!({ "action": "status", "linked": false }));
        let object = merged.as_object().unwrap();
        assert_eq!(object.keys().next().map(String::as_str), Some("ok"));
        assert_eq!(merged["ok"], json!(true));
        assert_eq!(merged["linked"], json!(false));
    }
}
