use pokoin_newsroom::{
    array,
    cadence::{self, DAY, HOUR},
    editorial, handover, iso,
    model::{Budget, Provider, Sse},
    moderation, sources, store, timestamp, website,
};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
};
fn fixture(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures")
                .join(name),
        )
        .unwrap(),
    )
    .unwrap()
}
fn now() -> i64 {
    timestamp("2026-10-05T18:00:00Z").unwrap()
}
fn published(game: &str, at: &str) -> Value {
    json!({"game":game,"status":"published","datePublished":at})
}
#[test]
fn cadence_node_cases_and_boundaries() {
    assert_eq!(cadence::cadence_for("pokemon").per_period, 2);
    assert_eq!(cadence::cadence_for("gundam").period_ms, 7 * DAY);
    let open =
        |game, records: Vec<Value>| cadence::slot_open(game, &records, &[], now())["open"] == true;
    assert!(open(
        "pokemon",
        vec![published("pokemon", "2026-10-05T08:00:00Z")]
    ));
    assert!(!open(
        "pokemon",
        vec![published("pokemon", "2026-10-05T15:00:00Z")]
    ));
    assert!(!open(
        "pokemon",
        vec![
            published("pokemon", "2026-10-05T01:00:00Z"),
            published("pokemon", "2026-10-05T08:00:00Z")
        ]
    ));
    assert!(open(
        "pokemon",
        vec![
            published("pokemon", "2026-10-04T22:00:00Z"),
            published("pokemon", "2026-10-05T08:00:00Z")
        ]
    ));
    assert!(!open(
        "gundam",
        vec![published("gundam", "2026-10-01T10:00:00Z")]
    ));
    assert!(open(
        "gundam",
        vec![published("gundam", "2026-09-27T10:00:00Z")]
    ));
    let attempts = vec![json!({"game":"magic","at":"2026-10-05T10:00:00Z"}); 4];
    assert_eq!(
        cadence::slot_open("magic", &[], &attempts, now())["reason"],
        "generation attempts used up for this period"
    );
    let draft =
        json!({"game":"magic","status":"review","revisions":[{"at":"2026-10-05T09:00:00Z"}]});
    assert!(!open(
        "magic",
        vec![draft.clone(), published("magic", "2026-10-05T03:00:00Z")]
    ));
    assert!(open("magic", vec![draft]));
    assert!(open(
        "pokemon",
        vec![published("pokemon", "2026-10-05T12:00:00Z")]
    ));
    assert!(!open(
        "pokemon",
        vec![published("pokemon", "2026-10-05T12:00:00.001Z")]
    ));
    assert!(open(
        "gundam",
        vec![published("gundam", "2026-09-28T17:59:59.999Z")]
    ));
    assert!(!open(
        "gundam",
        vec![published("gundam", "2026-09-28T18:00:00Z")]
    ));
}
#[test]
fn candidates_node_cases() {
    let story = |id, game, hours, outlets| json!({"id":id,"game":game,"first_seen_at":iso(now()-hours*HOUR),"last_updated_at":iso(now()),"sources":(0..outlets).map(|i|json!({"source":format!("outlet{i}")})).collect::<Vec<_>>()});
    let stories = vec![
        story("a", "gundam", 10, 3),
        story("b", "gundam", 60, 2),
        story("c", "gundam", 200, 5),
        story("d", "pokemon", 5, 1),
        story("e", "pokemon", 6, 3),
        story("f", "pokemon", 50, 4),
    ];
    let ids = |game, records: &[Value]| {
        cadence::pick_candidates(game, &stories, records, now())
            .iter()
            .map(|s| s["id"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids("gundam", &[]), vec![json!("b")]);
    assert_eq!(ids("pokemon", &[]), vec![json!("e"), json!("d")]);
    assert_eq!(
        ids("pokemon", &[json!({"canonicalStoryId":"e"})]),
        vec![json!("d")]
    );
    let via_google = |id, publisher| json!({"id":id,"game":"magic","first_seen_at":iso(now()),"sources":[{"source":"x","link":"https://news.google.com/rss/articles/x","source_url":publisher}]});
    let stories = vec![
        via_google("blog", "https://randomblog.example"),
        via_google("scg", "https://starcitygames.com"),
    ];
    assert_eq!(
        cadence::pick_candidates("magic", &stories, &[], now())[0]["id"],
        "scg"
    );
}
#[test]
fn live_node_schedule_exact() {
    let f = fixture("schedule.json");
    assert_eq!(
        cadence::plan(
            array(&f["stories"]),
            array(&f["records"]),
            &f["state"],
            timestamp(f["now"].as_str().unwrap()).unwrap()
        ),
        f["expected"]
    );
}
#[test]
fn source_resolution_node_golden() {
    for row in array(&fixture("sources.json")) {
        let input = row["input"].as_str().unwrap();
        assert_eq!(sources::resolve_source_host(input), row["host"], "{input}");
        assert_eq!(
            sources::source_tier(input).to_string(),
            row["tier"],
            "{input}"
        );
    }
    assert_eq!(
        sources::story_status(&["pokebeach.com".into(), "pokebeach.com".into()]),
        "single_source"
    );
    assert_eq!(
        sources::story_status(&["pokebeach.com".into(), "ign.com".into()]),
        "multi_source"
    );
    assert_eq!(sources::story_status(&["pokemon.com".into()]), "confirmed");
    assert_eq!(sources::story_status(&["x.com".into()]), "rumor");
}
#[test]
fn moderation_node_golden() {
    let f = fixture("moderation.json");
    for row in array(&f["prechecks"]) {
        assert_eq!(
            moderation::precheck(row["input"].as_str().unwrap()).unwrap_or(Value::Null),
            row["expected"]
        );
    }
    for row in array(&f["decisions"]) {
        assert_eq!(
            moderation::parse_decision(&row["input"]).unwrap_or(Value::Null),
            row["expected"]
        );
    }
    let recent = json!({"createdAt":iso(now())});
    assert!(moderation::moderation_update(&recent, None, now(), false).is_none());
    let old = json!({"createdAt":iso(now()-DAY)});
    assert_eq!(
        moderation::moderation_update(&old, None, now(), false).unwrap()["moderation"]["model"],
        "timeout"
    );
    for (decision, status) in [
        ("publish", "visible"),
        ("hold", "held"),
        ("reject", "rejected"),
    ] {
        let v = moderation::parse_decision(&json!({"decision":decision,"reason":"r"})).unwrap();
        let update = moderation::moderation_update(&recent, Some(v), now(), false).unwrap();
        assert_eq!(update["status"], status);
        assert_eq!(update["moderation"]["model"], "deepseek-flash");
    }
    let mut invalid = old;
    invalid["createdAt"] = json!("invalid");
    assert_eq!(
        moderation::moderation_update(&invalid, None, now(), false).unwrap()["status"],
        "held"
    );
    let request = moderation::moderation_request(
        &json!({"articlePath":"/news/x","authorName":"A","body":"Pokoin got this wrong"}),
    );
    assert_eq!(request["model"], "deepseek-flash");
    assert_eq!(request["max_tokens"], 4000);
    assert!(request["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("Never reject a comment only because it criticises Pokoin."));
}
#[test]
fn firestore_values_and_key_normalization() {
    let v = json!({"a":[1,2.5,true,null,"x"],"z":{"q":false}});
    assert_eq!(moderation::plain_value(&moderation::field_value(&v)), v);
    assert_eq!(
        moderation::plain_value(&json!({"timestampValue":"2026-10-05T18:00:00Z"})),
        json!("2026-10-05T18:00:00Z")
    );
    let pem = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n{}\n-----END PRIVATE KEY-----\n",
        "A".repeat(64),
        "B".repeat(30)
    );
    for input in [
        pem.clone(),
        pem.replace('\n', "\\n"),
        format!("\\\"{}\\\"", pem.replace('\n', "\\\\n")),
    ] {
        assert_eq!(moderation::normalize_private_key(&input), pem);
    }
    assert_eq!(
        moderation::normalize_private_key(" malformed "),
        "malformed"
    );
    for input in ["\\\"pokoin\\\"", "\"pokoin\"", "pokoin", " 'pokoin' "] {
        assert_eq!(moderation::clean_env(input), "pokoin");
    }
}
#[test]
fn editorial_requests_equal_node() {
    let f = fixture("editorial.json");
    let t: Vec<_> = array(&f["validTemplates"])
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let now = timestamp(f["now"].as_str().unwrap()).unwrap();
    assert_eq!(editorial::trimmed_pack(&f["pack"]), f["trimmed"]);
    assert_eq!(
        editorial::reporter_request(
            &f["pack"],
            &f["hints"],
            &t,
            f["memory"].as_str().unwrap(),
            None,
            now,
            true
        ),
        f["requests"]["reporter"]
    );
    assert_eq!(
        editorial::reporter_request(
            &f["pack"],
            &f["hints"],
            &t,
            f["memory"].as_str().unwrap(),
            Some(&f["previous"]),
            now,
            true
        ),
        f["requests"]["update"]
    );
    assert_eq!(
        editorial::editor_request(&f["pack"], &f["draft"], true),
        f["requests"]["editor"]
    );
}
#[test]
fn schemas_coercion_and_evidence_validation() {
    let f = fixture("editorial.json");
    let mut draft = f["draft"].clone();
    assert!(editorial::type_ok(&draft, &editorial::reporter_schema()));
    draft["section"] = json!("WRONG");
    draft["image_plan"] = Value::Null;
    draft["telegram"] = Value::Null;
    let tidy = editorial::normalize_draft(&draft);
    assert_eq!(tidy["section"], "sets");
    assert_eq!(tidy["image_plan"]["hero"], "fallback");
    assert_eq!(tidy["telegram"], "");
    let schema = json!({"type":"object","properties":{"n":{"anyOf":[{"type":"string"},{"type":"null"}]},"s":{"type":"string","enum":["READY"]}},"required":["n","s"]});
    assert_eq!(
        editorial::coerce(&json!({"s":"ready","extra":2}), &schema),
        json!({"n":null,"s":"READY"})
    );
    assert!(!editorial::schema_errors(&json!({}), &schema, "$").is_empty());
    assert!(editorial::validate_editor(
        &json!({"verdict":"revise","reason":"r","issues":[],"revised":null})
    )
    .iter()
    .any(|s| s.contains("requires revised")));
    assert!(editorial::validate_editor(
        &json!({"verdict":"approve","reason":"r","issues":[],"revised":null})
    )
    .is_empty());
    let block = json!({"sourceIds":["s1"],"supportedBy":["s2"],"items":[{"sourceIds":["s3"]}],"rows":[{"says":[{"sourceId":"s4"}]}]});
    assert_eq!(
        editorial::collect_refs(&block),
        vec!["s1", "s2", "s3", "s4"]
    );
    let mut draft = f["draft"].clone();
    draft["blocks"] = json!([{"type":"paragraph","text":"x","sourceIds":["invented"]},{"type":"key_facts","title":null,"items":[]},{"type":"why_it_matters","text":"x"}]);
    assert!(
        editorial::validate_reporter(&draft, &["breaking".into()], &f["pack"])
            .iter()
            .any(|s| s.contains("unknown source id"))
    );
    draft["blocks"][0]["sourceIds"] = json!(["s1"]);
    assert!(editorial::validate_reporter(&draft, &["breaking".into()], &f["pack"]).is_empty());
}
#[test]
fn store_exports_revision_slug_and_lock() {
    let dir = tempfile::tempdir().unwrap();
    assert!(store::load_array(&dir.path().join("missing")).is_empty());
    let r = json!({"id":"id","slug":"first","status":"published","revisions":[{"rev":1}]});
    store::save_record(dir.path(), &r).unwrap();
    assert!(dir
        .path()
        .join("newsroom-revisions/id/rev-0001.json")
        .exists());
    let mut changed = r.clone();
    changed["slug"] = json!("other");
    assert!(store::save_record(dir.path(), &changed).is_err());
    let lock = store::DataLock::acquire(dir.path()).unwrap();
    assert!(store::DataLock::acquire(dir.path()).is_err());
    drop(lock);
    assert!(store::DataLock::acquire(dir.path()).is_ok());
    let rows = vec![
        r,
        json!({"status":"review","channels":{"x":"secret"},"pendingRevision":{}}),
        json!({"status":"withdrawn"}),
    ];
    assert_eq!(store::export_records(&rows, "published", true).len(), 1);
    let all = store::export_records(&rows, "all", true);
    assert_eq!(all.len(), 2);
    assert!(all[1].get("channels").is_none());
}
#[test]
fn env_0600_required_without_printing_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("env");
    fs::write(&path, "NEWSROOM_PARITY_TEST_KEY='local-test-only'\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store::load_env_file(&path).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(store::load_env_file(&path).is_ok());
    let link = dir.path().join("link");
    symlink(&path, &link).unwrap();
    assert!(store::load_env_file(&link).is_err());
    fs::write(&path, "INVALID-KEY=local\n").unwrap();
    assert!(store::load_env_file(&path).is_err());
}
#[test]
fn h42_live_get_goldens() {
    let dir = tempfile::tempdir().unwrap();
    let config = website::Website {
        data_dir: dir.path().into(),
        legacy_data_dir: dir.path().into(),
        export_token: String::new(),
    };
    for row in array(&fixture("h42-live.json")["rows"]) {
        let (status, body) = website::answer(&config, "GET", row["query"].as_str().unwrap(), "");
        assert_eq!(json!(status), row["status"]);
        assert_eq!(body, row["body"]);
    }
    assert_eq!(website::answer(&config, "POST", "", "").0, 405);
}
#[tokio::test]
async fn h42_router_methods_headers_auth_and_nonempty_files() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let dir = tempfile::tempdir().unwrap();
    store::atomic_json(&dir.path().join("newsroom-articles.json"),&json!([{"slug":"one","canonical_story_id":"s1","headline":"News","datePublished":"2026-10-01T00:00:00Z"}])).unwrap();
    store::atomic_json(&dir.path().join(store::RECORDS),&json!([{"status":"review","slug":"review","pendingRevision":{},"channels":{"x":"private"}},{"status":"published","slug":"live"},{"status":"withdrawn"}])).unwrap();
    let config = website::Website {
        data_dir: dir.path().into(),
        legacy_data_dir: dir.path().into(),
        export_token: "local-test-token".into(),
    };
    assert_eq!(
        website::answer(&config, "GET", "slug=one", "").1["article"]["canonicalStoryId"],
        "s1"
    );
    assert_eq!(
        website::answer(&config, "GET", "story=s1", "").1["count"],
        1
    );
    assert_eq!(
        website::answer(&config, "GET", "export=all", "Bearer local-test-token").1["count"],
        2
    );
    assert!(
        website::answer(&config, "GET", "export=all", "Bearer local-test-token").1["articles"][0]
            .get("channels")
            .is_none()
    );
    for method in ["GET", "POST", "OPTIONS", "PUT", "HEAD"] {
        let response = website::router(config.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/api/poko/news")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status().as_u16(),
            if method == "GET" { 200 } else { 405 }
        );
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(response.headers()["cache-control"], "public, max-age=60");
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        if method != "HEAD" {
            assert!(serde_json::from_slice::<Value>(&bytes).is_ok());
        }
    }
}
#[test]
fn sse_chunks_thinking_multiple_text_refusal_and_truncation() {
    let events = [
        json!({"type":"message_start","message":{"model":"fake"}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"ignored"}}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\"ok\":true}"}}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        json!({"type":"message_stop"}),
    ];
    let raw = events
        .iter()
        .map(|e| format!("event: {}\r\ndata: {e}\r\n\r\n", e["type"]))
        .collect::<String>();
    for size in [1, 7, 113, 4096] {
        let mut s = Sse::default();
        for chunk in raw.as_bytes().chunks(size) {
            s.feed(chunk).unwrap();
        }
        assert_eq!(s.finish().unwrap()["json"], json!({"ok":true}));
    }
    assert!(Sse::default().finish().is_err());
    for reason in ["refusal", "max_tokens"] {
        let mut s = Sse::default();
        s.feed(format!("data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"{reason}\"}}}}\ndata: {{\"type\":\"message_stop\"}}\n").as_bytes()).unwrap();
        assert!(s.finish().is_err());
    }
    let budget = Budget::new(1);
    assert!(budget.take().is_ok());
    assert!(budget.take().is_err());
    assert_eq!(budget.remaining(), 0);
}
#[tokio::test]
async fn reqwest_messages_against_local_fake() {
    use wiremock::{
        matchers::{body_partial_json, header, method, path},
        Mock, MockServer, ResponseTemplate,
    };
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/messages")).and(header("x-api-key","local-fake"))
        .and(body_partial_json(json!({"stream":true,"thinking":{"type":"adaptive"}})))
        .respond_with(ResponseTemplate::new(200).set_body_raw("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"{\\\"x\\\":1}\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n","text/event-stream")).expect(1).mount(&server).await;
    let mut p = Provider::from_env(Budget::new(1)).unwrap();
    p.name = "anthropic".into();
    p.test_endpoint(server.uri());
    assert_eq!(
        p.request("reporter", "system", "user", &json!({}))["max_tokens"],
        32000
    );
    assert_eq!(
        p.generate("reporter", "system", "user", &json!({}))
            .await
            .unwrap()["json"],
        json!({"x":1})
    );
    assert!(p
        .generate("reporter", "system", "user", &json!({}))
        .await
        .is_err());
    p.name = "deepseek".into();
    assert_eq!(
        p.request("editor", "s", "u", &json!({}))["output_config"]["effort"],
        "max"
    );
    assert_eq!(
        p.request("reporter", "s", "u", &json!({}))["max_tokens"],
        96000
    );
}
#[test]
fn snapshot_validates_and_activation_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    fs::create_dir(&src).unwrap();
    let f = fixture("schedule.json");
    for (name, value) in [
        (store::RECORDS, &f["records"]),
        (store::STORIES, &f["stories"]),
        (store::STATE, &f["state"]),
    ] {
        store::atomic_json(&src.join(name), value).unwrap();
    }
    let before = handover::validate_state(&src).unwrap();
    let dest = root.path().join("snapshot");
    assert_eq!(handover::snapshot(&src, &dest).unwrap(), before);
    assert_eq!(handover::validate_state(&dest).unwrap(), before);
    assert!(handover::snapshot(&src, &dest).is_err());
    assert!(handover::activation_preflight().is_err());
    fs::write(src.join(store::STATE), "{}").unwrap();
    assert!(handover::validate_state(&src).is_err());
}
#[test]
fn live_evidence_hints_templates_worthiness_equal_node() {
    let f = fixture("live-evidence.json");
    let now = timestamp(f["now"].as_str().unwrap()).unwrap();
    let hints = pokoin_newsroom::templates::hints(&f["pack"], now);
    assert_eq!(hints, f["hints"]);
    assert_eq!(
        json!(pokoin_newsroom::templates::valid_templates(&hints)),
        f["validTemplates"]
    );
    assert_eq!(
        pokoin_newsroom::templates::worthiness(&f["pack"], &hints, false, true),
        f["worthiness"]
    );
    assert_eq!(
        pokoin_newsroom::templates::valid_templates(&json!({"storyStatus":"rumor"})),
        vec!["fact_check"]
    );
    assert_eq!(
        pokoin_newsroom::templates::worthiness(&f["pack"], &hints, true, true)["decision"],
        "skip"
    );
}

#[tokio::test]
async fn full_editorial_passes_repair_malformed_output_using_native_http() {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, Request, ResponseTemplate,
    };
    let server = MockServer::start().await;
    let f = fixture("editorial.json");
    let mut draft = f["draft"].clone();
    draft["blocks"] = json!([
        {"type":"paragraph","text":"A source reports a new set.","sourceIds":["s1"]},
        {"type":"key_facts","title":null,"items":[{"text":"A new set.","sourceIds":["s1"]}]},
        {"type":"why_it_matters","text":"Collectors can follow the announcement."}
    ]);
    let expected = draft.clone();
    Mock::given(method("POST")).and(path("/v1/messages")).respond_with(move |r:&Request| {
        let body:Value=serde_json::from_slice(&r.body).unwrap();
        let request:Value=serde_json::from_str(body["messages"][0]["content"].as_str().unwrap()).unwrap();
        let raw=match request["task"].as_str().unwrap() {
            "draft_article"=>"not JSON".to_owned(),
            "repair"=>{assert_eq!(request["errors"],json!(["response was not valid JSON"]));assert_eq!(request["previous"],"not JSON");assert_eq!(body["model"],"claude-sonnet-5-5");draft.to_string()},
            "edit_article"=>json!({"verdict":"approve","reason":"supported","issues":[],"revised":null}).to_string(),
            task=>panic!("unexpected task {task}"),
        };
        let content=[json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":raw}}),json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),json!({"type":"message_stop"})]
            .iter().map(|v|format!("data: {v}\n\n")).collect::<String>();
        ResponseTemplate::new(200).set_body_raw(content,"text/event-stream")
    }).expect(3).mount(&server).await;
    let budget = Budget::new(3);
    let mut provider = Provider::from_env(budget.clone()).unwrap();
    provider.name = "anthropic".into();
    provider.test_endpoint(server.uri());
    let result = editorial::run_passes(
        &provider,
        &f["pack"],
        &f["hints"],
        &["breaking".into()],
        "",
        now(),
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["finalDraft"], expected);
    assert_eq!(budget.remaining(), 0);
}

#[test]
fn cli_replay_does_not_mutate_cms_or_claim_production_readiness() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    fs::create_dir(&data).unwrap();
    let f = fixture("schedule.json");
    for (name, key) in [
        (store::RECORDS, "records"),
        (store::STORIES, "stories"),
        (store::STATE, "state"),
    ] {
        store::atomic_json(&data.join(name), &f[key]).unwrap();
    }
    let before = handover::validate_state(&data).unwrap();
    let binary = env!("CARGO_BIN_EXE_pokoin-newsroom");
    let status = Command::new(binary).arg("status").output().unwrap();
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["productionReady"], false);
    let failed = Command::new(binary)
        .args(["preflight", "--activate", "--data-dir"])
        .arg(&data)
        .output()
        .unwrap();
    assert!(!failed.status.success());
    let report = dir.path().join("report.json");
    let result = Command::new(binary)
        .args(["dry-run", "--input"])
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/live-evidence.json"))
        .args(["--data-dir"])
        .arg(&data)
        .args(["--output"])
        .arg(&report)
        .args([
            "--now",
            f["now"].as_str().unwrap(),
            "--max-model-calls",
            "10",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report = store::strict_read(&report).unwrap();
    assert_eq!(report["modelCalls"], 0);
    assert_eq!(report["passes"]["action"], "skip");
    assert_eq!(report["plan"], f["expected"]);
    assert_eq!(before, handover::validate_state(&data).unwrap());
}
