use std::path::Path;
use std::process::Command;

fn script() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/x-poko-cutover.sh")
}

fn run(inventory: &Path, mode: &str) -> std::process::Output {
    Command::new("bash")
        .arg(script())
        .arg(mode)
        .arg("/nonexistent-x-poko-bundle")
        .env("X_POKO_INVENTORY", inventory)
        .output()
        .unwrap()
}

#[test]
fn unfinished_inventory_blocks_check_and_apply_before_bundle_or_host_access() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/x-poko-cutover.sh");
    for mode in ["--check", "--apply"] {
        let output = Command::new("bash")
            .arg(&script)
            .arg(mode)
            .arg("/nonexistent-x-poko-bundle")
            .env_remove("X_POKO_INVENTORY")
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("CUTOVER BLOCKED"));
        assert!(stderr.contains("D05-D20"));
        assert!(stderr.contains("J10"));
        assert!(!stderr.contains("realpath"));
        assert!(!stderr.contains("must run as root"));
    }
}

/// The gate is bash + jq: a Python shim on the host cannot make it silently pass or hang.
#[test]
fn every_entry_being_verified_is_not_the_same_as_a_complete_parity() {
    let dir = tempfile::tempdir().unwrap();
    let inventory = dir.path().join("inventory.json");
    std::fs::write(
        &inventory,
        r#"{"complete":false,"entries":[{"id":"D05-D20","verified":true,"reason":"done"}]}"#,
    )
    .unwrap();
    let output = run(&inventory, "--check");
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(
        stderr,
        "CUTOVER BLOCKED: X-POKO parity is incomplete.\n",
        "only the flag, and no gap lines for a verified entry"
    );
    assert!(!stderr.contains("realpath"));
}

#[test]
fn an_inventory_that_cannot_be_read_or_parsed_blocks_closed() {
    let dir = tempfile::tempdir().unwrap();
    let cases = [
        ("missing.json", None),
        ("broken.json", Some("{ not json")),
        ("not-an-object.json", Some("null")),
        ("no-entries.json", Some(r#"{"complete":true}"#)),
        ("empty.json", Some("")),
    ];
    for (name, body) in cases {
        let inventory = dir.path().join(name);
        match body {
            Some(body) => std::fs::write(&inventory, body).unwrap(),
            None => assert!(!inventory.exists()),
        }
        let output = run(&inventory, "--apply");
        assert!(!output.status.success(), "{name} must block the cutover");
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.starts_with("CUTOVER BLOCKED"), "{name}: {stderr}");
        assert!(!stderr.contains("realpath"), "{name}: {stderr}");
        assert!(!stderr.contains("must run as root"), "{name}: {stderr}");
    }
}

/// Guards against a gate that blocks everything: with a complete, verified inventory the script
/// must continue past it and fail on the missing bundle instead.
#[test]
fn a_complete_verified_inventory_reaches_the_bundle_check() {
    let dir = tempfile::tempdir().unwrap();
    let inventory = dir.path().join("inventory.json");
    std::fs::write(
        &inventory,
        r#"{"complete":true,"entries":[{"id":"D05-D20","verified":true,"reason":"done"},{"id":"J10","verified":true,"reason":"done"}]}"#,
    )
    .unwrap();
    let output = run(&inventory, "--check");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        !stderr.contains("CUTOVER BLOCKED"),
        "the gate must let a finished inventory through: {stderr}"
    );
    assert!(!output.status.success(), "{stderr}");
}
