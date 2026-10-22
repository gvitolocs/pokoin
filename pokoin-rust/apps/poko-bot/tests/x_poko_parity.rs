use poko_bot::{social_text as s, x_client as x};
use serde_json::{json, Value};

fn creds() -> x::Credentials {
    x::Credentials {
        api_key: "consumer-key".into(),
        api_secret: "consumer-secret".into(),
        access_token: "access-token".into(),
        access_token_secret: "access-token-secret".into(),
    }
}

#[test]
fn live_source_pure_function_goldens() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/x-poko-pure.json")).unwrap();
    for (i, case) in cases.iter().enumerate() {
        let a = case["args"].as_array().unwrap();
        let str_arg = |i: usize| a[i].as_str().unwrap();
        let result = match case["fn"].as_str().unwrap() {
            "clean_post_text" => json!(s::clean_post_text(str_arg(0))),
            "hook_snippet" => json!(s::hook_snippet(str_arg(0))),
            "parse_iso_duration" => json!(s::parse_iso_duration(str_arg(0))),
            "clamp_reply" => json!(s::clamp_reply(str_arg(0))),
            "is_safe" => json!(s::is_safe(str_arg(0), a[1].as_bool().unwrap())),
            "original_post" => json!(s::original_post(
                str_arg(0),
                if a[1].is_null() { None } else { Some(&a[1]) }
            )),
            "friend_line" => json!(s::friend_line(str_arg(0))),
            "mention_text" => json!(s::mention_text(str_arg(0), str_arg(1))),
            "engagement_score" => json!(s::engagement_score(&a[0]) as u64),
            "card_reply" => json!(s::card_reply(&a[0])),
            "friend_hook" => json!(s::friend_hook(&a[0])),
            "pick_tweet" => json!(s::pick_tweet(
                a[0].as_array().unwrap(),
                a[1].as_array().unwrap(),
                a[2].as_str()
            )),
            "decide_friend_action" => {
                s::decide_friend_action(&a[0], a[1].as_array().unwrap(), str_arg(2))
            }
            "is_youtube_short" => json!(s::is_youtube_short(str_arg(0), a[1].as_f64().unwrap())),
            "oauth1" => json!(x::oauth1_authorization_header(
                str_arg(0),
                &url::Url::parse(str_arg(1)).unwrap(),
                &creds(),
                "noncenonce",
                "1700000000"
            )
            .unwrap()),
            "crc" => json!(x::crc_response_token(str_arg(0), "consumer-secret")),
            other => panic!("unhandled fixture {other}"),
        };
        assert_eq!(
            result, case["result"],
            "fixture {i}: {} {:?}",
            case["fn"], a
        );
    }
}

#[test]
fn raw_signature_authentication_rejects_tampering() {
    let body = b"{\"tweet_create_events\":[]}";
    let signature = x::crc_response_token(std::str::from_utf8(body).unwrap(), "consumer-secret");
    assert!(x::verify_webhook_signature(
        &signature,
        body,
        "consumer-secret"
    ));
    assert!(!x::verify_webhook_signature(
        &signature,
        b"{\"tweet_create_events\":[]} ",
        "consumer-secret"
    ));
    for signature in ["", "not-a-sha", "sha256=deadbeef", "sha256="] {
        assert!(!x::verify_webhook_signature(
            signature,
            body,
            "consumer-secret"
        ));
    }
    let mut c = creds();
    c.access_token_secret.clear();
    assert!(!c.configured());
    assert!(x::oauth1_authorization_header(
        "POST",
        &url::Url::parse("https://api.x.com/2/tweets").unwrap(),
        &c,
        "n",
        "1"
    )
    .is_err());
    assert_eq!(x::percent_encode("!'()* é"), "%21%27%28%29%2A%20%C3%A9");
}

#[test]
fn mentions_replies_self_and_retweets() {
    assert!(s::should_reply_to(
        &json!({"text":"@POKOINPOS hi", "user":{"id_str":"222"}}),
        "111",
        "PokoinPoS"
    ));
    assert!(s::should_reply_to(
        &json!({"text":"hi", "user":{"id_str":"222"},"in_reply_to_user_id_str":"111"}),
        "111",
        "PokoinPoS"
    ));
    assert!(!s::should_reply_to(
        &json!({"text":"@PokoinPoS hi", "user":{"id_str":"111"}}),
        "111",
        "PokoinPoS"
    ));
    assert!(!s::should_reply_to(
        &json!({"text":"@PokoinPoS hi", "user":{"id_str":"222"},"referenced_tweets":[{"type":"retweeted"}]}),
        "111",
        "PokoinPoS"
    ));
    assert!(!s::should_reply_to(&Value::Null, "111", "PokoinPoS"));
    assert!(!s::should_reply_to(
        &json!({"text":"hi", "user":{"id_str":"222"}}),
        "111",
        "PokoinPoS"
    ));
}

#[test]
fn video_day_guard_and_utf16_limits() {
    let state = json!({"video:abc":{"tweetId":"123","at":"2026-10-22T10:00:00Z"},"other":{"tweetId":"1","at":"2026-10-23"}});
    assert!(s::video_was_tweeted_today(&state, "2026-10-22"));
    assert!(!s::video_was_tweeted_today(&state, "2026-10-23"));
    assert_eq!(s::js_slice("💛hi", 2), "💛");
}

#[tokio::test]
async fn x_transport_uses_signed_user_context_and_json_body() {
    use wiremock::{
        matchers::{body_json, header, method, path},
        Mock, MockServer, ResponseTemplate,
    };
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/2/tweets"))
        .and(header("user-agent", "Hermes-Poko/1.0"))
        .and(body_json(
            json!({"text":"hello","reply":{"in_reply_to_tweet_id":"123"}}),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"data":{"id":"456"}})))
        .mount(&server)
        .await;
    let client = x::XClient::new(
        reqwest::Client::new(),
        url::Url::parse(&server.uri()).unwrap(),
        creds(),
    );
    assert_eq!(
        client.post_tweet("hello", Some("123")).await.unwrap()["data"]["id"],
        "456"
    );
    let requests = server.received_requests().await.unwrap();
    assert!(requests[0].headers["authorization"]
        .to_str()
        .unwrap()
        .starts_with("OAuth "));
}

#[test]
fn tied_nonnumeric_ids_keep_node_stable_sort_order() {
    let tweets = vec![
        json!({"id":"b","text":"a safe pokemon card","username":"a"}),
        json!({"id":"c","text":"another safe pokemon card","username":"b"}),
    ];
    assert_eq!(
        s::pick_tweet(&tweets, &[], Some("PokoinPoS")).unwrap()["id"],
        "b"
    );
    // JavaScript word boundaries are ASCII even next to Unicode text.
    assert!(!s::is_safe("ésexé Pokémon cards", true));
}
