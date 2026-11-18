//! Environment resolution shared by the daemon and the YouTube CLI commands.
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use poko_bot::youtube::{data_dir, oauth_listener_addr};

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
const NAMES: [&str; 3] = [
    "POKO_BOT_OAUTH_ADDR",
    "POKO_BOT_DATA_DIR",
    "POKO_BOT_STATE_DIR",
];

/// The harness runs tests in threads that share one process environment.
fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    let guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    for name in NAMES {
        std::env::remove_var(name);
    }
    guard
}

#[test]
fn an_empty_oauth_addr_is_absent_and_a_set_one_is_still_validated() {
    let _guard = env_guard();
    assert_eq!(oauth_listener_addr().unwrap(), None);
    for empty in ["", "   "] {
        std::env::set_var("POKO_BOT_OAUTH_ADDR", empty);
        assert_eq!(
            oauth_listener_addr().unwrap(),
            None,
            "POKO_BOT_OAUTH_ADDR={empty:?} must mean no listener"
        );
    }
    std::env::set_var("POKO_BOT_OAUTH_ADDR", "127.0.0.1:8799");
    assert_eq!(
        oauth_listener_addr().unwrap(),
        Some("127.0.0.1:8799".parse().unwrap())
    );
    std::env::set_var("POKO_BOT_OAUTH_ADDR", "0.0.0.0:8799");
    assert!(oauth_listener_addr().is_err());
    std::env::set_var("POKO_BOT_OAUTH_ADDR", "not-an-address");
    assert!(oauth_listener_addr().is_err());
}

#[test]
fn data_dir_falls_through_only_non_empty_values() {
    let _guard = env_guard();
    assert_eq!(data_dir(), PathBuf::from("/var/lib/poko-bot"));
    std::env::set_var("POKO_BOT_STATE_DIR", "/state/dir");
    assert_eq!(data_dir(), PathBuf::from("/state/dir"));
    std::env::set_var("POKO_BOT_DATA_DIR", "");
    assert_eq!(data_dir(), PathBuf::from("/state/dir"));
    std::env::set_var("POKO_BOT_DATA_DIR", "/data/dir");
    std::env::set_var("POKO_BOT_STATE_DIR", "");
    assert_eq!(data_dir(), PathBuf::from("/data/dir"));
    std::env::set_var("POKO_BOT_DATA_DIR", "  ");
    assert_eq!(data_dir(), PathBuf::from("/var/lib/poko-bot"));
}

/// Without the fix an empty POKO_BOT_OAUTH_ADDR reaches the parser, run() returns an error and the
/// daemon exits 1 instead of starting with no OAuth listener.
#[test]
fn daemon_starts_with_an_empty_oauth_addr_and_binds_no_listener() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_poko-bot"))
        .env("POKO_BOT_OAUTH_ADDR", "")
        .env("POKO_BOT_DATA_DIR", "")
        .env("POKO_BOT_STATE_DIR", dir.path())
        .env("POKO_BOT_HEALTH_ADDR", "127.0.0.1:0")
        .env("POKO_BOT_TELEGRAM", "off")
        .env("POKO_BOT_DISCORD", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(700));
    if let Some(status) = child.try_wait().unwrap() {
        let output = child.wait_with_output().unwrap();
        panic!(
            "daemon exited {status:?} with an empty POKO_BOT_OAUTH_ADDR: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    child.kill().unwrap();
    child.wait().unwrap();
}
