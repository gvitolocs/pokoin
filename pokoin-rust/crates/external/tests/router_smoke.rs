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
async fn audited_gaps_answer_501_not_a_fake_success() {
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
async fn admin_refresh_requires_the_config_secret() {
    let request = Request::builder()
        .uri("/api/cardtrader-daily-listings-refresh")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "invalid_secret");

    // Correct secret passes the gate and then honestly reports the SQL gap.
    let request = Request::builder()
        .uri("/api/cardtrader-daily-listings-refresh")
        .header("authorization", "Bearer test-cron")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["code"], "not_implemented");
}

#[tokio::test]
async fn methods_outside_the_route_are_405() {
    let request = Request::builder()
        .uri("/api/client-country")
        .method("POST")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn social_routes_are_private() {
    // No secret and no bearer → 401.
    for uri in ["/api/social-autopost", "/api/social-post-agent"] {
        let request = Request::builder()
            .uri(uri)
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let (status, _) = call(DomainState::for_test(), request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    // A signed-in non-admin (no admin allow-list email) → 403, never a send.
    let request = Request::builder()
        .uri("/api/social-autopost")
        .method("POST")
        .header("authorization", "Bearer test-uid")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, _) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Preflight is open.
    let request = Request::builder()
        .uri("/api/social-autopost")
        .method("OPTIONS")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(DomainState::for_test(), request).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}
