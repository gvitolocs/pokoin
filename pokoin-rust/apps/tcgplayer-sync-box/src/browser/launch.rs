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

pub async fn launch(options: &LaunchOptions) -> anyhow::Result<Chrome> {
    let binary = find_chrome(options.chrome.as_deref()).context("could not find Chrome; set --chrome or CHROME")?;
    let profile = options.profile_dir.canonicalize().unwrap_or_else(|_| options.profile_dir.clone());
    std::fs::create_dir_all(&profile).with_context(|| format!("could not create {}", profile.display()))?;
    let mut command = Command::new(&binary);
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
    if options.headless {
        command.arg("--headless=new");
    }
    command.arg("about:blank");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().with_context(|| format!("could not start {}", binary.display()))?;
    let stderr = child.stderr.take().context("chrome stderr was not piped")?;
    let port = match tokio::task::spawn_blocking(move || wait_for_devtools(stderr)).await {
        Ok(Ok(port)) => port,
        Ok(Err(error)) => {
            kill_child(&mut child);
            anyhow::bail!("{error}");
        }
        Err(error) => {
            kill_child(&mut child);
            anyhow::bail!("chrome debug port wait failed: {error}");
        }
    };
    Ok(Chrome { child, port })
}

fn wait_for_devtools(stderr: std::process::ChildStderr) -> Result<u16, String> {
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
    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left.min(Duration::from_millis(200))) {
            Ok(line) => {
                if let Some(port) = devtools_port(&line) {
                    return Ok(port);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("chrome exited before the debug port opened".to_string());
            }
        }
    }
    Err("chrome did not open a debug port within 20s".to_string())
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
}
