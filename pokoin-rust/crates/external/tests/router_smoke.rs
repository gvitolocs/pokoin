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

/// A Power Tools import whose locations end in numbers that could be box names.
const AMBIGUOUS_CSV: &str = "name,set,cn,condition,language,quantity,price,location\n\
    Pikachu,Base Set,58/102,NM,English,1,2.50,Focobomba 006\n\
    Charmander,Base Set,46/102,LP,English,2,1.00,Focobomba 007\n\
    Squirtle,Base Set,63/102,NM,English,1,1.00,FUOCOBOMBA 006 - 16\n";

/// A connected test seller, its integration document as stored.
async fn connected_seller() -> DomainState {
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
    state
}

async fn start_sync(
    state: &DomainState,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/api/cardtrader-sync")
        .header("authorization", "Bearer test-seller")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    call(state.clone(), request).await
}

async fn stored_doc(state: &DomainState) -> serde_json::Value {
    state
        .firestore
        .get_doc(
            pokoin_external::cardtrader::integration::COLLECTION,
            &pokoin_external::cardtrader::integration::integration_doc_id("seller"),
        )
        .await
        .expect("integration document")
        .data
}

/// The Power Tools import that writes listing locations is refused before
/// anything is written while a trailing number could still be the box name.
#[tokio::test]
async fn cardtrader_sync_refuses_an_unconfirmed_box_reading() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../src/fixtures/location_style_cases.json"))
            .expect("shared location-style table");
    let state = connected_seller().await;
    let (status, body) = start_sync(
        &state,
        serde_json::json!({ "powerToolsCsv": { "pokemon": AMBIGUOUS_CSV } }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        body, fixture["refusalOfAmbiguousList"],
        "the refusal carries the readings the seller has to choose between"
    );
    assert!(
        !state.sync_jobs.is_running("seller").await,
        "the refused import started no sync"
    );
}

/// "Refused" means nothing happened: the same request also carries a new sync
/// direction, and the guard runs before that write, so the integration document
/// comes back byte-equal and no sync is queued.
#[tokio::test]
async fn cardtrader_sync_refusal_changes_nothing_at_all() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../src/fixtures/location_style_cases.json"))
            .expect("shared location-style table");
    let state = connected_seller().await;
    state
        .firestore
        .merge_doc(
            pokoin_external::cardtrader::integration::COLLECTION,
            &pokoin_external::cardtrader::integration::integration_doc_id("seller"),
            serde_json::json!({ "inventorySync": { "direction": "ct_to_pokoin", "updatedAt": "before" } }),
        )
        .await
        .expect("set the stored direction");
    let before = serde_json::to_string(&stored_doc(&state).await).expect("document json");
    let (status, body) = start_sync(
        &state,
        serde_json::json!({
            "direction": "both",
            "powerToolsCsv": { "pokemon": AMBIGUOUS_CSV },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body, fixture["refusalOfAmbiguousList"]);
    let after = serde_json::to_string(&stored_doc(&state).await).expect("document json");
    assert_eq!(
        after, before,
        "a refused import must not move the sync direction or touch the document"
    );
    assert_eq!(
        stored_doc(&state).await.pointer("/inventorySync/direction"),
        Some(&serde_json::json!("ct_to_pokoin"))
    );
    assert!(
        !state.sync_jobs.is_running("seller").await,
        "the refused import started no sync"
    );
}
