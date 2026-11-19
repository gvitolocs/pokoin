//! Router-level behaviour tests: the mounted surface must fail closed the same
//! way the deployed Node handlers do (401 unauthenticated, 501 for audited
//! gaps, 503 when a downstream worker is absent).

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use pokoin_external::{router, DomainState};
use tower::ServiceExt;

async fn call(state: DomainState, request: Request<Body>) -> (StatusCode, serde_json::Value) {
    let response = router(state).oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, json)
}

fn get(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn client_country_reads_the_edge_header() {
    let request = Request::builder()
        .uri("/api/client-country")
        .header("cf-ipcountry", "it")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["country"], "IT");
}

#[tokio::test]
async fn authenticated_routes_require_a_bearer_token() {
    for uri in [
        "/api/cardtrader-status",
        "/api/cardtrader-assets",
        "/api/powertools-connect",
        "/api/marketplace-pricing-strategies",
        "/api/marketplace-pricing-groups",
    ] {
        let (status, body) = call(DomainState::for_test(), get(uri)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        assert_eq!(body["error"], "Missing Pokoin bearer token.", "{uri}");
        assert_eq!(body["code"], "auth/missing-token", "{uri}");
    }
    // The test verifier accepts any non-empty bearer as `uid`, so a valid
    // header reaches the handler instead of the 401 gate.
    let request = Request::builder()
        .uri("/api/cardtrader-status")
        .header("authorization", "Bearer test-uid")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["connected"], false);
}

#[tokio::test]
async fn commerce_owned_routes_are_absent_and_scan_never_answers_501() {
    // This route is commerce-owned in the merged API and is intentionally
    // absent from the external domain router.
    let request = Request::builder()
        .uri("/api/marketplace-listings-csv")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Scan Connect is implemented: with no database it fails to open one
    // (5xx), it must not fall back to a 501 "not implemented".
    let request = Request::builder()
        .uri("/api/scan-pair")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, _) = call(DomainState::for_test(), request).await;
    assert_ne!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(status.is_server_error(), "expected server error, got {status}");
}

#[tokio::test]
async fn recognition_proxy_fails_closed_without_workers() {
    let request = Request::builder()
        .uri("/api/scan/identify")
        .method("POST")
        .header("content-type", "multipart/form-data; boundary=x")
        .body(Body::from("--x--"))
        .unwrap();
    let (status, _) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // Health reports not-ok rather than pretending the workers are up.
    let (status, body) = call(DomainState::for_test(), get("/api/scan/health")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["ok"], false);
}

#[tokio::test]
async fn admin_refresh_requires_a_configured_environment_secret() {
    let request = Request::builder().uri("/api/cardtrader-daily-listings-refresh").body(Body::empty()).unwrap();
    let (status, body) = call(DomainState::for_test(), request).await;
    if ["CARDTRADER_DAILY_LISTINGS_SECRET", "CARDTRADER_DAILY_REFRESH_SECRET", "CRON_SECRET"].iter().all(|name| std::env::var(name).unwrap_or_default().trim().is_empty()) {
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "CARDTRADER_REFRESH_SECRET_MISSING");
    } else {
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "CardTrader daily refresh access denied.");
    }
}

/// The Power Tools import that writes listing locations is refused before
/// anything is written while a trailing number could still be the box name.
#[tokio::test]
async fn cardtrader_sync_refuses_an_unconfirmed_box_reading() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../src/fixtures/location_style_cases.json"))
            .expect("shared location-style table");
    let csv = "name,set,cn,condition,language,quantity,price,location\n\
        Pikachu,Base Set,58/102,NM,English,1,2.50,Focobomba 006\n\
        Charmander,Base Set,46/102,LP,English,2,1.00,Focobomba 007\n\
        Squirtle,Base Set,63/102,NM,English,1,1.00,FUOCOBOMBA 006 - 16\n";
    let state = DomainState::for_test();
    state
        .firestore
        .merge_doc(
            pokoin_external::cardtrader::integration::COLLECTION,
            &pokoin_external::cardtrader::integration::integration_doc_id("seller"),
            serde_json::json!({
                "enabled": true,
                "provider": "cardtrader",
                "encryptedToken": "test",
            }),
        )
        .await
        .expect("connect the test seller");
    let request = Request::builder()
        .method("POST")
        .uri("/api/cardtrader-sync")
        .header("authorization", "Bearer test-seller")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({ "powerToolsCsv": { "pokemon": csv } }).to_string(),
        ))
        .unwrap();
    let response = router(state.clone())
        .oneshot(request)
        .await
        .expect("router response");
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let body: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert_eq!(
        body, fixture["refusalOfAmbiguousList"],
        "the refusal carries the readings the seller has to choose between"
    );
    assert!(
        !state.sync_jobs.is_running("seller").await,
        "the refused import started no sync"
    );
}
