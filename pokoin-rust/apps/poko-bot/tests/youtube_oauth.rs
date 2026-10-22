use poko_bot::youtube::*;
use serde_json::{json, Value};
use std::sync::Arc;
use wiremock::{
    matchers::{header, method, path},
    Mock, MockServer, ResponseTemplate,
};

fn client(server: &MockServer, dir: &tempfile::TempDir) -> Youtube {
    Youtube::new(
        reqwest::Client::new(),
        YoutubeConfig {
            client_id: "client".into(),
            client_secret: "SECRET_SENTINEL".into(),
            redirect_uri: "http://localhost/oauth2callback".into(),
            login_hint: String::new(),
            channel_handle: "pokoinpos".into(),
            token_path: dir.path().join("token.json"),
            token_url: format!("{}/token", server.uri()).parse().unwrap(),
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth"
                .parse()
                .unwrap(),
            api_base: format!("{}/youtube/v3/", server.uri()).parse().unwrap(),
        },
    )
}

#[tokio::test]
async fn code_exchange_verifies_channel_and_persists_owner_only_tokens() {
    use std::os::unix::fs::PermissionsExt;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let yt = client(&server, &dir);
    Mock::given(method("POST")).and(path("/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"access_token":"ACCESS_SENTINEL","refresh_token":"REFRESH_SENTINEL","expires_in":3600}))).expect(1).mount(&server).await;
    Mock::given(method("GET"))
        .and(path("/youtube/v3/channels"))
        .and(header("authorization", "Bearer ACCESS_SENTINEL"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"items":[{"id":"UC123","snippet":{"title":"Poko","customUrl":"@PokoinPoS"}}]}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    let result = yt.exchange_code(" authorization-code ").await.unwrap();
    assert_eq!(result["channelId"], "UC123");
    assert!(!result.to_string().contains("SENTINEL"));
    let token = read_token(&yt.config.token_path).await.unwrap().unwrap();
    assert_eq!(token["refresh_token"], "REFRESH_SENTINEL");
    assert!(token["expiry_date"].as_u64().unwrap() > poko_bot::history::now_ms());
    assert!(token.get("expires_in").is_none());
    assert_eq!(
        std::fs::metadata(&yt.config.token_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn concurrent_refreshes_merge_once_without_losing_refresh_token() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let yt = client(&server, &dir);
    write_token(
        &yt.config.token_path,
        &json!({"access_token":"old","refresh_token":"preserved","expiry_date":1,"scope":"scope"}),
    )
    .await
    .unwrap();
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token":"fresh","expires_in":3600}))
                .set_delay(std::time::Duration::from_millis(30)),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/youtube/v3/channels"))
        .and(header("authorization", "Bearer fresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items":[]})))
        .expect(8)
        .mount(&server)
        .await;
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let yt = yt.clone();
        tasks.push(tokio::spawn(async move {
            yt.request(reqwest::Method::GET, "channels", &[], None)
                .await
                .unwrap()
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let token = read_token(&yt.config.token_path).await.unwrap().unwrap();
    assert_eq!(token["refresh_token"], "preserved");
    assert_eq!(token["scope"], "scope");
    assert_eq!(token["access_token"], "fresh");
}

#[tokio::test]
async fn token_errors_never_echo_provider_secrets() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let yt = client(&server, &dir);
    Mock::given(method("POST")).and(path("/token")).respond_with(ResponseTemplate::new(400).set_body_json(json!({"error":"invalid_grant","error_description":"SECRET_SENTINEL ACCESS_SENTINEL authorization-code"}))).mount(&server).await;
    let error = format!(
        "{:#}",
        yt.exchange_code("authorization-code").await.unwrap_err()
    );
    assert!(error.contains("invalid_grant"));
    assert!(!error.contains("SENTINEL"));
    assert!(!error.contains("authorization-code"));
    assert!(read_token(&yt.config.token_path).await.unwrap().is_none());
}

#[tokio::test]
async fn callback_handles_validation_and_wrong_methods_without_network() {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = router(Arc::new(client(&server, &dir)));
    for (uri, phrase) in [
        ("/oauth2callback?state=wrong", "Wrong OAuth state"),
        (
            "/oauth2callback?state=poko&error=access_denied",
            "auth denied",
        ),
        ("/oauth2callback?state=poko", "start here"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8"
        );
        let body = String::from_utf8(
            to_bytes(response.into_body(), 100_000)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(body.contains(phrase));
    }
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth2callback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 405);
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn permissions_enforced_and_atomic_replacement_fixes_legacy_modes() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("token.json");
    assert!(read_token(&path).await.unwrap().is_none());
    std::fs::write(&path, "{}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_token(&path).await.is_err());
    write_token(&path, &json!({"refresh_token":"safe"}))
        .await
        .unwrap();
    assert_eq!(
        read_token(&path).await.unwrap().unwrap()["refresh_token"],
        "safe"
    );
}

#[test]
fn channel_check_and_authorization_contract() {
    let data = json!({"items":[{"id":"other","snippet":{"title":"Other","customUrl":"@Other"}},{"id":"poko","snippet":{"title":"Poko","customUrl":"@PokoinPoS"}}]});
    assert_eq!(
        verify_channel(&data, "pokoinpos").unwrap()["channel"]["id"],
        "poko"
    );
    assert_eq!(verify_channel(&data, "").unwrap()["channel"]["id"], "other");
    assert!(verify_channel(&data, "missing")
        .unwrap_err()
        .to_string()
        .contains("Re-auth and select the Poko brand account."));
    assert_eq!(
        verify_channel(&json!({}), "").unwrap()["channel"],
        Value::Null
    );
    let message = format_oauth_error(
        "invalid_grant",
        "test",
        std::path::Path::new("/tmp/token"),
        "pokoinpos",
    );
    assert!(message.contains("code expired"));
    let scope = format_oauth_error(
        "Insufficient authentication scopes",
        "test",
        std::path::Path::new("/tmp/token"),
        "",
    );
    assert!(scope.contains("wrong channel"));
    assert!(!scope.contains("Channel expected"));
    assert!(comments_unavailable(
        &YoutubeError {
            status: 403,
            reason: "commentsDisabled".into()
        }
        .into()
    ));
    assert!(!comments_unavailable(
        &YoutubeError {
            status: 403,
            reason: "quotaExceeded".into()
        }
        .into()
    ));
}

#[tokio::test]
async fn authorize_url_has_live_scopes_and_no_secret() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let yt = client(&server, &dir);
    let url = yt.config.authorize_url().unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["state"], "poko");
    assert_eq!(q["access_type"], "offline");
    assert_eq!(q["prompt"], "consent select_account");
    assert!(q["scope"].contains("youtube.force-ssl"));
    assert!(q["scope"].contains("youtube.upload"));
    assert!(q["scope"].contains("youtube.readonly"));
    assert!(!url.as_str().contains("SECRET_SENTINEL"));
    let mut config = yt.config;
    config.client_secret.clear();
    assert!(config.authorize_url().is_err());
}

#[tokio::test]
async fn rejected_access_token_refreshes_once_and_retries() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let yt = client(&server, &dir);
    write_token(
        &yt.config.token_path,
        &json!({"access_token":"rejected","refresh_token":"keep"}),
    )
    .await
    .unwrap();
    Mock::given(method("GET"))
        .and(path("/youtube/v3/channels"))
        .and(header("authorization", "Bearer rejected"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error":{}})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                json!({"access_token":"fresh","refresh_token":"","expires_in":3600}),
            ),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/youtube/v3/channels"))
        .and(header("authorization", "Bearer fresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items":[]})))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(
        yt.request(reqwest::Method::GET, "channels", &[], None)
            .await
            .unwrap(),
        json!({"items":[]})
    );
    assert_eq!(
        read_token(&yt.config.token_path).await.unwrap().unwrap()["refresh_token"],
        "keep"
    );
}

#[test]
fn oauth_bind_is_explicit_and_loopback_only() {
    assert!(listener_addr("127.0.0.1:8791").is_ok());
    assert!(listener_addr("[::1]:8791").is_ok());
    assert!(listener_addr("0.0.0.0:8791").is_err());
    assert!(listener_addr("bad").is_err());
}

#[tokio::test]
async fn denied_callback_replays_readonly_live_get_with_native_cli_recovery_text() {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/live-get/oauth-poko-denied.json")).unwrap();
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut yt = client(&server, &dir);
    yt.config.token_path = "/opt/hermes-poko/data/youtube-poko-token.json".into();
    let response = router(Arc::new(yt))
        .oneshot(
            Request::builder()
                .uri(fixture["path"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status().as_u16(),
        fixture["status"].as_u64().unwrap() as u16
    );
    assert_eq!(
        response.headers()["content-type"].to_str().unwrap(),
        fixture["headers"]["content-type"].as_str().unwrap()
    );
    let actual = String::from_utf8(
        to_bytes(response.into_body(), 100_000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let expected=fixture["body"].as_str().unwrap().replace("cd /home/nez/Projects/Hermes\nnode --env-file=private/cityhop/.env.local scripts/poko-youtube-auth.js --code=PASTE_CODE","poko-bot youtube-auth --code-file /path/to/0600-code-file");
    assert_eq!(actual, expected);
    assert!(server.received_requests().await.unwrap().is_empty());
}
