//! The live API pods of the nezopt k3s namespace (`pokoin-overflow`), from one
//! `kubectl get pods -o json` per sentinel run: no Ready replica, a container that
//! restarted (OOMKilled named as such), memory near the pod's own limit, and Failed
//! leftovers. Crit findings mail at once, Warn findings land in the digest
//! (`POKOIN_SENTINEL_IMMEDIATE`), and a pod that could not be measured is never reported
//! as fine.
//!
//! Mail texts are built only from the pod fields named below and these constants: never
//! from `spec.containers[].env`, secret references or request data.

use crate::health::{self, Meta};
use crate::nezopt::NezCfg;
use crate::sentinel::{Finding, Sev, State};
use crate::sys;
use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};

/// The Deployment families whose pods are watched, by pod-name prefix. A Deployment pod is
/// named `<deployment>-<pod-template-hash>-<pod suffix>`; `pokoin-api-` is the Rust edge
/// serving api.pokoin.com and `cloudflared-` the tunnels that carry it (and, through this
/// prefix, `cloudflared-cdn`). Every prefix is also an expected family on its own, so a
/// Deployment whose last pod vanished is reported instead of silently disappearing.
const WATCH: [&str; 2] = ["pokoin-api-", "cloudflared-"];
/// A watched pod at or over this share of its own memory limit mails: the kills this
/// catches start as pressure, and the 1536Mi of the Guaranteed pods is the whole story
/// (finding PKN-10).
const MEM_CRIT_PCT: f64 = 80.0;
/// `kubectl top` and the cgroup need a couple of scrapes after a pod starts; a younger pod
/// without a reading is not "unmeasured" yet, or every rollout would warn.
const MEASURE_GRACE_S: i64 = 900;
/// How long the restart tracker of a pod that is gone is kept, so its restart window
/// survives the deletion of that pod.
const TRACK_KEEP_S: i64 = 3600;
/// The cgroup fallback: the pod containers of the k3s node are under this root, one leaf
/// directory per container (`cri-containerd-<id>.scope`), and this file holds its usage.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const CGROUP_FILE: &str = "memory.current";
/// `find` walks no deeper than this: real pod paths are 4 to 6 levels under the root.
const CGROUP_MAX_DEPTH: &str = "12";
const PHASE_RUNNING: &str = "Running";
const PHASE_FAILED: &str = "Failed";
/// How many pod names a detail line lists before it switches to "and N more".
const NAME_MAX: usize = 6;
/// Prefix of the `State::k3s_pod_restarts` keys of this check (`pod:<pod>/<container>`).
const TRACK_PREFIX: &str = "pod:";

#[derive(Clone, Debug, PartialEq)]
pub struct Container {
    pub name: String,
    /// The 64 hex digits of `containerID` (`containerd://<hex>`), for the cgroup fallback.
    pub id: String,
    pub restarts: u64,
    /// `lastState.terminated.reason`, empty when the container never terminated.
    pub reason: String,
    /// `lastState.terminated.finishedAt`, empty with no previous termination.
    pub finished_at: String,
    /// `spec.containers[].resources.limits.memory`, in bytes.
    pub limit_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pod {
    pub name: String,
    /// The Deployment family of a watched pod, `None` for every other pod of the namespace.
    pub family: Option<String>,
    pub phase: String,
    /// The `Ready` pod condition, and its reason while it is not true.
    pub ready: bool,
    pub not_ready: String,
    /// `status.reason` (an evicted pod says `Evicted`), empty when unset.
    pub status_reason: String,
    pub created: i64,
    pub containers: Vec<Container>,
}

impl Pod {
    fn watched(&self) -> bool {
        self.family.is_some()
    }

    /// The pod's memory ceiling: the sum of its container limits, or `None` when a
    /// container has no limit (then there is no share to compute and no kernel kill).
    fn limit_bytes(&self) -> Option<u64> {
        if self.containers.is_empty() {
            return None;
        }
        let mut total = 0u64;
        for c in &self.containers {
            total = total.checked_add(c.limit_bytes?)?;
        }
        Some(total)
    }
}

/// What one run could learn about memory, and from where.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Measured {
    /// Pod name → memory in use, in bytes.
    pub bytes: BTreeMap<String, u64>,
    /// Where the numbers came from, or why they are missing (it goes into the digest text).
    pub source: String,
}

/// One container whose restart counter rose, for the mail text.
struct Restart {
    family: String,
    pod: String,
    container: String,
    restarts: u64,
    /// Restarts since the previous run.
    fresh: u64,
    /// Restarts in the tracker's last-hour window.
    window: u32,
    reason: String,
    finished_at: String,
    limit: Option<u64>,
}

// ------------------------------------------------------------------ parsing

fn text(v: &serde_json::Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

/// A Kubernetes quantity (`1536Mi`, `2Gi`, `640M`, `1024`, …) in bytes.
pub fn parse_quantity(value: &str) -> Option<u64> {
    let t = value.trim();
    let cut = t
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(t.len());
    let (num, unit) = t.split_at(cut);
    let n: f64 = num.parse().ok()?;
    let mult: f64 = match unit {
        "" => 1.0,
        "k" | "K" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => 1024.0,
        "Mi" => 1024.0f64.powi(2),
        "Gi" => 1024.0f64.powi(3),
        "Ti" => 1024.0f64.powi(4),
        "Pi" => 1024.0f64.powi(5),
        "Ei" => 1024.0f64.powi(6),
        _ => return None,
    };
    // A quantity is a count of bytes: 0 or nonsense is not a limit to compare against.
    let bytes = n * mult;
    if !bytes.is_finite() || bytes < 1.0 || bytes >= u64::MAX as f64 {
        return None;
    }
    Some(bytes.round() as u64)
}

/// `kubectl top pods --no-headers`: `NAME  CPU(cores)  MEMORY(bytes)`, memory in bytes.
pub fn parse_top(value: &str) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for line in value.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        if let Some(bytes) = parse_quantity(cols[2]) {
            out.insert(cols[0].to_string(), bytes);
        }
    }
    out
}

/// `metadata.creationTimestamp` (RFC 3339) as unix seconds; 0 when it cannot be read,
/// which makes the pod old and therefore always expected to be measurable.
fn created_unix(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|d| d.timestamp())
        .unwrap_or(0)
}

/// The Deployment of a pod name, split at its `pod-template-hash` label when it has one.
pub fn family_of(name: &str, hash: Option<&str>) -> Option<String> {
    let prefix = WATCH.iter().copied().find(|p| name.starts_with(p))?;
    if let Some(h) = hash.filter(|h| !h.is_empty()) {
        if let Some(i) = name.find(&format!("-{h}-")) {
            return Some(name[..i].to_string());
        }
    }
    Some(prefix.trim_end_matches('-').to_string())
}

/// Every pod of a `kubectl get pods -o json` answer, watched or not.
pub fn pods_of(v: &serde_json::Value) -> Vec<Pod> {
    let mut out = Vec::new();
    for item in v["items"].as_array().into_iter().flatten() {
        let (meta, status) = (&item["metadata"], &item["status"]);
        let name = text(&meta["name"]);
        if name.is_empty() {
            continue;
        }
        let mut limits: BTreeMap<String, Option<u64>> = BTreeMap::new();
        for c in item["spec"]["containers"].as_array().into_iter().flatten() {
            limits.insert(
                text(&c["name"]),
                c["resources"]["limits"]["memory"]
                    .as_str()
                    .and_then(parse_quantity),
            );
        }
        let mut ready = false;
        let mut not_ready = String::new();
        for cond in status["conditions"].as_array().into_iter().flatten() {
            if text(&cond["type"]) != "Ready" {
                continue;
            }
            ready = text(&cond["status"]) == "True";
            if !ready {
                not_ready = text(&cond["reason"]);
            }
        }
        let mut containers = Vec::new();
        for c in status["containerStatuses"].as_array().into_iter().flatten() {
            let cname = text(&c["name"]);
            let term = &c["lastState"]["terminated"];
            containers.push(Container {
                id: match c["containerID"].as_str() {
                    Some(i) => i.rsplit("//").next().unwrap_or(i).to_string(),
                    None => String::new(),
                },
                restarts: c["restartCount"].as_u64().unwrap_or(0),
                reason: text(&term["reason"]),
                finished_at: text(&term["finishedAt"]),
                limit_bytes: limits.get(&cname).copied().flatten(),
                name: cname,
            });
        }
        out.push(Pod {
            family: family_of(&name, meta["labels"]["pod-template-hash"].as_str()),
            phase: text(&status["phase"]),
            ready,
            not_ready,
            status_reason: text(&status["reason"]),
            created: created_unix(&text(&meta["creationTimestamp"])),
            containers,
            name,
        });
    }
    out
}

/// The families to report on: the expected one of every prefix, plus every watched family
/// seen in the namespace.
pub fn families(pods: &[Pod]) -> Vec<String> {
    let mut out: Vec<String> = WATCH
        .iter()
        .map(|p| p.trim_end_matches('-').to_string())
        .collect();
    for p in pods.iter().filter_map(|p| p.family.clone()) {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// The `find` lines under the cgroup root whose directory names a container of `pods`:
/// pod name → the `memory.current` paths to read. Paths are matched, never built.
pub fn cgroup_paths(listing: &str, pods: &[&Pod]) -> BTreeMap<String, Vec<String>> {
    let mut ids: BTreeMap<&str, &str> = BTreeMap::new();
    for p in pods {
        for c in &p.containers {
            if c.id.len() >= 16 {
                ids.insert(c.id.as_str(), p.name.as_str());
            }
        }
    }
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in listing.lines() {
        let path = line.trim();
        if !path.starts_with(CGROUP_ROOT) || !path.ends_with(CGROUP_FILE) {
            continue;
        }
        if let Some((_, pod)) = ids.iter().find(|(id, _)| path.contains(**id)) {
            out.entry((*pod).to_string())
                .or_default()
                .push(path.to_string());
        }
    }
    out
}

/// The value of a `memory.current` file; "max" or anything else is not a reading.
pub fn parse_memory_current(value: &str) -> Option<u64> {
    value.split_whitespace().next()?.parse().ok()
}

// ------------------------------------------------------------------ checks

fn meta(nz: &NezCfg, what: &str) -> Meta {
    Meta::new("k3s", &format!("{}/{}", nz.k3s_namespace, what)).group("Pokoin")
}

fn hint(nz: &NezCfg, verb: &str, arg: &str) -> String {
    format!(
        "next: docker exec {} kubectl -n {} {verb} {arg}",
        nz.k3s_container, nz.k3s_namespace
    )
}

fn names(list: &[String]) -> String {
    let mut out = list
        .iter()
        .take(NAME_MAX)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if list.len() > NAME_MAX {
        out.push_str(&format!(" and {} more", list.len() - NAME_MAX));
    }
    out
}

/// Memory in Mi or Ki, the unit a limit is written in.
fn human(bytes: u64) -> String {
    const MIB: u64 = 1 << 20;
    if bytes >= MIB {
        format!("{}Mi", bytes / MIB)
    } else {
        format!("{}Ki", bytes / 1024)
    }
}

fn watched_of<'a>(pods: &'a [Pod], fam: &str) -> Vec<&'a Pod> {
    pods.iter()
        .filter(|p| p.family.as_deref() == Some(fam))
        .collect()
}

/// (1) The Deployment has no ready replica: one crit per outage, one ok when it is back.
pub fn eval_ready(pods: &[Pod], nz: &NezCfg) -> Vec<Finding> {
    let mut out = Vec::new();
    for fam in families(pods) {
        let mine = watched_of(pods, &fam);
        let ready = mine.iter().filter(|p| p.ready).count();
        let key = format!("pods.no-ready.{fam}");
        let f = if ready > 0 {
            let down = if mine.len() == ready {
                String::new()
            } else {
                let list: Vec<String> = mine
                    .iter()
                    .filter(|p| !p.ready)
                    .map(|p| format!("{} {}", p.name, p.not_ready))
                    .collect();
                format!(" ({} not Ready: {})", list.len(), names(&list))
            };
            Finding::new(
                key,
                Sev::Ok,
                format!("{ready}/{} {fam} pod(s) Ready{down}", mine.len()),
                1,
            )
        } else if mine.is_empty() {
            Finding::new(
                key,
                Sev::Crit,
                format!(
                    "no {fam} pod in {ns} at all: the Deployment runs no replica, so this origin answers nothing while the load balancer still sends it requests. {}",
                    hint(nz, "get deploy", &fam),
                    ns = nz.k3s_namespace,
                ),
                1,
            )
        } else {
            let list: Vec<String> = mine
                .iter()
                .map(|p| {
                    let state = if p.phase == PHASE_RUNNING {
                        "not Ready".to_string()
                    } else {
                        p.phase.clone()
                    };
                    if p.not_ready.is_empty() {
                        format!("{} {state}", p.name)
                    } else {
                        format!("{} {state} ({})", p.name, p.not_ready)
                    }
                })
                .collect();
            Finding::new(
                key,
                Sev::Crit,
                format!(
                    "no Ready {fam} replica in {ns} ({} pod(s): {}); every request the load balancer sends here fails. {}",
                    mine.len(),
                    names(&list),
                    hint(nz, "describe pod", &mine[0].name),
                    ns = nz.k3s_namespace,
                ),
                1,
            )
        };
        out.push(f.with(meta(nz, &format!("deploy/{fam}"))));
    }
    out
}

/// (2) A restart counter that rose since the previous run. It stays crit for the hour
/// around it, so a burst of kills is one mail and the reminder carries the running total.
pub fn eval_restarts(pods: &[Pod], state: &mut State, now: i64, nz: &NezCfg) -> Vec<Finding> {
    let mut rows: Vec<Restart> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for p in pods.iter().filter(|p| p.watched()) {
        let fam = p.family.clone().unwrap_or_default();
        for c in &p.containers {
            let id = format!("{TRACK_PREFIX}{}/{}", p.name, c.name);
            let prev = state.k3s_pod_restarts.get(&id).cloned();
            let fresh = match &prev {
                None => 0,
                Some(x) if c.restarts >= x.last => c.restarts - x.last,
                Some(_) => c.restarts,
            };
            let (t, window) = health::restarts_update(prev.as_ref(), c.restarts, now);
            state.k3s_pod_restarts.insert(id.clone(), t);
            seen.insert(id);
            if window > 0 {
                rows.push(Restart {
                    family: fam.clone(),
                    pod: p.name.clone(),
                    container: c.name.clone(),
                    restarts: c.restarts,
                    fresh,
                    window,
                    reason: c.reason.clone(),
                    finished_at: c.finished_at.clone(),
                    limit: c.limit_bytes,
                });
            }
        }
    }
    // A pod that is gone keeps its tracker only while its window is alive.
    state.k3s_pod_restarts.retain(|id, t| {
        seen.contains(id) || t.events.iter().any(|(ts, _)| now - *ts < TRACK_KEEP_S)
    });

    let mut out = Vec::new();
    for fam in families(pods) {
        let mine: Vec<&Restart> = rows.iter().filter(|r| r.family == fam).collect();
        if mine.is_empty() && watched_of(pods, &fam).is_empty() {
            continue;
        }
        let key = format!("pods.restarted.{fam}");
        let mut m = meta(nz, &format!("deploy/{fam}"));
        let f = if mine.is_empty() {
            Finding::new(
                key,
                Sev::Ok,
                format!("{fam}: no container restart in the last hour"),
                1,
            )
        } else {
            let total: u32 = mine.iter().map(|r| r.window).sum();
            let fresh: u64 = mine.iter().map(|r| r.fresh).sum();
            m.restarts_1h = total;
            let list: Vec<String> = mine
                .iter()
                .map(|r| {
                    let when = if r.finished_at.is_empty() {
                        "at an unknown time".to_string()
                    } else {
                        format!("at {}", r.finished_at)
                    };
                    let why = match r.reason.as_str() {
                        "" => format!("reason not recorded {when}"),
                        "OOMKilled" => format!(
                            "OOMKilled {when}: out of memory, the kernel killed it at its {} limit",
                            r.limit.map_or_else(|| "unknown".to_string(), human)
                        ),
                        other => format!("{other} {when}"),
                    };
                    format!(
                        "{}/{} restartCount {}, last kill {}",
                        r.pod, r.container, r.restarts, why
                    )
                })
                .collect();
            Finding::new(
                key,
                Sev::Crit,
                format!(
                    "{fam}: {total} container restart(s) in the last hour ({fresh} since the previous run): {}. {}",
                    names(&list),
                    hint(nz, "describe pod", &mine[0].pod),
                ),
                1,
            )
        };
        out.push(f.with(m));
    }
    out
}

/// (3) Memory against the pod's own limit. No reading is never an all-clear: the finding
/// goes warn (digest) instead of ok and says what could not be measured.
pub fn eval_memory(pods: &[Pod], mem: &Measured, now: i64, nz: &NezCfg) -> Vec<Finding> {
    fn share(p: &Pod, mem: &Measured) -> Option<(u64, f64)> {
        let used = *mem.bytes.get(&p.name)?;
        Some((used, used as f64 / p.limit_bytes()? as f64 * 100.0))
    }
    let mut out = Vec::new();
    for fam in families(pods) {
        let mine: Vec<&Pod> = watched_of(pods, &fam)
            .into_iter()
            .filter(|p| p.phase == PHASE_RUNNING && p.limit_bytes().is_some())
            .collect();
        if mine.is_empty() {
            continue;
        }
        let over: Vec<(&Pod, u64, f64)> = mine
            .iter()
            .filter_map(|p| share(p, mem).map(|(used, pct)| (*p, used, pct)))
            .filter(|(_, _, pct)| *pct >= MEM_CRIT_PCT)
            .collect();
        let missing: Vec<String> = mine
            .iter()
            .filter(|p| !mem.bytes.contains_key(&p.name))
            .filter(|p| now - p.created >= MEASURE_GRACE_S)
            .map(|p| p.name.clone())
            .collect();
        let key = format!("pods.over-memory.{fam}");
        let f = if !over.is_empty() {
            let list: Vec<String> = over
                .iter()
                .map(|(p, used, pct)| {
                    format!(
                        "{} {} of {} = {pct:.1}%",
                        p.name,
                        human(*used),
                        human(p.limit_bytes().unwrap_or(0))
                    )
                })
                .collect();
            Finding::new(
                key,
                Sev::Crit,
                format!(
                    "{fam} at or over {MEM_CRIT_PCT:.0}% of its memory limit: {}; the next step of that curve is a kernel kill of the pod. {}",
                    names(&list),
                    hint(nz, "top pod", &format!("{} --containers", over[0].0.name)),
                ),
                1,
            )
        } else if !missing.is_empty() {
            Finding::new(
                key,
                Sev::Warn,
                format!(
                    "{fam}: memory not measured for {} of {} pod(s) ({}); source: {}. Over-memory has no reading here, so this is not an all-clear.",
                    missing.len(),
                    mine.len(),
                    names(&missing),
                    mem.source,
                ),
                1,
            )
        } else {
            match mine.iter().filter_map(|p| share(p, mem).map(|(used, pct)| (*p, used, pct))).max_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal)) {
                Some((p, used, pct)) => Finding::new(
                    key,
                    Sev::Ok,
                    format!(
                        "{fam}: highest of {} pod(s) at {pct:.1}% of its memory limit ({} {} of {})",
                        mine.len(),
                        p.name,
                        human(used),
                        human(p.limit_bytes().unwrap_or(0))
                    ),
                    1,
                ),
                None => Finding::new(
                    key,
                    Sev::Ok,
                    format!("{fam}: no memory reading yet, all {} pod(s) started within the last {} min", mine.len(), MEASURE_GRACE_S / 60),
                    1,
                ),
            }
        };
        out.push(f.with(meta(nz, &format!("deploy/{fam}"))));
    }
    out
}

/// (4) Failed pods left in the namespace, as a digest line: the count now and at the
/// previous run, which is what the Monday mail then carries for this key.
pub fn eval_failed(pods: &[Pod], state: &mut State, nz: &NezCfg) -> Vec<Finding> {
    let failed: Vec<&Pod> = pods.iter().filter(|p| p.phase == PHASE_FAILED).collect();
    let prev = state.k3s_failed_pods_prev.unwrap_or(0);
    state.k3s_failed_pods_prev = Some(failed.len());
    let ns = nz.k3s_namespace.as_str();
    let list: Vec<String> = failed
        .iter()
        .map(|p| {
            if p.status_reason.is_empty() {
                p.name.clone()
            } else {
                format!("{} ({})", p.name, p.status_reason)
            }
        })
        .collect();
    let f = if failed.is_empty() {
        Finding::new(
            "pods.failed-pods",
            Sev::Ok,
            format!("no pod of {ns} in phase Failed"),
            1,
        )
    } else if failed.len() == prev {
        Finding::new(
            "pods.failed-pods",
            Sev::Ok,
            format!(
                "{prev} pod(s) of {ns} in phase Failed, unchanged since the previous run: {}",
                names(&list)
            ),
            1,
        )
    } else {
        Finding::new(
            "pods.failed-pods",
            Sev::Warn,
            format!(
                "{n} pod(s) of {ns} in phase Failed ({prev} at the previous run): {list}; they serve nothing but show what the kernel or a Job did here. {next}",
                n = failed.len(),
                list = names(&list),
                next = hint(nz, "describe pod", &failed[0].name),
            ),
            1,
        )
    };
    vec![f.with(meta(nz, "pods-failed"))]
}

/// One `kubectl get pods -o json`, then the four checks. A failure of that command fails
/// the whole check, so an earlier crit keeps its state instead of being called resolved.
pub fn findings(nz: &NezCfg, state: &mut State, now: i64) -> Result<Vec<Finding>> {
    let pods = pods_of(&kubectl(nz, &["get", "pods", "-o", "json"])?.parse::<serde_json::Value>()?);
    let mem = measure(nz, &pods);
    let mut out = eval_ready(&pods, nz);
    out.extend(eval_restarts(&pods, state, now, nz));
    out.extend(eval_memory(&pods, &mem, now, nz));
    out.extend(eval_failed(&pods, state, nz));
    Ok(out)
}

fn kubectl(nz: &NezCfg, args: &[&str]) -> Result<String> {
    let mut a: Vec<&str> = vec![
        "exec",
        &nz.k3s_container,
        "kubectl",
        "-n",
        &nz.k3s_namespace,
    ];
    a.extend(args.iter().copied());
    sys::output("docker", &a)
}

/// `kubectl top pods` first; when that fails (metrics-server down, or the node too loaded
/// to answer) each container's cgroup `memory.current`, read inside the k3s container.
pub fn measure(nz: &NezCfg, pods: &[Pod]) -> Measured {
    let watched: Vec<&Pod> = pods
        .iter()
        .filter(|p| p.watched() && p.phase == PHASE_RUNNING && p.limit_bytes().is_some())
        .collect();
    if watched.is_empty() {
        return Measured {
            bytes: BTreeMap::new(),
            source: "no watched Running pod with a memory limit".into(),
        };
    }
    match kubectl(nz, &["top", "pods", "--no-headers"]) {
        Ok(value) => Measured {
            bytes: parse_top(&value),
            source: "kubectl top pods".into(),
        },
        Err(top) => {
            let a: Vec<&str> = vec![
                "exec",
                &nz.k3s_container,
                "find",
                CGROUP_ROOT,
                "-maxdepth",
                CGROUP_MAX_DEPTH,
                "-type",
                "f",
                "-name",
                CGROUP_FILE,
            ];
            match sys::output("docker", &a) {
                Ok(listing) => Measured {
                    bytes: cgroup_usage(nz, cgroup_paths(&listing, &watched)),
                    source: format!(
                        "kubectl top failed ({top:#}); cgroup {CGROUP_ROOT}/**/{CGROUP_FILE}"
                    ),
                },
                Err(find) => Measured {
                    bytes: BTreeMap::new(),
                    source: format!(
                        "kubectl top failed ({top:#}) and reading {CGROUP_FILE} failed ({find:#})"
                    ),
                },
            }
        }
    }
}

/// One `cat` per container cgroup file, summed per pod. A file that vanished with its
/// container leaves that pod without a reading.
fn cgroup_usage(nz: &NezCfg, paths: BTreeMap<String, Vec<String>>) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for (pod, list) in paths {
        let mut sum = 0u64;
        let mut got = false;
        for path in list {
            if let Ok(value) = sys::output("docker", &["exec", &nz.k3s_container, "cat", &path]) {
                if let Some(v) = parse_memory_current(&value) {
                    sum = sum.saturating_add(v);
                    got = true;
                }
            }
        }
        if got {
            out.insert(pod, sum);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sentinel::{self, AlertState, CheckOut, EventKind};
    use anyhow::anyhow;
    use regex::Regex;
    use std::path::PathBuf;

    /// 2026-11-17T12:00:00Z: after every fixture pod was created, so none of them is too
    /// young to be expected to have a memory reading.
    const NOW: i64 = 1_794_916_800;
    /// The Guaranteed limit of the live API pods (finding PKN-10).
    const API_LIMIT: u64 = 1_610_612_736; // 1536Mi
    const REMIND: i64 = 6 * 3600;
    /// The value `POKOIN_SENTINEL_IMMEDIATE` should hold on nezopt: the three pod problems
    /// mail at once, the digest carries the leftover count, an unmeasured pod and a failed
    /// check.
    const IMMEDIATE: &str = r"^pods\.(no-ready|restarted|over-memory)";
    /// Planted as `POKOIN_TEST_ENV_CANARY` in the fixtures' `spec.containers[].env`; none of
    /// it may reach a mail.
    const CANARY: &str = "POKOIN-TEST-ENV-CANARY-8f2b6e";
    const BANNED: [&str; 7] = [
        CANARY,
        "POKOIN_TEST_ENV_CANARY",
        "MARKETPLACE_DATABASE_URL",
        "pokoin-api-env",
        "pokoin-api-nez-tunnel",
        "TUNNEL_TOKEN",
        "0.0.0.0:8080",
    ];

    const OUTAGE: &str = include_str!("../testdata/pods-outage.json");
    const RECOVERED: &str = include_str!("../testdata/pods-recovered.json");
    const RESTART_BASE: &str = include_str!("../testdata/pods-restart-base.json");
    const RESTART_OOM: &str = include_str!("../testdata/pods-restart-oom.json");
    const MEMORY: &str = include_str!("../testdata/pods-memory.json");
    const LEFTOVERS: &str = include_str!("../testdata/pods-leftovers.json");
    const TOP_HIGH: &str = include_str!("../testdata/top-high.txt");
    const TOP_OK: &str = include_str!("../testdata/top-ok.txt");
    const CGROUP_FIND: &str = include_str!("../testdata/cgroup-find.txt");

    fn nz() -> NezCfg {
        NezCfg {
            expected_file: PathBuf::from("testdata"),
            forwards: Vec::new(),
            k3s_container: "pokoin-k3s".into(),
            k3s_namespace: "pokoin-overflow".into(),
        }
    }

    fn pods(text: &str) -> Vec<Pod> {
        pods_of(&serde_json::from_str(text).unwrap())
    }

    fn top(text: &str) -> Measured {
        Measured {
            bytes: parse_top(text),
            source: "kubectl top pods".into(),
        }
    }

    /// Both memory readings failed, which is what `measure` returns when metrics-server is
    /// down and the node is too loaded to answer the cgroup walk either.
    fn not_measured() -> Measured {
        Measured {
            bytes: BTreeMap::new(),
            source: "kubectl top failed (docker exec pokoin-k3s kubectl -n pokoin-overflow top pods --no-headers exited \
                     failure: Metrics API could not get available metrics) and reading memory.current failed (exited 2)"
                .into(),
        }
    }

    fn got(fs: &[Finding], key: &str) -> Finding {
        fs.iter()
            .find(|f| f.key == key)
            .unwrap_or_else(|| {
                panic!(
                    "{key}: no finding among {:?}",
                    fs.iter().map(|f| &f.key).collect::<Vec<_>>()
                )
            })
            .clone()
    }

    fn outs(findings: Vec<Finding>) -> Vec<CheckOut> {
        vec![CheckOut {
            prefix: "pods",
            findings,
            complete: true,
        }]
    }

    /// One sentinel run over these findings: the alerted state it leaves and its events.
    fn run(
        prev: &BTreeMap<String, AlertState>,
        findings: Vec<Finding>,
        now: i64,
    ) -> (BTreeMap<String, AlertState>, Vec<sentinel::Event>) {
        sentinel::plan(prev, &outs(findings), now, REMIND)
    }

    fn keys(events: &[sentinel::Event]) -> Vec<String> {
        events.iter().map(|e| e.key.clone()).collect()
    }

    #[test]
    fn parses_the_pod_fields_the_mails_name() {
        let ps = pods(OUTAGE);
        assert_eq!(ps.len(), 4);
        let z = &ps[0];
        assert_eq!(
            (z.name.as_str(), z.phase.as_str(), z.family.as_deref()),
            ("pokoin-api-6559bc874-zq4vk", "Running", Some("pokoin-api"))
        );
        assert!(!z.ready);
        assert_eq!(z.not_ready, "ContainersNotReady");
        assert_eq!(z.created, created_unix("2026-11-16T21:04:11Z"));
        assert!(z.created < NOW - MEASURE_GRACE_S);
        assert_eq!(z.limit_bytes(), Some(API_LIMIT));
        let c = &z.containers[0];
        assert_eq!(
            (c.name.as_str(), c.restarts, c.limit_bytes),
            ("api", 4, Some(API_LIMIT))
        );
        assert_eq!(
            (c.reason.as_str(), c.finished_at.as_str()),
            ("OOMKilled", "2026-11-17T05:58:12Z")
        );
        assert_eq!(c.id.len(), 64, "{}", c.id);
        assert_eq!(ps[1].containers[0].reason, "");
        assert_eq!(ps[2].family.as_deref(), Some("cloudflared"));
        assert!(
            !ps[3].watched(),
            "redis is not one of the watched Deployments"
        );
        // What killed an evicted pod is status.reason, not a containerState.
        let l = &pods(LEFTOVERS)[2];
        assert_eq!(
            (l.phase.as_str(), l.status_reason.as_str()),
            ("Failed", "Evicted")
        );
    }

    #[test]
    fn quantities_and_readings_parse_as_kubectl_prints_them() {
        assert_eq!(parse_quantity("1536Mi"), Some(API_LIMIT));
        assert_eq!(parse_quantity("1.5Gi"), Some(API_LIMIT));
        assert_eq!(parse_quantity("2Gi"), Some(2_147_483_648));
        assert_eq!(parse_quantity("640M"), Some(640_000_000));
        assert_eq!(parse_quantity("4Ki"), Some(4096));
        assert_eq!(parse_quantity(" 256Mi "), Some(268_435_456));
        assert_eq!(parse_quantity("1024"), Some(1024));
        assert_eq!(
            parse_quantity("500m"),
            None,
            "a cpu quantity is not a memory limit"
        );
        assert_eq!(parse_quantity("Mi"), None);
        assert_eq!(parse_quantity(""), None);
        assert_eq!(parse_quantity("0"), None);

        assert_eq!(
            parse_top(TOP_HIGH)["pokoin-api-6559bc874-zq4vk"],
            1244 * 1048576
        );
        // The header of a `kubectl top pods` answer without --no-headers is not a pod.
        let h = parse_top(TOP_OK);
        assert_eq!(h.len(), 4);
        assert!(!h.contains_key("NAME"));

        assert_eq!(parse_memory_current("1304428544\n"), Some(1304428544));
        assert_eq!(parse_memory_current("  1304428544  \n"), Some(1304428544));
        assert_eq!(parse_memory_current("max"), None);
        assert_eq!(parse_memory_current(""), None);
    }

    #[test]
    fn families_split_at_the_pod_template_hash() {
        assert_eq!(
            family_of("pokoin-api-6559bc874-zq4vk", Some("6559bc874")).as_deref(),
            Some("pokoin-api")
        );
        assert_eq!(
            family_of("cloudflared-cdn-6b9f4d7c8-pvvw2", Some("6b9f4d7c8")).as_deref(),
            Some("cloudflared-cdn")
        );
        assert_eq!(
            family_of("pokoin-api-f5c4b3d2a1-zx9wq", None).as_deref(),
            Some("pokoin-api")
        );
        assert_eq!(family_of("redis-0", Some("6559bc874")), None);
        assert_eq!(
            families(&pods(OUTAGE)),
            vec!["cloudflared".to_string(), "pokoin-api".to_string()]
        );
        // A namespace whose pods all vanished still reports both expected Deployments.
        assert_eq!(
            families(&[]),
            vec!["cloudflared".to_string(), "pokoin-api".to_string()]
        );
    }

    #[test]
    fn cgroup_paths_match_a_watched_container_id_and_nothing_else() {
        let ps = pods(MEMORY);
        let watched: Vec<&Pod> = ps.iter().filter(|p| p.watched()).collect();
        let paths = cgroup_paths(CGROUP_FIND, &watched);
        assert_eq!(paths.len(), 3, "{paths:?}");
        let z = &paths["pokoin-api-6559bc874-zq4vk"];
        assert_eq!(z.len(), 1);
        // The Guaranteed slice for a QoS-Guaranteed pod, burstable for the others; found,
        // never guessed from the pod uid.
        assert!(
            z[0].starts_with("/sys/fs/cgroup/kubepods.slice/kubepods-pod"),
            "{}",
            z[0]
        );
        assert!(z[0].ends_with("-8a1f2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef.scope/memory.current"));
        let all: Vec<&String> = paths.values().flatten().collect();
        assert_eq!(all.len(), 3);
        assert!(all
            .iter()
            .all(|p| p.contains("cri-containerd-") && p.ends_with("/memory.current")));
        assert!(
            cgroup_paths(CGROUP_FIND, &[&ps[3]]).is_empty(),
            "redis is not watched"
        );
        assert!(cgroup_paths("", &watched).is_empty());
    }

    #[test]
    fn no_ready_replica_mails_once_and_the_recovery_once() {
        let nz = nz();
        let down = eval_ready(&pods(OUTAGE), &nz);
        let f = got(&down, "pods.no-ready.pokoin-api");
        assert_eq!(f.sev, Sev::Crit);
        assert_eq!(
            f.detail,
            "no Ready pokoin-api replica in pokoin-overflow (2 pod(s): pokoin-api-6559bc874-zq4vk not Ready \
             (ContainersNotReady), pokoin-api-6559bc874-t7xwl not Ready (ReadinessGatesNotReady)); every request the \
             load balancer sends here fails. next: docker exec pokoin-k3s kubectl -n pokoin-overflow describe pod \
             pokoin-api-6559bc874-zq4vk"
        );
        assert_eq!(
            f.meta.as_ref().unwrap().id,
            "k3s:pokoin-overflow/deploy/pokoin-api"
        );
        assert_eq!(got(&down, "pods.no-ready.cloudflared").sev, Sev::Ok);

        let (alerts, events) = sentinel::plan(&BTreeMap::new(), &outs(down), NOW, REMIND);
        assert_eq!(keys(&events), vec!["pods.no-ready.pokoin-api"]);
        assert_eq!(events[0].kind, EventKind::Firing);
        // The outage continues: one mail per outage, not one per run.
        assert!(run(&alerts, eval_ready(&pods(OUTAGE), &nz), NOW + 300)
            .1
            .is_empty());
        // Back up: exactly the recovery mail.
        let up = eval_ready(&pods(RECOVERED), &nz);
        assert_eq!(
            got(&up, "pods.no-ready.pokoin-api").detail,
            "2/2 pokoin-api pod(s) Ready"
        );
        let (active, events) = sentinel::plan(&alerts, &outs(up), NOW + 600, REMIND);
        assert_eq!(keys(&events), vec!["pods.no-ready.pokoin-api"]);
        assert_eq!(events[0].kind, EventKind::Resolved);
        let (subject, body) = sentinel::render(&events, &active, NOW + 600);
        assert_eq!(subject, "1 resolved");
        assert!(
            body.starts_with("RESOLVED OK pods.no-ready.pokoin-api (10 min)\n"),
            "{body}"
        );

        // A Deployment running no pod at all is said plainly, for every expected family.
        let gone = eval_ready(&[], &nz);
        assert_eq!(gone.len(), 2);
        for fam in ["pokoin-api", "cloudflared"] {
            let f = got(&gone, &format!("pods.no-ready.{fam}"));
            assert_eq!(f.sev, Sev::Crit);
            assert!(
                f.detail.starts_with(&format!(
                    "no {fam} pod in pokoin-overflow at all: the Deployment runs no replica"
                )),
                "{}",
                f.detail
            );
        }
    }

    #[test]
    fn a_restart_rise_mails_and_names_the_oom_kill() {
        let nz = nz();
        let mut state = State::default();
        // First sighting: the counter holds history, so nothing is claimed.
        let base = eval_restarts(&pods(RESTART_BASE), &mut state, NOW - 300, &nz);
        let f = got(&base, "pods.restarted.pokoin-api");
        assert_eq!(f.sev, Sev::Ok);
        assert_eq!(
            f.detail,
            "pokoin-api: no container restart in the last hour"
        );
        // One restart since then: the mail names the pod, the new count, OOMKilled and when.
        let oom = eval_restarts(&pods(RESTART_OOM), &mut state, NOW, &nz);
        let f = got(&oom, "pods.restarted.pokoin-api");
        assert_eq!(f.sev, Sev::Crit);
        assert_eq!(
            f.detail,
            "pokoin-api: 1 container restart(s) in the last hour (1 since the previous run): \
             pokoin-api-6559bc874-zq4vk/api restartCount 5, last kill OOMKilled at 2026-11-17T06:23:41Z: out of \
             memory, the kernel killed it at its 1536Mi limit. next: docker exec pokoin-k3s kubectl -n pokoin-overflow \
             describe pod pokoin-api-6559bc874-zq4vk"
        );
        assert_eq!(f.meta.as_ref().unwrap().restarts_1h, 1);
        let (alerts, events) = run(&BTreeMap::new(), oom, NOW);
        assert_eq!(keys(&events), vec!["pods.restarted.pokoin-api"]);
        assert_eq!(events[0].kind, EventKind::Firing);
        // An unchanged counter says nothing new, even while the hour around it is still crit.
        let same = eval_restarts(&pods(RESTART_OOM), &mut state, NOW + 300, &nz);
        let f = got(&same, "pods.restarted.pokoin-api");
        assert_eq!(f.sev, Sev::Crit);
        assert!(
            f.detail.contains("(0 since the previous run)"),
            "{}",
            f.detail
        );
        assert!(
            run(&alerts, same, NOW + 300).1.is_empty(),
            "no second mail for one restart"
        );
        // An hour later the window is empty and the check clears itself.
        let calm = eval_restarts(&pods(RESTART_OOM), &mut state, NOW + 3700, &nz);
        assert_eq!(got(&calm, "pods.restarted.pokoin-api").sev, Sev::Ok);
        let events = run(&alerts, calm, NOW + 3700).1;
        assert_eq!(keys(&events), vec!["pods.restarted.pokoin-api"]);
        assert_eq!(events[0].kind, EventKind::Resolved);
    }

    #[test]
    fn memory_at_81_of_the_limit_mails_79_says_nothing() {
        let nz = nz();
        let ps = pods(MEMORY);
        let over = eval_memory(&ps, &top(TOP_HIGH), NOW, &nz);
        let f = got(&over, "pods.over-memory.pokoin-api");
        assert_eq!(f.sev, Sev::Crit);
        assert_eq!(
            f.detail,
            "pokoin-api at or over 80% of its memory limit: pokoin-api-6559bc874-zq4vk 1244Mi of 1536Mi = 81.0%; the \
             next step of that curve is a kernel kill of the pod. next: docker exec pokoin-k3s kubectl -n \
             pokoin-overflow top pod pokoin-api-6559bc874-zq4vk --containers"
        );
        assert_eq!(got(&over, "pods.over-memory.cloudflared").sev, Sev::Ok);
        assert_eq!(
            keys(&run(&BTreeMap::new(), over, NOW).1),
            vec!["pods.over-memory.pokoin-api"]
        );

        let ok = eval_memory(&ps, &top(TOP_OK), NOW, &nz);
        let f = got(&ok, "pods.over-memory.pokoin-api");
        assert_eq!(f.sev, Sev::Ok);
        assert!(
            f.detail.contains("at 79.0% of its memory limit"),
            "{}",
            f.detail
        );
        assert!(f.detail.contains("1213Mi of 1536Mi"), "{}", f.detail);
        assert!(
            run(&BTreeMap::new(), ok, NOW).1.is_empty(),
            "79% mails nothing"
        );
    }

    #[test]
    fn an_unmeasured_pod_is_a_digest_warning_never_an_all_clear() {
        let nz = nz();
        let ps = pods(MEMORY);
        let blind = eval_memory(&ps, &not_measured(), NOW, &nz);
        let f = got(&blind, "pods.over-memory.pokoin-api");
        assert_eq!(f.sev, Sev::Warn);
        assert_eq!(
            f.detail,
            "pokoin-api: memory not measured for 2 of 2 pod(s) (pokoin-api-6559bc874-zq4vk, \
             pokoin-api-6559bc874-t7xwl); source: kubectl top failed (docker exec pokoin-k3s kubectl -n pokoin-overflow \
             top pods --no-headers exited failure: Metrics API could not get available metrics) and reading \
             memory.current failed (exited 2). Over-memory has no reading here, so this is not an all-clear."
        );
        // A crit is not called resolved by a run that could not measure anything.
        let crit = eval_memory(&ps, &top(TOP_HIGH), NOW, &nz);
        let (alerts, events) = run(&BTreeMap::new(), crit, NOW);
        assert_eq!(keys(&events), vec!["pods.over-memory.pokoin-api"]);
        let (next, events) = run(&alerts, blind.clone(), NOW + 300);
        assert!(
            !events.iter().any(|e| e.kind == EventKind::Resolved),
            "{events:?}"
        );
        assert!(
            next["pods.over-memory.pokoin-api"].alerted,
            "the outage is still alerted"
        );
        assert_eq!(next["pods.over-memory.pokoin-api"].sev, Sev::Warn);
        let re = Regex::new(IMMEDIATE).unwrap();
        // The warnings themselves are digest lines, never mails, and they name every family
        // that has no reading.
        let (mail, digest, _) = routed(&BTreeMap::new(), blind, NOW, &re);
        assert!(mail.is_empty(), "an unmeasured pod does not mail");
        assert_eq!(
            keys(&digest),
            vec![
                "pods.over-memory.cloudflared".to_string(),
                "pods.over-memory.pokoin-api".to_string()
            ]
        );
    }

    #[test]
    fn a_pod_too_young_for_metrics_or_without_a_limit_is_not_unmeasured() {
        let nz = nz();
        let mut young = pods(MEMORY)[0].clone();
        young.created = NOW - MEASURE_GRACE_S + 1;
        let f = eval_memory(&[young], &Measured::default(), NOW, &nz);
        let got_young = got(&f, "pods.over-memory.pokoin-api");
        assert_eq!(got_young.sev, Sev::Ok);
        assert_eq!(
            got_young.detail,
            "pokoin-api: no memory reading yet, all 1 pod(s) started within the last 15 min"
        );

        // A pod with no limit has no share to compute and no kernel kill coming.
        let mut free = pods(MEMORY)[0].clone();
        for c in &mut free.containers {
            c.limit_bytes = None;
        }
        assert!(eval_memory(&[free], &Measured::default(), NOW, &nz).is_empty());
    }

    #[test]
    fn failed_leftovers_are_one_digest_line_per_count_change() {
        let nz = nz();
        let mut state = State::default();
        let f = got(
            &eval_failed(&pods(LEFTOVERS), &mut state, &nz),
            "pods.failed-pods",
        );
        assert_eq!(f.sev, Sev::Warn);
        assert_eq!(
            f.detail,
            "3 pod(s) of pokoin-overflow in phase Failed (0 at the previous run): pokoin-api-5f7d9c8b4-qk1zz \
             (Evicted), pokoin-api-5f7d9c8b4-pp99jj (OOMKilling), search-delta-29021400-xc4m2 (Error); they serve \
             nothing but show what the kernel or a Job did here. next: docker exec pokoin-k3s kubectl -n \
             pokoin-overflow describe pod pokoin-api-5f7d9c8b4-qk1zz"
        );
        assert_eq!(
            f.meta.as_ref().unwrap().id,
            "k3s:pokoin-overflow/pods-failed"
        );
        assert_eq!(state.k3s_failed_pods_prev, Some(3));
        // The same three again: unchanged, so the digest gets nothing new. The Succeeded job
        // is never counted.
        let same = got(
            &eval_failed(&pods(LEFTOVERS), &mut state, &nz),
            "pods.failed-pods",
        );
        assert_eq!(same.sev, Sev::Ok);
        assert_eq!(
            same.detail,
            "3 pod(s) of pokoin-overflow in phase Failed, unchanged since the previous run: pokoin-api-5f7d9c8b4-qk1zz \
             (Evicted), pokoin-api-5f7d9c8b4-pp99jj (OOMKilling), search-delta-29021400-xc4m2 (Error)"
        );
        // A Succeeded job pod is not a leftover kill: alone, the namespace has none.
        let done: Vec<Pod> = pods(LEFTOVERS)
            .into_iter()
            .filter(|p| p.phase == "Succeeded")
            .collect();
        assert_eq!(done.len(), 1);
        assert_eq!(
            eval_failed(&done, &mut state, &nz)[0].detail,
            "no pod of pokoin-overflow in phase Failed"
        );
        assert_eq!(state.k3s_failed_pods_prev, Some(0));
        // It is a digest line, not a mail.
        let mut fresh = State::default();
        let (mail, digest, _) = routed(
            &BTreeMap::new(),
            eval_failed(&pods(LEFTOVERS), &mut fresh, &nz),
            NOW,
            &Regex::new(IMMEDIATE).unwrap(),
        );
        assert!(mail.is_empty());
        assert_eq!(keys(&digest), vec!["pods.failed-pods"]);
    }

    #[test]
    fn a_kubectl_failure_is_a_digest_error_and_no_false_all_clear() {
        let nz = nz();
        let down = eval_ready(&pods(OUTAGE), &nz);
        let (alerts, events) = run(&BTreeMap::new(), down, NOW);
        assert_eq!(keys(&events), vec!["pods.no-ready.pokoin-api"]);
        let broken = sentinel::check("pods", 1, || {
            Err(anyhow!("docker exec pokoin-k3s kubectl -n pokoin-overflow get pods -o json exited 1: Unable to connect to the server"))
        });
        assert!(!broken.complete, "the check did not run");
        assert_eq!(broken.findings[0].key, "pods.check");
        assert_eq!(broken.findings[0].sev, Sev::Crit);
        assert!(
            broken.findings[0]
                .detail
                .starts_with("check failed: docker exec pokoin-k3s kubectl"),
            "{}",
            broken.findings[0].detail
        );

        let (next, events) = sentinel::plan(&alerts, &[broken], NOW + 300, REMIND);
        // The outage keeps its alerted state: a failed command is not a recovery, and the
        // Secretary row of an incomplete check is not pushed as healthy.
        assert!(next["pods.no-ready.pokoin-api"].alerted);
        assert!(
            !events.iter().any(|e| e.kind == EventKind::Resolved),
            "{events:?}"
        );
        assert_eq!(keys(&events), vec!["pods.check"]);
        // The error line goes to the digest, so the owner still reads it; it is not mailed
        // as if the pods were down.
        let re = Regex::new(IMMEDIATE).unwrap();
        let (mail, digest) = sentinel::split_events(&events, &alerts, Some(&re));
        assert!(mail.is_empty());
        assert_eq!(keys(&digest), vec!["pods.check"]);
    }

    #[test]
    fn crit_pods_mail_at_once_and_everything_else_waits_for_the_digest() {
        let nz = nz();
        let mut state = State::default();
        // The outage fixture's live pods plus the Failed leftovers of the same namespace.
        let mut ps = pods(OUTAGE);
        ps.extend(
            pods(LEFTOVERS)
                .into_iter()
                .filter(|p| p.phase == PHASE_FAILED),
        );
        let mut all = eval_ready(&ps, &nz);
        all.extend(eval_restarts(&ps, &mut state, NOW, &nz));
        all.extend(eval_memory(&ps, &top(TOP_HIGH), NOW, &nz));
        all.extend(eval_failed(&ps, &mut state, &nz));
        assert!(
            all.iter().all(|f| f.key.starts_with("pods.")),
            "keys: {:?}",
            all.iter().map(|f| &f.key).collect::<Vec<_>>()
        );
        let events = run(&BTreeMap::new(), all, NOW).1;
        let re = Regex::new(IMMEDIATE).unwrap();
        let (mail, digest) = sentinel::split_events(&events, &BTreeMap::new(), Some(&re));
        assert_eq!(
            keys(&mail),
            vec!["pods.no-ready.pokoin-api", "pods.over-memory.pokoin-api"]
        );
        assert_eq!(keys(&digest), vec!["pods.failed-pods"]);
        // Without the filter (the legacy path) everything mails, as before.
        let (all_mail, none) = sentinel::split_events(&events, &BTreeMap::new(), None);
        assert_eq!(all_mail.len(), events.len());
        assert!(none.is_empty());
    }

    #[test]
    fn mail_text_never_carries_an_environment_value_or_a_secret_reference() {
        std::env::set_var("POKOIN_TEST_ENV_CANARY", CANARY);
        assert_eq!(std::env::var("POKOIN_TEST_ENV_CANARY").unwrap(), CANARY);
        let nz = nz();
        let mut state = State::default();
        for text in [
            OUTAGE,
            RECOVERED,
            RESTART_BASE,
            RESTART_OOM,
            MEMORY,
            LEFTOVERS,
        ] {
            for mem in [top(TOP_HIGH), top(TOP_OK), not_measured()] {
                let ps = pods(text);
                let mut all = eval_ready(&ps, &nz);
                all.extend(eval_restarts(&ps, &mut state, NOW, &nz));
                all.extend(eval_memory(&ps, &mem, NOW, &nz));
                all.extend(eval_failed(&ps, &mut state, &nz));
                let (active, events) =
                    sentinel::plan(&BTreeMap::new(), &outs(all.clone()), NOW, REMIND);
                let (subject, body) = sentinel::render(&events, &active, NOW);
                let mut texts: Vec<String> = all
                    .iter()
                    .map(|f| format!("{} {}", f.key, f.detail))
                    .collect();
                texts.extend(events.iter().map(|e| e.detail.clone()));
                texts.push(subject);
                texts.push(body);
                texts.push(format!("{ps:?}"));
                for t in &texts {
                    for banned in BANNED {
                        assert!(!t.contains(banned), "{banned} leaked into: {t}");
                    }
                }
            }
        }
        std::env::remove_var("POKOIN_TEST_ENV_CANARY");
    }

    /// One run's findings through `plan` and the `POKOIN_SENTINEL_IMMEDIATE` filter: what
    /// mails at once, what the Monday digest carries, and the state the run leaves.
    fn routed(
        prev: &BTreeMap<String, AlertState>,
        findings: Vec<Finding>,
        now: i64,
        re: &Regex,
    ) -> (
        Vec<sentinel::Event>,
        Vec<sentinel::Event>,
        BTreeMap<String, AlertState>,
    ) {
        let (next, events) = sentinel::plan(prev, &outs(findings), now, REMIND);
        let (mail, digest) = sentinel::split_events(&events, prev, Some(re));
        (mail, digest, next)
    }
}
