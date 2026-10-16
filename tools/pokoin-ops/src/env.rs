//! Host-local env files (KEY=VALUE). Values already in the process environment win,
//! so a systemd Environment= line overrides the file.

use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/root"))
}

/// The uptime mailer's env files first (they hold the Resend key), then alerts.env.
pub fn default_files() -> Vec<PathBuf> {
    let h = home();
    vec![
        PathBuf::from("/etc/pokoin/uptime-mail.env"),
        PathBuf::from("/etc/pokoin/alerts.env"),
        h.join(".config/pokoin/uptime-mail.env"),
        h.join(".config/pokoin/alerts.env"),
    ]
}

pub fn parse(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let value = value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        out.push((key.to_string(), value.to_string()));
    }
    out
}

/// Called once at startup, before any thread exists.
pub fn load(paths: &[PathBuf]) {
    for path in paths {
        load_file(path);
    }
}

fn load_file(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for (key, value) in parse(&text) {
        if std::env::var_os(&key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

pub fn get(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn get_or(key: &str, default: &str) -> String {
    get(key).unwrap_or_else(|| default.to_string())
}

pub fn get_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| get("HOSTNAME"))
        .unwrap_or_else(|| "unknown-host".into())
}

/// Root keeps state in /var/lib; a user unit in ~/.local/state.
pub fn state_dir() -> PathBuf {
    if let Some(dir) = get("POKOIN_OPS_STATE_DIR") {
        return PathBuf::from(dir);
    }
    if unsafe { libc::geteuid() } == 0 {
        PathBuf::from("/var/lib/pokoin-ops")
    } else {
        home().join(".local/state/pokoin-ops")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quotes_comments_and_export() {
        let got = parse(
            "# comment\nRESEND_API_KEY=\"re_123\"\nexport A='b c'\n  \nBAD LINE\nX=1=2\n-bad=1\n",
        );
        assert_eq!(
            got,
            vec![
                ("RESEND_API_KEY".into(), "re_123".into()),
                ("A".into(), "b c".into()),
                ("X".into(), "1=2".into()),
            ]
        );
    }
}
