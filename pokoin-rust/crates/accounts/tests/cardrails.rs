//! Card Rails sign-in contract: `POST /api/cardrails-authorize` mints a
//! single-use PKCE code for the signed-in Pokoin user, and
//! `POST /api/cardrails-token` exchanges it exactly once for the identity.

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use pokoin_accounts::domain::cardrails::{
    MemoryCardRailsCodeStore, NewCardRailsCode, REDIRECT_SCHEME,
};
use pokoin_accounts::{router, DomainState};
use tower::ServiceExt;

const CLIENT_SECRET: &str = "cardrails-client-secret";
const VALID_STATE: &str = "0123456789abcdef";
// The PKCE S256 challenge of VERIFIER (RFC 7636 appendix B).
const VALID_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

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

/// A state with the client secret configured and the in-memory code store
/// injected, so the full authorize → token flow runs without a database.
fn cardrails_state(transport: &Arc<ScriptedTransport>, secret: Option<&str>) -> DomainState {
    script_firebase(transport);
    let mut config = test_config();
    config.cardrails_client_secret = secret.map(str::to_string);
    let state = DomainState::with_transport(config, transport.as_transport());
    state.with_cardrails_store(Some(Arc::new(MemoryCardRailsCodeStore::new())))
}

/// The JWKS/OAuth answers the verifier needs, as `common::test_state` scripts
/// them for the other suites.
fn script_firebase(transport: &Arc<ScriptedTransport>) {
    transport.on_json(
        "https://test.local/oauth",
        200,
        serde_json::json!({ "access_token": "test-access-token", "expires_in": 3600 }),
    );
    transport.on("https://test.local/jwks", |_| jwks_response());
}

fn authorize_body() -> serde_json::Value {
    serde_json::json!({
        "state": VALID_STATE,
        "code_challenge": VALID_CHALLENGE,
        "code_challenge_method": "S256",
    })
}

async fn authorize(app: &axum::Router) -> (StatusCode, serde_json::Value, axum::http::HeaderMap) {
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "ash@pokoin.com", now));
    call(app, "POST", "/api/cardrails-authorize", Some(&token), Some(authorize_body())).await
}

/// The stored record for the code an authorize response minted.
fn stored_record(code: &str) -> NewCardRailsCode {
    NewCardRailsCode {
        code_hash: pokoin_accounts::domain::cardrails::code_hash(code),
        uid: "user-1".into(),
        email: "ash@pokoin.com".into(),
        email_verified: true,
        code_challenge: VALID_CHALLENGE.into(),
        expires_at: chrono::Utc::now() + chrono::Duration::seconds(120),
    }
}

#[tokio::test]
async fn authorize_requires_a_bearer_token() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/cardrails-authorize",
        None,
        Some(authorize_body()),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, serde_json::json!({ "error": "Missing Pokoin bearer token." }));
}

#[tokio::test]
async fn authorize_preflight_answers_204_with_cors() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let (status, _body, headers) = call(&app, "OPTIONS", "/api/cardrails-authorize", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["access-control-allow-origin"], "*");
    assert_eq!(headers["access-control-allow-methods"], "POST, OPTIONS");
}

#[tokio::test]
async fn authorize_validates_the_pkce_parameters_before_any_storage() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));

    for body in [
        serde_json::json!({ "state": "short", "code_challenge": VALID_CHALLENGE, "code_challenge_method": "S256" }),
        serde_json::json!({ "state": VALID_STATE, "code_challenge": "tooshort", "code_challenge_method": "S256" }),
        serde_json::json!({ "state": VALID_STATE, "code_challenge": VALID_CHALLENGE, "code_challenge_method": "plain" }),
        serde_json::json!({ "state": VALID_STATE, "code_challenge": VALID_CHALLENGE }),
        serde_json::json!({}),
    ] {
        let now = chrono::Utc::now().timestamp();
        let token = sign_id_token(id_token_claims("user-1", "ash@pokoin.com", now));
        let (status, body_json, _) = call(
            &app,
            "POST",
            "/api/cardrails-authorize",
            Some(&token),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body_json}");
        assert_eq!(body_json, serde_json::json!({ "error": "invalid_request" }));
    }
}

#[tokio::test]
async fn authorize_requires_an_email_claim() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let now = chrono::Utc::now().timestamp();
    // Anonymous-style token: no email claim at all.
    let mut claims = id_token_claims("user-1", "", now);
    claims.as_object_mut().unwrap().remove("email");
    let token = sign_id_token(claims);
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/cardrails-authorize",
        Some(&token),
        Some(authorize_body()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, serde_json::json!({ "error": "email_required" }));
}

#[tokio::test]
async fn authorize_mints_a_code_and_the_redirect_deep_link() {
    let transport = ScriptedTransport::new();
    let state = cardrails_state(&transport, Some(CLIENT_SECRET));
    let app = router(state.clone());
    let (status, body, headers) = authorize(&app).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(headers["access-control-allow-origin"], "*");

    let code = body["code"].as_str().expect("code is a string");
    assert_eq!(code.len(), 43, "{code}");
    assert_eq!(body["redirect"],
        serde_json::json!(format!("{REDIRECT_SCHEME}?code={code}&state={VALID_STATE}"))
    );

    // The token flow accepts the minted code: the store really has the record.
    let (status, token_body, _) = call(
        &app,
        "POST",
        "/api/cardrails-token",
        Some(CLIENT_SECRET),
        Some(serde_json::json!({ "code": code, "code_verifier": VERIFIER })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{token_body}");
    assert_eq!(token_body["uid"], serde_json::json!("user-1"));
    assert_eq!(token_body["email"], serde_json::json!("ash@pokoin.com"));
    assert_eq!(token_body["email_verified"], serde_json::json!(true));
}

#[tokio::test]
async fn the_token_exchange_answers_no_store_without_cors() {
    let transport = ScriptedTransport::new();
    let state = cardrails_state(&transport, Some(CLIENT_SECRET));
    let app = router(state.clone());
    let (_, body, _) = authorize(&app).await;
    let code = body["code"].as_str().unwrap();

    let (status, _, headers) = call(
        &app,
        "POST",
        "/api/cardrails-token",
        Some(CLIENT_SECRET),
        Some(serde_json::json!({ "code": code, "code_verifier": VERIFIER })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");
    // Server-to-server: no CORS headers are mounted on this route.
    assert!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
}

#[tokio::test]
async fn a_pkce_mismatch_burns_the_code() {
    let transport = ScriptedTransport::new();
    let state = cardrails_state(&transport, Some(CLIENT_SECRET));
    let app = router(state.clone());
    let (_, body, _) = authorize(&app).await;
    let code = body["code"].as_str().unwrap().to_string();

    let (status, error, _) = call(
        &app,
        "POST",
        "/api/cardrails-token",
        Some(CLIENT_SECRET),
        Some(serde_json::json!({ "code": code, "code_verifier": "wrong-verifier-wrong-verifier-wrong-verifier" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error, serde_json::json!({ "error": "invalid_grant" }));

    // The first attempt consumed the code: the corrected verifier is too late.
    let (status, error, _) = call(
        &app,
        "POST",
        "/api/cardrails-token",
        Some(CLIENT_SECRET),
        Some(serde_json::json!({ "code": code, "code_verifier": VERIFIER })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error, serde_json::json!({ "error": "invalid_grant" }));
}

#[tokio::test]
async fn a_code_is_single_use() {
    let transport = ScriptedTransport::new();
    let state = cardrails_state(&transport, Some(CLIENT_SECRET));
    let app = router(state.clone());
    let (_, body, _) = authorize(&app).await;
    let code = body["code"].as_str().unwrap().to_string();

    let exchange = serde_json::json!({ "code": code, "code_verifier": VERIFIER });
    let (first, _, _) = call(&app, "POST", "/api/cardrails-token", Some(CLIENT_SECRET), Some(exchange.clone())).await;
    let (second, error, _) = call(&app, "POST", "/api/cardrails-token", Some(CLIENT_SECRET), Some(exchange)).await;
    assert_eq!(first, StatusCode::OK);
    assert_eq!(second, StatusCode::BAD_REQUEST);
    assert_eq!(error, serde_json::json!({ "error": "invalid_grant" }));
}

#[tokio::test]
async fn an_unknown_code_is_invalid_grant() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let (status, error, _) = call(
        &app,
        "POST",
        "/api/cardrails-token",
        Some(CLIENT_SECRET),
        Some(serde_json::json!({ "code": "unknown-code", "code_verifier": VERIFIER })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error, serde_json::json!({ "error": "invalid_grant" }));
}

#[tokio::test]
async fn a_missing_code_or_verifier_is_invalid_grant() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    for body in [
        serde_json::json!({}),
        serde_json::json!({ "code": "x" }),
        serde_json::json!({ "code_verifier": VERIFIER }),
    ] {
        let (status, error, _) = call(&app, "POST", "/api/cardrails-token", Some(CLIENT_SECRET), Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error, serde_json::json!({ "error": "invalid_grant" }));
    }
}

#[tokio::test]
async fn an_expired_code_is_invalid_grant_and_is_removed() {
    let transport = ScriptedTransport::new();
    let state = cardrails_state(&transport, Some(CLIENT_SECRET));
    let app = router(state.clone());

    // A record that expired before the exchange.
    let mut record = stored_record("expired-code-0000000000000000000000000");
    record.expires_at = chrono::Utc::now() - chrono::Duration::seconds(1);
    state
        .cardrails_store()
        .expect("store resolves")
        .insert(record)
        .await
        .unwrap();

    let (status, error, _) = call(
        &app,
        "POST",
        "/api/cardrails-token",
        Some(CLIENT_SECRET),
        Some(serde_json::json!({ "code": "expired-code-0000000000000000000000000", "code_verifier": VERIFIER })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error, serde_json::json!({ "error": "invalid_grant" }));
}

#[tokio::test]
async fn the_token_route_rejects_a_wrong_or_missing_client_secret() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let body = serde_json::json!({ "code": "x", "code_verifier": VERIFIER });

    let (status, error, _) = call(&app, "POST", "/api/cardrails-token", Some("nope"), Some(body.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error, serde_json::json!({ "error": "invalid_client" }));

    let (status, error, _) = call(&app, "POST", "/api/cardrails-token", None, Some(body)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error, serde_json::json!({ "error": "invalid_client" }));
}

#[tokio::test]
async fn the_token_route_reports_an_unconfigured_secret_truthfully() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, None));
    let (status, error, _) = call(
        &app,
        "POST",
        "/api/cardrails-token",
        Some("anything"),
        Some(serde_json::json!({ "code": "x", "code_verifier": VERIFIER })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error, serde_json::json!({ "error": "not_configured" }));
}

#[tokio::test]
async fn authorize_reports_a_missing_database_truthfully() {
    let transport = ScriptedTransport::new();
    script_firebase(&transport);
    // No injected store and no marketplace database URL: the production
    // resolver falls back to Postgres and reports it, never fakes success.
    let mut config = test_config();
    config.cardrails_client_secret = Some(CLIENT_SECRET.into());
    let app = router(DomainState::with_transport(config, transport.as_transport()));

    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims("user-1", "ash@pokoin.com", now));
    let (status, body, _) = call(
        &app,
        "POST",
        "/api/cardrails-authorize",
        Some(&token),
        Some(authorize_body()),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        serde_json::json!({ "error": "Marketplace database is not configured." })
    );
}

/// Authorize, then exchange with `extra` merged into the token body; returns
/// the token answer and the store, to look at the grant it kept.
async fn exchange_with(
    grant_key: Option<&str>,
    extra: serde_json::Value,
) -> (StatusCode, serde_json::Value, Arc<MemoryCardRailsCodeStore>) {
    let transport = ScriptedTransport::new();
    script_firebase(&transport);
    let mut config = test_config();
    config.cardrails_client_secret = Some(CLIENT_SECRET.into());
    config.seller_grant_key = grant_key.map(str::to_string);
    let store = Arc::new(MemoryCardRailsCodeStore::new());
    let state = DomainState::with_transport(config, transport.as_transport())
        .with_cardrails_store(Some(store.clone()));
    let app = router(state);
    let (_, authorized, _) = authorize(&app).await;
    let mut body = serde_json::json!({ "code": authorized["code"], "code_verifier": VERIFIER });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    let (status, answer, _) =
        call(&app, "POST", "/api/cardrails-token", Some(CLIENT_SECRET), Some(body)).await;
    (status, answer, store)
}

#[tokio::test]
async fn the_exchange_hands_card_rails_a_seller_grant_when_asked() {
    let key = "0123456789abcdef0123456789abcdef";
    let (status, answer, store) = exchange_with(Some(key), serde_json::json!({ "grant": true })).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["uid"], "user-1");
    let token = answer["grant"].as_str().expect("a grant token");
    assert!(token.starts_with("pkn_"), "{token}");
    let stored = store.sign_in_grant("user-1").expect("grant stored for the seller");
    assert_eq!(stored.token_hash, pokoin_accounts::domain::cardrails::code_hash(token));
    assert_eq!(stored.shared_secret["algorithm"], "aes-256-gcm");

    // Older callers that do not ask, and servers without the key, get the identity only.
    let (status, answer, store) = exchange_with(Some(key), serde_json::json!({})).await;
    assert_eq!((status, answer.get("grant")), (StatusCode::OK, None));
    assert!(store.sign_in_grant("user-1").is_none());
    let (status, answer, _) = exchange_with(None, serde_json::json!({ "grant": true })).await;
    assert_eq!((status, answer.get("grant")), (StatusCode::OK, None));
    assert_eq!(answer["email"], "ash@pokoin.com");
}

// ---------------------------------------------------------------------------
// Silver membership lookup (`GET /api/cardrails-membership`)
// ---------------------------------------------------------------------------

fn user_doc(uid: &str, fields: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "name": format!("projects/{TEST_PROJECT}/databases/(default)/documents/users/{uid}"),
        "fields": fields,
    })
}

async fn membership(
    app: &axum::Router,
    query: &str,
    secret: Option<&str>,
) -> (StatusCode, serde_json::Value, axum::http::HeaderMap) {
    call(app, "GET", &format!("/api/cardrails-membership?{query}"), secret, None).await
}

#[tokio::test]
async fn membership_requires_the_client_secret() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let (status, error, _) = membership(&app, "uid=u1", Some("nope")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error["error"], "invalid_client");
    let (status, _, _) = membership(&app, "uid=u1", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Nothing reached Firestore or Identity Toolkit.
    assert!(transport.requests_to("documents/users").is_empty());

    let app = router(cardrails_state(&transport, None));
    let (status, error, _) = membership(&app, "uid=u1", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error["error"], "not_configured");
}

#[tokio::test]
async fn membership_needs_a_uid_or_an_email() {
    let transport = ScriptedTransport::new();
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let (status, error, _) = membership(&app, "", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"], "invalid_request");
}

#[tokio::test]
async fn membership_answers_silver_by_role_or_unexpired_until() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        "documents/users/u-role",
        200,
        user_doc("u-role", serde_json::json!({ "role": { "stringValue": "silver" }, "email": { "stringValue": "Role@Example.com" } })),
    );
    transport.on_json(
        "documents/users/u-until",
        200,
        user_doc("u-until", serde_json::json!({ "silverUntil": { "timestampValue": "2999-01-01T00:00:00Z" } })),
    );
    transport.on_json(
        "documents/users/u-expired",
        200,
        user_doc("u-expired", serde_json::json!({ "role": { "stringValue": "user" }, "silverUntil": { "timestampValue": "2000-01-01T00:00:00Z" } })),
    );
    transport.on_json(
        "documents/users/u-none",
        404,
        serde_json::json!({ "error": { "code": 404, "status": "NOT_FOUND", "message": "missing" } }),
    );
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));

    let (status, body, headers) = membership(&app, "uid=u-role", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["uid"], "u-role");
    assert_eq!(body["email"], "role@example.com");
    assert_eq!(body["silver"], true);
    assert_eq!(body["role"], "silver");
    assert_eq!(body["silverUntil"], serde_json::Value::Null);
    assert_eq!(body["profile"], true);
    assert_eq!(headers.get("cache-control").and_then(|v| v.to_str().ok()), Some("no-store"));
    assert!(headers.get("access-control-allow-origin").is_none());

    let (status, body, _) = membership(&app, "uid=u-until", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["silver"], true);
    assert_eq!(body["silverUntil"], "2999-01-01T00:00:00.000Z");
    assert_eq!(body["role"], "");

    let (status, body, _) = membership(&app, "uid=u-expired", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["silver"], false);
    assert_eq!(body["silverUntil"], "2000-01-01T00:00:00.000Z");
    assert_eq!(body["role"], "user");

    let (status, body, _) = membership(&app, "uid=u-none", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["silver"], false);
    assert_eq!(body["profile"], false);
}

#[tokio::test]
async fn membership_resolves_an_email_through_identity_toolkit() {
    let transport = ScriptedTransport::new();
    transport.on_json(
        "accounts:lookup",
        200,
        serde_json::json!({ "users": [{ "localId": "u-role", "email": "Role@Example.com" }] }),
    );
    transport.on_json(
        "documents/users/u-role",
        200,
        user_doc("u-role", serde_json::json!({ "role": { "stringValue": "silver" } })),
    );
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let (status, body, _) = membership(&app, "email=Role%40Example.com", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["uid"], "u-role");
    assert_eq!(body["email"], "role@example.com");
    assert_eq!(body["silver"], true);
    let lookups = transport.requests_to("accounts:lookup");
    assert_eq!(lookups.len(), 1);
    let payload: serde_json::Value = serde_json::from_slice(&lookups[0].body).unwrap();
    assert_eq!(payload["email"], serde_json::json!(["role@example.com"]));
}

#[tokio::test]
async fn membership_of_an_unknown_email_is_not_found() {
    let transport = ScriptedTransport::new();
    transport.on_json("accounts:lookup", 200, serde_json::json!({ "users": [] }));
    let app = router(cardrails_state(&transport, Some(CLIENT_SECRET)));
    let (status, error, _) = membership(&app, "email=nobody%40example.com", Some(CLIENT_SECRET)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["error"], "user_not_found");
    assert!(transport.requests_to("documents/users").is_empty());
}
