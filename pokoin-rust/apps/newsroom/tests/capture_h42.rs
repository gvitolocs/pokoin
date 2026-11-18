//! capture-h42 against a wiremock listener: the six public GETs, their recorded
//! status, headers and JSON body, and nothing else. No token, no auth header.
use serde_json::{json, Value};
use std::{fs, process::Command};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, Request, ResponseTemplate,
};

fn expected(query: &str) -> (u16, Value, bool) {
    match query {
        "" => (
            200,
            json!({"ok":true,"count":1,"articles":[{"slug":"rust-parity","headline":"Rust parity"}]}),
            true,
        ),
        "slug=missing-rust-parity" => (404, json!({"error":"not_found"}), true),
        "story=missing-rust-parity" => (200, json!({"ok":true,"count":0,"articles":[]}), false),
        "export=invalid" => (
            400,
            json!({"error":"export must be published or all"}),
            true,
        ),
        "export=all" => (401, json!({"error":"unauthorized"}), false),
        "export=published" => (
            200,
            json!({"ok":true,"scope":"published","count":0,"articles":[]}),
            true,
        ),
        other => panic!("unexpected query {other:?}"),
    }
}

#[tokio::test]
async fn capture_h42_records_six_public_get_responses() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/poko/news"))
        .respond_with(move |request: &Request| {
            assert!(
                !request.headers.contains_key("authorization"),
                "the capture must stay anonymous"
            );
            let query = request.url.query().unwrap_or("");
            let (status, body, cors) = expected(query);
            let mut template = ResponseTemplate::new(status)
                .insert_header("cache-control", "public, max-age=60")
                .set_body_json(body.clone());
            if cors {
                template = template.insert_header("access-control-allow-origin", "*");
            }
            template
        })
        .expect(6)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("h42-capture.json");
    let run = Command::new(env!("CARGO_BIN_EXE_pokoin-newsroom"))
        .args(["capture-h42", "--base"])
        .arg(server.uri())
        .args(["--output"])
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&run.stdout),
        "captured 6 public GET responses\n"
    );
    let raw = fs::read_to_string(&output).unwrap();
    assert!(
        raw.starts_with("{\n  \"base\":") && raw.ends_with("}\n"),
        "capture must be pretty-printed with a trailing newline: {raw}"
    );
    let document: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(document["base"], server.uri());
    assert_eq!(document["method"], "GET");
    chrono::DateTime::parse_from_rfc3339(document["capturedAt"].as_str().unwrap())
        .expect("capturedAt is RFC 3339");
    let rows = document["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 6);
    for (index, query) in [
        "",
        "slug=missing-rust-parity",
        "story=missing-rust-parity",
        "export=invalid",
        "export=all",
        "export=published",
    ]
    .iter()
    .enumerate()
    {
        let (status, body, cors) = expected(query);
        assert_eq!(rows[index]["query"], json!(query));
        assert_eq!(rows[index]["status"], json!(status));
        assert_eq!(
            rows[index]["headers"]["content-type"],
            json!("application/json")
        );
        assert_eq!(
            rows[index]["headers"]["cache-control"],
            json!("public, max-age=60")
        );
        assert_eq!(
            rows[index]["headers"]["access-control-allow-origin"],
            if cors { json!("*") } else { Value::Null }
        );
        assert_eq!(rows[index]["body"], body);
    }
}
