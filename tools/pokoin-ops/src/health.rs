//! The nezopt → Secretary server-health snapshot (`POST /v1/system/health`) and the
//! state-change logic behind its `/v1/notify` pushes. Pure functions only; the sentinel
//! gathers the inputs. Contract: one check per watched item (healthy ones included), id
//! `<kind>:<name>`, `since` = when the current state began, kept across runs.

use crate::sentinel::Sev;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// The contract's `kind` values.
#[cfg(test)]
pub const KINDS: [&str; 8] = ["unit", "timer", "container", "k3s", "forward", "log", "disk", "deadman"];

pub fn state_str(sev: Sev) -> &'static str {
    match sev {
        Sev::Ok => "ok",
        Sev::Warn => "warn",
        Sev::Crit => "crit",
    }
}

/// Project group by name prefix (unit, container or check name).
pub fn group_for(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if let Some(rest) = n.strip_prefix("gh-runner-") {
        return if rest.starts_with("cardrails") { "CardRails" } else { group_for(rest) };
    }
    let has = |ps: &[&str]| ps.iter().any(|p| n.starts_with(p));
    if has(&["lucina-", "secretary-", "cloudflared-lucina"]) {
        "Lucina"
    } else if has(&["cardrails"]) {
        "CardRails"
    } else if has(&[
        "pokoin-", "poko-", "ctcm-", "upworkpkn-", "nezopt-cardscan", "marketplace-", "battlescan-", "price-book",
        "tcgprices-", "tcgcsv-", "card-lang",
    ]) {
        "Pokoin"
    } else if has(&[
        "dsh-", "flareon-", "codevira", "llama-", "qwen", "honcho", "harness-", "obscura-", "opencode-", "ollama",
        "freechain", "deepseek-", "docker-searxng", "openai-tunnel",
    ]) {
        "AI"
    } else if has(&["nezopt-", "cloudflared-", "oracle-", "mybook", "rustdesk", "nextcloud", "tailscale", "docker", "infisical", "/"]) {
        "Homelab"
    } else {
        "Other"
    }
}

/// Where a finding lands in the snapshot. Findings of the older checks carry none and get
/// one from their key (`legacy`).
#[derive(Clone, Debug, PartialEq)]
pub struct Meta {
    pub kind: &'static str,
    pub name: String,
    pub id: String,
    pub group: &'static str,
    pub restarts_1h: u32,
}

impl Meta {
    /// `id_name` is the full name in the id (`lucina-rs.service`); the display name drops
    /// a `.service` suffix (`lucina-rs`).
    pub fn new(kind: &'static str, id_name: &str) -> Meta {
        let name = id_name.strip_suffix(".service").unwrap_or(id_name).to_string();
        Meta { kind, group: group_for(&name), id: format!("{kind}:{id_name}"), name, restarts_1h: 0 }
    }

    pub fn group(mut self, group: &'static str) -> Meta {
        self.group = group;
        self
    }

    pub fn restarts(mut self, n: u32) -> Meta {
        self.restarts_1h = n;
        self
    }

    /// Keys of the Postgres/backup/disk/unit checks that predate the snapshot.
    pub fn legacy(key: &str) -> Meta {
        if let Some(u) = key.strip_prefix("unit.user.").or_else(|| key.strip_prefix("unit.system.")) {
            return Meta::new("unit", u);
        }
        if let Some(p) = key.strip_prefix("disk.") {
            return Meta::new("disk", p).group("Homelab");
        }
        // writer.*, replication.*, slot.*, backup.*, replica.*, archiver.*, api.*, peer.*,
        // and `<check>.check` (a check that could not run).
        Meta::new("deadman", key).group("Pokoin")
    }
}

/// One merged snapshot row before serialization.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub meta: Meta,
    pub sev: Sev,
    pub detail: String,
    /// The sentinel check that produced it (to keep state when that check could not run).
    pub prefix: String,
}

/// Several findings can describe one item (a unit that is expected-active and also
/// restart-storming): keep one row per id, worst state first, details of the bad ones.
pub fn merge(items: Vec<Item>) -> Vec<Item> {
    let mut by_id: BTreeMap<String, Vec<Item>> = BTreeMap::new();
    for it in items {
        by_id.entry(it.meta.id.clone()).or_default().push(it);
    }
    let mut out = Vec::new();
    for (_, mut group) in by_id {
        group.sort_by_key(|i| std::cmp::Reverse(i.sev));
        let worst = group[0].sev;
        let restarts = group.iter().map(|i| i.meta.restarts_1h).max().unwrap_or(0);
        let detail = if worst == Sev::Ok {
            group[0].detail.clone()
        } else {
            group.iter().filter(|i| i.sev != Sev::Ok).map(|i| i.detail.as_str()).collect::<Vec<_>>().join("; ")
        };
        let mut first = group.swap_remove(0);
        first.detail = detail;
        first.meta.restarts_1h = restarts;
        out.push(first);
    }
    out.sort_by(|a, b| b.sev.cmp(&a.sev).then(a.meta.group.cmp(b.meta.group)).then(a.meta.id.cmp(&b.meta.id)));
    out
}

// ---------------------------------------------------------------- snapshot

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DiskMetric {
    pub mount: String,
    pub used_pct: f64,
    pub free_gb: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Metrics {
    pub disks: Vec<DiskMetric>,
    pub cpu_temp_c: Option<f64>,
    pub load: [f64; 3],
    pub mem_used_pct: f64,
    pub swap_used_pct: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CheckView {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub group: &'static str,
    pub state: &'static str,
    pub detail: String,
    pub since: String,
    pub restarts_1h: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Snapshot {
    pub host: String,
    pub at: String,
    pub overall: &'static str,
    pub metrics: Metrics,
    pub checks: Vec<CheckView>,
}

pub fn rfc3339(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

pub fn snapshot(host: &str, now: i64, metrics: Metrics, items: &[Item], tracks: &BTreeMap<String, Track>) -> Snapshot {
    let overall = items.iter().map(|i| i.sev).max().unwrap_or(Sev::Ok);
    let checks = items
        .iter()
        .map(|i| CheckView {
            id: i.meta.id.clone(),
            kind: i.meta.kind,
            name: i.meta.name.clone(),
            group: i.meta.group,
            state: state_str(i.sev),
            detail: crate::secretary::clip(&i.detail, 300),
            since: rfc3339(tracks.get(&i.meta.id).map_or(now, |t| t.since)),
            restarts_1h: i.meta.restarts_1h,
        })
        .collect();
    Snapshot { host: host.to_string(), at: rfc3339(now), overall: state_str(overall), metrics, checks }
}

/// "12 ok, 2 warn, 1 crit".
pub fn summary(items: &[Item]) -> String {
    let n = |s: Sev| items.iter().filter(|i| i.sev == s).count();
    format!("{} ok, {} warn, {} crit", n(Sev::Ok), n(Sev::Warn), n(Sev::Crit))
}

// ---------------------------------------------------------------- state changes

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Track {
    pub sev: Sev,
    pub since: i64,
    /// A crit push went out and no recovered push has followed yet.
    #[serde(default)]
    pub notified: bool,
    /// The last crit push did not get through: try again next run.
    #[serde(default)]
    pub retry: bool,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prefix: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushKind {
    Crit,
    Recovered,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Push {
    pub kind: PushKind,
    pub id: String,
    pub name: String,
    pub detail: String,
}

impl Push {
    pub fn title(&self, host: &str) -> String {
        match self.kind {
            PushKind::Crit => format!("{host}: {} failed", self.name),
            PushKind::Recovered => format!("{host}: {} recovered", self.name),
        }
    }

    pub fn dedup_key(&self, host: &str) -> String {
        format!("{host}:{}", self.id)
    }
}

/// Crit is pushed only on the change into crit (or to retry an undelivered push); a check
/// that was already crit on the previous run is never pushed again. Recovered is pushed
/// once when a pushed crit is back to ok (or its item vanished from a check that ran).
/// `incomplete`: prefixes of checks that could not run this time.
///
/// The very first run (no previous state) is a baseline: it records every state without
/// pushing, so installing the sentinel does not page for long-known problems (they are in
/// the snapshot, and the mail path still reports them).
pub fn track(
    prev: &BTreeMap<String, Track>,
    items: &[Item],
    incomplete: &BTreeSet<String>,
    now: i64,
) -> (BTreeMap<String, Track>, Vec<Push>) {
    let mut next = BTreeMap::new();
    let mut pushes = Vec::new();
    let baseline = prev.is_empty();
    for it in items {
        let p = prev.get(&it.meta.id);
        let mut t = Track {
            sev: it.sev,
            since: p.filter(|p| p.sev == it.sev).map_or(now, |p| p.since),
            notified: p.is_some_and(|p| p.notified),
            retry: false,
            name: it.meta.name.clone(),
            prefix: it.prefix.clone(),
        };
        let push = |kind| Push { kind, id: it.meta.id.clone(), name: it.meta.name.clone(), detail: it.detail.clone() };
        match it.sev {
            _ if baseline => {}
            Sev::Crit if p.is_none_or(|p| p.sev != Sev::Crit || p.retry) => {
                pushes.push(push(PushKind::Crit));
                t.notified = true;
            }
            Sev::Ok if t.notified => {
                pushes.push(push(PushKind::Recovered));
                t.notified = false;
            }
            _ => {}
        }
        next.insert(it.meta.id.clone(), t);
    }
    for (id, old) in prev {
        if next.contains_key(id) {
            continue;
        }
        if incomplete.contains(&old.prefix) {
            next.insert(id.clone(), old.clone());
        } else if old.notified {
            pushes.push(Push { kind: PushKind::Recovered, id: id.clone(), name: old.name.clone(), detail: "no longer reported".into() });
        }
    }
    (next, pushes)
}

/// Undelivered pushes are retried on the next run.
pub fn undelivered(next: &mut BTreeMap<String, Track>, prev: &BTreeMap<String, Track>, failed: &[Push], now: i64) {
    for p in failed {
        match p.kind {
            PushKind::Crit => {
                if let Some(t) = next.get_mut(&p.id) {
                    t.notified = false;
                    t.retry = true;
                }
            }
            PushKind::Recovered => match next.get_mut(&p.id) {
                Some(t) => t.notified = true,
                None => {
                    let mut t = prev.get(&p.id).cloned().unwrap_or(Track {
                        sev: Sev::Ok,
                        since: now,
                        notified: true,
                        retry: false,
                        name: p.name.clone(),
                        prefix: String::new(),
                    });
                    t.sev = Sev::Ok;
                    t.notified = true;
                    next.insert(p.id.clone(), t);
                }
            },
        }
    }
}

// ---------------------------------------------------------------- restart storms

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct RestartTrack {
    /// Last NRestarts / RestartCount seen.
    pub last: u64,
    /// (time, restarts since the previous run), last hour only.
    #[serde(default)]
    pub events: Vec<(i64, u64)>,
}

/// Restarts in the last hour from the counter delta since the previous run. The first
/// sighting counts nothing (the counter holds history); a counter that went down was
/// reset by an explicit start, so all of it is new.
pub fn restarts_update(prev: Option<&RestartTrack>, cur: u64, now: i64) -> (RestartTrack, u32) {
    let mut t = prev.cloned().unwrap_or_default();
    let delta = match prev {
        None => 0,
        Some(p) if cur >= p.last => cur - p.last,
        Some(_) => cur,
    };
    t.last = cur;
    if delta > 0 {
        t.events.push((now, delta));
    }
    t.events.retain(|e| now - e.0 < 3600);
    let n = t.events.iter().map(|e| e.1).sum::<u64>();
    (t, n.min(u32::MAX as u64) as u32)
}

pub fn restart_sev(n: u32) -> Sev {
    if n >= 10 {
        Sev::Crit
    } else if n >= 3 {
        Sev::Warn
    } else {
        Sev::Ok
    }
}

// ---------------------------------------------------------------- parsers

/// `systemctl show` output for several units: one property map per blank-line block.
pub fn parse_show(text: &str) -> Vec<BTreeMap<String, String>> {
    text.split("\n\n")
        .map(|block| {
            block
                .lines()
                .filter_map(|l| l.split_once('='))
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>()
        })
        .filter(|m| m.contains_key("Id"))
        .collect()
}

/// Local targets of `ssh -R [bind:]port:host:hostport` in an ExecStart property
/// (`{ path=… ; argv[]=/usr/bin/ssh -NT -R 127.0.0.1:8100:127.0.0.1:8098 host ; … }`).
pub fn ssh_remote_targets(exec_start: &str) -> Vec<u16> {
    let Some(argv) = exec_start.split("argv[]=").nth(1).map(|s| s.split(" ;").next().unwrap_or("")) else {
        return vec![];
    };
    let words: Vec<&str> = argv.split_whitespace().collect();
    if !words.first().is_some_and(|w| w.ends_with("/ssh") || *w == "ssh") {
        return vec![];
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let spec = match words[i] {
            "-R" => words.get(i + 1).copied(),
            w if w.starts_with("-R") && w.len() > 2 => Some(&w[2..]),
            _ => None,
        };
        if let Some(spec) = spec {
            let parts: Vec<&str> = spec.split(':').collect();
            if parts.len() >= 3 {
                let host = parts[parts.len() - 2];
                if let (true, Ok(port)) = (matches!(host, "127.0.0.1" | "localhost"), parts[parts.len() - 1].parse::<u16>()) {
                    if !out.contains(&port) {
                        out.push(port);
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Rows of `docker inspect --format '{{.Name}}\t{{.HostConfig.RestartPolicy.Name}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.RestartCount}}'`.
#[derive(Clone, Debug, PartialEq)]
pub struct Container {
    pub name: String,
    pub policy: String,
    pub status: String,
    pub health: String,
    pub restarts: u64,
}

pub fn parse_containers(text: &str) -> Vec<Container> {
    text.lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split('\t').collect();
            (c.len() >= 5).then(|| Container {
                name: c[0].trim().trim_start_matches('/').to_string(),
                policy: c[1].trim().to_string(),
                status: c[2].trim().to_string(),
                health: c[3].trim().to_string(),
                restarts: c[4].trim().parse().unwrap_or(0),
            })
        })
        .filter(|c| !c.name.is_empty())
        .collect()
}

pub fn eval_container(c: &Container) -> (Sev, String) {
    match (c.status.as_str(), c.health.as_str()) {
        ("running", "unhealthy") => (Sev::Crit, "running but unhealthy".into()),
        ("running", "") => (Sev::Ok, "running".into()),
        ("running", h) => (Sev::Ok, format!("running ({h})")),
        ("restarting", _) => (Sev::Warn, "restarting".into()),
        (s, _) => (Sev::Crit, format!("{s} (restart policy {})", c.policy)),
    }
}

/// Failed Jobs of `kubectl get jobs -o json`: (name, creation time).
pub fn failed_jobs(v: &serde_json::Value) -> Vec<(String, i64)> {
    let Some(items) = v["items"].as_array() else { return vec![] };
    items
        .iter()
        .filter(|j| {
            j["status"]["conditions"]
                .as_array()
                .is_some_and(|cs| cs.iter().any(|c| c["type"] == "Failed" && c["status"] == "True"))
        })
        .filter_map(|j| {
            let name = j["metadata"]["name"].as_str()?.to_string();
            let created = chrono::DateTime::parse_from_rfc3339(j["metadata"]["creationTimestamp"].as_str()?).ok()?.timestamp();
            Some((name, created))
        })
        .collect()
}

/// (mem_used_pct, swap_used_pct) from /proc/meminfo.
pub fn parse_meminfo(text: &str) -> (f64, f64) {
    let kb = |key: &str| -> f64 {
        text.lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
            .and_then(|v| v.split_whitespace().next()?.parse().ok())
            .unwrap_or(0.0)
    };
    let pct = |used: f64, total: f64| if total > 0.0 { round1(used / total * 100.0) } else { 0.0 };
    let (total, avail) = (kb("MemTotal"), kb("MemAvailable"));
    let (stotal, sfree) = (kb("SwapTotal"), kb("SwapFree"));
    (pct(total - avail, total), pct(stotal - sfree, stotal))
}

pub fn parse_loadavg(text: &str) -> [f64; 3] {
    let v: Vec<f64> = text.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
    [v.first().copied().unwrap_or(0.0), v.get(1).copied().unwrap_or(0.0), v.get(2).copied().unwrap_or(0.0)]
}

/// Real disk mounts from /proc/self/mounts: one per device, no snaps/boot/docker layers.
pub fn parse_mounts(text: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for l in text.lines() {
        let c: Vec<&str> = l.split_whitespace().collect();
        if c.len() < 3 || !c[0].starts_with("/dev/") || c[0].starts_with("/dev/loop") {
            continue;
        }
        if !matches!(c[2], "ext4" | "xfs" | "btrfs" | "f2fs" | "zfs") {
            continue;
        }
        let mount = c[1].replace("\\040", " ");
        if ["/boot", "/snap", "/var/lib/docker", "/var/snap"].iter().any(|p| mount.starts_with(p)) {
            continue;
        }
        if seen.insert(c[0].to_string()) {
            out.push(mount);
        }
    }
    out
}

/// Disk free in % → state: < 5 crit, < 10 warn.
pub fn disk_sev(free_pct: f64) -> Sev {
    if free_pct < 5.0 {
        Sev::Crit
    } else if free_pct < 10.0 {
        Sev::Warn
    } else {
        Sev::Ok
    }
}

/// Tctl in °C → state: ≥ 95 crit, ≥ 90 warn (the owner's limit).
pub fn temp_sev(c: f64) -> Sev {
    if c >= 95.0 {
        Sev::Crit
    } else if c >= 90.0 {
        Sev::Warn
    } else {
        Sev::Ok
    }
}

/// expected-active.txt: `name.service` (user unit), `system:name.service`,
/// `container:name`; `#` comments. A bare name means a user `.service`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Expected {
    pub user: Vec<String>,
    pub system: Vec<String>,
    pub containers: Vec<String>,
}

pub fn parse_expected(text: &str) -> Expected {
    let mut e = Expected::default();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let unit = |n: &str| if n.contains('.') { n.to_string() } else { format!("{n}.service") };
        if let Some(c) = line.strip_prefix("container:") {
            e.containers.push(c.trim().to_string());
        } else if let Some(u) = line.strip_prefix("system:") {
            e.system.push(unit(u.trim()));
        } else {
            e.user.push(unit(line.strip_prefix("user:").unwrap_or(line).trim()));
        }
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: &'static str, name: &str, sev: Sev) -> Item {
        Item { meta: Meta::new(kind, name), sev, detail: format!("{name} {}", state_str(sev)), prefix: kind.to_string() }
    }

    /// State after an earlier run, so the first-run baseline does not apply.
    fn seeded() -> BTreeMap<String, Track> {
        let t = Track { sev: Sev::Ok, since: 0, notified: false, retry: false, name: "/".into(), prefix: "disk".into() };
        [("disk:/".to_string(), t)].into()
    }

    #[test]
    fn snapshot_serializes_with_contract_field_names() {
        let mut storm = item("unit", "lucina-rs.service", Sev::Crit);
        storm.meta.restarts_1h = 12;
        storm.detail = "restarted 12 times in 1 h".into();
        let items = vec![storm, item("disk", "/", Sev::Ok)];
        let mut tracks = BTreeMap::new();
        tracks.insert("unit:lucina-rs.service".to_string(), Track {
            sev: Sev::Crit, since: 1_793_091_600, notified: true, retry: false, name: "lucina-rs".into(), prefix: "restarts".into(),
        });
        let metrics = Metrics {
            disks: vec![DiskMetric { mount: "/".into(), used_pct: 59.1, free_gb: 736.0 }],
            cpu_temp_c: Some(71.5),
            load: [1.2, 1.4, 1.6],
            mem_used_pct: 62.0,
            swap_used_pct: 10.0,
        };
        let snap = snapshot("nezopt", 1_793_097_000, metrics, &items, &tracks);
        let v = serde_json::to_value(&snap).unwrap();
        let keys = |o: &serde_json::Value| o.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&v), vec!["at", "checks", "host", "metrics", "overall"]);
        assert_eq!(keys(&v["metrics"]), vec!["cpu_temp_c", "disks", "load", "mem_used_pct", "swap_used_pct"]);
        assert_eq!(keys(&v["metrics"]["disks"][0]), vec!["free_gb", "mount", "used_pct"]);
        assert_eq!(keys(&v["checks"][0]), vec!["detail", "group", "id", "kind", "name", "restarts_1h", "since", "state"]);
        assert_eq!(v["host"], "nezopt");
        assert_eq!(v["at"], "2026-10-27T10:30:00Z");
        assert_eq!(v["overall"], "crit");
        let c = &v["checks"][0];
        assert_eq!(c["id"], "unit:lucina-rs.service");
        assert_eq!(c["kind"], "unit");
        assert_eq!(c["name"], "lucina-rs");
        assert_eq!(c["group"], "Lucina");
        assert_eq!(c["state"], "crit");
        assert_eq!(c["since"], "2026-10-27T09:00:00Z");
        assert_eq!(c["restarts_1h"], 12);
        // A check with no track yet starts now.
        assert_eq!(v["checks"][1]["since"], "2026-10-27T10:30:00Z");
        assert_eq!(v["checks"][1]["group"], "Homelab");
        assert!(v["metrics"]["cpu_temp_c"].is_number());
        let unknown = Metrics { cpu_temp_c: None, ..snap.metrics.clone() };
        assert!(serde_json::to_value(&unknown).unwrap()["cpu_temp_c"].is_null());
        for c in &snap.checks {
            assert!(KINDS.contains(&c.kind));
        }
    }

    #[test]
    fn groups_by_prefix() {
        for (n, g) in [
            ("lucina-rs", "Lucina"), ("secretary-maps", "Lucina"), ("cloudflared-lucina-link", "Lucina"),
            ("pokoin-newsroom", "Pokoin"), ("poko-shorts", "Pokoin"), ("ctcm-deals-worker", "Pokoin"),
            ("upworkpkn-image-status", "Pokoin"), ("nezopt-cardscan", "Pokoin"), ("pokoin-k3s", "Pokoin"),
            ("cardrails-api", "CardRails"), ("gh-runner-CardRailsIOS", "CardRails"), ("gh-runner-pokoin-scanner", "Pokoin"),
            ("dsh-remote", "AI"), ("flareon-honcho-mcp", "AI"), ("codevira@cardvault", "AI"), ("llama-server-qwen", "AI"),
            ("qwen-lane", "AI"), ("nezopt-dashboard", "Homelab"), ("ai-timers", "Other"),
        ] {
            assert_eq!(group_for(n), g, "{n}");
        }
    }

    #[test]
    fn legacy_keys_map_to_contract_kinds() {
        assert_eq!(Meta::legacy("unit.user.poko-shorts.service").id, "unit:poko-shorts.service");
        assert_eq!(Meta::legacy("unit.system.nextcloud.service").name, "nextcloud");
        let d = Meta::legacy("disk./");
        assert_eq!((d.kind, d.id.as_str(), d.group), ("disk", "disk:/", "Homelab"));
        let r = Meta::legacy("replication.standby");
        assert_eq!((r.kind, r.group), ("deadman", "Pokoin"));
    }

    #[test]
    fn merge_keeps_one_row_per_id_worst_first() {
        let mut a = item("unit", "x.service", Sev::Ok);
        a.detail = "active (running)".into();
        let mut b = item("unit", "x.service", Sev::Crit);
        b.detail = "restarted 11 times in 1 h".into();
        b.meta.restarts_1h = 11;
        let m = merge(vec![a, b, item("disk", "/", Sev::Ok)]);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].sev, Sev::Crit);
        assert_eq!(m[0].detail, "restarted 11 times in 1 h");
        assert_eq!(m[0].meta.restarts_1h, 11);
    }

    #[test]
    fn first_run_is_a_silent_baseline() {
        let none = BTreeSet::new();
        let (s1, p1) = track(&BTreeMap::new(), &[item("unit", "old.service", Sev::Crit), item("disk", "/", Sev::Ok)], &none, 0);
        assert!(p1.is_empty());
        assert!(!s1["unit:old.service"].notified);
        // Still crit next run: no push. Recovery of an unpushed crit: no push either.
        let (s2, p2) = track(&s1, &[item("unit", "old.service", Sev::Crit), item("disk", "/", Sev::Ok)], &none, 300);
        assert!(p2.is_empty());
        let (_, p3) = track(&s2, &[item("unit", "old.service", Sev::Ok), item("disk", "/", Sev::Crit)], &none, 600);
        assert_eq!(p3.len(), 1);
        assert_eq!((p3[0].kind, p3[0].id.as_str()), (PushKind::Crit, "disk:/"));
    }

    #[test]
    fn crit_pushes_once_then_recovers_once() {
        let none = BTreeSet::new();
        let (s1, p1) = track(&BTreeMap::new(), &[item("unit", "a.service", Sev::Ok)], &none, 0);
        assert!(p1.is_empty());
        let (s2, p2) = track(&s1, &[item("unit", "a.service", Sev::Crit)], &none, 300);
        assert_eq!(p2.len(), 1);
        assert_eq!(p2[0].kind, PushKind::Crit);
        assert_eq!(p2[0].title("nezopt"), "nezopt: a failed");
        assert_eq!(p2[0].dedup_key("nezopt"), "nezopt:unit:a.service");
        assert_eq!(s2["unit:a.service"].since, 300);
        // Already crit on the previous run: no push, since kept.
        let (s3, p3) = track(&s2, &[item("unit", "a.service", Sev::Crit)], &none, 600);
        assert!(p3.is_empty());
        assert_eq!(s3["unit:a.service"].since, 300);
        // crit → warn: no push, the alert stays pending.
        let (s4, p4) = track(&s3, &[item("unit", "a.service", Sev::Warn)], &none, 900);
        assert!(p4.is_empty());
        assert_eq!(s4["unit:a.service"].since, 900);
        // warn → ok: one recovered with the same dedup key.
        let (s5, p5) = track(&s4, &[item("unit", "a.service", Sev::Ok)], &none, 1200);
        assert_eq!(p5.len(), 1);
        assert_eq!(p5[0].kind, PushKind::Recovered);
        assert_eq!(p5[0].title("nezopt"), "nezopt: a recovered");
        let (_, p6) = track(&s5, &[item("unit", "a.service", Sev::Ok)], &none, 1500);
        assert!(p6.is_empty());
    }

    #[test]
    fn warn_never_pushes_and_crit_again_after_warn_does() {
        let none = BTreeSet::new();
        let (s1, p1) = track(&seeded(), &[item("log", "x", Sev::Warn)], &none, 0);
        assert!(p1.is_empty());
        let (s2, p2) = track(&s1, &[item("log", "x", Sev::Crit)], &none, 300);
        assert_eq!(p2.len(), 1);
        let (s3, _) = track(&s2, &[item("log", "x", Sev::Warn)], &none, 600);
        let (_, p4) = track(&s3, &[item("log", "x", Sev::Crit)], &none, 900);
        assert_eq!(p4.len(), 1, "a new change into crit is a new alert");
    }

    #[test]
    fn vanished_items_recover_unless_their_check_failed() {
        let none = BTreeSet::new();
        let (s1, _) = track(&seeded(), &[item("unit", "gone.service", Sev::Crit)], &none, 0);
        let broken: BTreeSet<String> = ["unit".to_string()].into();
        let (s2, p2) = track(&s1, &[], &broken, 300);
        assert!(p2.is_empty() && s2.contains_key("unit:gone.service"));
        let (s3, p3) = track(&s2, &[], &none, 600);
        assert_eq!(p3[0].kind, PushKind::Recovered);
        assert!(s3.is_empty());
    }

    #[test]
    fn undelivered_pushes_are_retried() {
        let none = BTreeSet::new();
        let (mut s1, p1) = track(&seeded(), &[item("unit", "a.service", Sev::Crit)], &none, 0);
        undelivered(&mut s1, &BTreeMap::new(), &p1, 0);
        let (s2, p2) = track(&s1, &[item("unit", "a.service", Sev::Crit)], &none, 300);
        assert_eq!(p2.len(), 1, "retry the failed crit push");
        assert_eq!(s2["unit:a.service"].since, 0);
        let (s3, p3) = track(&s2, &[item("unit", "a.service", Sev::Crit)], &none, 600);
        assert!(p3.is_empty());
        let (mut s4, p4) = track(&s3, &[], &none, 900);
        undelivered(&mut s4, &s3, &p4, 900);
        let (_, p5) = track(&s4, &[], &none, 1200);
        assert_eq!(p5[0].kind, PushKind::Recovered, "retry the failed recovered push");
    }

    #[test]
    fn restart_storm_thresholds_and_window() {
        assert_eq!(restart_sev(2), Sev::Ok);
        assert_eq!(restart_sev(3), Sev::Warn);
        assert_eq!(restart_sev(9), Sev::Warn);
        assert_eq!(restart_sev(10), Sev::Crit);
        // First sighting: the counter's history does not count.
        let (t0, n0) = restarts_update(None, 184, 0);
        assert_eq!(n0, 0);
        let (t1, n1) = restarts_update(Some(&t0), 188, 300);
        assert_eq!(n1, 4);
        let (t2, n2) = restarts_update(Some(&t1), 195, 600);
        assert_eq!((n2, restart_sev(n2)), (11, Sev::Crit));
        // An explicit restart reset the counter: everything after it is new.
        let (t3, n3) = restarts_update(Some(&t2), 1, 900);
        assert_eq!(n3, 12);
        // An hour on, only the restart at 900 is still inside the window.
        let (_, n4) = restarts_update(Some(&t3), 1, 600 + 3600);
        assert_eq!(n4, 1);
    }

    #[test]
    fn parses_show_blocks_and_ssh_forwards() {
        let text = "Id=a.service\nNRestarts=3\nActiveState=active\n\nId=b.service\nNRestarts=0\n";
        let m = parse_show(text);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["NRestarts"], "3");
        let exec = "{ path=/usr/bin/ssh ; argv[]=/usr/bin/ssh -NT -i k -R 127.0.0.1:7007:127.0.0.1:7007 -R127.0.0.1:7008:localhost:7008 -R 9000:10.0.0.2:22 -L 18888:10.200.0.2:18999 u@h ; ignore_errors=no ; start_time=[n/a] }";
        assert_eq!(ssh_remote_targets(exec), vec![7007, 7008]);
        assert!(ssh_remote_targets("{ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared -R 1:127.0.0.1:2 ; }").is_empty());
    }

    #[test]
    fn parses_containers_and_k3s_jobs() {
        let rows = "/lucina-nez\tunless-stopped\trunning\t\t0\n/prduct-nginx\tunless-stopped\texited\t\t3\n/honcho-api\talways\trunning\tunhealthy\t1\n/x\tno\trestarting\t\t9\n";
        let cs = parse_containers(rows);
        assert_eq!(cs.len(), 4);
        assert_eq!(cs[1].restarts, 3);
        let sevs: Vec<Sev> = cs.iter().map(|c| eval_container(c).0).collect();
        assert_eq!(sevs, vec![Sev::Ok, Sev::Crit, Sev::Crit, Sev::Warn]);
        let jobs = serde_json::json!({"items": [
            {"metadata": {"name": "search-delta-1", "creationTimestamp": "2026-10-27T10:00:00Z"},
             "status": {"conditions": [{"type": "Failed", "status": "True"}]}},
            {"metadata": {"name": "build-lists-2", "creationTimestamp": "2026-10-27T10:05:00Z"},
             "status": {"conditions": [{"type": "Complete", "status": "True"}]}},
        ]});
        assert_eq!(failed_jobs(&jobs), vec![("search-delta-1".to_string(), 1_793_095_200)]);
    }

    #[test]
    fn parses_proc_files_and_thresholds() {
        let mem = "MemTotal:       100000 kB\nMemFree: 1 kB\nMemAvailable:    38000 kB\nSwapTotal: 2000 kB\nSwapFree: 1800 kB\n";
        assert_eq!(parse_meminfo(mem), (62.0, 10.0));
        assert_eq!(parse_meminfo("MemTotal: 10 kB\nMemAvailable: 5 kB\nSwapTotal: 0 kB\n").1, 0.0);
        assert_eq!(parse_loadavg("1.20 1.40 1.60 2/900 1234\n"), [1.2, 1.4, 1.6]);
        let mounts = "/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p1 /boot/efi vfat rw 0 0\ntmpfs /run tmpfs rw 0 0\n\
                      /dev/mapper/mybook /home/nez/mnt/mybook xfs rw 0 0\n/dev/nvme0n1p2 /var/lib/docker ext4 rw 0 0\n\
                      /dev/loop3 /snap/x squashfs ro 0 0\n/dev/nvme0n1p2 /home/nez/bind ext4 rw 0 0\n";
        assert_eq!(parse_mounts(mounts), vec!["/", "/home/nez/mnt/mybook"]);
        assert_eq!((disk_sev(11.0), disk_sev(9.9), disk_sev(4.9)), (Sev::Ok, Sev::Warn, Sev::Crit));
        assert_eq!((temp_sev(89.9), temp_sev(90.0), temp_sev(95.0)), (Sev::Ok, Sev::Warn, Sev::Crit));
    }

    #[test]
    fn parses_expected_list() {
        let e = parse_expected("# comment\nlucina-rs\ngh-runner-CardRailsIOS.service\nsystem:mybook.service  # disk\ncontainer:pokoin-k3s\n\n");
        assert_eq!(e.user, vec!["lucina-rs.service", "gh-runner-CardRailsIOS.service"]);
        assert_eq!(e.system, vec!["mybook.service"]);
        assert_eq!(e.containers, vec!["pokoin-k3s"]);
    }
}
