//! Deferred alerts, summarized once a week. The separate lock survives log rotation,
//! so concurrent notifiers cannot append to a file that has already been mailed.

use crate::{env, health, mail, sentinel, sys};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Record {
    at: i64,
    source: String,
    key: String,
    sev: String,
    detail: String,
}

struct Lock(File);

impl Lock {
    fn acquire(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let file = OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join("digest.lock"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Lock(file))
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); }
    }
}

fn entry(source: &str, key: &str, sev: &str, detail: &str) -> Record {
    Record {
        at: chrono::Utc::now().timestamp(),
        source: source.into(),
        key: key.into(),
        sev: sev.into(),
        detail: detail.chars().take(300).collect(),
    }
}

pub fn record(source: &str, key: &str, sev: &str, detail: &str) {
    if let Err(err) = append(&env::state_dir(), &entry(source, key, sev, detail)) {
        eprintln!("digest record: {err:#}");
    }
}

fn append(dir: &Path, entry: &Record) -> Result<()> {
    let _lock = Lock::acquire(dir)?;
    let file = OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join("digest.jsonl"))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    let mut line = serde_json::to_vec(entry)?;
    line.push(b'\n');
    (&file).write_all(&line)?;
    Ok(())
}

struct Group {
    count: usize,
    first: i64,
    last: i64,
    detail: String,
}

fn groups(path: &Path) -> Result<BTreeMap<String, Group>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(err) => return Err(err.into()),
    };
    let mut groups = BTreeMap::<String, Group>::new();
    for (i, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: Record = serde_json::from_str(&line).with_context(|| format!("digest line {}", i + 1))?;
        let group = groups.entry(entry.key).or_insert_with(|| Group {
            count: 0, first: entry.at, last: entry.at, detail: entry.detail.clone(),
        });
        group.count += 1;
        group.first = group.first.min(entry.at);
        if entry.at >= group.last {
            group.last = entry.at;
            group.detail = entry.detail;
        }
    }
    Ok(groups)
}

fn failing(path: &Path) -> BTreeSet<String> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<sentinel::State>(&b).ok())
        .map(|s| s.alerts.into_iter().filter(|(_, s)| s.alerted).map(|(k, _)| k).collect())
        .unwrap_or_default()
}

fn render(groups: &BTreeMap<String, Group>, failing: &BTreeSet<String>) -> (String, String) {
    let still = groups.keys().filter(|k| failing.contains(*k)).count();
    let subject = mail::subject(&format!("weekly: {} things, {still} still failing", groups.len()));
    let mut body = String::new();
    let mut shown = 0;
    for (active, heading) in [(true, "Still failing"), (false, "Happened, no action needed")] {
        body.push_str(&format!("{heading}\n"));
        let mut rows: Vec<_> = groups.iter().filter(|(k, _)| failing.contains(*k) == active).collect();
        rows.sort_by(|(ka, a), (kb, b)| b.count.cmp(&a.count).then(ka.cmp(kb)));
        if rows.is_empty() {
            body.push_str("  None\n");
        }
        for (key, group) in rows {
            if shown == 100 {
                break;
            }
            shown += 1;
            let detail = group.detail.split_whitespace().collect::<Vec<_>>().join(" ");
            body.push_str(&format!(
                "  {key}: {} occurrence(s), first {}, last {}\n    {detail}\n",
                group.count, health::rfc3339(group.first), health::rfc3339(group.last),
            ));
        }
        body.push('\n');
    }
    if groups.len() > shown {
        body.push_str(&format!("{} more keys omitted.\n", groups.len() - shown));
    }
    (subject, body)
}

pub fn run(dry_run: bool) -> Result<()> {
    let dir = env::state_dir();
    // These are the same roles used by the Pi system and nezopt user sentinel units.
    let state = dir.join(if sys::is_root() { "sentinel-pi.json" } else { "sentinel-nezopt.json" });
    deliver(&dir, &state, dry_run || env::get("POKOIN_OPS_DRY_RUN").is_some(), mail::send)
}

fn deliver(dir: &Path, state: &Path, dry_run: bool, send: impl FnOnce(&str, &str) -> Result<()>) -> Result<()> {
    // A dry run must not even create a lock or state directory.
    let _lock = if dry_run { None } else { Some(Lock::acquire(dir)?) };
    let path = dir.join("digest.jsonl");
    let groups = groups(&path)?;
    if groups.is_empty() {
        return Ok(());
    }
    let (subject, body) = render(&groups, &failing(state));
    if dry_run {
        println!("{subject}\n\n{body}");
        return Ok(());
    }
    send(&subject, &body)?;
    std::fs::rename(&path, dir.join("digest.jsonl.sent"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, at: i64, detail: &str) -> Record {
        Record { at, source: "check".into(), key: key.into(), sev: "WARN".into(), detail: detail.into() }
    }

    #[test]
    fn record_caps_detail_on_a_char_boundary() {
        let record = super::entry("unit", "a", "CRIT", &"é".repeat(400));
        assert_eq!(record.detail.chars().count(), 300);
        assert_eq!(record.source, "unit");
        assert!(record.at > 0);
    }

    #[test]
    fn dry_run_with_no_log_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("absent");
        deliver(&absent, &absent.join("state"), true, |_, _| panic!("empty")).unwrap();
        assert!(!absent.exists());
    }

    #[test]
    fn groups_sort_times_and_still_failing_first() {
        let dir = tempfile::tempdir().unwrap();
        for e in [entry("old", 30, "latest\ndetail"), entry("old", 10, "early"), entry("active", 20, "bad")] {
            append(dir.path(), &e).unwrap();
        }
        let g = groups(&dir.path().join("digest.jsonl")).unwrap();
        assert_eq!((g["old"].count, g["old"].first, g["old"].last), (2, 10, 30));
        assert_eq!(g["old"].detail, "latest\ndetail");
        let (s, b) = render(&g, &BTreeSet::from(["active".into()]));
        assert!(s.ends_with("weekly: 2 things, 1 still failing"));
        assert!(b.find("active:").unwrap() < b.find("old:").unwrap());
        assert!(b.contains("1970-01-01T00:00:10Z"));
        assert!(b.contains("latest detail"));
        assert_eq!(std::fs::metadata(dir.path().join("digest.jsonl")).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn caps_keys_and_sorts_counts() {
        let g = (0..102).map(|n| (format!("key{n:03}"), Group { count: n + 1, first: 0, last: 0, detail: "d".into() })).collect();
        let (_, body) = render(&g, &BTreeSet::new());
        assert!(body.contains("2 more keys omitted"));
        assert!(body.find("key101:").unwrap() < body.find("key100:").unwrap());
        assert!(!body.contains("key000:"));
    }

    #[test]
    fn failed_send_keeps_log_dry_run_changes_nothing_success_replaces_sent() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("missing-state");
        deliver(dir.path(), &state, false, |_, _| panic!("empty must not send")).unwrap();
        append(dir.path(), &entry("a", 0, "d")).unwrap();
        let path = dir.path().join("digest.jsonl");
        let original = std::fs::read(&path).unwrap();
        deliver(dir.path(), &state, true, |_, _| panic!("dry run must not send")).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(deliver(dir.path(), &state, false, |_, _| anyhow::bail!("mail failed")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::write(dir.path().join("digest.jsonl.sent"), "old").unwrap();
        deliver(dir.path(), &state, false, |_, _| Ok(())).unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read(dir.path().join("digest.jsonl.sent")).unwrap(), original);
    }

    #[test]
    fn concurrent_record_waits_for_rotation_and_stays_in_new_log() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &entry("before", 1, "d")).unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let writer_dir = dir.path().to_path_buf();
        let mut writer = None;
        deliver(dir.path(), &dir.path().join("missing"), false, |_, _| {
            writer = Some(std::thread::spawn(move || {
                started.send(()).unwrap();
                append(&writer_dir, &entry("after", 2, "d")).unwrap();
            }));
            ready.recv().unwrap();
            Ok(())
        }).unwrap();
        writer.unwrap().join().unwrap();
        let sent = groups(&dir.path().join("digest.jsonl.sent")).unwrap();
        let pending = groups(&dir.path().join("digest.jsonl")).unwrap();
        assert_eq!(sent.keys().map(String::as_str).collect::<Vec<_>>(), vec!["before"]);
        assert_eq!(pending.keys().map(String::as_str).collect::<Vec<_>>(), vec!["after"]);
    }

    #[test]
    fn unreadable_or_missing_state_has_no_failing_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state");
        assert!(failing(&path).is_empty());
        std::fs::write(&path, "invalid").unwrap();
        assert!(failing(&path).is_empty());
        std::fs::write(&path, r#"{"alerts":{"a":{"sev":"Warn","streak":1,"alerted":true,"since":0,"last_mail":0,"detail":"d"},"b":{"sev":"Crit","streak":1,"alerted":false,"since":0,"last_mail":0,"detail":"d"}}}"#).unwrap();
        assert_eq!(failing(&path), BTreeSet::from(["a".into()]));
    }
}
