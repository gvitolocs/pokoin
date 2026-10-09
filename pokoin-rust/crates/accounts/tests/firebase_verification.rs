//! Firebase ID token verification, JWKS caching, the password-email gate,
//! custom-token minting and the cached OAuth 2.0 exchange.
//!
//! Everything runs against the scripted transport with a generated RSA key, so
//! the RS256 signature path is exercised for real with no network.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use pokoin_accounts::firebase::{FirebaseVerifier, ServiceAccount, TokenVerifier, CUSTOM_TOKEN_AUDIENCE};
use pokoin_accounts::http::{HttpResponse, SharedTransport};

fn verifier(transport: &Arc<ScriptedTransport>) -> FirebaseVerifier {
    FirebaseVerifier::new(&test_config(), transport.as_transport())
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[tokio::test]
async fn a_valid_id_token_verifies_to_its_claims() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let token = sign_id_token(id_token_claims("user-1", "Ash@Pokoin.com", now()));
    let claims = verifier.verify(&token).await.expect("token verifies");
    assert_eq!(claims.uid, "user-1");
    // Emails are lowercased, matching `admin.auth().verifyIdToken`.
    assert_eq!(claims.email, "ash@pokoin.com");
    assert!(claims.email_verified);
    assert_eq!(claims.firebase.sign_in_provider, "password");
}

#[tokio::test]
async fn an_expired_token_is_rejected() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let mut claims = id_token_claims("user-1", "a@b.co", now() - 7200);
    claims["exp"] = serde_json::json!(now() - 3600);
    let token = sign_id_token(claims);
    let error = verifier.verify(&token).await.unwrap_err();
    assert!(
        error.to_string().to_ascii_lowercase().contains("expired"),
        "{error}"
    );
}

#[tokio::test]
async fn a_token_issued_in_the_future_is_rejected() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let mut claims = id_token_claims("user-1", "a@b.co", now() + 7200);
    claims["iat"] = serde_json::json!(now() + 7200);
    let token = sign_id_token(claims);
    assert!(verifier.verify(&token).await.is_err());
}

#[tokio::test]
async fn the_wrong_audience_is_rejected() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let mut claims = id_token_claims("user-1", "a@b.co", now());
    claims["aud"] = serde_json::json!("someone-else");
    assert!(verifier.verify(&sign_id_token(claims)).await.is_err());
}

#[tokio::test]
async fn the_wrong_issuer_is_rejected() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let mut claims = id_token_claims("user-1", "a@b.co", now());
    claims["iss"] = serde_json::json!("https://securetoken.google.com/other");
    assert!(verifier.verify(&sign_id_token(claims)).await.is_err());
}

#[tokio::test]
async fn a_token_without_a_subject_is_rejected() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let mut claims = id_token_claims("user-1", "a@b.co", now());
    claims.as_object_mut().unwrap().remove("sub");
    assert!(verifier.verify(&sign_id_token(claims)).await.is_err());
}

#[tokio::test]
async fn a_token_signed_by_another_key_is_rejected() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);
    // A syntactically valid RS256 JWT with a bogus signature.
    let forged = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJzdWIiOiJ1In0.AAAA";
    assert!(verifier.verify(forged).await.is_err());
}

#[tokio::test]
async fn the_jwks_is_cached_between_verifications() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    for _ in 0..3 {
        let token = sign_id_token(id_token_claims("user-1", "a@b.co", now()));
        verifier.verify(&token).await.expect("verifies");
    }
    assert_eq!(
        transport.requests_to("/jwks").len(),
        1,
        "the JWKS must be fetched once and cached"
    );
}

#[tokio::test]
async fn an_unknown_kid_forces_one_refetch() {
    let transport = ScriptedTransport::new();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = calls.clone();
    transport.on("https://test.local/jwks", move |_| {
        let call = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if call == 0 {
            // First fetch: a key set that does not contain the token's kid.
            HttpResponse::json(
                200,
                serde_json::json!({ "keys": [{ "kty": "RSA", "kid": "rotated-out", "n": TEST_KEY_N, "e": TEST_KEY_E }] }),
            )
        } else {
            jwks_response()
        }
    });
    let verifier = verifier(&transport);

    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now()));
    verifier
        .verify(&token)
        .await
        .expect("a rotated key id must trigger a refetch");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_jwks_outage_is_reported_as_unavailable() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| {
        HttpResponse::json(503, serde_json::json!({ "error": "down" }))
    });
    let verifier = verifier(&transport);
    let token = sign_id_token(id_token_claims("user-1", "a@b.co", now()));
    let error = verifier.verify(&token).await.unwrap_err();
    assert!(matches!(
        error,
        pokoin_accounts::firebase::AuthError::Unavailable
    ));
}

#[tokio::test]
async fn an_empty_project_id_is_configuration_not_a_token_failure() {
    let transport = ScriptedTransport::new();
    let mut config = test_config();
    config.project_id = String::new();
    let verifier = FirebaseVerifier::new(&config, transport.as_transport());
    let error = verifier.verify("anything").await.unwrap_err();
    assert!(matches!(
        error,
        pokoin_accounts::firebase::AuthError::Unconfigured(_)
    ));
}

#[tokio::test]
async fn the_password_gate_blocks_unverified_email_signups_only_when_enabled() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let mut claims = id_token_claims("user-1", "a@b.co", now());
    claims["email_verified"] = serde_json::json!(false);
    let token = sign_id_token(claims);
    let decoded = verifier.verify(&token).await.expect("signature is valid");

    // The token itself verifies; the gate is a separate authorization step.
    assert!(decoded.password_account_requires_verification());
    let error = decoded
        .assert_active_password_account(true)
        .expect_err("unverified password accounts are blocked");
    assert_eq!(error.status(), axum::http::StatusCode::FORBIDDEN);
    assert_eq!(error.code(), Some("auth/pokoin-email-not-verified"));
    // With the flag off (the production default today) it is allowed.
    assert!(decoded.assert_active_password_account(false).is_ok());
}

#[tokio::test]
async fn the_pok_email_verified_claim_satisfies_the_gate() {
    let transport = ScriptedTransport::new();
    transport.on("https://test.local/jwks", |_| jwks_response());
    let verifier = verifier(&transport);

    let mut claims = id_token_claims("user-1", "a@b.co", now());
    claims["email_verified"] = serde_json::json!(false);
    claims["pok_email_verified"] = serde_json::json!(true);
    let decoded = verifier
        .verify(&sign_id_token(claims))
        .await
        .expect("verifies");
    assert!(!decoded.password_account_requires_verification());
    assert!(decoded.assert_active_password_account(true).is_ok());
}

#[tokio::test]
async fn google_and_wallet_providers_are_not_gated() {
    for provider in ["google.com", "custom"] {
        let transport = ScriptedTransport::new();
        transport.on("https://test.local/jwks", |_| jwks_response());
        let verifier = verifier(&transport);
        let mut claims = id_token_claims("user-1", "a@b.co", now());
        claims["email_verified"] = serde_json::json!(false);
        claims["firebase"]["sign_in_provider"] = serde_json::json!(provider);
        let decoded = verifier.verify(&sign_id_token(claims)).await.unwrap();
        assert!(
            !decoded.password_account_requires_verification(),
            "{provider} must not be gated"
        );
    }
}

// ---------------------------------------------------------------------------
// Service account: OAuth exchange and custom tokens
// ---------------------------------------------------------------------------

fn service_account(transport: &Arc<ScriptedTransport>) -> ServiceAccount {
    ServiceAccount::new(&test_config(), transport.as_transport()).expect("test key is usable")
}

#[tokio::test]
async fn the_oauth_exchange_sends_a_signed_jwt_bearer_assertion() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        "https://test.local/oauth",
        200,
        serde_json::json!({ "access_token": "access-1", "expires_in": 3600 }),
    );
    let account = service_account(&transport);
    let token = account.access_token().await.expect("token exchange works");
    assert_eq!(token, "access-1");

    let requests = transport.requests_to("/oauth");
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.header_value("content-type"),
        Some("application/x-www-form-urlencoded")
    );

    // The assertion must verify against the same key and carry the right claims.
    let body = String::from_utf8_lossy(&request.body).to_string();
    assert!(body.starts_with("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="));
    let assertion = body.split("assertion=").nth(1).unwrap();
    let assertion = assertion.replace("%2E", ".").replace("%2D", "-").replace("%5F", "_");
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&["https://test.local/oauth"]);
    validation.set_issuer(&[TEST_CLIENT_EMAIL]);
    validation.set_required_spec_claims(&["exp", "iat", "iss", "aud"]);
    let key = jsonwebtoken::DecodingKey::from_rsa_components(TEST_KEY_N, TEST_KEY_E).unwrap();
    let decoded = jsonwebtoken::decode::<serde_json::Value>(&assertion, &key, &validation)
        .expect("the assertion is a valid RS256 JWT");
    let scope = decoded.claims["scope"].as_str().unwrap();
    assert!(scope.contains("https://www.googleapis.com/auth/datastore"));
    assert!(scope.contains("https://www.googleapis.com/auth/identitytoolkit"));
    let exp = decoded.claims["exp"].as_i64().unwrap();
    let iat = decoded.claims["iat"].as_i64().unwrap();
    assert_eq!(exp - iat, 3600);
}

#[tokio::test]
async fn the_access_token_is_cached_until_it_almost_expires() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        "https://test.local/oauth",
        200,
        serde_json::json!({ "access_token": "access-1", "expires_in": 3600 }),
    );
    let account = service_account(&transport);
    for _ in 0..5 {
        assert_eq!(account.access_token().await.unwrap(), "access-1");
    }
    assert_eq!(transport.requests_to("/oauth").len(), 1);
}

#[tokio::test]
async fn a_short_lived_token_is_not_cached_past_its_lifetime() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        "https://test.local/oauth",
        200,
        serde_json::json!({ "access_token": "short", "expires_in": 120 }),
    );
    let account = service_account(&transport);
    let _ = account.access_token().await.unwrap();
    // 120s minus the 60s safety margin leaves a positive TTL, so it is reused.
    assert_eq!(account.access_token().await.unwrap(), "short");
    // Explicit invalidation forces a new exchange.
    account.invalidate_access_token().await;
    let _ = account.access_token().await.unwrap();
    assert_eq!(transport.requests_to("/oauth").len(), 2);
}

#[tokio::test]
async fn an_oauth_failure_is_reported_and_not_cached() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        "https://test.local/oauth",
        400,
        serde_json::json!({ "error": "invalid_grant" }),
    );
    let account = service_account(&transport);
    assert!(account.access_token().await.is_err());
    assert!(account.access_token().await.is_err());
    assert_eq!(transport.requests_to("/oauth").len(), 2);
}

#[tokio::test]
async fn a_custom_token_carries_the_uid_and_nested_claims() {
    let transport = ScriptedTransport::new();
    let account = service_account(&transport);
    let token = account
        .create_custom_token(
            "wallet:0xabc",
            Some(serde_json::json!({ "walletAddress": "0xabc", "provider": "metamask" })),
        )
        .expect("minting works");

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    // A custom token is signed for the Identity Toolkit audience, not the app.
    validation.set_audience(&[CUSTOM_TOKEN_AUDIENCE]);
    validation.set_issuer(&[TEST_CLIENT_EMAIL]);
    validation.validate_exp = true;
    let key = jsonwebtoken::DecodingKey::from_rsa_components(TEST_KEY_N, TEST_KEY_E).unwrap();
    let decoded = jsonwebtoken::decode::<serde_json::Value>(&token, &key, &validation)
        .expect("the custom token is a valid RS256 JWT");
    assert_eq!(decoded.claims["uid"], serde_json::json!("wallet:0xabc"));
    assert_eq!(decoded.claims["sub"], serde_json::json!(TEST_CLIENT_EMAIL));
    assert_eq!(
        decoded.claims["claims"]["provider"],
        serde_json::json!("metamask")
    );
}

#[tokio::test]
async fn a_custom_token_without_a_uid_is_refused() {
    let transport = ScriptedTransport::new();
    let account = service_account(&transport);
    assert!(account.create_custom_token("   ", None).is_err());
}

#[tokio::test]
async fn a_service_account_without_credentials_reports_configuration() {
    let transport = ScriptedTransport::new();
    let mut config = test_config();
    config.private_key_pem = String::new();
    let error = ServiceAccount::new(&config, transport.as_transport())
        .err()
        .expect("an unusable credential must be reported");
    assert!(matches!(
        error,
        pokoin_accounts::firebase::AuthError::Unconfigured(_)
    ));
}

#[tokio::test]
async fn an_unusable_private_key_reports_configuration() {
    let transport = ScriptedTransport::new();
    let mut config = test_config();
    config.private_key_pem = "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----".into();
    let error = ServiceAccount::new(&config, transport.as_transport())
        .err()
        .expect("an unusable credential must be reported");
    assert!(matches!(
        error,
        pokoin_accounts::firebase::AuthError::Unconfigured(_)
    ));
}

#[test]
fn test_harness_timeout_is_documented() {
    assert_eq!(test_timeout(), Duration::from_secs(2));
    let _: SharedTransport = ScriptedTransport::new().as_transport();
}
