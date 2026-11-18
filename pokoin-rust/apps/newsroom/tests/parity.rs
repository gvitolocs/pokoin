use pokoin_newsroom::{
    array,
    cadence::{self, DAY, HOUR},
    editorial, handover, iso,
    model::{Budget, Completion, Failure, Provider, Reason, Sse},
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
/// JS Date.parse reads a bare YYYY-MM-DD as UTC midnight, so the port does the
/// same; nothing looser is a date at all.
#[test]
fn timestamp_accepts_rfc3339_and_a_bare_utc_day() {
    assert_eq!(timestamp("2026-10-05"), timestamp("2026-10-05T00:00:00Z"));
    assert_eq!(timestamp("2026-10-05"), Some(1_791_158_400_000));
    assert_eq!(
        timestamp("2026-10-05T18:00:00+02:00"),
        Some(1_791_158_400_000 + 16 * HOUR)
    );
    for bad in [
        "",
        " ",
        "2026-10",
        "20261005",
        "2026-1-5",
        "2026-02-30",
        "2026-13-01",
        "05/10/2026",
        "yesterday",
        "2026-10-05T18:00:00",
        "2026-10-05 18:00:00",
    ] {
        assert_eq!(timestamp(bad), None, "{bad} must stay unparseable");
    }
}

/// A published record nobody can date is not an empty slot: cadence.js:38-39
/// would let its NaN count nothing and keep the slot open.
#[test]
fn slot_open_fails_closed_on_an_unparseable_date_published() {
    let broken = json!({"id":"art_broken_en","game":"pokemon","status":"published",
        "datePublished":"05/10/2026"});
    let slot = cadence::slot_open("pokemon", std::slice::from_ref(&broken), &[], now());
    assert_eq!(slot["open"], false);
    assert_eq!(slot["reason"], "unparseable datePublished on art_broken_en");
    // Another game's broken record is not this slot's problem.
    assert_eq!(
        cadence::slot_open("magic", &[broken], &[], now())["open"],
        true
    );
    // A missing date is not a broken one.
    let undated =
        json!({"id":"art_x_en","game":"pokemon","status":"published","datePublished":null});
    assert_eq!(
        cadence::slot_open("pokemon", &[undated], &[], now())["open"],
        true
    );
    // A bare day is a date, and a weekly slot filled by it stays shut.
    let dated =
        json!({"id":"art_y_en","game":"gundam","status":"published","datePublished":"2026-10-01"});
    assert_eq!(
        cadence::slot_open("gundam", &[dated], &[], now())["reason"],
        "1/1 published or in review this week"
    );
}

/// The living-update rule is JS arithmetic on Date.parse: every comparison
/// with NaN is false, so an undated source or an undated article does not block
/// the update, it guarantees one (newsroom-publisher.mjs:104-106).
#[test]
fn a_living_update_follows_nan_comparisons_and_the_try_gap() {
    let empty = json!({"attempts":[],"updates":{}});
    let story = |sources: Value| {
        json!([{"id":"story_1","game":"pokemon",
            "first_seen_at":"2026-10-05T17:00:00Z","last_updated_at":"2026-10-05T17:00:00Z",
            "sources":sources}])
    };
    let record = |modified: Value| {
        json!([{"id":"art_1_en","game":"pokemon","status":"published","slug":"a",
            "canonicalStoryId":"story_1","datePublished":"2026-09-01T00:00:00Z",
            "dateModified":modified}])
    };
    let updates = |state: Value, stories: Value, records: Value| {
        cadence::plan(array(&stories), array(&records), &state, now())["updates"].clone()
    };
    let fresh = json!([{"added_at":"2026-10-05T12:00:00Z"}]);
    let older = json!("2026-10-01T00:00:00Z");
    let updated = json!([{"id":"art_1_en","storyId":"story_1","slug":"a"}]);
    // Both dates read and the source is newer: the update is queued.
    assert_eq!(
        updates(empty.clone(), story(fresh.clone()), record(older.clone())),
        updated
    );
    // A bare-day dateModified is a date too, and the article is older still.
    assert_eq!(
        updates(
            empty.clone(),
            story(fresh.clone()),
            record(json!("2026-10-04"))
        ),
        updated
    );
    // Both dates read and nothing newer than the article: no update.
    assert_eq!(
        updates(
            empty.clone(),
            story(json!([{"added_at":"2026-09-01T00:00:00Z"}])),
            record(older.clone())
        ),
        json!([])
    );
    // One unreadable added_at makes Math.max NaN, and NaN <= modified is false,
    // so the record is queued however old the readable sources are.
    assert_eq!(
        updates(
            empty.clone(),
            story(json!([{"added_at":"2026-10-05T12:00:00Z"},{"added_at":"05/10/2026"}])),
            record(older.clone())
        ),
        updated
    );
    assert_eq!(
        updates(empty.clone(), story(json!([{}])), record(older.clone())),
        updated
    );
    // A null or unreadable dateModified is the same NaN on the other side.
    assert_eq!(
        updates(empty.clone(), story(fresh.clone()), record(Value::Null)),
        updated
    );
    assert_eq!(
        updates(
            empty.clone(),
            story(fresh.clone()),
            record(json!("tomorrow"))
        ),
        updated
    );
    // Zero sources is Math.max() = -Infinity, which is <= any readable date…
    assert_eq!(
        updates(empty.clone(), story(json!([])), record(older.clone())),
        json!([])
    );
    // …unless the article date is unreadable as well, so nothing compares.
    assert_eq!(
        updates(empty.clone(), story(json!([])), record(Value::Null)),
        updated
    );
    // The 12-hour gap since the last try still gates it, NaN and all.
    assert_eq!(
        updates(
            json!({"attempts":[],"updates":{"art_1_en":"2026-10-05T07:00:00Z"}}),
            story(fresh.clone()),
            record(Value::Null)
        ),
        json!([])
    );
    assert_eq!(
        updates(
            json!({"attempts":[],"updates":{"art_1_en":"2026-09-28T07:00:00Z"}}),
            story(fresh),
            record(Value::Null)
        ),
        updated
    );
}

/// Node leans on `||`, truthiness and `String()` where the port used strict
/// equality: templates.js:175, claude.js:519-527, publication.js:60,
/// sources.js:89 and comment-moderation.js:152-155.
#[test]
fn javascript_truthiness_and_string_coercion() {
    for falsy in [Value::Null, json!(false), json!(""), json!(0)] {
        let pack = json!({"entities": falsy, "pokoinEntities": [{"type": "card"}]});
        assert_eq!(
            pokoin_newsroom::templates::hints(&pack, now())["entityCount"],
            1,
            "{falsy} must fall through to pokoinEntities"
        );
    }
    let trimmed = editorial::trimmed_pack(&json!({
        "dates": Value::Null,
        "numbers": false,
        "unconfirmedClaims": "",
        "resolvedEntities": [{"type": "card", "name": "Pikachu", "resolved": 1}],
        "market": [],
    }));
    assert_eq!(trimmed["dates"], json!([]));
    assert_eq!(trimmed["numbers"], json!([]));
    assert_eq!(trimmed["unconfirmedClaims"], json!([]));
    assert_eq!(
        trimmed["entities"],
        json!([{"type": "card", "name": "Pikachu"}]),
        "claude.js:524 tests entity.resolved for truthiness"
    );
    assert!(
        trimmed["market"].is_object(),
        "claude.js:527 builds the market module for any truthy market"
    );
    let pack = json!({"market": {"sufficient": 1}, "sourceList": [
        {"outlet": "pokebeach.com", "tier": "A", "addedAt": "2026-10-05T17:00:00Z"}]});
    let hints = pokoin_newsroom::templates::hints(&pack, now());
    assert_eq!(
        pokoin_newsroom::templates::worthiness(&pack, &hints, false, false)["components"]
            ["pokoinValue"],
        json!(0.6),
        "publication.js:60 pays the bonus for a truthy sufficient"
    );
    assert_eq!(
        editorial::reporter_request(&pack, &hints, &["breaking".into()], "", None, now(), true)
            ["availableModules"]["market"],
        json!(false),
        "claude.js:546 still demands sufficient === true"
    );
    assert_eq!(
        sources::resolve_source_host("www.www.pokebeach.com"),
        "www.pokebeach.com",
        "sources.js:89 strips exactly one leading www."
    );
    let row = moderation::comment_row(&json!({
        "name": "projects/p/databases/(default)/documents/news_comments/c1",
        "fields": {"id": {"stringValue": "stored"}, "body": {"stringValue": "hi"}},
    }));
    assert_eq!(row["id"], "stored", "the stored field beats the path");
    assert_eq!(row["body"], "hi");
}

/// claude.js:448,457 stringify the card ids on both sides; claude.js:447,449 keep
/// chart ids and set slugs raw.
#[test]
fn evidence_ids_compare_the_way_node_stringifies_them() {
    let f = fixture("editorial.json");
    let misses = |kind: &str, key: &str, block_id: Value, pack_id: Value| {
        let mut pack = f["pack"].clone();
        pack["related"]["cards"] = json!([{"cardId": pack_id, "name": "Pikachu"}]);
        pack["market"] = json!({"sufficient": true, "charts": [{"id": pack_id}]});
        let mut draft = f["draft"].clone();
        let mut block = serde_json::Map::new();
        block.insert("type".into(), json!(kind));
        block.insert(key.into(), block_id);
        draft["blocks"] = json!([Value::Object(block)]);
        editorial::validate_reporter(&draft, &["breaking".into()], &pack)
            .into_iter()
            .filter(|error| error.contains("is not in the evidence pack"))
            .collect::<Vec<_>>()
    };
    assert!(
        misses("related_card", "cardId", json!("241905"), json!(241905)).is_empty(),
        "a numeric catalog id is the card the draft quoted"
    );
    assert!(
        misses("related_card", "cardId", json!("241905"), json!("241905")).is_empty(),
        "the ordinary string id"
    );
    assert_eq!(
        misses("related_card", "cardId", json!("999999"), json!(241905)),
        ["blocks[0]: cardId \"999999\" is not in the evidence pack"],
        "a different id is still missing"
    );
    assert_eq!(
        misses("chart", "chartId", json!("3"), json!(3)),
        ["blocks[0]: chartId \"3\" is not in the evidence pack"],
        "chart ids stay raw, as claude.js:447 collects them"
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

/// comment-moderation.js:20 reads `\d` as ASCII digits only, and :45 slices the
/// reason in UTF-16 code units.
#[test]
fn moderation_precheck_is_ascii_digits_and_the_reason_cut_is_utf16() {
    assert_eq!(
        moderation::precheck("call +39 123 456 7890").unwrap()["reason"],
        "contains contact details"
    );
    for digits in ["٠١٢٣٤٥٦٧٨٩", "０１２３４５６７８", "۰۱۲۳۴۵۶۷۸"] {
        assert_eq!(
            moderation::precheck(&format!("dial {digits} now")),
            None,
            "{digits} is not ASCII digits"
        );
    }
    let reason = format!("{}😀tail", "a".repeat(199));
    let cut = moderation::parse_decision(&json!({"decision": "hold", "reason": reason})).unwrap()
        ["reason"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(cut, "a".repeat(199), "the lone high surrogate goes");
    assert_eq!(cut.encode_utf16().count(), 199);
    // A pair inside the window costs two units, so the slice ends mid-word exactly
    // where JS ends it, and a reason of 200 units is untouched.
    let long = format!("{}😀ok", "b".repeat(197));
    assert_eq!(
        moderation::parse_decision(&json!({"decision": "hold", "reason": &long})).unwrap()
            ["reason"],
        format!("{}😀o", "b".repeat(197))
    );
    let fits = format!("{}😀o", "b".repeat(197));
    assert_eq!(
        moderation::parse_decision(&json!({"decision": "hold", "reason": &fits})).unwrap()
            ["reason"],
        fits
    );
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

/// Value equality ignores key order, so the goldens above cannot see it. The
/// request is sent as JSON text, which makes Node's key order part of the
/// contract: claude.js:603 puts output_schema and output_rules between
/// allowed_values and hints, claude.js:636 puts output_schema between
/// instructions and evidence_pack.
#[test]
fn non_strict_requests_keep_node_key_positions() {
    let f = fixture("editorial.json");
    let t: Vec<_> = array(&f["validTemplates"])
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let now = timestamp(f["now"].as_str().unwrap()).unwrap();
    let memory = f["memory"].as_str().unwrap();
    let keys = |value: &Value| {
        value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<String>>()
    };
    // Byte-for-byte where the Node golden exists at all: strictSchema is not false.
    for (request, golden) in [
        (
            editorial::reporter_request(&f["pack"], &f["hints"], &t, memory, None, now, true),
            &f["requests"]["reporter"],
        ),
        (
            editorial::reporter_request(
                &f["pack"],
                &f["hints"],
                &t,
                memory,
                Some(&f["previous"]),
                now,
                true,
            ),
            &f["requests"]["update"],
        ),
        (
            editorial::editor_request(&f["pack"], &f["draft"], true),
            &f["requests"]["editor"],
        ),
    ] {
        assert_eq!(
            serde_json::to_string(&request).unwrap(),
            serde_json::to_string(golden).unwrap()
        );
    }
    assert_eq!(
        keys(&editorial::reporter_request(
            &f["pack"],
            &f["hints"],
            &t,
            memory,
            None,
            now,
            false
        )),
        [
            "task",
            "instructions",
            "validTemplates",
            "allowed_values",
            "output_schema",
            "output_rules",
            "hints",
            "availableModules",
            "reporter_memory",
            "now",
            "previous_article",
            "evidence_pack"
        ]
    );
    assert_eq!(
        keys(&editorial::editor_request(&f["pack"], &f["draft"], false)),
        [
            "task",
            "instructions",
            "output_schema",
            "evidence_pack",
            "draft"
        ]
    );
    // Nothing is added at all when the provider is strict.
    assert_eq!(
        keys(&editorial::reporter_request(
            &f["pack"],
            &f["hints"],
            &t,
            memory,
            None,
            now,
            true
        )),
        keys(&f["requests"]["reporter"])
    );
    assert_eq!(
        keys(&editorial::editor_request(&f["pack"], &f["draft"], true)),
        keys(&f["requests"]["editor"])
    );
}

/// claude.js:573 — the repair request puts output_schema after schema_reminder
/// and before original_request.
#[tokio::test]
async fn a_non_strict_repair_request_keeps_the_node_key_position() {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, Request, ResponseTemplate,
    };
    let f = fixture("editorial.json");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(move |r: &Request| {
            let body: Value = serde_json::from_slice(&r.body).unwrap();
            let request: Value =
                serde_json::from_str(body["messages"][0]["content"].as_str().unwrap()).unwrap();
            let keys = request
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<String>>();
            match request["task"].as_str().unwrap() {
                "draft_article" => {}
                "repair" => assert_eq!(
                    keys,
                    [
                        "task",
                        "errors",
                        "previous",
                        "schema_reminder",
                        "output_schema",
                        "original_request"
                    ]
                ),
                task => panic!("unexpected task {task}"),
            }
            let content = [
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"still not JSON"}}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                json!({"type":"message_stop"}),
            ]
            .iter()
            .map(|v| format!("data: {v}\n\n"))
            .collect::<String>();
            ResponseTemplate::new(200).set_body_raw(content, "text/event-stream")
        })
        .expect(2)
        .mount(&server)
        .await;
    let budget = Budget::new(2);
    let mut provider = Provider::from_env(budget.clone()).unwrap();
    provider.name = "anthropic".into();
    provider.strict = false;
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
    assert_eq!(result["ok"], false);
    assert_eq!(result["reason"], "malformed");
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
        let Completion::Ready { json, .. } = s.finish() else {
            panic!("a text block of valid JSON is ready");
        };
        assert_eq!(json, json!({"ok":true}));
    }
    assert_eq!(
        Sse::default().finish(),
        Completion::Failed(Failure {
            reason: Reason::Unavailable,
            detail: Some("model stream incomplete".into()),
            raw: String::new(),
        })
    );
    for reason in ["refusal", "max_tokens"] {
        let mut s = Sse::default();
        s.feed(format!("data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"{reason}\"}}}}\ndata: {{\"type\":\"message_stop\"}}\n").as_bytes()).unwrap();
        let Completion::Failed(Failure {
            reason: got,
            detail,
            raw,
        }) = s.finish()
        else {
            panic!("stop_reason {reason} must not be ready");
        };
        assert_eq!(
            got,
            if reason == "refusal" {
                Reason::Refused
            } else {
                Reason::Truncated
            }
        );
        assert_eq!(detail, None);
        assert!(raw.is_empty());
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
    let Completion::Ready { json, .. } = p
        .generate("reporter", "system", "user", &json!({}))
        .await
        .unwrap()
    else {
        panic!("the fake answered with a text block of JSON");
    };
    assert_eq!(json, json!({"x":1}));
    // The single call is spent, so a second never reaches the API (model.rs takes
    // the budget before the request); the HTTP classes are covered by
    // model_http_status_picks_the_failure_class.
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

/// claude.js:648-663 and 694-706: a revision that breaks the reporter contract
/// becomes a rejection whose reason is the first three validation errors.
#[tokio::test]
async fn editor_revision_failing_validation_is_an_editor_rejection() {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, Request, ResponseTemplate,
    };
    let f = fixture("editorial.json");
    let mut draft = f["draft"].clone();
    draft["blocks"] = json!([
        {"type":"paragraph","text":"A source reports a new set.","sourceIds":["s1"]},
        {"type":"key_facts","title":null,"items":[{"text":"A new set.","sourceIds":["s1"]}]},
        {"type":"why_it_matters","text":"Collectors can follow the announcement."}
    ]);
    draft["first_reported_source_id"] = json!("s1");
    let mut revised = draft.clone();
    revised["blocks"][0]["sourceIds"] = json!(["a", "d"]);
    revised["blocks"][1]["items"][0]["sourceIds"] = json!(["b"]);
    revised["first_reported_source_id"] = json!("c");
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/messages")).respond_with(move |r:&Request| {
        let body:Value=serde_json::from_slice(&r.body).unwrap();
        let request:Value=serde_json::from_str(body["messages"][0]["content"].as_str().unwrap()).unwrap();
        let raw=match request["task"].as_str().unwrap() {
            "draft_article"=>draft.to_string(),
            "edit_article"=>json!({"verdict":"revise","reason":"tightened","issues":[{"blockIndex":0,"quote":"A source reports a new set.","problem":"unsupported","fix":"cite s1"}],"revised":{"headline":revised["headline"],"dek":revised["dek"],"blocks":revised["blocks"]}}).to_string(),
            task=>panic!("unexpected task {task}"),
        };
        let content=[json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":raw}}),json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),json!({"type":"message_stop"})]
            .iter().map(|v|format!("data: {v}\n\n")).collect::<String>();
        ResponseTemplate::new(200).set_body_raw(content,"text/event-stream")
    }).expect(2).mount(&server).await;
    let budget = Budget::new(2);
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
    assert_eq!(result["ok"], false);
    assert_eq!(result["reason"], "editor_rejected");
    assert!(result["finalDraft"].is_null());
    assert_eq!(result["editor"]["verdict"], "reject");
    assert_eq!(
        result["editor"]["reason"],
        "editor revision failed validation: blocks[0] (paragraph): unknown source id \"a\"; blocks[0] (paragraph): unknown source id \"d\"; blocks[1] (key_facts): unknown source id \"b\""
    );
    assert_eq!(
        result["editor"]["issues"],
        json!([{"blockIndex":0,"quote":"A source reports a new set.","problem":"unsupported","fix":"cite s1"}])
    );
    assert_eq!(result["draft"]["blocks"][0]["sourceIds"], json!(["s1"]));
}

/// claude.js:207-214 — the HTTP status alone picks the class, and nothing of the
/// response body or the credential is ever carried into the failure.
#[tokio::test]
async fn model_http_status_picks_the_failure_class() {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    for (status, reason) in [
        (401, Reason::Auth),
        (403, Reason::Auth),
        (429, Reason::Unavailable),
        (500, Reason::Unavailable),
        (503, Reason::Unavailable),
        (400, Reason::ApiError),
        (404, Reason::ApiError),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(status)
                    .set_body_string(format!("body of {status} mentioning KEY-NEVER-LEAKS")),
            )
            .mount(&server)
            .await;
        let mut provider = Provider::from_env(Budget::new(2)).unwrap();
        provider.name = "anthropic".into();
        provider.test_endpoint(server.uri());
        let Completion::Failed(failure) = provider
            .generate("reporter", "s", "u", &json!({}))
            .await
            .unwrap()
        else {
            panic!("HTTP {status} must not be a completion");
        };
        assert_eq!(failure.reason, reason);
        assert_eq!(
            failure.detail.as_deref(),
            Some(format!("model HTTP {status}").as_str())
        );
        assert!(failure.raw.is_empty());
        let rendered = format!("{failure:?}");
        for secret in ["NEVER-LEAKS", "local-fake", "body of"] {
            assert!(!rendered.contains(secret), "{rendered}");
        }
    }
}

#[test]
fn refusal_detail_is_only_the_stop_details_category() {
    // claude.js:200 — stop_details?.category || null.
    for (delta, category) in [
        (
            r#""stop_details":{"category":"sensitive_topics"}"#,
            Some("sensitive_topics"),
        ),
        (r#""stop_details":{"category":""}"#, None),
        (r#""stop_details":null"#, None),
    ] {
        let mut s = Sse::default();
        s.feed(format!("data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"refusal\",{delta}}}}}\ndata: {{\"type\":\"message_stop\"}}\n").as_bytes()).unwrap();
        let Completion::Failed(Failure {
            reason,
            detail,
            raw,
        }) = s.finish()
        else {
            panic!("a refusal is never a completion");
        };
        assert_eq!(reason, Reason::Refused);
        assert_eq!(detail.as_deref(), category);
        assert!(raw.is_empty());
    }
    // claude.js:203 — no text block is malformed with an empty raw, 205 — an
    // unparseable block is malformed with the block itself.
    for (text, raw) in [("", ""), ("not JSON", "not JSON")] {
        let mut s = Sse::default();
        s.feed(format!("data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"thinking\",\"thinking\":\"reasoning\"}}}}\ndata: {{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{{\"type\":\"text\",\"text\":\"{text}\"}}}}\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\"}}}}\ndata: {{\"type\":\"message_stop\"}}\n").as_bytes()).unwrap();
        let Completion::Failed(failure) = s.finish() else {
            panic!("unparseable text is never a completion");
        };
        assert_eq!(failure.reason, Reason::Malformed);
        assert_eq!(failure.raw, raw);
    }
}

/// claude.js:563 — a failure that is not malformed ends the passes with its own
/// reason and never costs a repair call.
#[tokio::test]
async fn a_refused_draft_never_costs_a_repair_call() {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, Request, ResponseTemplate,
    };
    let f = fixture("editorial.json");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(move |r: &Request| {
            let body: Value = serde_json::from_slice(&r.body).unwrap();
            let request: Value =
                serde_json::from_str(body["messages"][0]["content"].as_str().unwrap()).unwrap();
            assert_eq!(request["task"], "draft_article");
            ResponseTemplate::new(200).set_body_raw(
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\",\"stop_details\":{\"category\":\"sensitive_topics\"}}}\ndata: {\"type\":\"message_stop\"}\n\n",
                "text/event-stream",
            )
        })
        .expect(1)
        .mount(&server)
        .await;
    let budget = Budget::new(4);
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
    assert_eq!(result["ok"], false);
    assert_eq!(result["reason"], "refused");
    assert_eq!(result["errors"], json!([]));
    assert!(result.get("draft").is_none());
    assert_eq!(budget.remaining(), 3);
}

/// claude.js:694 — a failing editor call is reported as `editor_<reason>`.
#[tokio::test]
async fn an_editor_call_failure_is_prefixed_editor() {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, Request, ResponseTemplate,
    };
    let f = fixture("editorial.json");
    let mut draft = f["draft"].clone();
    draft["blocks"] = json!([
        {"type":"paragraph","text":"A source reports a new set.","sourceIds":["s1"]},
        {"type":"key_facts","title":null,"items":[{"text":"A new set.","sourceIds":["s1"]}]},
        {"type":"why_it_matters","text":"Collectors can follow the announcement."}
    ]);
    draft["first_reported_source_id"] = json!("s1");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(move |r: &Request| {
            let body: Value = serde_json::from_slice(&r.body).unwrap();
            let request: Value =
                serde_json::from_str(body["messages"][0]["content"].as_str().unwrap()).unwrap();
            match request["task"].as_str().unwrap() {
                "draft_article" => {
                    let content = [
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":draft.to_string()}}),
                        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                        json!({"type":"message_stop"}),
                    ]
                    .iter()
                    .map(|v| format!("data: {v}\n\n"))
                    .collect::<String>();
                    ResponseTemplate::new(200).set_body_raw(content, "text/event-stream")
                }
                "edit_article" => ResponseTemplate::new(429).set_body_string("overloaded"),
                task => panic!("unexpected task {task}"),
            }
        })
        .expect(2)
        .mount(&server)
        .await;
    let budget = Budget::new(4);
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
    assert_eq!(result["ok"], false);
    assert_eq!(result["reason"], "editor_unavailable");
    assert_eq!(result["errors"], json!([]));
    assert_eq!(result["draft"]["template"], "breaking");
    assert_eq!(budget.remaining(), 2);
}

#[test]
fn find_record_by_story_is_the_english_cms_record_only() {
    let records = vec![
        json!({"id":"a", "canonicalStoryId":"s1", "language":"en"}),
        json!({"id":"b", "canonicalStoryId":"s1", "language":"ja"}),
        json!({"id":"c", "canonicalStoryId":"s2"}),
    ];
    assert_eq!(
        store::find_record_by_story(&records, "s1").unwrap()["id"],
        "a"
    );
    assert!(store::find_record_by_story(&records, "s2").is_none());
    assert!(store::find_record_by_story(&records, "nope").is_none());
    assert!(store::find_record_by_story(&records, "").is_none());
}

/// The dry-run must derive the two worthiness flags the live publisher passes:
/// `allowSingleSpecialist` from the slot cadence kind (newsroom-publisher.mjs:91)
/// and `covered` from an existing record (pipeline.js:132), and it must not skip a
/// story that already has one (pipeline.js:133-134).
#[test]
fn dry_run_worthiness_flags_follow_cadence_and_existing_record() {
    use std::process::Command;
    let bin = env!("CARGO_BIN_EXE_pokoin-newsroom");
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    store::atomic_json(&data.join(store::STORIES), &json!([])).unwrap();
    store::atomic_json(
        &data.join(store::STATE),
        &json!({"attempts":[],"updates":{}}),
    )
    .unwrap();
    let run = |records: Value, input: &std::path::Path, report: &std::path::Path| {
        store::atomic_json(&data.join(store::RECORDS), &records).unwrap();
        let output = Command::new(bin)
            .args(["dry-run", "--input"])
            .arg(input)
            .args(["--data-dir"])
            .arg(&data)
            .args(["--output"])
            .arg(report)
            .args(["--now", "2026-10-05T18:00:00Z"])
            .args(["--max-model-calls", "1"])
            .env("POKO_NEWSROOM_CLAUDE_PROVIDER", "none")
            .output()
            .unwrap();
        (
            output.status.success(),
            store::strict_read(report).unwrap_or(Value::Null),
        )
    };

    // A tier-A single-source story scores flash_only; only a daily slot may
    // promote it to an article. gundam is weekly, so it stays skipped.
    let weekly = json!({"pack":{"canonicalStoryId":"story_weekly","game":"gundam","status":"confirmed",
        "angle":"OFFICIAL","firstSeenAt":"2026-10-05T18:00:00Z",
        "sourceList":[{"id":"s1","outlet":"example.net","tier":"A","addedAt":"2026-10-05T18:00:00Z"}],
        "claimLedger":[{"claim":"x","kind":"statement"}],"conflicts":[],"images":[]},"memory":""});
    let weekly_input = root.path().join("weekly.json");
    store::atomic_json(&weekly_input, &weekly).unwrap();
    let weekly_report = root.path().join("weekly-report.json");
    let (ok, report) = run(json!([]), &weekly_input, &weekly_report);
    assert!(ok, "{report}");
    assert_eq!(report["worthiness"]["decision"], "flash_only");
    assert!(report["worthiness"]["components"]
        .get("singleSpecialist")
        .is_none());
    assert_eq!(
        report["passes"]["reason"],
        "editorial_worthiness_flash_only"
    );
    assert_eq!(report["worthiness"]["components"]["alreadyCovered"], 0);

    // The same story in a daily slot is promoted, exactly as the magic fixture is.
    let mut daily_pack = weekly["pack"].clone();
    daily_pack["game"] = json!("magic");
    let daily = json!({"pack": daily_pack, "memory": ""});
    let daily_input = root.path().join("daily.json");
    store::atomic_json(&daily_input, &daily).unwrap();
    let daily_report = root.path().join("daily-report.json");
    let (ok, report) = run(json!([]), &daily_input, &daily_report);
    assert!(!ok, "{report}");
    assert_eq!(report["worthiness"]["decision"], "article");
    assert_eq!(report["worthiness"]["components"]["singleSpecialist"], true);

    // A story that already has a CMS record is covered, and is not skipped for it.
    let captured = fixture("live-evidence.json");
    let covered_input = root.path().join("covered.json");
    store::atomic_json(
        &covered_input,
        &json!({"pack": captured["pack"], "memory": ""}),
    )
    .unwrap();
    let covered_report = root.path().join("covered-report.json");
    let story_id = captured["pack"]["canonicalStoryId"].clone();
    let (ok, report) = run(
        json!([{"id":"rec","canonicalStoryId":story_id,"language":"en","slug":"already","status":"published","datePublished":"2026-10-05T07:00:00Z"}]),
        &covered_input,
        &covered_report,
    );
    assert!(!ok, "a covered story must still be worked on: {report}");
    assert_eq!(report["worthiness"]["components"]["alreadyCovered"], 1);
    assert!(report.get("passes").is_none());
    assert_eq!(
        report["error"], "no native Messages provider configured",
        "the run has to reach the model passes"
    );

    // Without a record the same pack skips on worthiness, as the fixture replay does.
    let bare_report = root.path().join("bare-report.json");
    let (ok, report) = run(json!([]), &covered_input, &bare_report);
    assert!(ok, "{report}");
    assert_eq!(report["worthiness"]["components"]["alreadyCovered"], 0);
    assert_eq!(report["passes"]["action"], "skip");
}

/// The dry-run ends failed with the model failure class, and neither the report
/// nor stderr ever carries the response body or the credential.
#[tokio::test]
async fn dry_run_reports_the_model_failure_class_without_the_body() {
    use std::process::Command;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    let bin = env!("CARGO_BIN_EXE_pokoin-newsroom");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_string("Anthropic error envelope mentioning NEVER-LEAKS"),
        )
        .mount(&server)
        .await;
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    store::atomic_json(&data.join(store::STORIES), &json!([])).unwrap();
    store::atomic_json(
        &data.join(store::STATE),
        &json!({"attempts":[],"updates":{}}),
    )
    .unwrap();
    let captured = fixture("live-evidence.json");
    // A covered story is never skipped for worthiness, so the run reaches the model.
    store::atomic_json(
        &data.join(store::RECORDS),
        &json!([{"id":"rec","canonicalStoryId":captured["pack"]["canonicalStoryId"],
            "language":"en","slug":"already","status":"published","datePublished":"2026-10-05T07:00:00Z"}]),
    )
    .unwrap();
    let input = root.path().join("input.json");
    store::atomic_json(&input, &json!({"pack": captured["pack"], "memory": ""})).unwrap();
    let report = root.path().join("report.json");
    let output = Command::new(bin)
        .args(["dry-run", "--input"])
        .arg(&input)
        .args(["--data-dir"])
        .arg(&data)
        .args(["--output"])
        .arg(&report)
        .args(["--now", "2026-10-05T18:00:00Z"])
        .env("POKO_NEWSROOM_CLAUDE_PROVIDER", "anthropic")
        .env("POKO_NEWSROOM_ANTHROPIC_BASE_URL", server.uri())
        .env(
            "POKO_NEWSROOM_ANTHROPIC_API_KEY",
            "credential-that-must-NEVER-LEAKS",
        )
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "a failed model call is a failed run"
    );
    let report = store::strict_read(&report).unwrap();
    assert_eq!(report["passes"]["ok"], false);
    assert_eq!(report["passes"]["reason"], "auth");
    assert_eq!(report["passes"]["errors"], json!([]));
    assert_eq!(report["modelCalls"], 1);
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    assert!(stderr.contains("auth"), "{stderr}");
    for written in [stderr, report.to_string()] {
        assert!(!written.contains("NEVER-LEAKS"), "leaked: {written}");
    }
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

/// The snapshot is a copy, so a destination inside the source would have the
/// copy read the files it is writing and the original stops being one.
#[test]
fn snapshot_refuses_a_destination_inside_the_source_and_creates_nothing() {
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
    let inside = src.join("snapshots/today");
    let error = handover::snapshot(&src, &inside).unwrap_err().to_string();
    assert!(error.contains("inside the source directory"), "{error}");
    assert!(!inside.exists(), "the check runs before anything is made");
    assert!(!src.join("snapshots").exists());
    // The source itself is refused too, however it is spelled.
    assert!(handover::snapshot(&src, &src).is_err());
    let back_again = src
        .join("snapshots")
        .join("..")
        .join(src.file_name().unwrap());
    assert!(handover::snapshot(&src, &back_again).is_err());
    // A symlinked parent must not smuggle the destination back into the source.
    let real = root.path().join("real/data");
    fs::create_dir_all(&real).unwrap();
    for (name, value) in [
        (store::RECORDS, &f["records"]),
        (store::STORIES, &f["stories"]),
        (store::STATE, &f["state"]),
    ] {
        store::atomic_json(&real.join(name), value).unwrap();
    }
    let link = root.path().join("link");
    symlink(&real, &link).unwrap();
    let error = handover::snapshot(&real, &link.join("snap"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("inside the source directory"), "{error}");
    assert!(
        !real.join("snap").exists(),
        "the refusal must not create the destination through the link"
    );
    // Only outside the source does the snapshot run.
    let dest = root.path().join("snapshot");
    assert!(handover::snapshot(&src, &dest).is_ok());
}

/// No command silently reads a relative "data" directory, and `serve` never
/// substitutes the v2 export directory for the F16 legacy mount.
#[test]
fn cli_commands_fail_closed_without_an_explicit_data_directory() {
    use std::process::Command;
    let bin = env!("CARGO_BIN_EXE_pokoin-newsroom");
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("cwd");
    fs::create_dir(&cwd).unwrap();
    let out = cwd.join("out.json");
    let cases: Vec<Vec<String>> = vec![
        vec!["preflight".into()],
        vec!["plan".into()],
        vec![
            "snapshot".into(),
            "--output".into(),
            out.display().to_string(),
        ],
        vec![
            "dry-run".into(),
            "--input".into(),
            cwd.join("missing.json").display().to_string(),
            "--output".into(),
            out.display().to_string(),
        ],
    ];
    for case in &cases {
        let run = Command::new(bin)
            .args(case)
            .env_remove("NEWSROOM_DATA_DIR")
            .current_dir(&cwd)
            .output()
            .unwrap();
        assert!(!run.status.success(), "{case:?}");
        let error = String::from_utf8_lossy(&run.stderr).to_lowercase();
        assert!(
            error.contains("--data-dir") && error.contains("newsroom_data_dir"),
            "{case:?} names neither way to give a data directory: {error}"
        );
    }
    assert!(
        !cwd.join("data").exists() && !out.exists(),
        "a missing data directory must not be created relative to the cwd"
    );
    // The stateless commands keep working, and report the mount they lack.
    let status = Command::new(bin)
        .arg("status")
        .env_remove("NEWSROOM_DATA_DIR")
        .output()
        .unwrap();
    assert!(status.status.success());
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert!(
        array(&status["gaps"])
            .iter()
            .any(|gap| gap.as_str().unwrap_or("")
                == "Mount F16 legacy newsroom-articles.json from the checkout data directory"),
        "{status}"
    );
    // `serve` fails on the legacy mount before it ever binds a socket.
    let mut serve = Command::new(bin)
        .args(["serve", "--bind", "127.0.0.1:28317", "--data-dir"])
        .arg(&cwd)
        .env_remove("NEWSROOM_DATA_DIR")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match serve.try_wait().unwrap() {
            Some(_) => break,
            None if std::time::Instant::now() > deadline => {
                let _ = serve.kill();
                panic!("serve accepted a missing --legacy-data-dir and started listening");
            }
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    let served = serve.wait_with_output().unwrap();
    assert!(!served.status.success());
    assert!(
        String::from_utf8_lossy(&served.stderr).contains("--legacy-data-dir"),
        "{}",
        String::from_utf8_lossy(&served.stderr)
    );
}
