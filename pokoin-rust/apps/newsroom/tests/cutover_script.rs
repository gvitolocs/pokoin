//! Orchestration of scripts/cutover-newsroom-rust.sh against local command fakes only.
//! Nothing here reaches systemctl, a production publisher or a real service unit.
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

const NODE: &str = "pokoin-newsroom.service";
const RUST: &str = "pokoin-newsroom-rust.service";

const FAKE_BINARY: &str = r#"#!/bin/bash
printf 'binary %s\n' "$1" >> "$TRACE"
case "$1" in
preflight) [[ "$GATE" = yes ]];;
snapshot) exit 0;;
ready) [[ "$HEALTH" = yes ]];;
esac
"#;

const FAKE_SYSTEMCTL: &str = r#"#!/bin/bash
shift
printf 'systemctl %s\n' "$*" >> "$TRACE"
case "$1" in
is-active) unit=${@: -1}; [[ -f "$FAKE_ROOT/$unit" ]];;
start) touch "$FAKE_ROOT/$2";;
stop) if [[ "$2" = pokoin-newsroom-rust.service && "$STOP" = no ]]; then exit 1; fi; rm -f "$FAKE_ROOT/$2";;
esac
"#;

struct Run {
    code: i32,
    trace: String,
    node_active: bool,
    rust_active: bool,
}

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repository root")
        .join("scripts/cutover-newsroom-rust.sh")
}

fn write_fake(dir: &Path, name: &str, body: &str) {
    let path = dir.join(name);
    fs::write(&path, body).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn yes(flag: bool) -> &'static str {
    if flag {
        "yes"
    } else {
        "no"
    }
}

fn cutover(gate: bool, health: bool, stop: bool) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("data")).unwrap();
    fs::write(root.join("env"), "LOCAL_ONLY=test\n").unwrap();
    fs::set_permissions(root.join("env"), fs::Permissions::from_mode(0o600)).unwrap();
    write_fake(root, "newsroom", FAKE_BINARY);
    write_fake(root, "systemctl", FAKE_SYSTEMCTL);
    // The readiness poll must not really wait between its 30 attempts.
    write_fake(root, "sleep", "#!/bin/sh\nexit 0\n");
    fs::write(root.join(NODE), "").unwrap();
    let trace = root.join("trace");
    let output = Command::new("bash")
        .arg(script())
        .arg("--execute")
        .envs(env::vars())
        .env(
            "PATH",
            format!("{}:{}", root.display(), env::var("PATH").unwrap()),
        )
        .env("NEWSROOM_RUST_BINARY", root.join("newsroom"))
        .env("NEWSROOM_DATA_DIR", root.join("data"))
        .env("NEWSROOM_ENV_FILE", root.join("env"))
        .env("NEWSROOM_BACKUP_DIR", root.join("backups"))
        .env("TRACE", &trace)
        .env("FAKE_ROOT", root)
        .env("GATE", yes(gate))
        .env("HEALTH", yes(health))
        .env("STOP", yes(stop))
        .output()
        .unwrap();
    Run {
        code: output.status.code().unwrap_or(-1),
        trace: fs::read_to_string(&trace).unwrap(),
        node_active: root.join(NODE).exists(),
        rust_active: root.join(RUST).exists(),
    }
}

fn starts_before(trace: &str, earlier: &str, later: &str) {
    let at = |needle: &str| {
        trace
            .find(needle)
            .unwrap_or_else(|| panic!("{needle:?} never traced:\n{trace}"))
    };
    assert!(
        at(earlier) < at(later),
        "{earlier:?} is not before {later:?}:\n{trace}"
    );
}

#[test]
fn incomplete_parity_never_touches_services() {
    let run = cutover(false, true, true);
    assert_ne!(run.code, 0);
    assert!(!run.trace.contains("systemctl"), "{}", run.trace);
    assert!(run.node_active);
    assert!(!run.rust_active);
}

#[test]
fn success_stops_node_snapshots_then_starts_rust() {
    let run = cutover(true, true, true);
    assert_eq!(run.code, 0, "{}", run.trace);
    assert!(!run.node_active);
    assert!(run.rust_active);
    starts_before(
        &run.trace,
        "stop pokoin-newsroom.service",
        "binary snapshot",
    );
    starts_before(
        &run.trace,
        "binary snapshot",
        "start pokoin-newsroom-rust.service",
    );
}

#[test]
fn failed_health_restores_node() {
    let run = cutover(true, false, true);
    assert_ne!(run.code, 0);
    assert!(run.node_active);
    assert!(!run.rust_active);
    starts_before(
        &run.trace,
        "stop pokoin-newsroom-rust.service",
        "start pokoin-newsroom.service",
    );
}

#[test]
fn failed_rust_stop_does_not_start_second_publisher() {
    let run = cutover(true, false, false);
    assert_ne!(run.code, 0);
    assert!(!run.node_active);
    assert!(run.rust_active);
    assert!(
        !run.trace.contains("start pokoin-newsroom.service\n"),
        "{}",
        run.trace
    );
}
