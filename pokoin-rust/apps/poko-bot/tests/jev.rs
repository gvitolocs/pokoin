use poko_bot::decide::{classify_poko_message, decide_poko_engagement};
use poko_bot::gate::{should_poko_engage, EngageInput};
use poko_bot::health::Metrics;
use poko_bot::jev::{Jev, JevConfig, JevError};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const KEY: &str = "SECRET-jev-test-key";
fn config(server: &MockServer) -> JevConfig {
    JevConfig {
        url: format!("{}/v1/systemone", server.uri()),
        poko_key: Some(KEY.into()),
        ..JevConfig::default()
    }
}
fn answers(engage: f64, private: f64) -> Value {
    json!({"answers": {"engage": {"noul": engage}, "private_request": {"noul": private}, "market_question": {"noul": 0.75}}, "model": "jev-1.14.0", "usage": {"input_tokens": 123}})
}
async fn mount(server: &MockServer, response: ResponseTemplate) {
    Mock::given(method("POST"))
        .and(path("/v1/systemone"))
        .and(header("authorization", format!("Bearer {KEY}")))
        .respond_with(response)
        .mount(server)
        .await;
}
async fn probability_client(engage: f64, private: f64) -> (MockServer, Jev) {
    let server = MockServer::start().await;
    mount(
        &server,
        ResponseTemplate::new(200).set_body_json(answers(engage, private)),
    )
    .await;
    let jev = Jev::new(config(&server));
    (server, jev)
}

#[tokio::test]
async fn request_shape_typed_parse_and_cache() {
    let (server, jev) = probability_client(0.9, 0.05).await;
    let mut input = EngageInput::new("  how much\n is a Charizard worth?  ");
    input.platform = "discord";
    input.parent_name = " Community ";
    input.channel_name = "general";
    let result = classify_poko_message(&jev, &input).await.unwrap();
    assert_eq!(result.engage, 0.9);
    assert_eq!(result.private_request, 0.05);
    assert_eq!(result.market_question, 0.75);
    assert!(!result.cached);
    assert!(classify_poko_message(&jev, &input).await.unwrap().cached);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let body: Value = requests[0].body_json().unwrap();
    assert_eq!(body["model"], "jev-1.14.0");
    assert_eq!(
        body["questions"],
        serde_json::from_str::<Value>(include_str!("../src/message_questions.json")).unwrap()
    );
    assert_eq!(body["questions"].as_object().unwrap().len(), 3);
    assert!(body["questions"]
        .as_object()
        .unwrap()
        .values()
        .all(|q| q["type"] == "noul"));
    assert_eq!(
        body["state"],
        json!({"platform": "discord", "chat": "group", "channel": "Community/general", "directlyAddressed": false, "message": "how much is a Charizard worth?"})
    );
    let stats = jev.snapshot();
    assert_eq!(stats["calls"], 2);
    assert_eq!(stats["network"], 1);
    assert_eq!(stats["ok"], 2);
    assert_eq!(stats["cacheHits"], 1);
    assert_eq!(stats["inputTokens"], 123);
    assert_eq!(stats["latencyMs"]["count"], 1);
    let long = "é".repeat(4010);
    let mut input = EngageInput::new(&long);
    input.is_dm = true;
    classify_poko_message(&jev, &input).await.unwrap();
    let body: Value = server.received_requests().await.unwrap()[1]
        .body_json()
        .unwrap();
    assert_eq!(
        body["state"]["message"].as_str().unwrap().chars().count(),
        4000
    );
    assert_eq!(body["state"]["chat"], "dm");
    assert_eq!(body["state"]["directlyAddressed"], true);
}

#[tokio::test]
async fn malformed_answers_fall_back_exactly() {
    let mut missing = answers(0.5, 0.0);
    missing["answers"]
        .as_object_mut()
        .unwrap()
        .remove("market_question");
    let mut wrong_type = answers(0.5, 0.0);
    wrong_type["answers"]["engage"] = json!({"choice":"yes"});
    let mut string_probability = answers(0.5, 0.0);
    string_probability["answers"]["engage"]["noul"] = json!("0.5");
    for body in [
        missing,
        answers(1.01, 0.0),
        answers(-0.1, 0.0),
        wrong_type,
        string_probability,
        json!({}),
    ] {
        let server = MockServer::start().await;
        mount(&server, ResponseTemplate::new(200).set_body_json(body)).await;
        let jev = Jev::new(config(&server));
        let input = EngageInput::new("how do you store your cards?");
        let d = decide_poko_engagement(&jev, input).await;
        assert_eq!(d.engage, should_poko_engage(input));
        assert_eq!(d.source, "rules_fallback");
        assert_eq!(d.classification.unwrap().unwrap_err(), JevError::Malformed);
        assert_eq!(jev.snapshot()["fallbacks"], 1);
    }
    let server = MockServer::start().await;
    mount(
        &server,
        ResponseTemplate::new(200).set_body_string("not json"),
    )
    .await;
    assert_eq!(
        classify_poko_message(&Jev::new(config(&server)), &EngageInput::new("hi"))
            .await
            .unwrap_err(),
        JevError::Malformed
    );
}

#[tokio::test]
async fn absent_key_and_disabled_never_request() {
    let server = MockServer::start().await;
    for (enabled, key, error) in [
        (true, None, JevError::NoKey),
        (false, Some(KEY.into()), JevError::Disabled),
    ] {
        let jev = Jev::new(JevConfig {
            enabled,
            poko_key: key,
            ..config(&server)
        });
        assert_eq!(
            classify_poko_message(&jev, &EngageInput::new("hi"))
                .await
                .unwrap_err(),
            error
        );
        assert_eq!(jev.snapshot()["configured"], false);
    }
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn key_files_are_reread_and_lookup_order_is_preserved() {
    let server = MockServer::start().await;
    // Unique per server, with no process-global environment mutation.
    let dir = std::env::temp_dir().join(format!(
        "poko-jev-{}-{}",
        std::process::id(),
        server.address().port()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("late-key");
    let c = JevConfig {
        poko_key: None,
        key_file: Some(file.clone()),
        ..config(&server)
    };
    let jev = Jev::new(c.clone());
    assert_eq!(
        classify_poko_message(&jev, &EngageInput::new("hi"))
            .await
            .unwrap_err(),
        JevError::NoKey
    );
    assert_eq!(jev.snapshot()["configured"], false);
    std::fs::write(&file, format!("  {KEY}\n")).unwrap();
    mount(
        &server,
        ResponseTemplate::new(200).set_body_json(answers(0.5, 0.0)),
    )
    .await;
    classify_poko_message(&jev, &EngageInput::new("hi"))
        .await
        .unwrap();
    assert_eq!(jev.snapshot()["configured"], true);
    std::fs::write(dir.join("jev_api_key"), KEY).unwrap();
    for (poko, shared, creds) in [
        (Some(KEY.into()), Some("wrong".into()), Some(dir.clone())),
        (Some("  ".into()), Some(KEY.into()), Some(dir.clone())),
        (None, None, Some(dir.clone())),
    ] {
        let jev = Jev::new(JevConfig {
            poko_key: poko,
            shared_key: shared,
            credentials_directory: creds,
            key_file: Some(dir.join("missing")),
            ..c.clone()
        });
        classify_poko_message(&jev, &EngageInput::new("check key"))
            .await
            .unwrap();
    }
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn timeout_is_bounded_and_transport_is_sanitized() {
    let server = MockServer::start().await;
    mount(
        &server,
        ResponseTemplate::new(200)
            .set_delay(Duration::from_secs(2))
            .set_body_json(answers(0.9, 0.0)),
    )
    .await;
    let jev = Jev::new(JevConfig {
        timeout: Duration::from_millis(50),
        ..config(&server)
    });
    let started = Instant::now();
    assert_eq!(
        classify_poko_message(&jev, &EngageInput::new("hi"))
            .await
            .unwrap_err(),
        JevError::Timeout
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let jev = Jev::new(JevConfig {
        url: format!("http://{addr}/v1/systemone"),
        ..config(&server)
    });
    assert_eq!(
        classify_poko_message(&jev, &EngageInput::new("hi"))
            .await
            .unwrap_err(),
        JevError::Transport
    );
}

#[tokio::test]
async fn status_mapping_breaker_and_secret_redaction() {
    for (status, body, error, duration) in [
        (429, "slow down", JevError::Quota, 120_000),
        (402, "payment required", JevError::Credits, 1_800_000),
        (401, KEY, JevError::Auth, 1_800_000),
        (403, "forbidden", JevError::Auth, 1_800_000),
        (400, "Usage limit reached", JevError::Quota, 120_000),
        (503, "rate limit reached", JevError::Quota, 120_000),
        (400, "insufficient credits", JevError::Credits, 1_800_000),
        (400, "insufficient balance", JevError::Credits, 1_800_000),
        (400, "bad field", JevError::BadRequest, 0),
    ] {
        let server = MockServer::start().await;
        mount(&server, ResponseTemplate::new(status).set_body_string(body)).await;
        let c = config(&server);
        let jev = Jev::new(c.clone());
        let e = classify_poko_message(&jev, &EngageInput::new("hi"))
            .await
            .unwrap_err();
        assert_eq!(e, error);
        let health = Metrics::with_jev(jev.clone()).snapshot();
        let all = format!("{jev:?} {c:?} {e:?} {e} {health}");
        assert!(!all.contains(KEY));
        assert_eq!(health["jev"]["failures"][error.to_string()], 1);
        assert_eq!(health["jev"]["breaker"]["open"], duration > 0);
        if duration > 0 {
            let remaining = health["jev"]["breaker"]["reopensInMs"].as_u64().unwrap();
            assert!(remaining > duration - 5000 && remaining <= duration);
            assert_eq!(health["jev"]["breaker"]["reason"], error.to_string());
            assert_eq!(
                classify_poko_message(&jev, &EngageInput::new("another"))
                    .await
                    .unwrap_err(),
                JevError::CoolingDown
            );
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn transient_breaker_opens_after_three_and_success_resets_count() {
    let server = MockServer::start().await;
    let jev = Jev::new(config(&server));
    mount(&server, ResponseTemplate::new(500)).await;
    for _ in 0..2 {
        assert_eq!(
            classify_poko_message(&jev, &EngageInput::new("hi"))
                .await
                .unwrap_err(),
            JevError::Overloaded
        );
    }
    assert_eq!(jev.snapshot()["breaker"]["open"], false);
    server.reset().await;
    mount(
        &server,
        ResponseTemplate::new(200).set_body_json(answers(0.9, 0.0)),
    )
    .await;
    classify_poko_message(&jev, &EngageInput::new("success"))
        .await
        .unwrap();
    assert_eq!(jev.snapshot()["breaker"]["consecutiveFailures"], 0);
    server.reset().await;
    mount(&server, ResponseTemplate::new(500)).await;
    for _ in 0..3 {
        assert_eq!(
            classify_poko_message(&jev, &EngageInput::new("hi"))
                .await
                .unwrap_err(),
            JevError::Overloaded
        );
    }
    let stats = jev.snapshot();
    assert_eq!(stats["breaker"]["open"], true);
    assert_eq!(stats["failures"]["overloaded"], 5);
    let remaining = stats["breaker"]["reopensInMs"].as_u64().unwrap();
    assert!(remaining > 55_000 && remaining <= 60_000);
    // Cached answers remain available while the breaker is open, as in Hermes.
    assert!(
        classify_poko_message(&jev, &EngageInput::new("success"))
            .await
            .unwrap()
            .cached
    );
    assert_eq!(
        classify_poko_message(&jev, &EngageInput::new("hi"))
            .await
            .unwrap_err(),
        JevError::CoolingDown
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn authoritative_rules_do_not_call_jev() {
    let server = MockServer::start().await;
    let jev = Jev::new(config(&server));
    for text in ["  ", "check my gmail inbox please", "CA?"] {
        let input = EngageInput::new(text);
        let d = decide_poko_engagement(&jev, input).await;
        assert_eq!(d.engage, should_poko_engage(input));
        assert_eq!(d.source, "rules");
        assert!(d.classification.is_none());
    }
    assert_eq!(jev.snapshot()["calls"], 0);
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn decision_thresholds_and_direct_invocation() {
    for (engage, private, direct, reply, reason) in [
        (0.02, 0.0, true, true, "direct_invocation"),
        (0.99, 0.8, true, false, "private_operator_request"),
        (0.99, 0.79, true, true, "direct_invocation"),
        (0.5, 0.0, false, true, "jev_engage"),
        (0.4999, 0.0, false, false, "jev_ambient"),
        (0.9, 0.8, false, false, "private_operator_request"),
    ] {
        let (_server, jev) = probability_client(engage, private).await;
        let mut input = EngageInput::new("that pull was insane");
        input.is_dm = direct;
        let d = decide_poko_engagement(&jev, input).await;
        assert_eq!(d.source, "jev");
        assert_eq!(d.engage.should_reply, reply);
        assert_eq!(d.engage.reason, reason);
        assert_eq!(d.classification.unwrap().unwrap().market_question, 0.75);
    }
    for field in ["mention", "reply", "username", "poko"] {
        let (_server, jev) = probability_client(0.01, 0.0).await;
        let mut input = EngageInput::new(if field == "username" {
            "hello @testbot"
        } else if field == "poko" {
            "poko hi"
        } else {
            "hello"
        });
        input.is_mentioned = field == "mention";
        input.is_reply_to_bot = field == "reply";
        input.bot_username = "testbot";
        let d = decide_poko_engagement(&jev, input).await;
        assert!(d.engage.should_reply);
        assert_eq!(d.engage.reason, "direct_invocation");
    }
}

#[tokio::test]
async fn failures_preserve_rules_for_every_gate_fixture() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/gate_cases.json")).unwrap();
    for status in [429, 500, 200] {
        let server = MockServer::start().await;
        mount(
            &server,
            ResponseTemplate::new(status).set_body_json(json!({})),
        )
        .await;
        let jev = Jev::new(config(&server));
        for f in &fixtures {
            let input = EngageInput {
                text: f["text"].as_str().unwrap(),
                platform: f["platform"].as_str().unwrap(),
                is_dm: f["isDm"].as_bool().unwrap(),
                is_mentioned: f["isMentioned"].as_bool().unwrap(),
                is_reply_to_bot: f["isReplyToBot"].as_bool().unwrap(),
                bot_username: f["botUsername"].as_str().unwrap(),
                channel_name: f["channelName"].as_str().unwrap(),
                parent_name: f["parentName"].as_str().unwrap(),
            };
            let rules = should_poko_engage(input);
            let d = decide_poko_engagement(&jev, input).await;
            assert_eq!(d.engage, rules);
            if d.source != "rules" {
                assert_eq!(d.source, "rules_fallback");
                assert!(d.classification.unwrap().is_err());
            }
        }
    }
}

#[tokio::test]
async fn invalid_questions_never_request() {
    let server = MockServer::start().await;
    let jev = Jev::new(config(&server));
    for questions in [
        json!({}),
        json!({"q": {"type":"choice", "instructions":"choose"}}),
        json!({"q":{"type":"noul"}}),
    ] {
        assert_eq!(
            jev.evaluate(json!("state"), questions, "test")
                .await
                .unwrap_err(),
            JevError::Invalid
        );
    }
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn extra_answer_fields_from_the_live_api_are_accepted() {
    let server = MockServer::start().await;
    let body = json!({"answers": {
        "engage": {"noul": 0.9, "confidence": 0.9, "type": "noul"},
        "private_request": {"noul": 0.02, "confidence": 0.98, "type": "noul"},
        "market_question": {"noul": 0.1, "confidence": 0.9, "type": "noul"}
    }, "model": "jev-1.14.0", "usage": {"input_tokens": 715, "output_tokens": 0}});
    mount(&server, ResponseTemplate::new(200).set_body_json(body)).await;
    let jev = Jev::new(config(&server));
    let mut input = EngageInput::new("anyone know how to withdraw PKN to my wallet?");
    input.platform = "telegram";
    let result = classify_poko_message(&jev, &input).await.unwrap();
    assert_eq!(result.engage, 0.9);
    assert_eq!(result.private_request, 0.02);
}
