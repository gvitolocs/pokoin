//! Start Chrome with a loopback debug port and kill it when the portal drops.
//!
//! The port is bound to 127.0.0.1, so nothing off this machine can attach.
//! Any other process on the box still can. The box is the seller's own computer.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::Context;

use super::config::PortalConfig;

/// Pause between page actions. Tests pass a zero range; the CLI uses [`ACTION_GAP_MS`].
pub const ACTION_GAP_MS: (u64, u64) = (300, 1200);
pub const TYPE_GAP_MS: (u64, u64) = (40, 140);

#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub profile_dir: PathBuf,
    pub chrome: Option<PathBuf>,
    pub headless: bool,
    pub config: PortalConfig,
    pub action_gap_ms: (u64, u64),
}

pub struct Chrome {
    child: Child,
    pub port: u16,
}

impl Chrome {
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Chrome {
    fn drop(&mut self) {
        kill_child(&mut self.child);
    }
}

/// `--chrome`, then `CHROME` / `POKOIN_CHROME`, then the usual install paths.
pub fn find_chrome(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return path.is_file().then(|| path.to_path_buf());
    }
    for key in ["CHROME", "POKOIN_CHROME"] {
        if let Some(value) = std::env::var_os(key) {
            let path = PathBuf::from(value);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
    let mut candidates = vec![PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            for name in names {
                candidates.push(dir.join(name));
            }
        }
    }
    for name in names {
        candidates.push(PathBuf::from("/usr/bin").join(name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Stderr lines kept for error messages, and the per-line character cap.
const STDERR_TAIL_LINES: usize = 8;
const STDERR_LINE_MAX_CHARS: usize = 200;
/// Pause before the one retry after Chrome died before opening the debug port.
const RETRY_DELAY: Duration = Duration::from_millis(500);

pub async fn launch(options: &LaunchOptions) -> anyhow::Result<Chrome> {
    let binary = find_chrome(options.chrome.as_deref()).context("could not find Chrome; set --chrome or CHROME")?;
    let profile = options.profile_dir.canonicalize().unwrap_or_else(|_| options.profile_dir.clone());
    std::fs::create_dir_all(&profile).with_context(|| format!("could not create {}", profile.display()))?;
    clear_stale_singleton(&profile, None)?;
    match launch_attempt(&binary, &profile, options.headless).await {
        Ok(chrome) => Ok(chrome),
        Err(AttemptFailure { error, reaped_pid }) => {
            let retryable = matches!(
                error.downcast_ref::<DevtoolsFailure>(),
                Some(DevtoolsFailure::EarlyExit(_))
            );
            if !retryable {
                return Err(error);
            }
            // Chrome occasionally dies once at startup on a loaded host (seen on the
            // release gate); a fresh spawn with the same profile usually clears it.
            tokio::time::sleep(RETRY_DELAY).await;
            clear_stale_singleton(&profile, reaped_pid)?;
            launch_attempt(&binary, &profile, options.headless)
                .await
                .map_err(|attempt| attempt.error)
        }
    }
}

/// A launch attempt that failed. `reaped_pid` is the pid of the Chrome this
/// attempt killed and reaped, if it got that far: the retry uses it to prove a
/// singleton lock naming that pid is stale even where liveness cannot be
/// checked (no `/proc`, no `nix`).
struct AttemptFailure {
    error: anyhow::Error,
    reaped_pid: Option<u32>,
}

async fn launch_attempt(binary: &Path, profile: &Path, headless: bool) -> Result<Chrome, AttemptFailure> {
    let mut child = build_chrome_command(binary, profile, headless)
        .spawn()
        .with_context(|| format!("could not start {}", binary.display()))
        .map_err(|error| AttemptFailure { error, reaped_pid: None })?;
    let stderr = child
        .stderr
        .take()
        .context("chrome stderr was not piped")
        .map_err(|error| AttemptFailure { error, reaped_pid: None })?;
    let port = match tokio::task::spawn_blocking(move || wait_for_devtools(stderr)).await {
        Ok(Ok(port)) => port,
        Ok(Err(failure)) => {
            let reaped_pid = kill_child(&mut child);
            return Err(AttemptFailure { error: anyhow::Error::new(failure), reaped_pid: Some(reaped_pid) });
        }
        Err(error) => {
            let reaped_pid = kill_child(&mut child);
            return Err(AttemptFailure {
                error: anyhow::anyhow!("chrome debug port wait failed: {error}"),
                reaped_pid: Some(reaped_pid),
            });
        }
    };
    Ok(Chrome { child, port })
}

/// The profile files Chrome's process singleton creates. A SIGKILLed or
/// crashed Chrome leaves them behind, and the next Chrome on the same profile
/// refuses the directory ("Failed to create a ProcessSingleton").
const SINGLETON_FILES: [&str; 3] = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/// Clear the profile's singleton locks when they are provably stale, before a
/// Chrome spawn. A lock naming a live pid belongs to another Chrome the seller
/// opened on this profile: fail with a clear message instead of fighting it.
/// Locks we cannot judge are left for Chrome's own stale-lock logic.
fn clear_stale_singleton(profile: &Path, own_reaped: Option<u32>) -> anyhow::Result<()> {
    let Ok(target) = std::fs::read_link(profile.join("SingletonLock")) else {
        return Ok(());
    };
    let Some(pid) = singleton_pid(&target) else {
        return Ok(());
    };
    match lock_state(pid, own_reaped) {
        LockState::Stale => {
            for name in SINGLETON_FILES {
                let path = profile.join(name);
                if let Err(error) = std::fs::remove_file(&path) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        return Err(error).with_context(|| format!("could not remove {}", path.display()));
                    }
                }
            }
            Ok(())
        }
        LockState::InUse => Err(anyhow::anyhow!(
            "the box's Chrome profile is in use by pid {pid}; close that Chrome window"
        )),
        LockState::Unknown => Ok(()),
    }
}

/// The pid in a `<hostname>-<pid>` SingletonLock target.
fn singleton_pid(target: &Path) -> Option<u32> {
    let (_, pid) = target.to_str()?.rsplit_once('-')?;
    pid.parse().ok()
}

enum LockState {
    Stale,
    InUse,
    Unknown,
}

fn lock_state(pid: u32, own_reaped: Option<u32>) -> LockState {
    if pid == std::process::id() {
        // Our own pid is trivially alive.
        return LockState::InUse;
    }
    match pid_alive(pid) {
        Some(true) => LockState::InUse,
        Some(false) => LockState::Stale,
        // No /proc here: trust only a lock that names the child this process
        // killed and reaped.
        None => {
            if own_reaped == Some(pid) {
                LockState::Stale
            } else {
                LockState::Unknown
            }
        }
    }
}

/// `Some(true)` alive, `Some(false)` gone, `None` cannot tell on this platform.
fn pid_alive(pid: u32) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        let proc_entry = format!("/proc/{pid}");
        Some(Path::new(&proc_entry).exists())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

fn build_chrome_command(binary: &Path, profile: &Path, headless: bool) -> Command {
    let mut command = Command::new(binary);
    command
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--remote-debugging-port=0")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--remote-allow-origins=*")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--window-size=1280,900")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if headless {
        command.arg("--headless=new");
    }
    command.arg("about:blank");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

fn wait_for_devtools(stderr: std::process::ChildStderr) -> Result<u16, DevtoolsFailure> {
    let (tx, rx) = std::sync::mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                // The waiter has the port. Keep reading so Chrome's pipe cannot fill.
                continue;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut recent: Vec<String> = Vec::new();
    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left.min(Duration::from_millis(200))) {
            Ok(line) => {
                if let Some(port) = devtools_port(&line) {
                    return Ok(port);
                }
                recent.push(line);
                if recent.len() > STDERR_TAIL_LINES {
                    recent.remove(0);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(DevtoolsFailure::EarlyExit(stderr_tail(&recent)));
            }
        }
    }
    Err(DevtoolsFailure::Timeout(stderr_tail(&recent)))
}

/// Why the debug port never opened. The message carries the stderr tail when
/// Chrome said anything; `EarlyExit` is the only variant `launch` retries.
#[derive(Debug)]
enum DevtoolsFailure {
    EarlyExit(String),
    Timeout(String),
}

impl std::fmt::Display for DevtoolsFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (base, tail) = match self {
            DevtoolsFailure::EarlyExit(tail) => ("chrome exited before the debug port opened", tail),
            DevtoolsFailure::Timeout(tail) => ("chrome did not open a debug port within 20s", tail),
        };
        if tail.is_empty() {
            f.write_str(base)
        } else {
            write!(f, "{base} | {tail}")
        }
    }
}

impl std::error::Error for DevtoolsFailure {}

/// Last [`STDERR_TAIL_LINES`] lines joined with " | ", each trimmed and capped
/// at [`STDERR_LINE_MAX_CHARS`] characters.
fn stderr_tail(lines: &[String]) -> String {
    let start = lines.len().saturating_sub(STDERR_TAIL_LINES);
    lines[start..]
        .iter()
        .map(|line| {
            let line = line.trim();
            match line.char_indices().nth(STDERR_LINE_MAX_CHARS) {
                Some((cut, _)) => &line[..cut],
                None => line,
            }
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

pub fn devtools_port(line: &str) -> Option<u16> {
    let rest = line.split("ws://").nth(1)?;
    let host = rest.split(['/', ' ']).next()?;
    let (name, port) = host.rsplit_once(':')?;
    if name != "127.0.0.1" {
        return None;
    }
    port.parse().ok()
}

/// How long a killed Chrome group still gets to actually die before we force
/// it again. On a loaded host (the release gate sits at load ~9) a SIGKILLed
/// process can stay unscheduled past the next spawn.
const KILL_GRACE: Duration = Duration::from_secs(3);

/// Kill the Chrome process group and do not return until the child itself is
/// reaped: whatever pid the profile's SingletonLock names must be dead by the
/// time this returns, or the next Chrome refuses the profile. Returns the pid.
fn kill_child(child: &mut Child) -> u32 {
    let id = child.id();
    #[cfg(unix)]
    kill_group(id);
    let _ = child.kill();
    if reaped_within(child, KILL_GRACE) {
        return id;
    }
    #[cfg(unix)]
    kill_group(id);
    let _ = child.kill();
    let _ = child.wait();
    id
}

#[cfg(unix)]
fn kill_group(id: u32) {
    let _ = Command::new("kill")
        .args(["-KILL", &format!("-{id}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Poll [`Child::try_wait`] until the child is reaped or the budget runs out.
fn reaped_within(child: &mut Child, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_gap_is_a_short_human_pause() {
        assert_eq!(ACTION_GAP_MS, (300, 1200));
        assert_eq!(TYPE_GAP_MS, (40, 140));
    }

    #[test]
    fn a_missing_chrome_path_is_not_used() {
        assert!(find_chrome(Some(Path::new("/no/such/chrome-for-pokoin"))).is_none());
    }

    #[test]
    fn devtools_line_is_loopback_only() {
        let line = "DevTools listening on ws://127.0.0.1:4321/devtools/browser/abc";
        assert_eq!(devtools_port(line), Some(4321));
        assert!(devtools_port("DevTools listening on ws://10.0.0.8:4321/devtools/browser/abc").is_none());
    }

    #[test]
    fn stderr_tail_keeps_the_last_eight_lines() {
        let lines: Vec<String> = (0..12).map(|i| format!("line-{i}")).collect();
        let expected = (4..12).map(|i| format!("line-{i}")).collect::<Vec<_>>().join(" | ");
        assert_eq!(stderr_tail(&lines), expected);
        assert_eq!(stderr_tail(&[]), "");
    }

    #[test]
    fn stderr_tail_trims_whitespace_and_caps_each_line() {
        let long = "x".repeat(STDERR_LINE_MAX_CHARS + 100);
        let tail = stderr_tail(&[format!("  {long} "), "ok".to_string()]);
        assert_eq!(tail, format!("{} | ok", "x".repeat(STDERR_LINE_MAX_CHARS)));
    }

    #[test]
    fn devtools_failure_text_appends_the_stderr_tail() {
        let dbus = "[4044:4044]: Failed to connect to the bus".to_string();
        assert_eq!(
            DevtoolsFailure::EarlyExit(stderr_tail(&[dbus.clone()])).to_string(),
            format!("chrome exited before the debug port opened | {dbus}")
        );
        assert_eq!(
            DevtoolsFailure::Timeout(stderr_tail(&[])).to_string(),
            "chrome did not open a debug port within 20s"
        );
    }

    /// A throwaway profile dir for the singleton-lock tests.
    fn temp_profile(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pokoin-launch-test-{}-{tag}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp profile");
        dir
    }

    #[test]
    fn the_singleton_pid_is_after_the_last_dash() {
        assert_eq!(singleton_pid(Path::new("gate-runner-12345")), Some(12345));
        assert_eq!(singleton_pid(Path::new("gate-runner-host-12345")), Some(12345));
        assert_eq!(singleton_pid(Path::new("plain")), None);
        assert_eq!(singleton_pid(Path::new("host-not-a-pid")), None);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_stale_singleton_lock_is_removed_with_its_siblings() {
        let profile = temp_profile("stale");
        // Above every kernel's pid_max: no process can own it.
        let dead = 999_999_999;
        std::os::unix::fs::symlink(format!("gate-runner-{dead}"), profile.join("SingletonLock")).expect("lock");
        std::fs::write(profile.join("SingletonSocket"), b"").expect("socket");
        std::fs::write(profile.join("SingletonCookie"), b"").expect("cookie");
        clear_stale_singleton(&profile, None).expect("clear");
        for name in SINGLETON_FILES {
            // exists() follows the link; judge the link itself.
            assert!(profile.join(name).symlink_metadata().is_err(), "{name} should be gone");
        }
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    #[cfg(unix)]
    fn a_lock_on_our_own_reaped_child_is_treated_as_stale() {
        let profile = temp_profile("reaped");
        let dead = 999_999_999;
        std::os::unix::fs::symlink(format!("gate-runner-{dead}"), profile.join("SingletonLock")).expect("lock");
        clear_stale_singleton(&profile, Some(dead)).expect("clear");
        assert!(profile.join("SingletonLock").symlink_metadata().is_err());
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    #[cfg(unix)]
    fn a_live_singleton_pid_is_kept_and_reported() {
        let profile = temp_profile("live");
        let mine = std::process::id();
        std::os::unix::fs::symlink(format!("gate-runner-{mine}"), profile.join("SingletonLock")).expect("lock");
        let error = clear_stale_singleton(&profile, None).expect_err("in use");
        let message = error.to_string();
        assert!(message.contains(&format!("in use by pid {mine}")), "{message}");
        assert!(message.contains("close that Chrome window"), "{message}");
        assert!(profile.join("SingletonLock").symlink_metadata().is_ok());
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn a_profile_without_a_singleton_lock_needs_nothing() {
        let profile = temp_profile("empty");
        clear_stale_singleton(&profile, None).expect("clear");
        assert!(!profile.join("SingletonLock").exists());
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    #[cfg(unix)]
    fn a_singleton_lock_we_cannot_judge_is_left_for_chrome() {
        let profile = temp_profile("opaque");
        std::fs::write(profile.join("SingletonLock"), b"not a symlink").expect("lock");
        clear_stale_singleton(&profile, None).expect("clear");
        assert!(profile.join("SingletonLock").exists());
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    #[cfg(unix)]
    fn kill_child_leaves_the_child_reaped() {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("sleep");
        command.arg("30").process_group(0);
        let mut child = command.spawn().expect("sleep");
        let id = kill_child(&mut child);
        assert!(child.try_wait().expect("reaped").is_some());
        #[cfg(target_os = "linux")]
        assert_eq!(pid_alive(id), Some(false), "pid {id} should be gone");
    }
}
