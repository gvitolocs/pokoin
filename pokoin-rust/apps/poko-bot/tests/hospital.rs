use poko_bot::hospital::{validate_url, Hospital};
use serde_json::json;
use wiremock::{
    matchers::{body_json, header, method, path},
    Mock, MockServer, ResponseTemplate,
};

#[test]
fn reject_dead_tunnel_and_unrelated_or_credential_bearing_urls() {
    for value in [
        "http://127.0.0.1:18789/api/internal/bot-hospital/incident",
        "http://localhost:18789/api/internal/bot-hospital/incident",
        // Every loopback spelling reaches the same retired listener.
        "http://127.1:18789/api/internal/bot-hospital/incident",
        "http://127.0.0.53:18789/api/internal/bot-hospital/incident",
        "http://LOCALHOST:18789/api/internal/bot-hospital/incident",
        "http://[::1]:18789/api/internal/bot-hospital/incident",
        "http://[0:0:0:0:0:0:0:1]:18789/api/internal/bot-hospital/incident",
        "http://[::ffff:127.0.0.1]:18789/api/internal/bot-hospital/incident",
        "http://host/wrong",
        "file:///api/internal/bot-hospital/incident",
        "http://secret@host/api/internal/bot-hospital/incident",
        "https://host/api/internal/bot-hospital/incident?token=secret",
    ] {
        assert!(validate_url(value).is_err(), "{value}");
    }
    assert!(validate_url("http://lucina-rs:8788/api/internal/bot-hospital/incident").is_ok());
    assert!(validate_url("http://127.0.0.1:18788/api/internal/bot-hospital/incident").is_ok());
    assert!(validate_url("http://[::1]:8788/api/internal/bot-hospital/incident").is_ok());
    assert!(validate_url("http://10.0.0.5:18789/api/internal/bot-hospital/incident").is_ok());
    assert!(Hospital::new(
        reqwest::Client::new(),
        "http://lucina-rs:8788/api/internal/bot-hospital/incident",
        String::new(),
        100
    )
    .is_err());
}

#[tokio::test]
async fn exact_incident_payload_and_auth_and_no_fake_success() {
    let server = MockServer::start().await;
    let incident =
        json!({"type":"news_post_platform_failure","runtime":"poko","message":"local fake"});
    Mock::given(method("POST"))
        .and(path("/api/internal/bot-hospital/incident"))
        .and(header("authorization", "Bearer TEST_SECRET"))
        .and(body_json(incident.clone()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"accepted":true})))
        .expect(1)
        .mount(&server)
        .await;
    let hospital = Hospital::new(
        reqwest::Client::new(),
        &format!("{}/api/internal/bot-hospital/incident", server.uri()),
        "TEST_SECRET".into(),
        60_000,
    )
    .unwrap();
    assert_eq!(
        hospital.report(&incident).await.unwrap(),
        json!({"ok":true,"data":{"accepted":true}})
    );
    server.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503).set_body_json(json!({"error":"TEST_SECRET"})))
        .mount(&server)
        .await;
    let error = hospital.report(&incident).await.unwrap_err().to_string();
    assert!(error.contains("503"));
    assert!(!error.contains("TEST_SECRET"));
}

#[tokio::test]
async fn a_two_hundred_answer_that_says_ok_false_is_a_failure() {
    let server = MockServer::start().await;
    let incident =
        json!({"type":"news_post_platform_failure","runtime":"poko","message":"local fake"});
    let hospital = Hospital::new(
        reqwest::Client::new(),
        &format!("{}/api/internal/bot-hospital/incident", server.uri()),
        "TEST_SECRET".into(),
        60_000,
    )
    .unwrap();
    Mock::given(method("POST"))
        .and(path("/api/internal/bot-hospital/incident"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"ok":false,"detail":"TEST_SECRET"})),
        )
        .expect(1)
        .mount(&server)
        .await;
    let error = hospital.report(&incident).await.unwrap_err().to_string();
    assert!(error.contains("rejected"), "{error}");
    assert!(!error.contains("TEST_SECRET"), "{error}");
    server.reset().await;
    // An absent or true flag is the success the receiver reported.
    Mock::given(method("POST"))
        .and(path("/api/internal/bot-hospital/incident"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"accepted":true})))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(
        hospital.report(&incident).await.unwrap(),
        json!({"ok":true,"data":{"accepted":true}})
    );
}
