//! One test per binary on purpose: a `tracing` callsite caches its interest the first time any
//! thread reaches it, and a thread without a subscriber caches "never". Another test in this file's
//! binary would silence these callsites before the thread-local subscriber exists, and this test
//! would then pass or fail by test order.
use poko_bot::youtube::*;
use serde_json::json;
use std::sync::Arc;
use wiremock::{
    matchers::{method, path},
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
async fn callback_logs_one_line_with_the_denial_code_and_channel_only() {
    use axum::{body::Body, http::Request};
    use std::io::Write;
    use std::sync::Mutex;
    use tower::ServiceExt;

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
        type Writer = Capture;
        fn make_writer(&'a self) -> Capture {
            self.clone()
        }
    }

    let sink = Capture::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(sink.clone())
            .finish(),
    );
    tracing::callsite::rebuild_interest_cache();
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = router(Arc::new(client(&server, &dir)));
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"access_token":"ACCESS_SENTINEL","refresh_token":"REFRESH_SENTINEL","expires_in":3600}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/youtube/v3/channels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"items":[{"id":"UC123","snippet":{"title":"Poko","customUrl":"@PokoinPoS"}}]}),
        ))
        .mount(&server)
        .await;
    for (uri, status) in [
        (
            "/oauth2callback?state=poko&error=access_denied&code=CODE_SENTINEL",
            400,
        ),
        ("/oauth2callback?state=poko&code=CODE_SENTINEL", 200),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status, "{uri}");
    }
    let log = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
    let denied: Vec<&str> = log
        .lines()
        .filter(|line| line.contains("YouTube OAuth callback denied"))
        .collect();
    let connected: Vec<&str> = log
        .lines()
        .filter(|line| line.contains("YouTube OAuth connected"))
        .collect();
    assert_eq!(denied.len(), 1, "one line per denial: {log}");
    assert_eq!(connected.len(), 1, "one line per success: {log}");
    assert!(denied[0].contains("access_denied"), "{denied:?}");
    assert!(
        connected[0].contains("UC123") && connected[0].contains("Poko"),
        "{connected:?}"
    );
    for secret in [
        "CODE_SENTINEL",
        "ACCESS_SENTINEL",
        "REFRESH_SENTINEL",
        "state=poko",
    ] {
        assert!(!log.contains(secret), "the log carries {secret:?}: {log}");
    }
}
