//! `sentinel --role nezopt|pi`: a 5-minute oneshot on each host. The two watch each other
//! through Postgres itself: nezopt sees the Pi drop out of pg_stat_replication, the Pi
//! sees its WAL receiver lose the writer. If a whole host dies, its sentinel's
//! healthchecks ping stops and healthchecks mails.
//!
//! A problem mails once it has been seen `confirm` runs in a row, again every
//! POKOIN_SENTINEL_REMIND_S while it lasts, on escalation (warn → crit), and once when it
//! clears. All of one run's changes go out in one mail.

use crate::{env, hc, mail, sys};
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Sev {
    Ok,
    Warn,
    Crit,
}

impl Sev {
    fn label(self) -> &'static str {
        match self {
            Sev::Ok => "OK",
            Sev::Warn => "WARN",
            Sev::Crit => "CRIT",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Finding {
    pub key: String,
    pub sev: Sev,
    pub detail: String,
    pub confirm: u32,
}

impl Finding {
    fn new(key: impl Into<String>, sev: Sev, detail: impl Into<String>, confirm: u32) -> Self {
        Finding { key: key.into(), sev, detail: detail.into(), confirm: confirm.max(1) }
    }
}

/// One check's result. `complete == false` means the check could not run: keys under
/// its prefix keep their previous state instead of being treated as resolved.
pub struct CheckOut {
    pub prefix: &'static str,
    pub findings: Vec<Finding>,
    pub complete: bool,
}

fn check(prefix: &'static str, confirm: u32, f: impl FnOnce() -> Result<Vec<Finding>>) -> CheckOut {
    match f() {
        Ok(findings) => CheckOut { prefix, findings, complete: true },
        Err(err) => CheckOut {
            prefix,
            findings: vec![Finding::new(format!("{prefix}.check"), Sev::Crit, format!("check failed: {err:#}"), confirm)],
            complete: false,
        },
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AlertState {
    pub sev: Sev,
    pub streak: u32,
    pub alerted: bool,
    pub since: i64,
    pub last_mail: i64,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct MetricsSample {
    pub requests: u64,
    pub errors: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub alerts: BTreeMap<String, AlertState>,
    #[serde(default)]
    pub metrics: Option<MetricsSample>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EventKind {
    Firing,
    Escalated,
    Reminder,
    Resolved,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub kind: EventKind,
    pub key: String,
    pub sev: Sev,
    pub detail: String,
    pub since: i64,
}

fn owned_by(key: &str, prefix: &str) -> bool {
    key.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('.'))
}

pub fn plan(
    prev: &BTreeMap<String, AlertState>,
    outs: &[CheckOut],
    now: i64,
    remind_s: i64,
) -> (BTreeMap<String, AlertState>, Vec<Event>) {
    let mut next = BTreeMap::new();
    let mut events = Vec::new();
    let mut seen = BTreeSet::new();
    for out in outs {
        for f in &out.findings {
            seen.insert(f.key.clone());
            let old = prev.get(&f.key);
            if f.sev == Sev::Ok {
                if let Some(old) = old.filter(|o| o.alerted) {
                    events.push(Event { kind: EventKind::Resolved, key: f.key.clone(), sev: Sev::Ok, detail: f.detail.clone(), since: old.since });
                }
                continue;
            }
            let mut st = old.cloned().unwrap_or(AlertState {
                sev: f.sev,
                streak: 0,
                alerted: false,
                since: now,
                last_mail: 0,
                detail: String::new(),
            });
            st.streak += 1;
            st.detail = f.detail.clone();
            let mut kind = None;
            if !st.alerted {
                if st.streak >= f.confirm {
                    kind = Some(EventKind::Firing);
                    st.alerted = true;
                }
            } else if f.sev > st.sev {
                kind = Some(EventKind::Escalated);
            } else if now - st.last_mail >= remind_s {
                kind = Some(EventKind::Reminder);
            }
            st.sev = f.sev;
            if let Some(kind) = kind {
                st.last_mail = now;
                events.push(Event { kind, key: f.key.clone(), sev: f.sev, detail: f.detail.clone(), since: st.since });
            }
            next.insert(f.key.clone(), st);
        }
    }
    for (key, old) in prev {
        if seen.contains(key) {
            continue;
        }
        let unknown = outs.iter().any(|o| !o.complete && owned_by(key, o.prefix));
        if unknown {
            next.insert(key.clone(), old.clone());
        } else if old.alerted {
            events.push(Event { kind: EventKind::Resolved, key: key.clone(), sev: Sev::Ok, detail: "cleared".into(), since: old.since });
        }
    }
    events.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.sev.cmp(&a.sev)).then(a.key.cmp(&b.key)));
    (next, events)
}

/// The mail did not go out: undo what the events changed, so the next run retries them.
pub fn rollback(
    prev: &BTreeMap<String, AlertState>,
    mut next: BTreeMap<String, AlertState>,
    events: &[Event],
) -> BTreeMap<String, AlertState> {
    for ev in events {
        match (ev.kind, prev.get(&ev.key)) {
            (EventKind::Resolved, Some(old)) => {
                next.insert(ev.key.clone(), old.clone());
            }
            (_, old) => {
                if let Some(st) = next.get_mut(&ev.key) {
                    st.alerted = old.is_some_and(|o| o.alerted);
                    st.last_mail = old.map_or(0, |o| o.last_mail);
                    if let Some(o) = old {
                        st.sev = o.sev;
                    }
                }
            }
        }
    }
    next
}

pub fn render(events: &[Event], active: &BTreeMap<String, AlertState>, now: i64) -> (String, String) {
    let firing = events.iter().filter(|e| e.kind != EventKind::Resolved).count();
    let resolved = events.len() - firing;
    let subject = match (firing, resolved, events.first()) {
        (1, 0, Some(e)) => format!("{} {}: {}", e.sev.label(), e.key, mail::truncate(&e.detail, 90)),
        (f, 0, _) => format!("{f} alerts"),
        (0, r, _) => format!("{r} resolved"),
        (f, r, _) => format!("{f} alerts, {r} resolved"),
    };
    let mut body = String::new();
    for e in events {
        let tag = match e.kind {
            EventKind::Firing => "NEW",
            EventKind::Escalated => "WORSE",
            EventKind::Reminder => "STILL",
            EventKind::Resolved => "RESOLVED",
        };
        let mins = (now - e.since).max(0) / 60;
        body.push_str(&format!("{tag:8} {} {} ({} min)\n         {}\n", e.sev.label(), e.key, mins, e.detail));
    }
    let others: Vec<_> = active
        .iter()
        .filter(|(k, s)| s.alerted && !events.iter().any(|e| &e.key == *k))
        .collect();
    if !others.is_empty() {
        body.push_str("\nAlso still active:\n");
        for (k, s) in others {
            body.push_str(&format!("  {} {} — {}\n", s.sev.label(), k, s.detail));
        }
    }
    body.push_str(&format!("\nhost {} · sentinel {}\n", env::hostname(), env!("CARGO_PKG_VERSION")));
    (subject, body)
}

// ---------------------------------------------------------------- checks

#[derive(Clone, Copy, PartialEq, Eq, Debug, clap::ValueEnum)]
pub enum Role {
    Nezopt,
    Pi,
}

pub struct Cfg {
    pub role: Role,
    pub writer: String,
    pub replica: String,
    pub pg_user: String,
    pub pg_db: String,
    pub conn_warn: u64,
    pub conn_crit: u64,
    pub lag_max_s: f64,
    pub disk_min_gb: u64,
    pub disk_paths: Vec<PathBuf>,
    pub slot_warn_gb: u64,
    pub metrics_url: String,
    pub metrics_errors_max: u64,
    pub wal_spool: PathBuf,
    pub replica_pgdata: PathBuf,
    pub wal_spool_max_age_s: u64,
    pub backup_dir: Option<PathBuf>,
    pub backup_mount: Option<PathBuf>,
    pub backup_max_age_h: u64,
    pub peer_tcp: Option<String>,
    pub ignore_units: Regex,
    pub remind_s: i64,
}

/// Desktop-session units of the nezopt login. Transient units (`systemd-run`, e.g. the
/// dated ML jobs and the Pi's ad-hoc reprice runs) are skipped separately.
pub const DEFAULT_IGNORE_UNITS: &str =
    r"^(run-|app-|session-|user@)|^(at-spi-dbus-bus|dconf|gpg-agent|pipewire|pipewire-pulse|wireplumber|xdg-.*)\.(service|socket)$";

impl Cfg {
    pub fn from_env(role: Role) -> Result<Cfg> {
        let pi = role == Role::Pi;
        let paths = env::get_or("POKOIN_SENTINEL_DISK_PATHS", if pi { "/,/srv/pokoin" } else { "/" });
        Ok(Cfg {
            role,
            writer: env::get_or("POKOIN_WRITER_CONTAINER", "pokoin-marketplace-postgres-15t"),
            replica: env::get_or("POKOIN_REPLICA_CONTAINER", "pokoin-marketplace-postgres-replica"),
            pg_user: env::get_or("POKOIN_PG_USER", "pokoin_marketplace"),
            pg_db: env::get_or("POKOIN_PG_DB", "pokoin_marketplace"),
            conn_warn: env::get_num("POKOIN_SENTINEL_CONN_WARN", 100),
            conn_crit: env::get_num("POKOIN_SENTINEL_CONN_CRIT", 120),
            lag_max_s: env::get_num("POKOIN_SENTINEL_LAG_MAX_S", 60.0),
            disk_min_gb: env::get_num("POKOIN_SENTINEL_DISK_MIN_GB", if pi { 10 } else { 40 }),
            disk_paths: paths.split(',').filter(|p| !p.is_empty()).map(PathBuf::from).collect(),
            slot_warn_gb: env::get_num("POKOIN_SENTINEL_SLOT_WARN_GB", 40),
            metrics_url: env::get_or("POKOIN_SENTINEL_METRICS_URL", "http://127.0.0.1:18082/metrics"),
            metrics_errors_max: env::get_num("POKOIN_SENTINEL_METRICS_ERRORS_MAX", 25),
            wal_spool: PathBuf::from(env::get_or("POKOIN_WAL_SPOOL", "/srv/pokoin/postgres/wal-spool")),
            wal_spool_max_age_s: env::get_num("POKOIN_WAL_SPOOL_MAX_AGE_S", 900),
            replica_pgdata: PathBuf::from(env::get_or("POKOIN_REPLICA_PGDATA", "/srv/pokoin/postgres/pgdata")),
            backup_dir: env::get("POKOIN_BACKUP_DIR").map(PathBuf::from),
            backup_mount: env::get("POKOIN_BACKUP_REQUIRE_MOUNT").map(PathBuf::from),
            backup_max_age_h: env::get_num("POKOIN_SENTINEL_BACKUP_MAX_AGE_H", 30),
            peer_tcp: env::get("POKOIN_SENTINEL_PEER_TCP").or_else(|| pi.then(|| "192.168.178.55:25433".to_string())),
            ignore_units: Regex::new(&env::get_or("POKOIN_SENTINEL_IGNORE_UNITS", DEFAULT_IGNORE_UNITS))
                .context("POKOIN_SENTINEL_IGNORE_UNITS")?,
            remind_s: env::get_num("POKOIN_SENTINEL_REMIND_S", 6 * 3600),
        })
    }
}

fn num<T: std::str::FromStr>(s: &str) -> Result<T> {
    s.trim().parse().map_err(|_| anyhow!("not a number: {s:?}"))
}

pub fn eval_connections(n: u64, warn: u64, crit: u64) -> Finding {
    let sev = if n >= crit { Sev::Crit } else if n >= warn { Sev::Warn } else { Sev::Ok };
    Finding::new("writer.connections", sev, format!("{n} client connections on the writer (warn {warn}, crit {crit}, max_connections 200)"), 2)
}

/// Rows: application_name, client_addr, state, replay_lag seconds.
pub fn eval_replication(rows: &[Vec<String>], lag_max: f64) -> Result<Vec<Finding>> {
    let mut streaming = Vec::new();
    for r in rows {
        if r.len() < 4 {
            return Err(anyhow!("short pg_stat_replication row {r:?}"));
        }
        if r[2] == "streaming" {
            streaming.push((r[0].clone(), r[1].clone(), num::<f64>(&r[3])?));
        }
    }
    let present = if streaming.is_empty() {
        Finding::new("replication.standby", Sev::Crit, "no streaming standby in pg_stat_replication: the Pi replica is down or disconnected", 2)
    } else {
        Finding::new("replication.standby", Sev::Ok, "standby streaming", 2)
    };
    let worst = streaming.iter().map(|s| s.2).fold(0.0, f64::max);
    let lag = if worst > lag_max {
        let who: Vec<_> = streaming.iter().map(|s| format!("{}@{} {:.0}s", s.0, s.1, s.2)).collect();
        Finding::new("replication.lag", Sev::Crit, format!("replay lag above {lag_max:.0}s: {}", who.join(", ")), 2)
    } else {
        Finding::new("replication.lag", Sev::Ok, format!("replay lag {worst:.1}s"), 2)
    };
    Ok(vec![present, lag])
}

/// Rows: slot_name, active, wal_status, retained bytes.
pub fn eval_slots(rows: &[Vec<String>], warn_gb: u64) -> Result<Vec<Finding>> {
    let mut out = Vec::new();
    for r in rows {
        if r.len() < 4 {
            return Err(anyhow!("short pg_replication_slots row {r:?}"));
        }
        let retained: f64 = num(&r[3])?;
        let gb = retained / sys::GB as f64;
        let key = format!("slot.{}", r[0]);
        let f = match r[2].as_str() {
            "lost" => Finding::new(key, Sev::Crit, format!("slot {} is lost: the replica must be rebuilt from a fresh base backup", r[0]), 1),
            "unreserved" => Finding::new(key, Sev::Crit, format!("slot {} holds {gb:.1} GB and is past max_slot_wal_keep_size: it will be invalidated", r[0]), 1),
            _ if gb >= warn_gb as f64 => Finding::new(key, Sev::Warn, format!("slot {} retains {gb:.1} GB of WAL (active={})", r[0], r[1]), 2),
            _ => Finding::new(key, Sev::Ok, format!("slot {} retains {gb:.2} GB", r[0]), 2),
        };
        out.push(f);
    }
    Ok(out)
}

/// Row: in_recovery, wal receiver status, replay delay seconds.
pub fn eval_replica(row: &[String], lag_max: f64) -> Result<Vec<Finding>> {
    if row.len() < 3 {
        return Err(anyhow!("short replica row {row:?}"));
    }
    let mut out = Vec::new();
    out.push(if row[0] == "t" {
        Finding::new("replica.recovery", Sev::Ok, "in recovery", 1)
    } else {
        Finding::new("replica.recovery", Sev::Crit, "the Pi replica is no longer in recovery (promoted?)", 1)
    });
    out.push(if row[1] == "streaming" {
        Finding::new("replica.receiver", Sev::Ok, "streaming", 2)
    } else {
        Finding::new("replica.receiver", Sev::Crit, format!("WAL receiver is {:?}: the nezopt writer is unreachable or refused the replica", row[1]), 2)
    });
    let lag: f64 = num(&row[2])?;
    out.push(if lag > lag_max {
        Finding::new("replica.lag", Sev::Crit, format!("replay is {lag:.0}s behind what it received (max {lag_max:.0}s)"), 2)
    } else {
        Finding::new("replica.lag", Sev::Ok, format!("{lag:.1}s"), 2)
    });
    Ok(out)
}

/// Row: archive_mode, archived_count, failed_count, last_failed_wal, failing.
/// `ready`: (count, oldest age s) of pg_wal/archive_status/*.ready. It catches what
/// pg_stat_archiver does not: an archive_command that exits >125 (e.g. 126, not
/// executable) kills the archiver without counting a failure.
pub fn eval_archiver(row: &[String], ready: Option<(usize, u64)>, max_age_s: u64) -> Result<Vec<Finding>> {
    if row.len() < 5 {
        return Err(anyhow!("short pg_stat_archiver row {row:?}"));
    }
    if row[0] == "off" {
        return Ok(vec![]);
    }
    let mut out = vec![if row[4] == "t" {
        Finding::new("archiver.failing", Sev::Crit, format!("archive_command is failing (last failed {}, {} failures total)", row[3], row[2]), 2)
    } else {
        Finding::new("archiver.failing", Sev::Ok, format!("{} archived", row[1]), 2)
    }];
    if let Some((n, oldest)) = ready {
        out.push(if oldest > max_age_s {
            Finding::new("archiver.backlog", Sev::Crit, format!("{n} WAL segments waiting for archive_command, oldest {} min (docker logs pokoin-marketplace-postgres-replica)", oldest / 60), 1)
        } else {
            Finding::new("archiver.backlog", Sev::Ok, format!("{n} waiting"), 1)
        });
    }
    Ok(out)
}

pub fn eval_metrics(prev: Option<MetricsSample>, cur: MetricsSample, max_errors: u64) -> Finding {
    let delta = match prev {
        Some(p) if cur.errors >= p.errors && cur.requests >= p.requests => cur.errors - p.errors,
        _ => cur.errors, // first run or the API restarted (counters reset)
    };
    if prev.is_some() && delta > max_errors {
        Finding::new("api.errors", Sev::Warn, format!("{delta} API errors since the last run (max {max_errors}); see journalctl -u pokoin-rust-api"), 1)
    } else {
        Finding::new("api.errors", Sev::Ok, format!("{delta} errors"), 1)
    }
}

pub fn eval_spool(files: &[(String, u64)], max_age_s: u64) -> Finding {
    let oldest = files.iter().map(|f| f.1).max().unwrap_or(0);
    if oldest > max_age_s {
        Finding::new("walspool.backlog", Sev::Crit, format!("{} WAL files waiting, oldest {} min: uploads to off-site storage are stalled (journalctl -u pokoin-wal-push)", files.len(), oldest / 60), 1)
    } else {
        Finding::new("walspool.backlog", Sev::Ok, format!("{} waiting", files.len()), 1)
    }
}

fn spool_files(dir: &Path) -> Result<Vec<(String, u64)>> {
    let now = SystemTime::now();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = entry.metadata()?;
        if name.starts_with('.') || !meta.is_file() {
            continue;
        }
        let age = now.duration_since(meta.modified()?).unwrap_or_default().as_secs();
        out.push((name, age));
    }
    Ok(out)
}

fn newest_dump_age_s(dir: &Path) -> Result<Option<u64>> {
    let dumps = dir.join("dumps");
    if !dumps.is_dir() {
        return Ok(None);
    }
    let now = SystemTime::now();
    let mut best: Option<u64> = None;
    for entry in std::fs::read_dir(&dumps)? {
        let manifest = entry?.path().join("MANIFEST.json");
        if let Ok(meta) = std::fs::metadata(&manifest) {
            let age = now.duration_since(meta.modified()?).unwrap_or_default().as_secs();
            best = Some(best.map_or(age, |b: u64| b.min(age)));
        }
    }
    Ok(best)
}

pub fn eval_units(units: &[String], ignore: &Regex, scope: &str) -> Vec<Finding> {
    units
        .iter()
        .filter(|u| !ignore.is_match(u))
        .map(|u| {
            let hint = if scope == "user" { "systemctl --user status" } else { "systemctl status" };
            Finding::new(format!("unit.{scope}.{u}"), Sev::Crit, format!("{u} is failed ({hint} {u})"), 1)
        })
        .collect()
}

fn run_checks(cfg: &Cfg, state: &mut State) -> Vec<CheckOut> {
    let mut outs = Vec::new();
    let psql_rows = |container: &str, sql: &str| -> Result<Vec<Vec<String>>> {
        Ok(sys::rows(&sys::psql(container, &cfg.pg_user, &cfg.pg_db, sql)?))
    };
    match cfg.role {
        Role::Nezopt => {
            outs.push(check("writer", 2, || {
                let rows = psql_rows(&cfg.writer, "select count(*) from pg_stat_activity where backend_type = 'client backend'")?;
                let n = rows.first().and_then(|r| r.first()).ok_or_else(|| anyhow!("no count"))?;
                Ok(vec![eval_connections(num(n)?, cfg.conn_warn, cfg.conn_crit)])
            }));
            outs.push(check("replication", 2, || {
                let rows = psql_rows(&cfg.writer, "select application_name, coalesce(client_addr::text, ''), state, \
                    coalesce(extract(epoch from replay_lag), 0)::float8 from pg_stat_replication")?;
                eval_replication(&rows, cfg.lag_max_s)
            }));
            outs.push(check("slot", 2, || {
                let rows = psql_rows(&cfg.writer, "select slot_name, active::text, coalesce(wal_status, ''), \
                    coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::bigint \
                    from pg_replication_slots where slot_type = 'physical'")?;
                eval_slots(&rows, cfg.slot_warn_gb)
            }));
            if let Some(dir) = cfg.backup_dir.clone() {
                outs.push(check("backup", 1, || {
                    let mut out = Vec::new();
                    if let Some(m) = &cfg.backup_mount {
                        out.push(if sys::is_mountpoint(m) {
                            Finding::new("backup.mount", Sev::Ok, "mounted", 1)
                        } else {
                            Finding::new("backup.mount", Sev::Crit, format!("{} is not mounted: local backups and the restore test cannot run", m.display()), 1)
                        });
                    }
                    let max = cfg.backup_max_age_h * 3600;
                    out.push(match newest_dump_age_s(&dir)? {
                        Some(age) if age <= max => Finding::new("backup.dump-age", Sev::Ok, format!("newest dump {} h old", age / 3600), 1),
                        Some(age) => Finding::new("backup.dump-age", Sev::Crit, format!("newest complete pg_dump is {} h old (max {} h): journalctl --user -u pokoin-pgdump", age / 3600, cfg.backup_max_age_h), 1),
                        None => Finding::new("backup.dump-age", Sev::Crit, format!("no complete pg_dump under {}", dir.display()), 1),
                    });
                    Ok(out)
                }));
            }
        }
        Role::Pi => {
            outs.push(check("replica", 2, || {
                let rows = psql_rows(&cfg.replica, "select pg_is_in_recovery()::text, \
                    coalesce((select status from pg_stat_wal_receiver), 'none'), \
                    (case when pg_last_wal_receive_lsn() is not distinct from pg_last_wal_replay_lsn() then 0 \
                     else coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp()), 0) end)::float8")?;
                eval_replica(rows.first().ok_or_else(|| anyhow!("no row"))?, cfg.lag_max_s)
            }));
            outs.push(check("archiver", 2, || {
                let rows = psql_rows(&cfg.replica, "select current_setting('archive_mode'), archived_count, failed_count, \
                    coalesce(last_failed_wal, ''), (last_failed_time is not null and \
                    (last_archived_time is null or last_failed_time > last_archived_time))::text from pg_stat_archiver")?;
                let status = cfg.replica_pgdata.join("pg_wal/archive_status");
                let ready = if status.is_dir() {
                    let files: Vec<_> = spool_files(&status)?.into_iter().filter(|f| f.0.ends_with(".ready")).collect();
                    Some((files.len(), files.iter().map(|f| f.1).max().unwrap_or(0)))
                } else {
                    None
                };
                eval_archiver(rows.first().ok_or_else(|| anyhow!("no row"))?, ready, cfg.wal_spool_max_age_s)
            }));
            if cfg.wal_spool.is_dir() {
                outs.push(check("walspool", 1, || Ok(vec![eval_spool(&spool_files(&cfg.wal_spool)?, cfg.wal_spool_max_age_s)])));
            }
            let prev = state.metrics;
            let mut sample = None;
            outs.push(check("api", 2, || {
                let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build();
                let v: serde_json::Value = agent.get(&cfg.metrics_url).call()?.into_json()?;
                let cur = MetricsSample {
                    requests: v["requests"].as_u64().ok_or_else(|| anyhow!("no requests counter"))?,
                    errors: v["errors"].as_u64().ok_or_else(|| anyhow!("no errors counter"))?,
                };
                sample = Some(cur);
                Ok(vec![eval_metrics(prev, cur, cfg.metrics_errors_max)])
            }));
            if sample.is_some() {
                state.metrics = sample;
            }
        }
    }
    outs.push(check("disk", 1, || {
        let mut out = Vec::new();
        for p in &cfg.disk_paths {
            let free = sys::free_bytes(p)?;
            let key = format!("disk.{}", p.display());
            out.push(if free < cfg.disk_min_gb * sys::GB {
                Finding::new(key, Sev::Crit, format!("{} has {} GB free (min {} GB)", p.display(), free / sys::GB, cfg.disk_min_gb), 1)
            } else {
                Finding::new(key, Sev::Ok, format!("{} GB free", free / sys::GB), 1)
            });
        }
        Ok(out)
    }));
    outs.push(check("unit", 1, || {
        let include_transient = env::get("POKOIN_SENTINEL_INCLUDE_TRANSIENT").as_deref() == Some("1");
        let failed = |user: bool| -> Result<Vec<String>> {
            let units = sys::failed_units(user)?;
            if include_transient {
                return Ok(units);
            }
            let transient = sys::transient_units(user, &units)?;
            Ok(units.into_iter().filter(|u| !transient.contains(u)).collect())
        };
        let mut out = eval_units(&failed(false)?, &cfg.ignore_units, "system");
        if !sys::is_root() {
            out.extend(eval_units(&failed(true)?, &cfg.ignore_units, "user"));
        }
        Ok(out)
    }));
    if let Some(peer) = &cfg.peer_tcp {
        outs.push(check("peer", 2, || {
            let addr = peer.to_socket_addrs()?.next().ok_or_else(|| anyhow!("cannot resolve {peer}"))?;
            Ok(vec![match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
                Ok(_) => Finding::new(format!("peer.{peer}"), Sev::Ok, "reachable", 2),
                Err(e) => Finding::new(format!("peer.{peer}"), Sev::Crit, format!("cannot reach the writer at {peer}: {e}"), 2),
            }])
        }));
    }
    outs
}

pub fn run(role: Role, dry_run: bool) -> Result<()> {
    let cfg = Cfg::from_env(role)?;
    let path = env::state_dir().join(format!("sentinel-{}.json", if role == Role::Pi { "pi" } else { "nezopt" }));
    let mut state: State = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let prev = state.alerts.clone();
    let outs = run_checks(&cfg, &mut state);
    let now = chrono::Utc::now().timestamp();
    let (next, events) = plan(&prev, &outs, now, cfg.remind_s);

    let active: Vec<String> = next.iter().filter(|(_, s)| s.sev != Sev::Ok).map(|(k, s)| format!("{} {k}: {}", s.sev.label(), s.detail)).collect();
    for o in &outs {
        for f in &o.findings {
            println!("{:4} {} — {}", f.sev.label(), f.key, f.detail);
        }
    }
    if dry_run {
        for e in &events {
            println!("event {:?} {}", e.kind, e.key);
        }
        return Ok(());
    }

    let mut delivered = true;
    if !events.is_empty() {
        let (subject, body) = render(&events, &next, now);
        if let Err(err) = mail::send(&mail::subject(&subject), &body) {
            eprintln!("{err:#}");
            delivered = false;
        }
    }
    state.alerts = if delivered { next } else { rollback(&prev, next, &events) };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&state)?)?;
    std::fs::rename(&tmp, &path)?;

    let slug = hc::slug_for_unit(&hc::host_prefix(), "pokoin-sentinel.service");
    let summary = if active.is_empty() { "all clear".to_string() } else { active.join("\n") };
    let kind = if delivered { hc::Kind::Success } else { hc::Kind::Fail };
    if let Err(err) = hc::ping(&slug, kind, &summary) {
        eprintln!("{err:#}");
    }
    if delivered { Ok(()) } else { Err(anyhow!("alert mail not delivered; will retry next run")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(prefix: &'static str, findings: Vec<Finding>) -> CheckOut {
        CheckOut { prefix, findings, complete: true }
    }

    fn f(key: &str, sev: Sev, confirm: u32) -> Finding {
        Finding::new(key, sev, "d", confirm)
    }

    #[test]
    fn fires_after_confirm_then_reminds_then_resolves() {
        let remind = 3600;
        let (s1, e1) = plan(&BTreeMap::new(), &[out("writer", vec![f("writer.connections", Sev::Crit, 2)])], 0, remind);
        assert!(e1.is_empty(), "first sighting only arms the alert");
        let (s2, e2) = plan(&s1, &[out("writer", vec![f("writer.connections", Sev::Crit, 2)])], 300, remind);
        assert_eq!(e2.len(), 1);
        assert_eq!(e2[0].kind, EventKind::Firing);
        let (s3, e3) = plan(&s2, &[out("writer", vec![f("writer.connections", Sev::Crit, 2)])], 600, remind);
        assert!(e3.is_empty());
        let (s4, e4) = plan(&s3, &[out("writer", vec![f("writer.connections", Sev::Crit, 2)])], 300 + remind, remind);
        assert_eq!(e4[0].kind, EventKind::Reminder);
        let (s5, e5) = plan(&s4, &[out("writer", vec![f("writer.connections", Sev::Ok, 2)])], 4000, remind);
        assert_eq!(e5[0].kind, EventKind::Resolved);
        assert!(s5.is_empty());
    }

    #[test]
    fn warn_to_crit_escalates_and_unalerted_blips_stay_quiet() {
        let (s1, _) = plan(&BTreeMap::new(), &[out("writer", vec![f("writer.connections", Sev::Warn, 1)])], 0, 9999);
        let (_, e2) = plan(&s1, &[out("writer", vec![f("writer.connections", Sev::Crit, 1)])], 60, 9999);
        assert_eq!(e2[0].kind, EventKind::Escalated);
        let (s3, _) = plan(&BTreeMap::new(), &[out("replica", vec![f("replica.lag", Sev::Crit, 2)])], 0, 9999);
        let (s4, e4) = plan(&s3, &[out("replica", vec![f("replica.lag", Sev::Ok, 2)])], 60, 9999);
        assert!(e4.is_empty() && s4.is_empty(), "one bad run below confirm never mails");
    }

    #[test]
    fn vanished_unit_resolves_but_failed_check_keeps_state() {
        let (s1, e1) = plan(&BTreeMap::new(), &[out("unit", vec![f("unit.user.x.service", Sev::Crit, 1)])], 0, 9999);
        assert_eq!(e1[0].kind, EventKind::Firing);
        let broken = CheckOut { prefix: "unit", findings: vec![f("unit.check", Sev::Crit, 1)], complete: false };
        let (s2, e2) = plan(&s1, &[broken], 60, 9999);
        assert!(s2.contains_key("unit.user.x.service"), "unknown is not resolved");
        assert!(e2.iter().all(|e| e.key == "unit.check"));
        let (s3, e3) = plan(&s2, &[out("unit", vec![])], 120, 9999);
        assert!(e3.iter().any(|e| e.kind == EventKind::Resolved && e.key == "unit.user.x.service"));
        assert!(!s3.contains_key("unit.user.x.service"));
    }

    #[test]
    fn rollback_retries_undelivered_events() {
        let (s1, _) = plan(&BTreeMap::new(), &[out("disk", vec![f("disk./", Sev::Crit, 1)])], 0, 9999);
        let (s2, e2) = plan(&BTreeMap::new(), &[out("disk", vec![f("disk./", Sev::Crit, 1)])], 0, 9999);
        let rolled = rollback(&BTreeMap::new(), s2, &e2);
        assert!(!rolled["disk./"].alerted);
        let (_, e3) = plan(&rolled, &[out("disk", vec![f("disk./", Sev::Crit, 1)])], 60, 9999);
        assert_eq!(e3[0].kind, EventKind::Firing);
        // An undelivered resolve keeps the alert so the next run resolves it again.
        let (s4, e4) = plan(&s1, &[out("disk", vec![f("disk./", Sev::Ok, 1)])], 60, 9999);
        let rolled = rollback(&s1, s4, &e4);
        assert!(rolled["disk./"].alerted);
    }

    #[test]
    fn thresholds() {
        assert_eq!(eval_connections(99, 100, 120).sev, Sev::Ok);
        assert_eq!(eval_connections(100, 100, 120).sev, Sev::Warn);
        assert_eq!(eval_connections(121, 100, 120).sev, Sev::Crit);

        let r = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let rep = eval_replication(&[r(&["walreceiver", "192.168.178.46", "streaming", "0.4"])], 60.0).unwrap();
        assert!(rep.iter().all(|f| f.sev == Sev::Ok));
        let rep = eval_replication(&[], 60.0).unwrap();
        assert_eq!(rep[0].sev, Sev::Crit);
        let rep = eval_replication(&[r(&["walreceiver", "x", "streaming", "75"])], 60.0).unwrap();
        assert_eq!(rep[1].sev, Sev::Crit);

        let slots = eval_slots(&[r(&["pokoin_pi_replica", "t", "reserved", "0"]), r(&["old", "f", "extended", "45000000000"]), r(&["gone", "f", "lost", "0"])], 40).unwrap();
        assert_eq!(slots.iter().map(|f| f.sev).collect::<Vec<_>>(), vec![Sev::Ok, Sev::Warn, Sev::Crit]);

        let rep = eval_replica(&r(&["t", "streaming", "0"]), 60.0).unwrap();
        assert!(rep.iter().all(|f| f.sev == Sev::Ok));
        let rep = eval_replica(&r(&["t", "none", "0"]), 60.0).unwrap();
        assert_eq!(rep[1].sev, Sev::Crit);
        let rep = eval_replica(&r(&["f", "none", "0"]), 60.0).unwrap();
        assert_eq!(rep[0].sev, Sev::Crit);

        assert!(eval_archiver(&r(&["off", "0", "0", "", "f"]), Some((50, 9999)), 900).unwrap().is_empty());
        assert_eq!(eval_archiver(&r(&["always", "10", "1", "0000000100000095000000AA", "t"]), None, 900).unwrap()[0].sev, Sev::Crit);
        assert_eq!(eval_archiver(&r(&["always", "10", "1", "x", "f"]), None, 900).unwrap()[0].sev, Sev::Ok);
        // exit 126 leaves failed_count at 0: only the .ready backlog shows it.
        let a = eval_archiver(&r(&["always", "0", "0", "", "f"]), Some((3, 1200)), 900).unwrap();
        assert_eq!((a[0].sev, a[1].sev), (Sev::Ok, Sev::Crit));
        assert_eq!(eval_archiver(&r(&["always", "9", "0", "", "f"]), Some((1, 20)), 900).unwrap()[1].sev, Sev::Ok);
    }

    #[test]
    fn metrics_delta_handles_restart() {
        let p = Some(MetricsSample { requests: 1000, errors: 10 });
        assert_eq!(eval_metrics(None, MetricsSample { requests: 5, errors: 500 }, 25).sev, Sev::Ok);
        assert_eq!(eval_metrics(p, MetricsSample { requests: 1100, errors: 20 }, 25).sev, Sev::Ok);
        assert_eq!(eval_metrics(p, MetricsSample { requests: 1100, errors: 40 }, 25).sev, Sev::Warn);
        assert_eq!(eval_metrics(p, MetricsSample { requests: 50, errors: 30 }, 25).sev, Sev::Warn);
        assert_eq!(eval_metrics(p, MetricsSample { requests: 50, errors: 3 }, 25).sev, Sev::Ok);
    }

    #[test]
    fn default_ignore_list_skips_desktop_and_transient_units() {
        let re = Regex::new(DEFAULT_IGNORE_UNITS).unwrap();
        let units: Vec<String> = ["run-p1-i2.service", "app-grok-bot-1.scope", "pipewire.service", "pipewire.socket", "dconf.service",
            "pokoin-all-cardtrader-daily.service", "tailscale-nextcloud-setup.service"].iter().map(|s| s.to_string()).collect();
        let keys: Vec<_> = eval_units(&units, &re, "user").into_iter().map(|f| f.key).collect();
        assert_eq!(keys, vec!["unit.user.pokoin-all-cardtrader-daily.service", "unit.user.tailscale-nextcloud-setup.service"]);
    }

    #[test]
    fn spool_age() {
        assert_eq!(eval_spool(&[], 900).sev, Sev::Ok);
        assert_eq!(eval_spool(&[("a".into(), 30), ("b".into(), 901)], 900).sev, Sev::Crit);
    }
}
