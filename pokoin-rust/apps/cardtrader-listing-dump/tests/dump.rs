//! The dump binary against a scripted fake bridge (python3) and a fake
//! new-printings query: order, resume, deadline, block and broken-bridge cases.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

const FAKE_BRIDGE: &str = r#"
import json,sys
script=json.load(open(sys.argv[1]))
log=open(sys.argv[2],"a")
for line in sys.stdin:
    req=json.loads(line);eid=str(req["params"]["expansion_id"]);log.write(eid+"\n");log.flush()
    act=script.get(eid,{"book":{}})
    if act.get("exit"):sys.exit(0)
    if "error" in act:sys.stdout.write(json.dumps({"id":req["id"],"error":act["error"]},separators=(",",":"))+"\n")
    elif "raw" in act:sys.stdout.write(act["raw"].replace("{ID}",json.dumps(req["id"]))+"\n")
    else:sys.stdout.write('{"id":'+json.dumps(req["id"])+',"data":'+json.dumps(act["book"])+'}\n')
    sys.stdout.flush()
"#;

struct Run {
    root: PathBuf,
    dir: PathBuf,
}

impl Run {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ct-dump-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = dir.join("2026-10-14");
        std::fs::create_dir_all(root.join("listing-books")).unwrap();
        for (game, slug) in [(1, "magic"), (5, "pokemon")] {
            std::fs::write(
                root.join(format!("pokoin_{slug}-target.json")),
                json!({"cardtraderGameId": game, "schema": format!("marketplace_{slug}"), "table": "cardtrader_blueprints"})
                    .to_string(),
            )
            .unwrap();
        }
        std::fs::write(
            root.join("_expansions-all.json"),
            json!([
                {"id": 101, "game_id": 1, "code": "a"},
                {"id": 102, "game_id": 1, "code": "b"},
                {"id": 201, "game_id": 5, "code": "c"},
                {"id": 999, "game_id": 77, "code": "not a live game"}
            ])
            .to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("bridge.py"), FAKE_BRIDGE).unwrap();
        Self { root, dir }
    }

    fn books(&self) -> PathBuf {
        self.root.join("listing-books")
    }

    /// Run the dump; `script` maps expansion id → action for the fake bridge.
    fn run(&self, script: Value, env: &[(&str, &str)]) -> (i32, Value, Vec<String>) {
        std::fs::write(self.dir.join("script.json"), script.to_string()).unwrap();
        let log = self.dir.join("requests.log");
        let _ = std::fs::remove_file(&log);
        let mut command = Command::new(env!("CARGO_BIN_EXE_pokoin-cardtrader-listing-dump"));
        command
            .env("POKOIN_CATALOG_RUN_ROOT", &self.root)
            .env(
                "POKOIN_CT_BRIDGE_CMD",
                format!(
                    "python3 {} {} {}",
                    self.dir.join("bridge.py").display(),
                    self.dir.join("script.json").display(),
                    log.display()
                ),
            )
            // Expansion 102 has printings imported today: it goes first.
            .env("POKOIN_DUMP_PSQL", "printf '%s\\n' 102 #")
            .env("POKOIN_DUMP_INFLIGHT", "2");
        for (key, value) in env {
            command.env(key, value);
        }
        let output = command.output().unwrap();
        let status: Value =
            serde_json::from_slice(&std::fs::read(self.root.join("listing-dump-status.json")).unwrap()).unwrap();
        let requests = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect();
        (output.status.code().unwrap_or(-1), status, requests)
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn read_ctb(path: &Path) -> Value {
    ctbook::read(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn fresh_run_stores_every_book_in_priority_order() {
    let run = Run::new("fresh");
    let books = json!({
        "101": {"book": {"1": [{"id": 1, "price_cents": 5}]}},
        "102": {"book": {"2": [{"id": 2}, {"id": 3}]}},
        "201": {"book": {"3": []}}
    });
    let (code, status, requests) = run.run(books.clone(), &[]);
    assert_eq!(code, 0, "{status}");
    assert_eq!(requests, vec!["102", "201", "101"], "new printings, then Pokémon, then the rest");
    assert_eq!(status["totalExpansions"], 3);
    assert_eq!(status["completed"], 3);
    assert_eq!(status["blueprintsWithListings"], 3);
    assert_eq!(status["listings"], 3);
    assert_eq!(status["newPrintingExpansions"], 1);
    assert_eq!(status["newPrintingExpansionsCompleted"], 1);
    assert_eq!(status["games"], json!([1, 5]));
    assert_eq!(status["errors"], json!([]));
    assert!(status["finishedAt"].is_string());
    for (file, id) in [("1-101.ctb", "101"), ("1-102.ctb", "102"), ("5-201.ctb", "201")] {
        assert_eq!(read_ctb(&run.books().join(file)), books[id]["book"], "{file}");
    }
}

#[test]
fn resume_counts_ctb_and_legacy_gzip_books_and_redownloads_a_corrupt_one() {
    let run = Run::new("resume");
    std::fs::write(
        run.books().join("1-101.ctb"),
        ctbook::write(&json!({"1": [{"id": 1}], "2": [{"id": 2}]}), 9).unwrap(),
    )
    .unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(3));
    gz.write_all(json!({"3": [{"id": 3}, {"id": 4}, {"id": 5}]}).to_string().as_bytes())
        .unwrap();
    std::fs::write(run.books().join("5-201.json.gz"), gz.finish().unwrap()).unwrap();
    std::fs::write(run.books().join("1-102.ctb"), b"CTB1 truncated").unwrap();
    let (code, status, requests) = run.run(json!({"102": {"book": {"9": [{"id": 9}]}}}), &[]);
    assert_eq!(code, 0, "{status}");
    assert_eq!(requests, vec!["102"], "only the corrupt book is fetched again");
    assert_eq!(status["completed"], 3);
    assert_eq!(status["blueprintsWithListings"], 4);
    assert_eq!(status["listings"], 6);
    assert!(run.books().join("1-102.ctb.corrupt").exists());
    assert_eq!(read_ctb(&run.books().join("1-102.ctb")), json!({"9": [{"id": 9}]}));
}

#[test]
fn a_cloudflare_block_stops_the_run_and_keeps_collected_books() {
    let run = Run::new("blocked");
    let (code, status, _) = run.run(
        json!({"102": {"error": "HTTPError: HTTP Error 403: Forbidden"}}),
        &[],
    );
    assert_eq!(code, 1);
    assert!(status["blocked"].as_str().unwrap().contains("Cloudflare"));
    assert_eq!(status["errors"].as_array().unwrap().len(), 1, "{status}");
    assert_eq!(status["errors"][0]["expansionId"], 102);
    assert_eq!(status["completed"], 0);
}

#[test]
fn the_deadline_stops_before_any_request() {
    let run = Run::new("deadline");
    let (code, status, requests) = run.run(json!({}), &[("POKOIN_DUMP_MAX_SECONDS", "0")]);
    assert_eq!(code, 75);
    assert_eq!(status["stoppedAtDeadline"], true);
    assert!(requests.is_empty());
}

#[test]
fn a_bridge_that_exits_is_reported_as_an_unreadable_reply() {
    let run = Run::new("exit");
    let (code, status, _) = run.run(json!({"102": {"exit": true}}), &[]);
    assert_eq!(code, 1);
    assert_eq!(
        status["errors"][0]["error"],
        "Bridge closed or sent an unreadable reply",
        "{status}"
    );
}

#[test]
fn a_book_that_is_not_an_object_is_an_error() {
    let run = Run::new("shape");
    let (code, status, _) = run.run(
        json!({"102": {"raw": "{\"id\":{ID},\"data\":[1,2]}"}}),
        &[],
    );
    assert_eq!(code, 1);
    assert_eq!(status["errors"][0]["error"], "ValueError: Expected listing book");
    assert_eq!(status["completed"], 2, "the other books are still stored: {status}");
}
