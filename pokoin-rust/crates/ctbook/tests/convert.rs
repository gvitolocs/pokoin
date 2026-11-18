//! `ctbook convert` on a folder of `.json.gz` books: verify, then delete.

use std::io::Write;
use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

fn gz(path: &Path, book: &Value) {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(3));
    encoder.write_all(book.to_string().as_bytes()).unwrap();
    std::fs::write(path, encoder.finish().unwrap()).unwrap();
}

fn ctbook(args: &[&str]) -> (i32, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_ctbook")).args(args).output().unwrap();
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
    )
}

#[test]
fn convert_verifies_then_deletes_and_keeps_what_it_cannot_convert() {
    let dir = std::env::temp_dir().join(format!("ctbook-convert-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let shop = json!({"id": 7, "username": "shop", "can_sell_via_hub": true});
    let books = [
        ("1-101", json!({"1": [{"id": 1, "user": shop}, {"id": 2, "user": {"id": 8, "username": "b"}}]})),
        ("1-102", json!({"2": [{"id": 3, "user": shop, "price_cents": 250}]})),
        ("5-201", json!({"3": []})),
    ];
    for (name, book) in &books {
        gz(&dir.join(format!("{name}.json.gz")), book);
    }
    // Stored in both formats already (a run that switched dumps).
    let both = json!({"4": [{"id": 9}]});
    gz(&dir.join("5-202.json.gz"), &both);
    std::fs::write(dir.join("5-202.ctb"), ctbook::write(&both, 9).unwrap()).unwrap();
    // Unreadable original: must stay.
    std::fs::write(dir.join("5-203.json.gz"), b"\x1f\x8bnot gzip").unwrap();

    let mut args = vec!["convert".to_string(), "--delete".into(), "--jobs".into(), "2".into()];
    for name in ["1-101", "1-102", "5-201", "5-202", "5-203"] {
        args.push(dir.join(format!("{name}.json.gz")).to_string_lossy().to_string());
    }
    let (code, out) = ctbook(&args.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(code, 1, "one book could not be converted: {out}");
    assert!(out.contains("converted 3") && out.contains("already 1") && out.contains("failed 1"), "{out}");

    for (name, book) in &books {
        assert!(!dir.join(format!("{name}.json.gz")).exists(), "{name}.json.gz should be gone");
        let (code, json) = ctbook(&["decode", &dir.join(format!("{name}.ctb")).to_string_lossy()]);
        assert_eq!(code, 0);
        assert_eq!(serde_json::from_str::<Value>(&json).unwrap(), *book, "{name}");
    }
    assert!(!dir.join("5-202.json.gz").exists());
    assert!(dir.join("5-203.json.gz").exists(), "an unreadable book is kept");
    assert!(!dir.join("5-203.ctb").exists());
    assert_eq!(
        std::fs::read_to_string(dir.join(ctbook::SELLERS_FILE)).unwrap().lines().count(),
        2,
        "the shared seller is stored once"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
