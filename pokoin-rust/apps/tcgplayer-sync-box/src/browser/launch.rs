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
    match launch_attempt(&binary, &profile, options.headless).await {
        Ok(chrome) => Ok(chrome),
        Err(error) => {
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
            launch_attempt(&binary, &profile, options.headless).await
        }
    }
}

async fn launch_attempt(binary: &Path, profile: &Path, headless: bool) -> anyhow::Result<Chrome> {
    let mut child = build_chrome_command(binary, profile, headless)
        .spawn()
        .with_context(|| format!("could not start {}", binary.display()))?;
    let stderr = child.stderr.take().context("chrome stderr was not piped")?;
    let port = match tokio::task::spawn_blocking(move || wait_for_devtools(stderr)).await {
        Ok(Ok(port)) => port,
        Ok(Err(failure)) => {
            kill_child(&mut child);
            return Err(anyhow::Error::new(failure));
        }
        Err(error) => {
            kill_child(&mut child);
            anyhow::bail!("chrome debug port wait failed: {error}");
        }
    };
    Ok(Chrome { child, port })
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

fn kill_child(child: &mut Child) {
    let id = child.id();
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{id}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
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
}
