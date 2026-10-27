//! nezopt-only sentinel checks for what OnFailure= cannot see: restart storms, expected
//! units and containers that are not running, failed timers, new failed k3s Jobs, dead
//! forward targets, silent degradation in logs, disk % and CPU temperature. Each returns
//! findings with a snapshot `Meta`; the logic lives in `health`.

use crate::health::{self, Meta};
use crate::sentinel::{Cfg, CheckOut, Finding, Sev, State};
use crate::{env, sys};
use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

type Props = BTreeMap<String, String>;

const SHOW_PROPS: [&str; 8] = ["Id", "LoadState", "ActiveState", "SubState", "NRestarts", "Result", "ExecStart", "Transient"];

/// Silent degradation: units that exit 0 while a feature is off. `window_s: None` reads
/// the unit's last invocation; `Some` reads that much of the journal (long-running units).
struct LogSignal {
    unit: &'static str,
    needle: &'static str,
    window_s: Option<u64>,
}

const LOG_SIGNALS: [LogSignal; 3] = [
    LogSignal { unit: "marketplace-rails-sync.service", needle: "no CARDTRADER_AUTH_TOKEN", window_s: None },
    LogSignal { unit: "poko-shorts.service", needle: "invalid_grant", window_s: None },
    LogSignal { unit: "pokoin-newsroom.service", needle: "moderation_failed", window_s: Some(3600) },
];

pub struct NezCfg {
    pub expected_file: PathBuf,
    /// Extra forward targets `name=host:port,…` (the Infisical :8088 forward is not a unit).
    pub forwards: Vec<(String, String)>,
    pub k3s_container: String,
    pub k3s_namespace: String,
}

impl NezCfg {
    pub fn from_env() -> NezCfg {
        let forwards = env::get_or("POKOIN_SENTINEL_FORWARDS", "infisical=127.0.0.1:8088")
            .split(',')
            .filter_map(|s| s.split_once('='))
            .map(|(n, a)| (n.trim().to_string(), a.trim().to_string()))
            .collect();
        NezCfg {
            expected_file: env::get("POKOIN_SENTINEL_EXPECTED_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| env::home().join(".config/pokoin/expected-active.txt")),
            forwards,
            k3s_container: env::get_or("POKOIN_K3S_CONTAINER", "pokoin-k3s"),
            k3s_namespace: env::get_or("POKOIN_K3S_NAMESPACE", "pokoin-overflow"),
        }
    }
}

fn found(key: String, sev: Sev, detail: impl Into<String>, confirm: u32, meta: Meta) -> Finding {
    Finding::new(key, sev, detail, confirm).with(meta)
}

fn scope_args(user: bool) -> Vec<&'static str> {
    if user {
        vec!["--user"]
    } else {
        vec![]
    }
}

/// Every loaded service of a scope plus `extra` (expected units that may not be loaded).
fn services(user: bool, extra: &[String]) -> Result<Vec<Props>> {
    let mut args = scope_args(user);
    args.extend(["list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"]);
    let mut names: Vec<String> = sys::parse_failed_units(&sys::output("systemctl", &args)?);
    for e in extra {
        if !names.contains(e) {
            names.push(e.clone());
        }
    }
    show(user, &names, &SHOW_PROPS)
}

fn show(user: bool, units: &[String], props: &[&str]) -> Result<Vec<Props>> {
    if units.is_empty() {
        return Ok(vec![]);
    }
    let mut args = scope_args(user);
    args.extend(["show", "--no-pager"]);
    for p in props {
        args.extend(["-p", p]);
    }
    args.extend(units.iter().map(String::as_str));
    Ok(health::parse_show(&sys::output("systemctl", &args)?))
}

fn active_detail(p: &Props) -> (Sev, String) {
    let (a, s) = (p.get("ActiveState").map_or("", String::as_str), p.get("SubState").map_or("", String::as_str));
    match a {
        "active" => (Sev::Ok, format!("active ({s})")),
        // Auto-restart or a deploy restart in progress; storms are their own check.
        "activating" | "reloading" | "deactivating" => (Sev::Warn, format!("{a} ({s})")),
        "" => (Sev::Crit, "unknown state".into()),
        _ => (Sev::Crit, format!("{a} ({s}), expected to be running")),
    }
}

pub fn checks(cfg: &Cfg, nz: &NezCfg, state: &mut State, now: i64) -> Vec<CheckOut> {
    let mut outs = Vec::new();
    let expected = match std::fs::read_to_string(&nz.expected_file) {
        Ok(t) => health::parse_expected(&t),
        Err(e) => {
            eprintln!("sentinel: {}: {e}; no expected-active checks", nz.expected_file.display());
            health::Expected::default()
        }
    };
    let user = services(true, &expected.user);
    let system = services(false, &expected.system);

    // (a) restart storms, systemd units and containers share one tracker map.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut restarts_of: BTreeMap<String, u32> = BTreeMap::new();
    let storm = |id: &str, cur: u64, state: &mut State, seen: &mut BTreeSet<String>| -> u32 {
        let (t, n) = health::restarts_update(state.restarts.get(id), cur, now);
        state.restarts.insert(id.to_string(), t);
        seen.insert(id.to_string());
        n
    };
    outs.push(crate::sentinel::check("restarts", 1, || {
        let mut out = Vec::new();
        for (scope, props) in [("user", &user), ("system", &system)] {
            let props = props.as_ref().map_err(|e| anyhow!("{scope} units: {e:#}"))?;
            for p in props.iter() {
                let id = p["Id"].clone();
                if p.get("LoadState").map(String::as_str) != Some("loaded") || cfg.ignore_units.is_match(&id) {
                    continue;
                }
                let cur: u64 = p.get("NRestarts").and_then(|v| v.parse().ok()).unwrap_or(0);
                let n = storm(&format!("unit:{id}"), cur, state, &mut seen);
                restarts_of.insert(id.clone(), n);
                if n > 0 {
                    let sev = health::restart_sev(n);
                    let detail = format!("restarted {n} times in 1 h");
                    out.push(found(format!("restarts.{scope}.{id}"), sev, detail, 1, Meta::new("unit", &id).restarts(n)));
                }
            }
        }
        Ok(out)
    }));

    // (b) expected-active units.
    outs.push(crate::sentinel::check("expected", 1, || {
        let mut out = Vec::new();
        for (scope, props, names) in [("user", &user, &expected.user), ("system", &system, &expected.system)] {
            let props = props.as_ref().map_err(|e| anyhow!("{scope} units: {e:#}"))?;
            for name in names {
                let p = props.iter().find(|p| &p["Id"] == name);
                let (sev, detail) = match p {
                    Some(p) if p.get("LoadState").map(String::as_str) == Some("not-found") => (Sev::Crit, "unit file not found".into()),
                    Some(p) => active_detail(p),
                    None => (Sev::Crit, "unit not found".into()),
                };
                let n = restarts_of.get(name).copied().unwrap_or(0);
                out.push(found(format!("expected.{scope}.{name}"), sev, detail, 1, Meta::new("unit", name).restarts(n)));
            }
        }
        Ok(out)
    }));

    // Timers whose last run failed.
    outs.push(crate::sentinel::check("timer", 1, || {
        let mut out = Vec::new();
        for user_scope in [true, false] {
            let mut args = scope_args(user_scope);
            args.extend(["list-timers", "--all", "--plain", "--no-legend", "--no-pager"]);
            let text = sys::output("systemctl", &args)?;
            let timers: Vec<String> = text
                .lines()
                .flat_map(|l| l.split_whitespace())
                .filter(|w| w.ends_with(".timer"))
                .filter(|w| !cfg.ignore_units.is_match(w))
                .map(str::to_string)
                .collect();
            let tprops = show(user_scope, &timers, &["Id", "Unit"])?;
            let targets: Vec<String> = tprops.iter().filter_map(|p| p.get("Unit").cloned()).collect();
            let sprops = show(user_scope, &targets, &["Id", "Result", "ActiveState", "ExecMainExitTimestamp"])?;
            for t in &tprops {
                let Some(target) = t.get("Unit") else { continue };
                let s = sprops.iter().find(|p| &p["Id"] == target);
                let result = s.and_then(|s| s.get("Result")).map_or("unknown", String::as_str);
                let when = s.and_then(|s| s.get("ExecMainExitTimestamp")).filter(|w| !w.is_empty()).map_or("never".to_string(), |w| w.clone());
                let (sev, detail) = if result == "success" {
                    (Sev::Ok, format!("last run ok ({when})"))
                } else {
                    (Sev::Crit, format!("last run of {target} failed: {result} ({when})"))
                };
                let id = t["Id"].clone();
                let name = id.strip_suffix(".timer").unwrap_or(&id).to_string();
                let mut meta = Meta::new("timer", &id);
                meta.name = name.clone();
                meta.group = health::group_for(&name);
                out.push(found(format!("timer.{id}"), sev, detail, 1, meta));
            }
        }
        Ok(out)
    }));

    // (c) docker.
    let mut container_ids = BTreeSet::new();
    outs.push(crate::sentinel::check("container", 1, || {
        let ids = sys::output("docker", &["ps", "-aq", "--no-trunc"])?;
        let ids: Vec<&str> = ids.split_whitespace().collect();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let mut args = vec![
            "inspect",
            "--format",
            "{{.Name}}\t{{.HostConfig.RestartPolicy.Name}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.RestartCount}}",
        ];
        args.extend(ids);
        let cs = health::parse_containers(&sys::output("docker", &args)?);
        let mut out = Vec::new();
        for want in &expected.containers {
            if !cs.iter().any(|c| &c.name == want) {
                out.push(found(format!("container.{want}"), Sev::Crit, "container does not exist", 1, Meta::new("container", want)));
            }
        }
        for c in &cs {
            let watched = matches!(c.policy.as_str(), "unless-stopped" | "always") || expected.containers.contains(&c.name);
            if !watched {
                continue;
            }
            let id = format!("container:{}", c.name);
            container_ids.insert(id.clone());
            let n = storm(&id, c.restarts, state, &mut seen);
            let (mut sev, mut detail) = health::eval_container(c);
            if n > 0 {
                let s = health::restart_sev(n);
                detail = format!("{detail}, restarted {n} times in 1 h");
                sev = sev.max(s);
            }
            out.push(found(format!("container.{}", c.name), sev, detail, 1, Meta::new("container", &c.name).restarts(n)));
        }
        Ok(out)
    }));
    // Drop trackers of units/containers that are gone (only when their check ran).
    let units_ok = user.is_ok() && system.is_ok();
    let containers_ok = outs.last().is_some_and(|o| o.complete);
    state.restarts.retain(|id, _| {
        seen.contains(id) || (id.starts_with("unit:") && !units_ok) || (id.starts_with("container:") && !containers_ok)
    });

    // (d) k3s: failed Jobs created since the previous run stay a warning for an hour.
    outs.push(crate::sentinel::check("k3s", 1, || {
        let text = sys::output("docker", &["exec", &nz.k3s_container, "kubectl", "get", "jobs", "-n", &nz.k3s_namespace, "-o", "json"])?;
        let v: serde_json::Value = serde_json::from_str(&text)?;
        let failed = health::failed_jobs(&v);
        let last = state.k3s_last_run;
        if last > 0 {
            for (name, created) in &failed {
                if *created > last && !state.k3s_new_failed.iter().any(|(n, _)| n == name) {
                    state.k3s_new_failed.push((name.clone(), now));
                }
            }
        }
        state.k3s_new_failed.retain(|(_, seen_at)| now - seen_at < 3600);
        state.k3s_last_run = now;
        let meta = Meta::new("k3s", &format!("{}/jobs", nz.k3s_namespace)).group("Pokoin");
        let f = if state.k3s_new_failed.is_empty() {
            found("k3s.jobs".into(), Sev::Ok, format!("no new failed Jobs ({} old failed Jobs kept)", failed.len()), 1, meta)
        } else {
            let names: Vec<&str> = state.k3s_new_failed.iter().map(|(n, _)| n.as_str()).collect();
            found("k3s.jobs".into(), Sev::Warn, format!("{} new failed Job(s): {}", names.len(), names.join(", ")), 1, meta)
        };
        Ok(vec![f])
    }));

    // (e) forwards: the local target of every active `ssh -R` unit, plus extras.
    outs.push(crate::sentinel::check("forward", 1, || {
        let mut targets: Vec<(String, String, &'static str)> = Vec::new();
        for (scope, props) in [("user", &user), ("system", &system)] {
            let props = props.as_ref().map_err(|e| anyhow!("{scope} units: {e:#}"))?;
            for p in props.iter().filter(|p| p.get("ActiveState").map(String::as_str) == Some("active")) {
                let Some(exec) = p.get("ExecStart") else { continue };
                let unit = p["Id"].strip_suffix(".service").unwrap_or(&p["Id"]).to_string();
                for port in health::ssh_remote_targets(exec) {
                    targets.push((format!("{unit}:{port}"), format!("127.0.0.1:{port}"), health::group_for(&unit)));
                }
            }
        }
        for (name, addr) in &nz.forwards {
            let port = addr.rsplit(':').next().unwrap_or("");
            targets.push((format!("{name}:{port}"), addr.clone(), health::group_for(name)));
        }
        let mut out = Vec::new();
        for (name, addr, group) in targets {
            let meta = Meta::new("forward", &name).group(group);
            let (sev, detail) = match addr.parse::<SocketAddr>() {
                Ok(sa) => match TcpStream::connect_timeout(&sa, Duration::from_secs(3)) {
                    Ok(_) => (Sev::Ok, format!("{addr} accepts connections")),
                    Err(e) => (Sev::Crit, format!("{addr}: {e}")),
                },
                Err(_) => (Sev::Crit, format!("bad address {addr}")),
            };
            out.push(found(format!("forward.{name}"), sev, detail, 1, meta));
        }
        Ok(out)
    }));

    // (f) silent degradation.
    outs.push(crate::sentinel::check("log", 1, || {
        let mut out = Vec::new();
        for s in &LOG_SIGNALS {
            let props = show(true, &[s.unit.to_string()], &["Id", "LoadState", "InvocationID"])?;
            let Some(p) = props.first().filter(|p| p.get("LoadState").map(String::as_str) == Some("loaded")) else { continue };
            let text = match (s.window_s, p.get("InvocationID").filter(|i| !i.is_empty())) {
                (Some(w), _) => sys::output("journalctl", &["--user", "-u", s.unit, "--since", &format!("-{w}s"), "-o", "cat", "--no-pager"])?,
                (None, Some(inv)) => sys::output("journalctl", &["--user", &format!("_SYSTEMD_INVOCATION_ID={inv}"), "-o", "cat", "--no-pager"])?,
                (None, None) => String::new(),
            };
            let n = text.lines().filter(|l| l.contains(s.needle)).count();
            let what = s.window_s.map_or("the last run".to_string(), |w| format!("the last {} min", w / 60));
            let (sev, detail) = if n > 0 {
                (Sev::Warn, format!("{n}× '{}' in {what}", s.needle))
            } else {
                (Sev::Ok, format!("no '{}' in {what}", s.needle))
            };
            let name = s.unit.strip_suffix(".service").unwrap_or(s.unit);
            out.push(found(format!("log.{name}"), sev, detail, 1, Meta::new("log", name)));
        }
        Ok(out)
    }));

    // Disks in % and CPU temperature.
    outs.push(crate::sentinel::check("diskpct", 1, || {
        let mut out = Vec::new();
        for d in disks()? {
            let free_pct = 100.0 - d.used_pct;
            let sev = health::disk_sev(free_pct);
            let detail = format!("{:.1}% free ({:.0} GB)", free_pct, d.free_gb);
            out.push(found(format!("diskpct.{}", d.mount), sev, detail, 1, Meta::new("disk", &d.mount).group("Homelab")));
        }
        Ok(out)
    }));
    if let Some(t) = cpu_temp() {
        let sev = health::temp_sev(t);
        let meta = Meta::new("deadman", "cpu-temp").group("Homelab");
        outs.push(CheckOut {
            prefix: "temp",
            findings: vec![found("temp.cpu".into(), sev, format!("CPU Tctl {t:.1} °C (warn 90, crit 95)"), 1, meta)],
            complete: true,
        });
    }
    outs
}

pub fn disks() -> Result<Vec<health::DiskMetric>> {
    let mounts = health::parse_mounts(&std::fs::read_to_string("/proc/self/mounts")?);
    let mut out = Vec::new();
    for m in mounts {
        let (total, free, avail) = sys::fs_stats(Path::new(&m))?;
        let used = total.saturating_sub(free);
        let denom = used + avail;
        if denom == 0 {
            continue;
        }
        out.push(health::DiskMetric {
            mount: m,
            used_pct: health::round1(used as f64 / denom as f64 * 100.0),
            free_gb: health::round1(avail as f64 / sys::GB as f64),
        });
    }
    Ok(out)
}

/// k10temp Tctl, in °C.
pub fn cpu_temp() -> Option<f64> {
    for entry in std::fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
        let dir = entry.path();
        if std::fs::read_to_string(dir.join("name")).is_ok_and(|n| n.trim() == "k10temp") {
            let milli: f64 = std::fs::read_to_string(dir.join("temp1_input")).ok()?.trim().parse().ok()?;
            return Some(health::round1(milli / 1000.0));
        }
    }
    None
}

pub fn metrics() -> health::Metrics {
    let (mem, swap) = std::fs::read_to_string("/proc/meminfo").map(|t| health::parse_meminfo(&t)).unwrap_or((0.0, 0.0));
    health::Metrics {
        disks: disks().unwrap_or_default(),
        cpu_temp_c: cpu_temp(),
        load: std::fs::read_to_string("/proc/loadavg").map(|t| health::parse_loadavg(&t)).unwrap_or([0.0; 3]),
        mem_used_pct: mem,
        swap_used_pct: swap,
    }
}
