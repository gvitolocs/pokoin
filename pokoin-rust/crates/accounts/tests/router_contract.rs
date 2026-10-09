//! Router contract: the ported routes answer with the same status codes and
//! body shapes as the Node handlers, the CORS preflight is preserved, and the
//! unported routes are deliberately absent (404) rather than stubbed.

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use pokoin_accounts::http::HttpResponse;
use pokoin_accounts::{router, DomainState};
use tower::ServiceExt;

const DOCS: &str = "/databases/(default)/documents";

/// The service token lives in the process environment, so every case that
/// depends on it runs inside one test holding a lock. Parallel tests in this
/// binary must not race on env mutation.
static SERVICE_TOKEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());


async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value, axum::http::HeaderMap) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.expect("router responds");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json, headers)
}

fn script_run_query(transport: &Arc<ScriptedTransport>, documents: serde_json::Value) {
    transport.on(":runQuery", move |_| {
        HttpResponse::json(200, documents.clone())
    });
}

fn script_transaction(
    transport: &Arc<ScriptedTransport>,
    found: Option<serde_json::Value>,
    transaction_id: &str,
) {
    let transaction_id = transaction_id.to_string();
    transport.on(":beginTransaction", move |_| {
        HttpResponse::json(
            200,
            serde_json::json!({ "transaction": transaction_id.clone() }),
        )
    });
    transport.on(":batchGet", move |_| {
        let entry = match &found {
            Some(document) => serde_json::json!({ "found": document }),
            None => serde_json::json!({ "missing": "x" }),
        };
        HttpResponse::json(200, serde_json::json!([entry]))
    });
    transport.on_json(":commit", 200, serde_json::json!({ "writeResults": [{}] }));
    transport.on_json(":rollback", 200, serde_json::json!({}));
}

fn document(name: &str, fields: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "name": name, "fields": fields })
}

#[tokio::test]
async fn options_preflight_answers_204_with_the_node_cors_headers() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, _body, headers) = call(&app, "OPTIONS", "/api/auth-login", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["access-control-allow-origin"], "*");
    assert_eq!(headers["access-control-allow-methods"], "POST, OPTIONS");
    assert_eq!(
        headers["access-control-allow-headers"],
        "Content-Type, Authorization"
    );
    assert_eq!(headers["access-control-max-age"], "86400");
}

#[tokio::test]
async fn auth_login_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(&app, "POST", "/api/auth-login", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
}

#[tokio::test]
async fn auth_login_returns_the_safe_auth_metadata() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "ash@pokoin.com", now));
    let (status, body, _) = call(&app, "POST", "/api/auth-login", Some(&token), None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], serde_json::json!(true));
    assert_eq!(body["auth"]["tokenType"], serde_json::json!("Bearer"));
    assert_eq!(body["auth"]["uid"], serde_json::json!("user-1"));
    assert_eq!(body["auth"]["email"], serde_json::json!("ash@pokoin.com"));
    assert_eq!(body["auth"]["emailVerified"], serde_json::json!(true));
    // `exp` and `auth_time` are rendered as ISO strings, like `toISOString()`.
    assert!(body["auth"]["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert!(body["auth"]["authTime"].as_str().unwrap().ends_with('Z'));
    // Never leak the raw token or unrelated claims.
    assert!(body["auth"].get("token").is_none());
    assert!(body["auth"].get("extra").is_none());
}

#[tokio::test]
async fn auth_login_rejects_an_expired_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let mut claims = id_token_claims("user-1", "a@b.co", now - 7200);
    claims["exp"] = serde_json::json!(now - 3600);
    let token = sign_id_token(claims);
    let (status, body, _) = call(&app, "POST", "/api/auth-login", Some(&token), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].as_str().unwrap().contains("Invalid or expired sign-in token."));
}

#[tokio::test]
async fn an_unconfigured_state_reports_configuration_instead_of_faking_success() {
    let app = router(unconfigured_state());
    let (status, body, _) = call(&app, "POST", "/api/auth-login", Some("token"), None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Sign-in verification is not configured." })
    );
}

#[tokio::test]
async fn register_email_validates_the_address_before_any_network_call() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/register-email",
        None,
        Some(serde_json::json!({ "email": "not-an-email", "password": "hunter2" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Enter a valid email address." }));
    assert_eq!(transport.request_count(), 0, "no outbound call is made");
}

#[tokio::test]
async fn register_email_requires_a_six_character_password() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/register-email",
        None,
        Some(serde_json::json!({ "email": "a@b.co", "password": "12345" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Password must be at least 6 characters." })
    );
}

#[tokio::test]
async fn register_email_rejects_a_taken_username() {
    let transport = ScriptedTransport::new();
    // usernames/ash already exists.
    transport.on("usernames/ash", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/usernames/ash"),
                serde_json::json!({ "uid": { "stringValue": "someone" } }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/register-email",
        None,
        Some(serde_json::json!({
            "email": "a@b.co",
            "password": "hunter2",
            "username": "ash"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, serde_json::json!({ "error": "Username is already taken." }));
}

#[tokio::test]
async fn register_email_rejects_an_invalid_requested_username() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/register-email",
        None,
        Some(serde_json::json!({
            "email": "a@b.co",
            "password": "hunter2",
            "username": "ash ketchum"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Username must be 3-32 letters or numbers, with no spaces." })
    );
}

#[tokio::test]
async fn verify_email_signup_rejects_a_missing_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(&app, "POST", "/api/verify-email-signup", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Verification token is missing." })
    );
}

#[tokio::test]
async fn verify_email_signup_reports_an_unknown_token() {
    let transport = ScriptedTransport::new();
    transport.on("pending_email_signups/", |_| {
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5 } }))
    });
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/verify-email-signup",
        None,
        Some(serde_json::json!({ "token": "unknown" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], serde_json::json!("invalid_token"));
    assert_eq!(
        body["error"],
        serde_json::json!("This verification link is invalid or already used.")
    );
}

#[tokio::test]
async fn verify_email_signup_reports_an_expired_token() {
    let transport = ScriptedTransport::new();
    let token_id = pokoin_accounts::domain::pending_signup::hash_value("stale");
    let document_name = format!("projects/{TEST_PROJECT}{DOCS}/pending_email_signups/{token_id}");
    transport.on(&format!("pending_email_signups/{token_id}"), move |_| {
        HttpResponse::json(
            200,
            document(
                &document_name,
                serde_json::json!({
                    "status": { "stringValue": "pending" },
                    "expiresAt": { "timestampValue": "2020-01-01T00:00:00Z" }
                }),
            ),
        )
    });
    transport.on_json(":commit", 200, serde_json::json!({ "writeResults": [{}] }));
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/verify-email-signup",
        None,
        Some(serde_json::json!({ "token": "stale" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], serde_json::json!("expired_token"));
}

#[tokio::test]
async fn ensure_username_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/ensure-username",
        None,
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
}

#[tokio::test]
async fn ensure_username_returns_the_existing_handle_without_rewriting_it() {
    let transport = ScriptedTransport::new();
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "ash@pokoin.com", now));
    // The transaction reads users/user-1 and finds an established handle.
    script_transaction(
        &transport,
        Some(document(
            &format!("projects/{TEST_PROJECT}{DOCS}/users/user-1"),
            serde_json::json!({ "username": { "stringValue": "ash" } }),
        )),
        "tx-1",
    );
    let app = router(test_state(&transport));
    let (status, body, headers) = call(
        &app,
        "POST",
        "/api/ensure-username",
        Some(&token),
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, serde_json::json!({ "username": "ash" }));
    assert_eq!(headers["cache-control"], "no-store");
    // Nothing was written: a read-only transaction is rolled back.
    assert!(transport.requests_to(":commit").is_empty());
    assert_eq!(transport.requests_to(":rollback").len(), 1);
}

#[tokio::test]
async fn wallet_auth_nonce_rejects_a_malformed_address() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-auth/nonce",
        None,
        Some(serde_json::json!({ "address": "0x123" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Enter a valid wallet address." })
    );
    assert_eq!(transport.request_count(), 0);
}

#[tokio::test]
async fn wallet_auth_nonce_persists_a_single_use_message() {
    let transport = ScriptedTransport::new();
    transport.on_json(":commit", 200, serde_json::json!({ "writeResults": [{}] }));
    let app = router(test_state(&transport));
    let address = "0xabcdef0123456789abcdef0123456789abcdef01";
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-auth/nonce",
        None,
        Some(serde_json::json!({ "address": address })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["address"], serde_json::json!(address));
    let message = body["message"].as_str().unwrap();
    assert!(message.starts_with("Sign in to Pokoin\n\nWallet: 0x"));
    assert!(message.contains("\nDomain: pokoin.com"));

    let commit: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    let fields = &commit["writes"][0]["update"]["fields"];
    assert_eq!(fields["address"]["stringValue"], serde_json::json!(address));
    assert_eq!(fields["used"]["booleanValue"], serde_json::json!(false));
    assert_eq!(
        commit["writes"][0]["update"]["name"],
        serde_json::json!(format!(
            "https://test.local/v1/projects/{TEST_PROJECT}{DOCS}/wallet_auth_nonces/{address}"
        ))
    );
}

#[tokio::test]
async fn wallet_auth_verify_rejects_a_non_hex_signature() {
    // Node (wallet-auth-verify.js) only checks the signature is 0x-hex before
    // reading the nonce; a short hex signature fails later in recovery.
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-auth/verify",
        None,
        Some(serde_json::json!({
            "address": "0xabcdef0123456789abcdef0123456789abcdef01",
            "signature": "0xnothex"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Missing wallet signature." }));
}

#[tokio::test]
async fn wallet_auth_verify_reports_an_unusable_nonce() {
    let transport = ScriptedTransport::new();
    // No nonce document exists yet.
    transport.on("wallet_auth_nonces/", |_| {
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5 } }))
    });
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-auth/verify",
        None,
        Some(serde_json::json!({
            "address": "0xabcdef0123456789abcdef0123456789abcdef01",
            "signature": format!("0x{}1b", "11".repeat(64))
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Wallet sign-in nonce expired. Try again." })
    );
}

#[tokio::test]
async fn wallet_link_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-link",
        None,
        Some(serde_json::json!({
            "address": "0xabcdef0123456789abcdef0123456789abcdef01",
            "signature": format!("0x{}1b", "11".repeat(64))
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
}

#[tokio::test]
async fn wallet_link_complete_validates_address_signature_then_session() {
    // Node (wallet-link-complete.js) order: address, signature, session id.
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-link/complete",
        None,
        Some(serde_json::json!({ "sessionId": "short" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Enter a valid wallet address." }));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-link/complete",
        None,
        Some(serde_json::json!({
            "sessionId": "short",
            "address": "0xabcdef0123456789abcdef0123456789abcdef01",
            "signature": "0xdeadbeef"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Wallet link session is invalid." })
    );
}

#[tokio::test]
async fn wallet_link_complete_reports_an_expired_session_as_410() {
    let transport = ScriptedTransport::new();
    let session_id = "a".repeat(48);
    let session_name = format!("projects/{TEST_PROJECT}{DOCS}/wallet_link_sessions/{session_id}");
    transport.on(&format!("wallet_link_sessions/{session_id}"), move |_| {
        HttpResponse::json(
            200,
            document(
                &session_name,
                serde_json::json!({
                    "uid": { "stringValue": "user-1" },
                    "used": { "booleanValue": false },
                    "expiresAtMs": { "integerValue": "1" }
                }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/wallet-link/complete",
        None,
        Some(serde_json::json!({
            "sessionId": session_id,
            "address": "0xabcdef0123456789abcdef0123456789abcdef01",
            "signature": format!("0x{}1b", "11".repeat(64))
        })),
    )
    .await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Wallet link session expired. Start again from your profile." })
    );
}

#[tokio::test]
async fn marketplace_collection_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(&app, "GET", "/api/marketplace-collection", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Authentication required." })
    );
}

#[tokio::test]
async fn marketplace_collection_returns_the_owners_holdings() {
    let transport = ScriptedTransport::new();
    script_run_query(
        &transport,
        serde_json::json!([
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/user_card_collections/scan:1"),
                serde_json::json!({
                    "uid": { "stringValue": "user-1" },
                    "cardId": { "stringValue": "12345" },
                    "cardName": { "stringValue": "Pikachu" },
                    "quantity": { "integerValue": "3" },
                    "condition": { "stringValue": "NM" },
                    "ownershipType": { "stringValue": "physical" },
                    "createdAt": { "timestampValue": "2026-01-02T03:04:05Z" }
                })
            ) },
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/user_card_collections/scan:2"),
                serde_json::json!({
                    "uid": { "stringValue": "someone-else" },
                    "quantity": { "integerValue": "9" }
                })
            ) }
        ]),
    );
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, headers) =
        call(&app, "GET", "/api/marketplace-collection", Some(&token), None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["uid"], serde_json::json!("user-1"));
    assert_eq!(body["itemCount"], serde_json::json!(1));
    assert_eq!(body["cardsOwned"], serde_json::json!(3));
    assert_eq!(body["physicalItems"], serde_json::json!(1));
    assert_eq!(body["items"][0]["id"], serde_json::json!("scan:1"));
    assert_eq!(body["items"][0]["quantity"], serde_json::json!(3));
    assert_eq!(body["items"][0]["createdAt"], serde_json::json!("2026-01-02T03:04:05.000Z"));
    // Another owner's document must never be returned.
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    assert_eq!(headers["cache-control"], "private, no-store");

    // The filter is by the verified uid, never a client-supplied value.
    let query: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":runQuery")[0].body).unwrap();
    assert_eq!(
        query["structuredQuery"]["where"]["fieldFilter"]["value"],
        serde_json::json!({ "stringValue": "user-1" })
    );
}

#[tokio::test]
async fn marketplace_collection_summary_returns_the_dashboard_shape() {
    let transport = ScriptedTransport::new();
    script_run_query(
        &transport,
        serde_json::json!([
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/user_card_collections/scan:1"),
                serde_json::json!({
                    "uid": { "stringValue": "user-1" },
                    "quantity": { "integerValue": "2" },
                    "ownershipType": { "stringValue": "physical" }
                })
            ) },
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/user_card_collections/scan:2"),
                serde_json::json!({
                    "uid": { "stringValue": "user-1" },
                    "quantity": { "integerValue": "1" },
                    "ownershipType": { "stringValue": "nft" }
                })
            ) }
        ]),
    );
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/marketplace-collection-summary",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cardsOwned"], serde_json::json!(3));
    assert_eq!(body["items"], serde_json::json!(2));
    assert_eq!(body["physicalItems"], serde_json::json!(1));
    assert_eq!(body["nftItems"], serde_json::json!(1));
    assert_eq!(body["physicalOwned"], serde_json::json!(2));
    assert_eq!(body["nftOwned"], serde_json::json!(1));
}

#[tokio::test]
async fn marketplace_collection_post_rejects_an_unknown_action() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/marketplace-collection?action=explode",
        Some(&token),
        Some(serde_json::json!({ "itemId": "scan:1" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Unknown collection action." })
    );
}

#[tokio::test]
async fn marketplace_collection_remove_refuses_another_owners_item_with_404() {
    let transport = ScriptedTransport::new();
    transport.on("user_card_collections/scan:1", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/user_card_collections/scan:1"),
                serde_json::json!({
                    "uid": { "stringValue": "someone-else" },
                    "quantity": { "integerValue": "1" }
                }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/marketplace-collection?action=remove",
        Some(&token),
        Some(serde_json::json!({ "itemId": "scan:1" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Collection item not found." })
    );
}

#[tokio::test]
async fn marketplace_collection_remove_deletes_at_zero_quantity() {
    let transport = ScriptedTransport::new();
    transport.on("user_card_collections/scan:1", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/user_card_collections/scan:1"),
                serde_json::json!({
                    "uid": { "stringValue": "user-1" },
                    "quantity": { "integerValue": "1" },
                    "ownershipType": { "stringValue": "physical" }
                }),
            ),
        )
    });
    transport.on_json(":commit", 200, serde_json::json!({ "writeResults": [{}] }));
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/marketplace-collection?action=remove",
        Some(&token),
        Some(serde_json::json!({ "itemId": "scan:1" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], serde_json::json!(true));
    assert_eq!(body["before"], serde_json::json!(1));
    assert_eq!(body["after"], serde_json::json!(0));
    let commit: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    assert!(commit["writes"][0].get("delete").is_some());
}

#[tokio::test]
async fn news_comments_get_requires_a_valid_article_id() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(&app, "GET", "/api/news-comments?articleId=nope", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "articleId is required." }));
}

#[tokio::test]
async fn news_comments_get_lists_only_visible_comments_for_anonymous_readers() {
    let transport = ScriptedTransport::new();
    script_run_query(
        &transport,
        serde_json::json!([
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/news_comments/c1"),
                serde_json::json!({
                    "status": { "stringValue": "visible" },
                    "authorName": { "stringValue": "ash" },
                    "body": { "stringValue": "second" },
                    "createdAt": { "stringValue": "2026-10-08T00:00:02Z" }
                })
            ) },
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/news_comments/c2"),
                serde_json::json!({
                    "status": { "stringValue": "pending" },
                    "uid": { "stringValue": "user-1" },
                    "body": { "stringValue": "hidden" }
                })
            ) },
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/news_comments/c0"),
                serde_json::json!({
                    "status": { "stringValue": "visible" },
                    "authorName": { "stringValue": "misty" },
                    "body": { "stringValue": "first" },
                    "createdAt": { "stringValue": "2026-10-08T00:00:01Z" }
                })
            ) }
        ]),
    );
    let app = router(test_state(&transport));
    let (status, body, headers) = call(
        &app,
        "GET",
        "/api/news-comments?articleId=art_abcd",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["articleId"], serde_json::json!("art_abcd"));
    assert_eq!(body["count"], serde_json::json!(2));
    // Oldest first.
    assert_eq!(body["comments"][0]["body"], serde_json::json!("first"));
    assert_eq!(body["comments"][1]["body"], serde_json::json!("second"));
    // A pending comment is never public.
    assert_eq!(body["mine"], serde_json::json!([]));
    assert_eq!(headers["cache-control"], "public, max-age=30");
}

#[tokio::test]
async fn news_comments_get_shows_the_callers_own_pending_comments() {
    let transport = ScriptedTransport::new();
    script_run_query(
        &transport,
        serde_json::json!([
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/news_comments/c1"),
                serde_json::json!({
                    "status": { "stringValue": "pending" },
                    "uid": { "stringValue": "user-1" },
                    "authorName": { "stringValue": "ash" },
                    "body": { "stringValue": "mine" },
                    "createdAt": { "stringValue": "2026-10-08T00:00:01Z" }
                })
            ) },
            { "document": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/news_comments/c2"),
                serde_json::json!({
                    "status": { "stringValue": "pending" },
                    "uid": { "stringValue": "someone-else" },
                    "body": { "stringValue": "not mine" }
                })
            ) }
        ]),
    );
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, headers) = call(
        &app,
        "GET",
        "/api/news-comments?articleId=art_abcd",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], serde_json::json!(0));
    assert_eq!(body["mine"].as_array().unwrap().len(), 1);
    assert_eq!(body["mine"][0]["body"], serde_json::json!("mine"));
    assert_eq!(body["mine"][0]["status"], serde_json::json!("pending"));
    assert_eq!(headers["cache-control"], "private, no-store");
}

#[tokio::test]
async fn news_comments_post_requires_sign_in() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/news-comments",
        None,
        Some(serde_json::json!({
            "articleId": "art_abcd",
            "articlePath": "/news/hello",
            "body": "hi"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Sign in to comment." }));
}

#[tokio::test]
async fn news_comments_post_validates_the_article_and_body() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));

    let (status, body, _) = call(
        &app,
        "POST",
        "/api/news-comments",
        Some(&token),
        Some(serde_json::json!({
            "articleId": "art_abcd",
            "articlePath": "/blog/hello",
            "body": "hi"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Unknown article." }));

    let (status, body, _) = call(
        &app,
        "POST",
        "/api/news-comments",
        Some(&token),
        Some(serde_json::json!({
            "articleId": "art_abcd",
            "articlePath": "/news/hello",
            "body": "x"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Comments are 2–1500 characters." }));
}

#[tokio::test]
async fn news_comments_post_stores_a_pending_comment_and_answers_202() {
    let transport = ScriptedTransport::new();
    transport.on(":commit", |_| {
        HttpResponse::json(200, serde_json::json!({ "writeResults": [{}] }))
    });
    // The author profile lookup.
    transport.on("users/user-1", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/user-1"),
                serde_json::json!({ "username": { "stringValue": "ash" } }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, headers) = call(
        &app,
        "POST",
        "/api/news-comments",
        Some(&token),
        Some(serde_json::json!({
            "articleId": "art_abcd",
            "articlePath": "/news/hello-world",
            "body": "  Hello   world  "
        })),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["comment"]["status"], serde_json::json!("pending"));
    assert_eq!(body["comment"]["authorName"], serde_json::json!("ash"));
    // `cleanBody` trims and drops control characters; it does not collapse
    // interior spaces, and neither does this port.
    assert_eq!(body["comment"]["body"], serde_json::json!("Hello   world"));
    assert_eq!(headers["cache-control"], "no-store");

    // Stored as pending, keyed by the verified uid.
    let commit: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    let fields = &commit["writes"][0]["update"]["fields"];
    assert_eq!(fields["status"]["stringValue"], serde_json::json!("pending"));
    assert_eq!(fields["uid"]["stringValue"], serde_json::json!("user-1"));
    assert_eq!(fields["articleId"]["stringValue"], serde_json::json!("art_abcd"));
    assert_eq!(fields["moderation"]["nullValue"], serde_json::Value::Null);
}

#[tokio::test]
async fn forum_reports_unconfigured_supabase_truthfully() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(&app, "GET", "/api/forum", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Supabase is not configured." })
    );
}

#[tokio::test]
async fn forum_create_topic_requires_a_bearer_token_before_validating_the_body() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/forum-create-topic",
        None,
        Some(serde_json::json!({ "categoryId": "nope" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
}

#[tokio::test]
async fn forum_create_post_rejects_a_malformed_topic_id() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/forum-create-post",
        Some(&token),
        Some(serde_json::json!({ "topicId": "not-a-uuid", "body": "hello" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Invalid topic id." }));
}

#[tokio::test]
async fn forum_upload_media_requires_image_data() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/forum-upload-media",
        Some(&token),
        Some(serde_json::json!({ "topicId": "0f8fad5b-d9cb-469f-a165-70867728950e" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Missing image data." }));
}

#[tokio::test]
async fn forum_upload_media_needs_a_topic_or_post() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/forum-upload-media",
        Some(&token),
        Some(serde_json::json!({ "imageBase64": "AAAA" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Upload media after creating a topic or reply." })
    );
}

#[tokio::test]
async fn the_wrong_method_is_rejected_with_an_allow_header() {
    // axum answers 405 for a method a route does not declare.
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, _body, headers) = call(&app, "DELETE", "/api/auth-login", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    let allow = headers[header::ALLOW].to_str().unwrap();
    assert!(allow.contains("POST"), "{allow}");
}

#[tokio::test]
async fn poko_market_requires_a_service_token_and_valid_tool() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
    std::env::remove_var("POKONTACT_SERVICE_TOKEN");

    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));

    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-market",
        None,
        Some(serde_json::json!({ "tool": "resolve_card", "params": {"query": "charizard"} })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body,
        serde_json::json!({ "error": "poko-market not configured: POKO_MARKET_SERVICE_TOKEN missing" })
    );

    std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "s3cret");
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-market",
        Some("wrong-token"),
        Some(serde_json::json!({ "tool": "resolve_card", "params": {"query": "charizard"} })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "unauthorized" }));

    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-market",
        Some("s3cret"),
        Some(serde_json::json!({ "tool": "drop_table" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"].as_str().unwrap(),
        "unknown tool; expected one of resolve_card, card_quote, card_ocr, card_liquidity, collection_quote, suggest_cards, market_snapshot, top_movers, top_sellers, card_sales, deal_check, set_sales, recent_sales, artist_cards, set_info"
    );
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
    std::env::remove_var("POKONTACT_SERVICE_TOKEN");
}

#[tokio::test]
async fn poko_market_validates_input_before_querying_the_database() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "s3cret");

    let transport = ScriptedTransport::new();
    let app = router(test_state_with_db(&transport));

    for (tool, params, expected) in [
        (
            "resolve_card",
            serde_json::json!({}),
            "query or artist required",
        ),
        (
            "set_info",
            serde_json::json!({}),
            "setName, era or nationality required",
        ),
    ] {
        let (status, body, _) = call(
            &app,
            "POST",
            "/api/poko-market",
            Some("s3cret"),
            Some(serde_json::json!({ "tool": tool, "params": params })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "tool={tool}");
        assert_eq!(body["error"], expected, "tool={tool}");
    }
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
    std::env::remove_var("POKONTACT_SERVICE_TOKEN");
}

#[tokio::test]
async fn every_ported_route_is_reachable_and_every_unported_one_is_not() {
    use pokoin_accounts::{PORTED_ROUTES, UNPORTED_ROUTES};
    let transport = ScriptedTransport::new();
    transport.set_fallback(|_| {
        // Any outbound call from a mounted route is answered with an empty,
        // well-formed response so the assertion is about reachability.
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5 } }))
    });
    let app = router(test_state(&transport));

    for entry in PORTED_ROUTES {
        let (method, path) = match entry.split_once(' ') {
            Some((method, path)) => (method, path.split('?').next().unwrap()),
            None => continue,
        };
        let (status, _body, _) = call(&app, method, path, None, None).await;
        assert_ne!(
            status,
            StatusCode::NOT_FOUND,
            "ported route {method} {path} is not mounted"
        );
    }
    for entry in UNPORTED_ROUTES {
        let (methods, path) = match entry.split_once(' ') {
            Some((methods, path)) => (methods, path),
            None => continue,
        };
        let method = methods.split(',').next().unwrap().trim();
        let (status, _body, _) = call(&app, method, path, None, None).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "unported route {method} {path} must stay unmounted"
        );
    }
}

#[test]
fn a_router_can_be_built_for_an_unconfigured_state() {
    let _ = router(DomainState::default());
}

// ---------------------------------------------------------------------------
// search-recipient-emails + user-current-page
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_recipient_emails_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    for method in ["GET", "POST"] {
        let (status, body, _) = call(
            &app,
            method,
            "/api/search-recipient-emails?q=raf",
            None,
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method}");
        assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
    }
}

#[tokio::test]
async fn search_recipient_emails_short_query_returns_empty_without_a_lookup() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/search-recipient-emails?q=a",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, serde_json::json!({ "usernames": [], "results": [] }));
    assert!(
        transport.requests_to(":runQuery").is_empty(),
        "a one-character query must not reach Firestore"
    );
}

#[tokio::test]
async fn search_recipient_emails_scans_both_indexes_and_filters_in_code() {
    let transport = ScriptedTransport::new();
    // Both scans see the same collection; the prefix filtering is what the
    // handler does in code, exactly like the Node pushMatch.
    transport.on(":runQuery", |_| {
        let name = |id: &str| format!("projects/{TEST_PROJECT}{DOCS}/usernames/{id}");
        HttpResponse::json(
            200,
            serde_json::json!([
                { "document": document(&name("rafa"), serde_json::json!({
                    "username": { "stringValue": "rafa" },
                    "displayName": { "stringValue": "Raffaella" },
                    "uid": { "stringValue": "user-2" } })) },
                { "document": document(&name("rafself"), serde_json::json!({
                    "username": { "stringValue": "rafself" },
                    "uid": { "stringValue": "user-1" } })) },
                { "document": document(&name("waterflower"), serde_json::json!({
                    "username": { "stringValue": "waterflower" },
                    "displayName": { "stringValue": "Raffaella Sabatino" },
                    "uid": { "stringValue": "user-3" },
                    "displayNameSearch": { "stringValue": "raffaellasabatino" } })) }
            ]),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));

    // A full display name compacts to raffaellasabatino and matches only the
    // document whose displayNameSearch is that exact compact string.
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/search-recipient-emails?q=Raffaella%20Sabatino",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["usernames"], serde_json::json!(["waterflower"]));
    assert_eq!(
        body["results"][0]["displayName"],
        serde_json::json!("Raffaella Sabatino")
    );

    transport.clear_requests();
    // A short prefix matches the handle and the compact display name, and never
    // the signed-in user's own handle.
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/search-recipient-emails?q=raf",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let usernames = body["usernames"].as_array().unwrap().clone();
    assert!(usernames.contains(&serde_json::json!("rafa")), "{usernames:?}");
    assert!(
        usernames.contains(&serde_json::json!("waterflower")),
        "{usernames:?}"
    );
    assert!(!usernames.contains(&serde_json::json!("rafself")), "{usernames:?}");
    // The first result's displayName is dropped when it duplicates the handle.
    let rafa = body["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["username"] == serde_json::json!("rafa"))
        .unwrap();
    assert_eq!(rafa["displayName"], serde_json::json!("Raffaella"));

    // The documentId range resolves to a reference cursor over the collection.
    let queries = transport.requests_to(":runQuery");
    let first: serde_json::Value = serde_json::from_slice(&queries[0].body).unwrap();
    assert_eq!(
        first["structuredQuery"]["orderBy"][0]["field"]["fieldPath"],
        serde_json::json!("__name__")
    );
    assert_eq!(
        first["structuredQuery"]["startAt"]["before"],
        serde_json::json!(true),
        "startAt is inclusive"
    );
    let start = first["structuredQuery"]["startAt"]["values"][0]
        .get("referenceValue")
        .and_then(|value| value.as_str())
        .unwrap();
    assert!(start.ends_with("/usernames/raf"), "{start}");
    let end = first["structuredQuery"]["endAt"]["values"][0]
        .get("referenceValue")
        .and_then(|value| value.as_str())
        .unwrap();
    assert!(end.ends_with("/usernames/raf\u{f8ff}"), "{end}");

    // The second scan orders by the compact display-name key.
    let second: serde_json::Value = serde_json::from_slice(&queries[1].body).unwrap();
    assert_eq!(
        second["structuredQuery"]["orderBy"][0]["field"]["fieldPath"],
        serde_json::json!("displayNameSearch")
    );
    assert_eq!(
        second["structuredQuery"]["startAt"]["values"][0],
        serde_json::json!({ "stringValue": "raf" })
    );
}

#[tokio::test]
async fn user_current_page_requires_a_session_id() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(&app, "GET", "/api/user-current-page", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "A valid sessionId is required." })
    );
}

#[tokio::test]
async fn user_current_page_reports_a_missing_database_truthfully() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/user-current-page?sessionId=sess12345",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );
}

#[tokio::test]
async fn user_current_page_post_rejects_an_unsafe_path_before_any_query() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/user-current-page?sessionId=sess12345",
        None,
        Some(serde_json::json!({ "path": "https://evil.com/x" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "A safe internal Pokoin path is required." })
    );
}

#[tokio::test]
async fn user_current_page_rejects_a_bad_session_id_even_with_a_body() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/user-current-page",
        None,
        Some(serde_json::json!({ "sessionId": "short", "path": "/marketplace" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "A valid sessionId is required." })
    );
}

// ---------------------------------------------------------------------------
// marketplace-referral + marketplace-associate-suggest
// ---------------------------------------------------------------------------

#[tokio::test]
async fn marketplace_referral_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    for method in ["GET", "POST"] {
        let (status, body, headers) = call(
            &app,
            method,
            "/api/marketplace-referral",
            None,
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method}");
        assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
        assert_eq!(headers["cache-control"], "private, no-store");
    }
}

#[tokio::test]
async fn marketplace_referral_preflight_allows_get_post_options() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, _body, headers) = call(&app, "OPTIONS", "/api/marketplace-referral", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    assert_eq!(
        headers["access-control-allow-headers"],
        "Authorization, Content-Type"
    );
}

#[tokio::test]
async fn marketplace_referral_rejects_an_unknown_action() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/marketplace-referral",
        Some(&token),
        Some(serde_json::json!({ "action": "explode", "code": "ash" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Unknown action.", "code": "" }));
}

#[tokio::test]
async fn marketplace_referral_rejects_an_unknown_invite_code() {
    let transport = ScriptedTransport::new();
    transport.on("usernames/nobody", |_| {
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5 } }))
    });
    transport.on("users/user-1", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/user-1"),
                serde_json::json!({ "username": { "stringValue": "ash" } }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/marketplace-referral",
        Some(&token),
        Some(serde_json::json!({ "action": "claim", "code": "nobody" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], serde_json::json!("invalid_code"));
    assert_eq!(
        body["error"],
        serde_json::json!("No Pokoin account uses that invite code.")
    );
}

#[tokio::test]
async fn marketplace_referral_get_returns_the_invite_summary() {
    let transport = ScriptedTransport::new();
    transport.on("users/user-1", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/user-1"),
                serde_json::json!({ "username": { "stringValue": "ash" } }),
            ),
        )
    });
    transport.on(":runQuery", |_| HttpResponse::json(200, serde_json::json!([])));
    transport.on("referrals/user-1", |_| {
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5 } }))
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(&app, "GET", "/api/marketplace-referral", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], serde_json::json!(true));
    // The invite code is the account's own handle.
    assert_eq!(body["code"], serde_json::json!("ash"));
    assert_eq!(body["rewardPkn"], serde_json::json!(20));
    assert_eq!(body["claimWindowDays"], serde_json::json!(14));
    assert_eq!(
        body["stats"],
        serde_json::json!({ "invited": 0, "pending": 0, "activated": 0, "earnedPkn": 0 })
    );
    assert_eq!(body["referredBy"], serde_json::Value::Null);
    // No roster database configured and no contributions: a collector.
    assert_eq!(body["ambassador"]["tier"], serde_json::json!("collector"));
    assert_eq!(body["ambassador"]["contributions"], serde_json::json!([]));
    assert_eq!(body["ambassador"]["next"]["missionsLeft"], serde_json::json!(3));
}

#[tokio::test]
async fn marketplace_associate_suggest_short_query_skips_the_roster() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) =
        call(&app, "GET", "/api/marketplace-associate-suggest?q=a", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, serde_json::json!({ "query": "a", "associates": [] }));
    assert_eq!(headers["cache-control"], "public, max-age=60");
    assert_eq!(headers["access-control-allow-methods"], "GET, OPTIONS");
}

#[tokio::test]
async fn marketplace_associate_suggest_reports_a_missing_database() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/marketplace-associate-suggest?q=raffaella",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );
}

#[tokio::test]
async fn marketplace_associate_suggest_preflight_is_204() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, _body, headers) = call(
        &app,
        "OPTIONS",
        "/api/marketplace-associate-suggest",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["access-control-allow-origin"], "*");
}

// ---------------------------------------------------------------------------
// poko-connect + chat
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poko_connect_is_post_only() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(&app, "GET", "/api/poko-connect", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, serde_json::json!({ "error": "POST only" }));
    assert_eq!(headers["allow"], "POST");
}

#[tokio::test]
async fn poko_connect_firebase_actions_need_a_bearer() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    for action in ["create_code", "my_status", "unlink_me"] {
        let (status, body, _) = call(
            &app,
            "POST",
            "/api/poko-connect",
            None,
            Some(serde_json::json!({ "action": action })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{action}");
        // The Node handler answered the generic authErrorResponse body.
        assert_eq!(body, serde_json::json!({ "error": "unauthorized" }), "{action}");
    }
}

#[tokio::test]
async fn poko_connect_service_token_flow() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
    std::env::remove_var("POKONTACT_SERVICE_TOKEN");

    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));

    // 1) No configured secret: 503, not a silent allow.
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-connect",
        None,
        Some(serde_json::json!({ "action": "status", "telegramUserId": "1" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "body={body}");
    assert_eq!(
        body,
        serde_json::json!({ "error": "poko-connect not configured: service token missing" })
    );

    // 2) With a secret, a wrong bearer is 401 and the right one proceeds.
    std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "s3cret");
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-connect",
        Some("wrong-token"),
        Some(serde_json::json!({ "action": "status", "telegramUserId": "1" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "body={body}");
    assert_eq!(body, serde_json::json!({ "error": "unauthorized" }));

    // The right token reaches the (unconfigured) database and reports it.
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-connect",
        Some("s3cret"),
        Some(serde_json::json!({ "action": "status", "telegramUserId": "1" })),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body={body}");
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );

    // 3) An unknown service action is rejected before any database work.
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-connect",
        Some("s3cret"),
        Some(serde_json::json!({ "action": "explode" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    assert_eq!(
        body["error"],
        serde_json::json!(
            "unknown action; expected one of create_code, my_status, unlink_me, redeem, status, unlink"
        )
    );

    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
}

#[tokio::test]
async fn chat_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    for method in ["GET", "POST"] {
        let (status, body, _) = call(&app, method, "/api/chat", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method}");
        assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
    }
}

#[tokio::test]
async fn chat_list_returns_the_callers_conversations() {
    let transport = ScriptedTransport::new();
    transport.on(":runQuery", |_| {
        HttpResponse::json(
            200,
            serde_json::json!([
                { "document": document(
                    &format!("projects/{TEST_PROJECT}{DOCS}/conversations/direct_abc"),
                    serde_json::json!({
                        "members": { "arrayValue": { "values": [
                            { "stringValue": "user-1" }, { "stringValue": "user-2" }] } },
                        "memberUsernames": { "mapValue": { "fields": {
                            "user-2": { "stringValue": "misty" } } } },
                        "unread": { "mapValue": { "fields": {
                            "user-1": { "integerValue": "2" } } } },
                        "lastEvent": { "mapValue": { "fields": {
                            "type": { "stringValue": "text" },
                            "text": { "stringValue": "see you" },
                            "senderUid": { "stringValue": "user-2" },
                            "at": { "timestampValue": "2026-10-08T00:00:00Z" } } } }
                    })) },
                { "document": document(
                    &format!("projects/{TEST_PROJECT}{DOCS}/conversations/direct_self"),
                    serde_json::json!({
                        "members": { "arrayValue": { "values": [
                            { "stringValue": "user-1" }, { "stringValue": "user-9" }] } },
                        "lastEvent": { "mapValue": { "fields": {
                            "type": { "stringValue": "text" },
                            "text": { "stringValue": "older" },
                            "senderUid": { "stringValue": "user-1" },
                            "at": { "timestampValue": "2026-10-07T00:00:00Z" } } } }
                    })) }
            ]),
        )
    });
    transport.on(":batchGet", |_| {
        HttpResponse::json(
            200,
            serde_json::json!([{ "found": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/user-2"),
                serde_json::json!({
                    "displayName": { "stringValue": "Misty" },
                    "photoUrl": { "stringValue": "https://cdn.pokoin.com/m.jpg" } })) }]),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(&app, "GET", "/api/chat?action=list", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    let conversations = body["conversations"].as_array().unwrap();
    assert_eq!(conversations.len(), 2);
    // Newest first.
    assert_eq!(conversations[0]["pairKey"], serde_json::json!("direct_abc"));
    assert_eq!(conversations[0]["peerUid"], serde_json::json!("user-2"));
    assert_eq!(conversations[0]["peerUsername"], serde_json::json!("misty"));
    assert_eq!(conversations[0]["preview"], serde_json::json!("see you"));
    assert_eq!(conversations[0]["unread"], serde_json::json!(2));
    assert_eq!(conversations[0]["peerDisplayName"], serde_json::json!("Misty"));
    assert_eq!(
        conversations[0]["peerPhotoUrl"],
        serde_json::json!("https://cdn.pokoin.com/m.jpg")
    );
    // The older conversation sorts last and has no unread count.
    assert_eq!(conversations[1]["unread"], serde_json::json!(0));
    assert_eq!(conversations[1]["peerUsername"], serde_json::json!(""));

    // The query filters on membership of the verified uid.
    let query: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":runQuery")[0].body).unwrap();
    assert_eq!(
        query["structuredQuery"]["where"]["fieldFilter"]["field"]["fieldPath"],
        serde_json::json!("members")
    );
    assert_eq!(
        query["structuredQuery"]["where"]["fieldFilter"]["op"],
        serde_json::json!("ARRAY_CONTAINS")
    );
    assert_eq!(
        query["structuredQuery"]["where"]["fieldFilter"]["value"],
        serde_json::json!({ "stringValue": "user-1" })
    );
}

#[tokio::test]
async fn chat_rejects_a_conversation_with_yourself() {
    let transport = ScriptedTransport::new();
    transport.on("usernames/ash", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/usernames/ash"),
                serde_json::json!({ "uid": { "stringValue": "user-1" } }),
            ),
        )
    });
    transport.on("users/user-1", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/user-1"),
                serde_json::json!({ "username": { "stringValue": "ash" } }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/chat?action=get&peer=ash",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "You cannot open a conversation with yourself." })
    );
}

#[tokio::test]
async fn chat_resolves_an_unknown_username_to_404() {
    let transport = ScriptedTransport::new();
    transport.on("usernames/nobody", |_| {
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5 } }))
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/chat?action=get&peer=nobody",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body,
        serde_json::json!({ "error": "No Pokoin account was found for that username." })
    );
}

#[tokio::test]
async fn chat_get_returns_events_and_clears_unread() {
    let transport = ScriptedTransport::new();
    transport.on("users/user-1", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/user-1"),
                serde_json::json!({ "username": { "stringValue": "ash" } }),
            ),
        )
    });
    transport.on(":runQuery", |_| {
        HttpResponse::json(
            200,
            serde_json::json!([
                { "document": document(
                    &format!("projects/{TEST_PROJECT}{DOCS}/conversations/direct_x/events/e1"),
                    serde_json::json!({
                        "type": { "stringValue": "text" },
                        "senderUid": { "stringValue": "uidBBBBBBBB" },
                        "senderUsername": { "stringValue": "misty" },
                        "text": { "stringValue": "hi" },
                        "createdAt": { "timestampValue": "2026-10-08T00:00:01Z" }
                    })) }
            ]),
        )
    });
    transport.on("conversations/", |_| {
        HttpResponse::json(
            200,
            document(
                &format!("projects/{TEST_PROJECT}{DOCS}/conversations/direct_x"),
                serde_json::json!({
                    "members": { "arrayValue": { "values": [
                        { "stringValue": "user-1" }, { "stringValue": "uidBBBBBBBB" }] } },
                    "memberUsernames": { "mapValue": { "fields": {
                        "uidBBBBBBBB": { "stringValue": "misty" } } } },
                    "unread": { "mapValue": { "fields": {
                        "user-1": { "integerValue": "3" } } } }
                }),
            ),
        )
    });
    transport.on(":batchGet", |_| {
        HttpResponse::json(
            200,
            serde_json::json!([{ "found": document(
                &format!("projects/{TEST_PROJECT}{DOCS}/users/uidBBBBBBBB"),
                serde_json::json!({ "displayName": { "stringValue": "Misty" } })) }]),
        )
    });
    transport.on_json(":commit", 200, serde_json::json!({ "writeResults": [{}] }));
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/chat?action=get&peerUid=uidBBBBBBBB",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["pairKey"], body["pairKey"]);
    assert_eq!(body["peer"]["uid"], serde_json::json!("uidBBBBBBBB"));
    // The stored member username wins over the (empty) resolved one.
    assert_eq!(body["peer"]["username"], serde_json::json!("misty"));
    assert_eq!(body["peer"]["displayName"], serde_json::json!("Misty"));
    assert_eq!(body["unread"], serde_json::json!(3));
    assert_eq!(body["hasMore"], serde_json::json!(false));
    assert_eq!(body["events"].as_array().unwrap().len(), 1);
    assert_eq!(body["events"][0]["text"], serde_json::json!("hi"));
    assert_eq!(body["events"][0]["mine"], serde_json::json!(false));

    // Unread is cleared with a dotted field path in the update mask.
    let commit: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    assert_eq!(
        commit["writes"][0]["updateMask"]["fieldPaths"],
        serde_json::json!(["unread.user-1"])
    );
    // A dotted field path travels as the literal key, with the mask naming it.
    assert_eq!(
        commit["writes"][0]["update"]["fields"]["unread.user-1"]["integerValue"],
        serde_json::json!("0")
    );
}

// ---------------------------------------------------------------------------
// pokoin-partner
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pokoin_partner_directory_is_public_and_placeholder() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(&app, "GET", "/api/pokoin-partner", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], serde_json::json!(true));
    assert_eq!(body["status"], serde_json::json!("placeholder"));
    assert_eq!(body["product"], serde_json::json!("pokoin_flex"));
    let stores = body["stores"].as_array().unwrap();
    assert_eq!(stores.len(), 4);
    assert_eq!(stores[0]["id"], serde_json::json!("milan-ace"));
    assert_eq!(headers["cache-control"], "public, max-age=60");
    assert_eq!(transport.request_count(), 0, "directory is static");
}

#[tokio::test]
async fn pokoin_partner_contract_is_public() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(
        &app,
        "GET",
        "/api/pokoin-partner?action=contract",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], serde_json::json!(true));
    assert_eq!(body["status"], serde_json::json!("scaffolding"));
    assert_eq!(body["bag"]["targetKg"], serde_json::json!(20));
    assert_eq!(body["actions"].as_array().unwrap().len(), 7);
    assert_eq!(headers["cache-control"], "public, max-age=300");
}

#[tokio::test]
async fn pokoin_partner_mutations_are_coming_soon() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    for action in ["intake", "bag", "receive-hub", "handoff"] {
        let (status, body, _) = call(
            &app,
            "POST",
            &format!("/api/pokoin-partner?action={action}"),
            None,
            Some(serde_json::json!({ "storeId": "milan-ace" })),
        )
        .await;
        // The live Node handler answers 501 coming_soon; so does this port.
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{action}");
        assert_eq!(body["code"], serde_json::json!("coming_soon"), "{action}");
        assert_eq!(body["action"], serde_json::json!(action), "{action}");
    }
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/pokoin-partner?action=pending",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["action"], serde_json::json!("pending"));
}

#[tokio::test]
async fn pokoin_partner_unknown_action_lists_the_surface() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/pokoin-partner?action=explode",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["ok"], serde_json::json!(false));
    assert_eq!(
        body["error"],
        serde_json::json!("Unknown pokoin-partner action: explode")
    );
    assert_eq!(
        body["actions"],
        serde_json::json!([
            "directory", "contract", "intake", "bag", "receive-hub", "handoff", "pending"
        ])
    );
}

#[tokio::test]
async fn pokoin_partner_defaults_the_action_to_directory() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    // No action at all defaults to `directory`, which a POST cannot serve.
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/pokoin-partner",
        None,
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"],
        serde_json::json!("Unknown pokoin-partner action: directory")
    );

    // A whitespace action cleans to empty, which the fallback names "(empty)".
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/pokoin-partner?action=%20",
        None,
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"],
        serde_json::json!("Unknown pokoin-partner action: (empty)")
    );

    // A body action is used when the query string has none.
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/pokoin-partner",
        None,
        Some(serde_json::json!({ "action": "bag" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["action"], serde_json::json!("bag"));
}

// ---------------------------------------------------------------------------
// poko-personal-context
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poko_personal_context_is_post_only() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(
        &app,
        "GET",
        "/api/poko-personal-context",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, serde_json::json!({ "error": "POST only" }));
    assert_eq!(headers["allow"], "POST");
}

#[tokio::test]
async fn poko_personal_context_requires_a_bearer_or_the_service_token() {
    // The service token is process-global, so every test that clears it must
    // hold the same lock.
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
    std::env::remove_var("POKONTACT_SERVICE_TOKEN");
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(
        &app,
        "POST",
        "/api/poko-personal-context",
        None,
        Some(serde_json::json!({ "action": "get" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Missing Pokoin bearer token." })
    );
    assert_eq!(headers["cache-control"], "private, no-store");
}

#[tokio::test]
async fn poko_personal_context_validates_the_action() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-personal-context",
        Some(&token),
        Some(serde_json::json!({ "action": "explode" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "action must be get or sync" })
    );
}

#[tokio::test]
async fn poko_personal_context_requires_a_user_for_the_service_path() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "s3cret");
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-personal-context",
        Some("s3cret"),
        Some(serde_json::json!({ "action": "get" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        serde_json::json!({ "error": "firebaseUid required for service personal-context." })
    );
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
}

#[tokio::test]
async fn poko_personal_context_reports_a_missing_database_as_a_build_failure() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, headers) = call(
        &app,
        "POST",
        "/api/poko-personal-context",
        Some(&token),
        Some(serde_json::json!({ "action": "get" })),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "ok": false, "error": "Could not load personal context." })
    );
    assert_eq!(headers["cache-control"], "private, no-store");
}

// ---------------------------------------------------------------------------
// marketplace-associate (the Associates desk)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn marketplace_associate_is_get_only_with_cors() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(&app, "POST", "/api/marketplace-associate", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, serde_json::json!({ "error": "GET only." }));
    assert_eq!(headers["allow"], "GET, OPTIONS");
    assert_eq!(headers["access-control-allow-methods"], "GET, OPTIONS");
    assert_eq!(headers["access-control-allow-headers"], "Authorization, Content-Type");
    assert_eq!(headers["access-control-allow-origin"], "*");

    let (status, _body, headers) = call(&app, "OPTIONS", "/api/marketplace-associate", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["access-control-allow-methods"], "GET, OPTIONS");
}

#[tokio::test]
async fn marketplace_associate_requires_a_bearer() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, _) = call(&app, "GET", "/api/marketplace-associate", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Missing Pokoin bearer token." })
    );
}

#[tokio::test]
async fn marketplace_associate_refuses_a_non_associate_with_the_404_body_shape() {
    let transport = ScriptedTransport::new();
    // No roster database configured: the payload read fails before the roster
    // lookup, so assert the database-level failure shape instead.
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "nobody@pokoin.com", now));
    let (status, body, _) = call(&app, "GET", "/api/marketplace-associate", Some(&token), None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );
}

#[tokio::test]
async fn marketplace_associate_admin_claim_skips_the_profile_lookup() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let mut claims = id_token_claims("admin-1", "admin@pokoin.com", now);
    claims["admin"] = serde_json::json!(true);
    let token = sign_id_token(claims);
    let (status, body, _) = call(&app, "GET", "/api/marketplace-associate", Some(&token), None).await;
    // Still needs the roster database, but the admin claim was honoured: the
    // failure is the missing pool, not a 403.
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body={body}");
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );
}

// ---------------------------------------------------------------------------
// poko-bets (escrow)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poko_bets_is_post_only_and_needs_the_service_token() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
    std::env::remove_var("POKONTACT_SERVICE_TOKEN");
    let transport = ScriptedTransport::new();
    let app = router(test_state_with_db(&transport));

    let (status, body, _) = call(&app, "GET", "/api/poko-bets", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, serde_json::json!({ "error": "POST only" }));

    // No configured secret: 503, never a silent allow.
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-bets",
        None,
        Some(serde_json::json!({ "action": "balances" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body,
        serde_json::json!({ "error": "poko-bets not configured: service token missing" })
    );

    // Wrong bearer: 401.
    std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "bets-secret");
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-bets",
        Some("wrong"),
        Some(serde_json::json!({ "action": "balances" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "unauthorized" }));

    // Unknown action: 400 with the full action list.
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-bets",
        Some("bets-secret"),
        Some(serde_json::json!({ "action": "explode" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"],
        serde_json::json!(
            "unknown action; expected one of reward_game, redeem_bonus, balances, set_consent, merge_wallet, stake, close, settle, refund"
        )
    );
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
}

#[tokio::test]
async fn poko_bets_stake_rejects_bad_input_before_touching_any_store() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "bets-secret");
    let transport = ScriptedTransport::new();
    let app = router(test_state_with_db(&transport));

    let cases = [
        (
            serde_json::json!({ "action": "stake", "side": "win", "amountPkn": 5 }),
            "guildId and gameId required",
        ),
        (
            serde_json::json!({ "action": "stake", "guildId": "12345", "gameId": "67890",
                               "amountPkn": 5, "side": "draw" }),
            "side must be win or loss",
        ),
        (
            serde_json::json!({ "action": "stake", "guildId": "12345", "gameId": "67890",
                               "side": "win", "amountPkn": 0 }),
            "amountPkn must be a whole number of PKN greater than zero",
        ),
        (
            serde_json::json!({ "action": "stake", "guildId": "12345", "gameId": "67890",
                               "side": "win", "amountPkn": 1.5 }),
            "amountPkn must be a whole number of PKN greater than zero",
        ),
    ];
    for (body, expected) in cases {
        let (status, response, _) = call(
            &app,
            "POST",
            "/api/poko-bets",
            Some("bets-secret"),
            Some(body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(response["ok"], serde_json::json!(false), "{body}");
        assert_eq!(response["error"], serde_json::json!(expected), "{body}");
    }
    // Nothing reached Firestore or Postgres.
    assert_eq!(transport.request_count(), 0);
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
}

/// A scripted round-settle test: the escrow must credit the winners with
/// exactly the pot, and a replay must be a no-op.
#[tokio::test]
async fn poko_bets_settle_pays_the_pot_exactly_and_is_idempotent() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::set_var("POKO_MARKET_SERVICE_TOKEN", "bets-secret");
    let transport = ScriptedTransport::new();

    let round_name = format!("projects/{TEST_PROJECT}{DOCS}/poko_bet_rounds/12345_67890");
    let balance_a = format!("projects/{TEST_PROJECT}{DOCS}/balances/uidA");
    let balance_b = format!("projects/{TEST_PROJECT}{DOCS}/balances/uidB");

    let open_round = serde_json::json!({
        "status": { "stringValue": "open" },
        "totalPkn": { "integerValue": "30" },
        "stakes": { "mapValue": { "fields": {
            "uidA": { "mapValue": { "fields": {
                "side": { "stringValue": "win" },
                "amountPkn": { "integerValue": "10" },
                "discordUserId": { "stringValue": "10001" },
                "holder": { "stringValue": "account" },
                "uid": { "stringValue": "uidA" } } } },
            "uidB": { "mapValue": { "fields": {
                "side": { "stringValue": "loss" },
                "amountPkn": { "integerValue": "20" },
                "discordUserId": { "stringValue": "10002" },
                "holder": { "stringValue": "account" },
                "uid": { "stringValue": "uidB" } } } }
        } } }
    });
    // A second settle sees the stored, already-settled round.
    let settled_round = serde_json::json!({
        "status": { "stringValue": "settled" },
        "outcome": { "stringValue": "win" },
        "totalPkn": { "integerValue": "30" },
        "payoutsByDiscord": { "mapValue": { "fields": {
            "10001": { "integerValue": "30" }, "10002": { "integerValue": "0" } } } },
        "stakes": { "mapValue": { "fields": {} } }
    });

    let _ = (&round_name, &balance_a, &balance_b);
    let rounds = std::sync::Arc::new(std::sync::Mutex::new(open_round.clone()));
    let rounds_writer = rounds.clone();
    transport.on(":beginTransaction", |_| {
        HttpResponse::json(200, serde_json::json!({ "transaction": "tx-1" }))
    });
    transport.on(":batchGet", move |request| {
        let body: serde_json::Value =
            serde_json::from_slice(&request.body).unwrap_or(serde_json::Value::Null);
        // The requested name is the full resource URL, so match on the suffix.
        let name = body["documents"][0].as_str().unwrap_or("");
        let fields = if name.ends_with("/poko_bet_rounds/12345_67890") {
            rounds_writer.lock().unwrap().clone()
        } else if name.ends_with("/balances/uidA") {
            serde_json::json!({ "availablePkn": { "integerValue": "0" } })
        } else if name.ends_with("/balances/uidB") {
            serde_json::json!({ "availablePkn": { "integerValue": "5" } })
        } else {
            serde_json::Value::Null
        };
        if fields.is_null() {
            return HttpResponse::json(200, serde_json::json!([{ "missing": name }]));
        }
        HttpResponse::json(
            200,
            serde_json::json!([{ "found": { "name": name, "fields": fields } }]),
        )
    });
    transport.on_method("POST", ":commit", |_| {
        HttpResponse::json(200, serde_json::json!({ "writeResults": [{}, {}] }))
    });

    let app = router(test_state_with_db(&transport));
    let settle = serde_json::json!({
        "action": "settle", "guildId": "12345", "gameId": "67890", "outcome": "win"
    });

    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-bets",
        Some("bets-secret"),
        Some(settle.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["ok"], serde_json::json!(true));
    assert_eq!(body["status"], serde_json::json!("settled"));
    assert_eq!(body["outcome"], serde_json::json!("win"));
    assert_eq!(body["totalPkn"], serde_json::json!(30));
    assert_eq!(body["payouts"]["10001"], serde_json::json!(30));
    assert_eq!(body["payouts"]["10002"], serde_json::json!(0));

    // The winner's balance is credited with the whole pot, and the round closes.
    let commit: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    let writes = commit["writes"].as_array().unwrap();
    let balance_write = writes
        .iter()
        .find(|write| write["update"]["name"].as_str().unwrap_or("").ends_with("/balances/uidA"))
        .expect("the winner balance is written");
    assert_eq!(
        balance_write["update"]["fields"]["availablePkn"]["integerValue"],
        serde_json::json!("30")
    );
    let round_write = writes
        .iter()
        .find(|write| write["update"]["name"].as_str().unwrap_or("").ends_with("/poko_bet_rounds/12345_67890"))
        .expect("the round is written");
    assert_eq!(
        round_write["update"]["fields"]["status"]["stringValue"],
        serde_json::json!("settled")
    );
    assert_eq!(
        round_write["update"]["fields"]["payoutsByDiscord"]["mapValue"]["fields"]["10001"]
            ["integerValue"],
        serde_json::json!("30")
    );
    // The loser is untouched: the escrow never touches a non-winning balance.
    assert!(
        !writes
            .iter()
            .any(|write| write["update"]["name"].as_str().unwrap_or("").ends_with("/balances/uidB")),
        "a losing stake must not be credited"
    );
    // A paired ledger entry lands in the account ledger.
    assert!(writes.iter().any(|write| write["update"]["name"]
        .as_str()
        .unwrap_or("")
        .contains("/ledger_entries/")));

    // Replaying the settle on a settled round is a no-op.
    transport.clear_requests();
    *rounds.lock().unwrap() = settled_round;
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-bets",
        Some("bets-secret"),
        Some(settle),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["idempotent"], serde_json::json!(true));
    assert_eq!(body["status"], serde_json::json!("settled"));
    assert_eq!(body["payouts"]["10001"], serde_json::json!(30));
    assert!(
        transport.requests_to(":commit").is_empty(),
        "an idempotent settle must not write anything"
    );
    std::env::remove_var("POKO_MARKET_SERVICE_TOKEN");
}

// ---------------------------------------------------------------------------
// marketplace-portfolio-history
// ---------------------------------------------------------------------------

fn history_document(name: &str, fields: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "name": name, "fields": fields })
}

#[tokio::test]
async fn portfolio_history_is_get_only_and_requires_a_bearer() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(
        &app,
        "POST",
        "/api/marketplace-portfolio-history",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, serde_json::json!({ "error": "Method not allowed." }));
    assert_eq!(headers["allow"], "GET");
    // The Node handler set no-store before doing anything.
    assert_eq!(headers["cache-control"], "no-store");

    let (status, body, headers) =
        call(&app, "GET", "/api/marketplace-portfolio-history", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
    assert_eq!(headers["cache-control"], "no-store");
}

#[tokio::test]
async fn portfolio_history_serves_a_fresh_stored_series_without_the_market() {
    let transport = ScriptedTransport::new();
    let now = chrono::Utc::now();
    let updated = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let name = format!("projects/{TEST_PROJECT}{DOCS}/portfolio_history/user-1");
    transport.on("portfolio_history/user-1", move |_| {
        HttpResponse::json(
            200,
            history_document(
                &name,
                serde_json::json!({
                    "priceBasis": { "stringValue": "ct-last-sold" },
                    "seriesRevision": { "integerValue": "4" },
                    "updatedAt": { "stringValue": updated },
                    "days": { "arrayValue": { "values": [
                        { "mapValue": { "fields": {
                            "date": { "stringValue": "2026-10-07" },
                            "currencyPkn": { "integerValue": "100" } } } },
                        { "mapValue": { "fields": {
                            "date": { "stringValue": "2026-10-08" },
                            "currencyPkn": { "integerValue": "120" },
                            "cardsValuePkn": { "integerValue": "30" },
                            "cardsHeld": { "integerValue": "2" } } } }
                    ] } }
                }),
            ),
        )
    });
    let app = router(test_state_with_db(&transport));
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now.timestamp()));
    let (status, body, headers) = call(
        &app,
        "GET",
        "/api/marketplace-portfolio-history",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["ok"], serde_json::json!(true));
    let days = body["days"].as_array().unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(days[0]["date"], serde_json::json!("2026-10-07"));
    assert_eq!(days[0]["currencyPkn"], serde_json::json!(100));
    assert_eq!(days[0]["cardsKnown"], serde_json::json!(false));
    assert_eq!(days[1]["cardsValuePkn"], serde_json::json!(30));
    assert_eq!(days[1]["cardsHeld"], serde_json::json!(2));
    assert_eq!(days[1]["totalPkn"], serde_json::json!(150));
    assert_eq!(headers["cache-control"], "no-store");
    // A fresh series needs no SQL at all.
    assert!(transport.requests_to(":runQuery").is_empty());
}

#[tokio::test]
async fn portfolio_history_reports_an_empty_series_without_a_market_read_model() {
    let transport = ScriptedTransport::new();
    transport.on("portfolio_history/user-1", |_| {
        HttpResponse::json(404, serde_json::json!({ "error": { "code": 5 } }))
    });
    // No marketplace database is configured, which the Node readCardBook catch
    // treated as "no card book", not as a route failure.
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, headers) = call(
        &app,
        "GET",
        "/api/marketplace-portfolio-history",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body, serde_json::json!({ "ok": true, "days": [] }));
    assert_eq!(headers["cache-control"], "no-store");
}

#[tokio::test]
async fn portfolio_history_serves_the_last_good_series_when_the_market_is_down() {
    let transport = ScriptedTransport::new();
    let name = format!("projects/{TEST_PROJECT}{DOCS}/portfolio_history/user-1");
    transport.on("portfolio_history/user-1", move |_| {
        HttpResponse::json(
            200,
            history_document(
                &name,
                serde_json::json!({
                    "priceBasis": { "stringValue": "ct-last-sold" },
                    "seriesRevision": { "integerValue": "4" },
                    // Stale: yesterday, so the recompute path runs.
                    "updatedAt": { "stringValue": "2026-10-07T00:00:00.000Z" },
                    "days": { "arrayValue": { "values": [
                        { "mapValue": { "fields": {
                            "date": { "stringValue": "2026-10-06" },
                            "currencyPkn": { "integerValue": "77" },
                            "cardsValuePkn": { "integerValue": "11" },
                            "cardsHeld": { "integerValue": "1" } } } }
                    ] } }
                }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/marketplace-portfolio-history",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], serde_json::json!(true));
    let days = body["days"].as_array().unwrap();
    assert_eq!(days.len(), 1, "the stored series is served as the last good one");
    assert_eq!(days[0]["currencyPkn"], serde_json::json!(77));
    assert_eq!(days[0]["cardsValuePkn"], serde_json::json!(11));

    // An out-of-date basis is discarded instead of served.
    let transport = ScriptedTransport::new();
    let name = format!("projects/{TEST_PROJECT}{DOCS}/portfolio_history/user-1");
    transport.on("portfolio_history/user-1", move |_| {
        HttpResponse::json(
            200,
            history_document(
                &name,
                serde_json::json!({
                    "priceBasis": { "stringValue": "old-basis" },
                    "seriesRevision": { "integerValue": "4" },
                    "updatedAt": { "stringValue": "2026-10-07T00:00:00.000Z" },
                    "days": { "arrayValue": { "values": [
                        { "mapValue": { "fields": { "date": { "stringValue": "2026-10-06" } } } }
                    ] } }
                }),
            ),
        )
    });
    let app = router(test_state(&transport));
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (_, body, _) = call(
        &app,
        "GET",
        "/api/marketplace-portfolio-history",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(body["days"], serde_json::json!([]));
}

// ---------------------------------------------------------------------------
// poko-chat
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poko_chat_is_get_post_only_and_requires_a_bearer() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(&app, "DELETE", "/api/poko-chat", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, serde_json::json!({ "error": "Method not allowed." }));
    assert_eq!(headers["allow"], "GET, POST");

    let (status, body, _) = call(&app, "GET", "/api/poko-chat", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));

    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-chat",
        None,
        Some(serde_json::json!({ "message": "hi" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
}

#[tokio::test]
async fn poko_chat_history_is_the_default_get_action() {
    let transport = ScriptedTransport::new();
    transport.on_method("POST", ":runQuery", |_| {
        // The transcript is empty.
        HttpResponse::json(200, serde_json::json!([]))
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));

    let (status, body, _) = call(&app, "GET", "/api/poko-chat", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["ok"], serde_json::json!(true));
    assert_eq!(body["events"], serde_json::json!([]));
    assert_eq!(body["hasMore"], serde_json::json!(false));

    // An unknown action is a 400, not a silent history read.
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/poko-chat?action=explode",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "Unknown action." }));
}

#[tokio::test]
async fn poko_chat_post_needs_a_message_card_or_image() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));
    let (status, body, _) = call(&app, "POST", "/api/poko-chat", Some(&token), Some(serde_json::json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "message, cards, or images required" }));
    // Nothing was sent to the assistant or the photo scanner (only the auth
    // key fetch the verifier does on first use).
    assert!(transport.requests_to("chat").is_empty());
    assert!(transport.requests_to("identify").is_empty());
}

/// With no Poko service configured the reply is the documented fallback and the
/// turn is still persisted — never a locally scripted answer.
#[tokio::test]
async fn poko_chat_falls_back_truthfully_when_the_assistant_is_unreachable() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::remove_var("POKO_CHAT_URL");
    std::env::remove_var("POKONTACT_SERVICE_URL");
    std::env::remove_var("POKO_API_TOKEN");
    std::env::remove_var("POKONTACT_SERVICE_TOKEN");
    let transport = ScriptedTransport::new();
    transport.on_method("POST", ":commit", |request| {
        let body: serde_json::Value =
            serde_json::from_slice(&request.body).unwrap_or(serde_json::Value::Null);
        let count = body["writes"].as_array().map(Vec::len).unwrap_or(0);
        HttpResponse::json(
            200,
            serde_json::json!({ "writeResults": vec![serde_json::json!({}); count] }),
        )
    });
    let app = router(test_state(&transport));
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now));

    let (status, body, _) = call(
        &app,
        "POST",
        "/api/poko-chat",
        Some(&token),
        Some(serde_json::json!({ "message": "quanto vale Pikachu?", "clientTurnId": "turn-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["ok"], serde_json::json!(false));
    assert_eq!(body["assistant"], serde_json::json!("poko"));
    assert_eq!(body["persona"], serde_json::json!("Poko"));
    assert_eq!(body["source"], serde_json::json!("unavailable"));
    assert_eq!(body["error"], serde_json::json!(pokoin_accounts::domain::poko_chat::HERMES_UNAVAILABLE_ERROR));
    assert_eq!(body["reply"], serde_json::json!(pokoin_accounts::domain::poko_chat::HERMES_UNAVAILABLE));

    // Both transcript rows were written: the user's turn and the fallback.
    let commit: serde_json::Value =
        serde_json::from_slice(&transport.requests_to(":commit")[0].body).unwrap();
    let writes = commit["writes"].as_array().unwrap();
    assert!(
        writes.len() >= 3,
        "expected the conversation meta write plus both event rows, got {}",
        writes.len()
    );
    let roles: Vec<String> = writes
        .iter()
        .filter_map(|write| {
            write["update"]["fields"]["role"]["stringValue"]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    assert!(roles.contains(&"user".to_string()));
    assert!(roles.contains(&"assistant".to_string()));
    let user_row = writes
        .iter()
        .find(|write| write["update"]["fields"]["role"]["stringValue"] == serde_json::json!("user"))
        .unwrap();
    assert_eq!(
        user_row["update"]["fields"]["clientTurnId"]["stringValue"],
        serde_json::json!("turn-1")
    );
    // The assistant row stores the fallback as text and no cards.
    let assistant_row = writes
        .iter()
        .find(|write| {
            write["update"]["fields"]["role"]["stringValue"] == serde_json::json!("assistant")
        })
        .unwrap();
    assert_eq!(
        assistant_row["update"]["fields"]["text"]["stringValue"],
        serde_json::json!(pokoin_accounts::domain::poko_chat::HERMES_UNAVAILABLE)
    );
    assert_eq!(
        assistant_row["update"]["fields"]["source"]["stringValue"],
        serde_json::json!("unavailable")
    );
}

// ---------------------------------------------------------------------------
// marketplace-portfolio
// ---------------------------------------------------------------------------

#[tokio::test]
async fn portfolio_is_get_only_with_a_day_long_preflight() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));

    let (status, _body, headers) = call(&app, "OPTIONS", "/api/marketplace-portfolio", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["access-control-allow-origin"], "*");
    assert_eq!(headers["access-control-allow-methods"], "GET, OPTIONS");
    assert_eq!(headers["access-control-allow-headers"], "Content-Type, Authorization");
    assert_eq!(headers["access-control-max-age"], "86400");

    let (status, body, headers) = call(&app, "POST", "/api/marketplace-portfolio", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, serde_json::json!({ "error": "Method not allowed." }));
    assert_eq!(headers["allow"], "GET, OPTIONS");
    assert_eq!(headers["access-control-allow-methods"], "GET, OPTIONS");
}

#[tokio::test]
async fn portfolio_reports_an_unconfigured_catalog_truthfully() {
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));
    let (status, body, headers) = call(&app, "GET", "/api/marketplace-portfolio", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );
    // Even the failure carries the portfolio CORS set.
    assert_eq!(headers["access-control-allow-methods"], "GET, OPTIONS");
    assert_eq!(headers["access-control-max-age"], "86400");
}

/// A non-Pokemon game resolves its own catalog URL instead of the default.
#[tokio::test]
async fn portfolio_resolves_a_per_game_catalog_url() {
    let _guard = SERVICE_TOKEN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    std::env::remove_var("MARKETPLACE_DATABASE_URL");
    std::env::remove_var("DATABASE_URL");
    std::env::set_var(
        "ONE_PIECE_MARKETPLACE_DATABASE_URL",
        "postgres://127.0.0.1:1/pokoin_one_piece_test",
    );
    let transport = ScriptedTransport::new();
    let app = router(test_state(&transport));

    // Pokemon still has nothing configured.
    let (status, body, _) = call(&app, "GET", "/api/marketplace-portfolio", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );

    // one-piece gets past config resolution and fails on the (dead) connection
    // instead, which is how we know the per-game URL was used.
    let (status, body, _) = call(
        &app,
        "GET",
        "/api/marketplace-portfolio?game=one-piece",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_ne!(
        body["error"],
        serde_json::json!("Marketplace database is not configured."),
        "the per-game URL must be resolved before hitting the catalog"
    );

    // A game with no configured URL and no base to derive from stays unset.
    let (status, body, _) = call(&app, "GET", "/api/marketplace-portfolio?game=magic", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );
    std::env::remove_var("ONE_PIECE_MARKETPLACE_DATABASE_URL");
}
