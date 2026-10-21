//! Host-wide gateway singleton lock per Telegram bot token (port of Hermes
//! Agent v0.22.2 #138594: boot-epoch rendezvous record instead of PIDs).
//!
//! The record format matches Hermes Node `src/gateway-lock.js`, so poko-bot and
//! the Node Poko runtime arbitrate one token when both point
//! `HERMES_GATEWAY_LOCK_DIR` at the same directory (e.g. during `poko-switch`).
//! A record blocks us only if another holder wrote it during this kernel boot
//! and its heartbeat is fresh; recycled PIDs after a reboot never count.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};

pub const STALE_MS: u64 = 90_000;
pub const HEARTBEAT: Duration = Duration::from_secs(30);
pub const RETRY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(default)]
    pub holder: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub bot_key: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub pid_ns: String,
    #[serde(default)]
    pub instance: String,
    #[serde(default)]
    pub boot_id: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub heartbeat_at: String,
}

pub enum Acquire {
    Acquired(GatewayLock),
    /// Another live gateway holds the token.
    Held(Record),
    /// Lock disabled or the directory is unusable: run without the guarantee.
    Unguarded(&'static str),
}

pub struct GatewayLock {
    path: PathBuf,
    holder: String,
    lost: Arc<AtomicBool>,
    heartbeat: tokio::task::JoinHandle<()>,
}

impl GatewayLock {
    /// True once another gateway took the token over (we must stop polling).
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::Relaxed)
    }

    pub fn release(self) {
        self.heartbeat.abort();
        if read_record(&self.path).is_some_and(|record| record.holder == self.holder) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Public bot id (before ':'), never the secret part of the token.
pub fn bot_key(token: &str) -> String {
    let head = token.split(':').next().unwrap_or_default();
    if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
        return head.to_string();
    }
    // FNV-1a: stable, non-reversible enough for a filename; Telegram tokens always hit the branch above.
    let hash = token.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |acc, byte| {
        (acc ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{hash:012x}")[..12].to_string()
}

pub fn current_boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

pub fn current_pid_namespace() -> String {
    std::fs::read_link("/proc/self/ns/pid")
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Explicit deployment identity (`HERMES_GATEWAY_INSTANCE`); one instance never runs twice.
pub fn current_instance() -> String {
    std::env::var("HERMES_GATEWAY_INSTANCE")
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

/// A fresh record can still be our own previous run that died without
/// releasing (SIGKILL, OOM): same explicit instance, or same PID namespace with
/// that PID gone or now ours. Same rule as Hermes Node `isOwnPreviousRun`.
pub fn is_own_previous_run(
    record: &Record,
    instance: &str,
    pid_ns: &str,
    pid: u32,
    alive: impl Fn(u32) -> bool,
) -> bool {
    if !instance.is_empty() && record.instance == instance {
        return true;
    }
    if !pid_ns.is_empty() && record.pid_ns == pid_ns && record.pid != 0 {
        return record.pid == pid || !alive(record.pid);
    }
    false
}

fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub fn is_record_live(record: &Record, boot_id: &str, now: u64, stale_ms: u64) -> bool {
    let Some(heartbeat) = ms_from_iso(&record.heartbeat_at) else {
        return false;
    };
    if now.saturating_sub(heartbeat) > stale_ms {
        return false;
    }
    // Legacy records without a boot id cannot prove the boot: heartbeat alone decides.
    !(!record.boot_id.is_empty() && !boot_id.is_empty() && record.boot_id != boot_id)
}

fn read_record(path: &Path) -> Option<Record> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_record(path: &Path, record: &Record) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut body = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
    body.push(b'\n');
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

pub async fn acquire(dir: &Path, enabled: bool, name: &str, token: &str) -> Acquire {
    if !enabled {
        return Acquire::Unguarded("disabled");
    }
    let key = bot_key(token);
    let path = dir.join(format!("telegram-{key}.lock"));
    let boot_id = current_boot_id();
    let host = hostname();
    let pid = std::process::id();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let holder = format!("{host}:{pid}:{nonce:08x}");

    if let Err(error) = std::fs::create_dir_all(dir) {
        tracing::warn!(error = %error, dir = %dir.display(), "gateway lock dir unusable; running unguarded");
        return Acquire::Unguarded("dir_unusable");
    }
    if let Some(current) = read_record(&path) {
        if current.holder != holder
            && is_record_live(&current, &boot_id, now_ms(), STALE_MS)
            && !is_own_previous_run(
                &current,
                &current_instance(),
                &current_pid_namespace(),
                pid,
                pid_alive,
            )
        {
            return Acquire::Held(current);
        }
    }
    let started_at = iso_from_ms(now_ms());
    let record = Record {
        holder: holder.clone(),
        name: name.to_string(),
        bot_key: key,
        hostname: host,
        pid,
        pid_ns: current_pid_namespace(),
        instance: current_instance(),
        boot_id: boot_id.clone(),
        started_at: started_at.clone(),
        heartbeat_at: started_at,
    };
    if let Err(error) = write_record(&path, &record) {
        tracing::warn!(error = %error, path = %path.display(), "gateway lock write failed; running unguarded");
        return Acquire::Unguarded("write_failed");
    }
    // Rendezvous: if two gateways raced, the last rename wins and the loser backs off.
    tokio::time::sleep(Duration::from_millis(250)).await;
    match read_record(&path) {
        Some(confirm) if confirm.holder == holder => {}
        Some(other) => return Acquire::Held(other),
        None => return Acquire::Unguarded("record_vanished"),
    }

    let lost = Arc::new(AtomicBool::new(false));
    let heartbeat = {
        let path = path.clone();
        let lost = lost.clone();
        let holder = holder.clone();
        tokio::spawn(async move {
            let mut record = record;
            loop {
                tokio::time::sleep(HEARTBEAT).await;
                if let Some(latest) = read_record(&path) {
                    if latest.holder != holder
                        && is_record_live(&latest, &boot_id, now_ms(), STALE_MS)
                    {
                        tracing::error!(holder = %latest.holder, "gateway lock lost to another gateway");
                        lost.store(true, Ordering::Relaxed);
                        return;
                    }
                }
                record.heartbeat_at = iso_from_ms(now_ms());
                if let Err(error) = write_record(&path, &record) {
                    tracing::warn!(error = %error, "gateway lock heartbeat failed");
                }
            }
        })
    };
    Acquire::Acquired(GatewayLock {
        path,
        holder,
        lost,
        heartbeat,
    })
}

/// RFC 3339 UTC with milliseconds, identical to JavaScript `Date#toISOString`.
pub fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

pub fn ms_from_iso(value: &str) -> Option<u64> {
    static ISO: OnceLock<Regex> = OnceLock::new();
    let pattern = ISO.get_or_init(|| {
        Regex::new(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$")
            .expect("iso regex")
    });
    let caps = pattern.captures(value.trim())?;
    let num = |index: usize| caps.get(index).and_then(|m| m.as_str().parse::<u64>().ok());
    let (year, month, day) = (num(1)? as i64, num(2)? as u32, num(3)? as u32);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let millis = caps
        .get(7)
        .map(|m| {
            format!("{:0<3}", &m.as_str()[..m.as_str().len().min(3)])
                .parse::<u64>()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let days = u64::try_from(days_from_civil(year, month, day)).ok()?;
    Some(((days * 86_400) + num(4)? * 3600 + num(5)? * 60 + num(6)?) * 1000 + millis)
}

// Howard Hinnant's civil calendar algorithms (proleptic Gregorian).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe as i64 + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = (year - era * 400) as u64;
    let month = u64::from(month);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + u64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("poko-bot-lock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn iso_round_trips_and_matches_javascript() {
        // new Date(1761047367411).toISOString() === "2025-10-21T11:49:27.411Z"
        assert_eq!(iso_from_ms(1_761_047_367_411), "2025-10-21T11:49:27.411Z");
        assert_eq!(
            ms_from_iso("2025-10-21T11:49:27.411Z"),
            Some(1_761_047_367_411)
        );
        assert_eq!(ms_from_iso("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(ms_from_iso("not a date"), None);
        let now = now_ms();
        assert_eq!(ms_from_iso(&iso_from_ms(now)), Some(now));
    }

    #[test]
    fn liveness_needs_same_boot_and_fresh_heartbeat() {
        let now = 1_761_047_367_411;
        let record = |boot: &str, age_ms: u64| Record {
            boot_id: boot.into(),
            heartbeat_at: iso_from_ms(now - age_ms),
            ..Record::default()
        };
        assert!(is_record_live(&record("a", 5_000), "a", now, STALE_MS));
        assert!(!is_record_live(&record("old", 5_000), "a", now, STALE_MS));
        assert!(!is_record_live(&record("a", 600_000), "a", now, STALE_MS));
        assert!(is_record_live(&record("", 5_000), "a", now, STALE_MS));
        assert!(!is_record_live(&Record::default(), "a", now, STALE_MS));
        assert_eq!(bot_key("123456:SECRET"), "123456");
        assert!(!bot_key("weird").contains("weird"));
    }

    #[tokio::test]
    async fn defers_to_a_live_holder_and_takes_over_a_stale_one() {
        let dir = scratch("acquire");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("telegram-111.lock");
        let foreign = Record {
            holder: "hermes-node:7:abcd".into(),
            hostname: "peer1".into(),
            boot_id: current_boot_id(),
            heartbeat_at: iso_from_ms(now_ms()),
            ..Record::default()
        };
        write_record(&path, &foreign).unwrap();
        match acquire(&dir, true, "poko-bot", "111:secret").await {
            Acquire::Held(holder) => assert_eq!(holder.hostname, "peer1"),
            _ => panic!("expected Held"),
        }

        write_record(
            &path,
            &Record {
                boot_id: "previous-boot".into(),
                ..foreign
            },
        )
        .unwrap();
        let Acquire::Acquired(lock) = acquire(&dir, true, "poko-bot", "111:secret").await else {
            panic!("expected Acquired");
        };
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"botKey\": \"111\""));
        assert!(!written.contains("secret"));
        assert!(!lock.is_lost());
        lock.release();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn own_previous_run_never_blocks_us() {
        let rec = |instance: &str, ns: &str, pid: u32| Record {
            instance: instance.into(),
            pid_ns: ns.into(),
            pid,
            ..Record::default()
        };
        let alive = |_: u32| true;
        let dead = |_: u32| false;
        assert!(is_own_previous_run(
            &rec("poko-bot", "", 0),
            "poko-bot",
            "ns:1",
            5,
            alive
        ));
        assert!(!is_own_previous_run(
            &rec("hermes-poko", "", 0),
            "poko-bot",
            "ns:1",
            5,
            alive
        ));
        assert!(is_own_previous_run(
            &rec("", "ns:1", 77),
            "",
            "ns:1",
            5,
            dead
        ));
        assert!(is_own_previous_run(
            &rec("", "ns:1", 5),
            "",
            "ns:1",
            5,
            alive
        ));
        assert!(!is_own_previous_run(
            &rec("", "ns:1", 77),
            "",
            "ns:1",
            5,
            alive
        ));
        assert!(!is_own_previous_run(
            &rec("", "ns:2", 77),
            "",
            "ns:1",
            5,
            dead
        ));
    }

    #[test]
    fn reads_records_written_by_hermes_node() {
        let node = r#"{"holder":"nezopt:19:ab12cd34","name":"Hermes","botKey":"42","hostname":"nezopt","pid":19,"pidNs":"pid:[4026532757]","instance":"lucina-nez","bootId":"b","startedAt":"2026-10-21T11:49:27.411Z","heartbeatAt":"2026-10-21T11:49:57.411Z"}"#;
        let record: Record = serde_json::from_str(node).unwrap();
        assert_eq!(record.instance, "lucina-nez");
        assert_eq!(record.pid_ns, "pid:[4026532757]");
        assert_eq!(
            ms_from_iso(&record.heartbeat_at),
            Some(ms_from_iso(&record.started_at).unwrap() + 30_000)
        );
    }

    #[tokio::test]
    async fn disabled_lock_runs_unguarded() {
        assert!(matches!(
            acquire(Path::new("/nonexistent"), false, "poko-bot", "1:x").await,
            Acquire::Unguarded("disabled")
        ));
    }
}
