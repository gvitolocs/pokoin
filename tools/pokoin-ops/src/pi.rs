//! `pi-health` (nezopt): the Pi being offline is a state, not a failure. A 1-minute timer
//! probes the Pi's SSH port and keeps `pi-health.json`. Only the transitions alert: one
//! mail + Secretary push when the Pi goes down (after `POKOIN_PI_DOWN_AFTER` failed probes)
//! and one when it is back, with the outage length.
//!
//! While the Pi is down the Pi-dependent units skip through their `ExecCondition=` probe
//! (`~/.local/bin/pokoin-pi-up`), the sentinel mutes their findings (`mute`), and the
//! healthchecks of the Pi's own timers are paused (a paused check resumes on its next ping).
//! When it is back, the enabled long-running units (the SSH tunnels) are started again,
//! because a condition skip ends `Restart=`, and the catch-up units run once.
//!
//! Planned work on the Pi: `pokoin-ops pi-health --maintenance 2h --reason "SSD move"` declares a
//! window. It pauses the healthchecks at once and says so in one notice, and the down/back alerts
//! are held. If the window ends with the Pi still down, that alert goes out then (`notice`).

use crate::sentinel::{CheckOut, Sev};
use crate::{env, mail, secretary, sys};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_ADDR: &str = "192.168.178.46:22";
/// Long-running units that need the Pi; started again when it is reachable.
pub const DEFAULT_UNITS: &str =
    "pokoin-scan-pi-tunnel.service,pokoin-honcho-pi-tunnel.service,tcgprices-pi-reader-tunnel.service,pokoin-pi-cdn-tunnel.service";
/// Oneshots that follow the Pi; run once when it comes back.
pub const DEFAULT_CATCHUP: &str = "pokoin-overflow-sync.service,poko-video-mirror.service";
/// Finding keys the sentinel mutes while the Pi is down, besides the units above.
pub const DEFAULT_MUTE: &str = "replication.standby,replication.lag";
/// Healthchecks paused on the way down: every Pi timer, and the nezopt sync that skips.
pub const DEFAULT_HC_PAUSE: &str = "pi-*,nezopt-overflow-sync";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Link {
    #[default]
    Unknown,
    Up,
    Down,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub link: Link,
    /// When `link` last changed (down: the first failed probe of the outage).
    pub since: i64,
    pub fails: u32,
    pub first_fail: i64,
    pub last_probe: i64,
    pub last_error: String,
    /// Declared maintenance: no down/back alerts before this time (unix s; 0 = none).
    #[serde(default)]
    pub maintenance_until: i64,
    #[serde(default)]
    pub maintenance_reason: String,
    /// The owner was told the Pi is down, so the return is worth a "back" alert.
    #[serde(default)]
    pub down_alerted: bool,
}

#[derive(Debug, PartialEq)]
pub enum Notice {
    None,
    Down,
    Back,
}

/// Which alert a transition is worth, given a maintenance window. A window that ends with
/// the Pi still down yields the `Down` it held back; an outage that stayed inside the window
/// is never announced, so its return is not either.
pub fn notice(state: &mut State, t: &Transition, now: i64) -> Notice {
    let quiet = now < state.maintenance_until;
    let n = match t {
        Transition::WentDown { .. } if !quiet => {
            state.down_alerted = true;
            Notice::Down
        }
        Transition::WentDown { .. } | Transition::Learned(Link::Down) => {
            state.down_alerted = false;
            Notice::None
        }
        Transition::CameBack { .. } => {
            let told = state.down_alerted;
            state.down_alerted = false;
            if told {
                Notice::Back
            } else {
                Notice::None
            }
        }
        Transition::None if state.link == Link::Down && !state.down_alerted && !quiet => {
            state.down_alerted = true;
            Notice::Down
        }
        _ => Notice::None,
    };
    if !quiet && state.maintenance_until != 0 && state.link == Link::Up {
        state.maintenance_until = 0;
        state.maintenance_reason.clear();
    }
    n
}

/// `2h`, `90m`, `1h30m`, `45s` → seconds.
pub fn parse_duration(text: &str) -> Result<i64> {
    let (mut total, mut num) = (0i64, String::new());
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: i64 = num.parse().map_err(|_| anyhow!("bad duration {text:?}"))?;
        total += n * match c {
            'h' => 3600,
            'm' => 60,
            's' => 1,
            _ => return Err(anyhow!("bad duration {text:?}: use h, m, s")),
        };
        num.clear();
    }
    if !num.is_empty() || total <= 0 {
        return Err(anyhow!("bad duration {text:?} (e.g. 2h, 90m, 1h30m)"));
    }
    Ok(total)
}

#[derive(Debug, PartialEq)]
pub enum Transition {
    None,
    /// First probe after install or a lost state file: no alert.
    Learned(Link),
    WentDown { since: i64 },
    CameBack { down_s: i64 },
}

/// The state machine, without I/O: `ok` is this run's probe result.
pub fn step(state: &mut State, ok: bool, now: i64, down_after: u32, err: &str) -> Transition {
    state.last_probe = now;
    if ok {
        state.fails = 0;
        state.last_error.clear();
        return match state.link {
            Link::Up => Transition::None,
            Link::Unknown => {
                state.link = Link::Up;
                state.since = now;
                Transition::Learned(Link::Up)
            }
            Link::Down => {
                let down_s = now - state.since;
                state.link = Link::Up;
                state.since = now;
                Transition::CameBack { down_s }
            }
        };
    }
    if state.fails == 0 {
        state.first_fail = now;
    }
    state.fails += 1;
    state.last_error = err.to_string();
    if state.link == Link::Down || state.fails < down_after.max(1) {
        return Transition::None;
    }
    let was = state.link;
    state.link = Link::Down;
    state.since = state.first_fail;
    if was == Link::Unknown {
        Transition::Learned(Link::Down)
    } else {
        Transition::WentDown { since: state.first_fail }
    }
}

fn state_path() -> PathBuf {
    env::state_dir().join("pi-health.json")
}

pub fn load() -> State {
    std::fs::read(state_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(state: &State) -> Result<()> {
    let path = state_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Since when the Pi is down, if `pi-health` says so. The sentinel's only input from here.
pub fn down_since() -> Option<i64> {
    let s = load();
    (s.link == Link::Down).then_some(s.since)
}

/// Two TCP connects to the Pi's SSH port, 3 s each.
pub fn probe(addr: &str) -> Result<()> {
    let addrs: Vec<SocketAddr> = addr.to_socket_addrs().map_err(|e| anyhow!("{addr}: {e}"))?.collect();
    let target = addrs.first().ok_or_else(|| anyhow!("{addr}: no address"))?;
    let mut last = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2));
        }
        match TcpStream::connect_timeout(target, Duration::from_secs(3)) {
            Ok(_) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(anyhow!("{addr}: {last}"))
}

pub fn list(key: &str, default: &str) -> Vec<String> {
    env::get_or(key, default).split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// Lower-case `1h 5m` / `12m` / `40s`.
pub fn human(secs: i64) -> String {
    let s = secs.max(0);
    match (s / 3600, (s % 3600) / 60) {
        (0, 0) => format!("{s}s"),
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

/// Mutes Pi-dependent findings while the Pi is down: they become OK with the reason in
/// front, so their alerts resolve instead of repeating, and the one Pi alert stands.
pub fn mute(outs: &mut [CheckOut], since: i64, now: i64) -> usize {
    let mut needles: Vec<String> = list("POKOIN_PI_UNITS", DEFAULT_UNITS)
        .into_iter()
        .chain(list("POKOIN_PI_CATCHUP_UNITS", DEFAULT_CATCHUP))
        .map(|u| u.strip_suffix(".service").unwrap_or(&u).to_string())
        .collect();
    let exact = list("POKOIN_PI_MUTE_KEYS", DEFAULT_MUTE);
    needles.sort();
    let mut n = 0;
    for o in outs.iter_mut() {
        for f in o.findings.iter_mut().filter(|f| f.sev != Sev::Ok) {
            if exact.iter().any(|k| &f.key == k) || needles.iter().any(|u| mentions_unit(&f.key, u)) {
                f.detail = format!("Pi offline for {} (pi-health): {}", human(now - since), f.detail);
                f.sev = Sev::Ok;
                n += 1;
            }
        }
    }
    n
}

/// `unit.user.poko-video-mirror.service`, `timer.poko-video-mirror.timer`,
/// `forward.pokoin-scan-pi-tunnel:8098` mention `poko-video-mirror` / `pokoin-scan-pi-tunnel`;
/// `poko-video-mirror-x` does not.
fn mentions_unit(key: &str, stem: &str) -> bool {
    key.match_indices(stem).any(|(i, _)| {
        let before = key[..i].chars().next_back();
        let after = key[i + stem.len()..].chars().next();
        matches!(before, None | Some('.') | Some(':')) && matches!(after, None | Some('.') | Some(':'))
    })
}

fn systemctl_user(args: &[&str]) -> Result<String> {
    let mut all = vec!["--user"];
    all.extend_from_slice(args);
    sys::output("systemctl", &all)
}

/// Starts the enabled units that are not active. `systemctl start` of a running unit is a
/// no-op, but asking first keeps the journal quiet.
fn ensure_started(units: &[String]) -> Vec<String> {
    let mut started = Vec::new();
    for u in units {
        let enabled = systemctl_user(&["is-enabled", u]).map(|s| s.trim().to_string()).unwrap_or_default();
        if enabled != "enabled" {
            continue;
        }
        let active = systemctl_user(&["is-active", u]).map(|s| s.trim().to_string()).unwrap_or_default();
        if active == "active" || active == "activating" {
            continue;
        }
        match systemctl_user(&["start", "--no-block", u]) {
            Ok(_) => started.push(u.clone()),
            Err(e) => eprintln!("pi-health: start {u}: {e:#}"),
        }
    }
    started
}

/// Pauses the checks whose slug matches (`pi-*` = prefix). Needs POKOIN_HC_API_KEY;
/// best effort, like every alert side channel.
fn hc_pause(patterns: &[String]) -> Result<Vec<String>> {
    let Some(key) = env::get("POKOIN_HC_API_KEY") else {
        return Ok(vec![]);
    };
    let base = env::get_or("POKOIN_HC_API_BASE", "https://healthchecks.io");
    let base = base.trim_end_matches('/');
    if env::get("POKOIN_OPS_DRY_RUN").is_some() {
        eprintln!("[dry-run hc] pause {patterns:?}");
        return Ok(vec![]);
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
    let list: serde_json::Value = agent
        .get(&format!("{base}/api/v3/checks/"))
        .set("X-Api-Key", &key)
        .call()
        .map_err(|e| anyhow!("list checks: {e}"))?
        .into_json()?;
    let mut paused = Vec::new();
    for c in list["checks"].as_array().into_iter().flatten() {
        let slug = c["slug"].as_str().unwrap_or_default();
        if !patterns.iter().any(|p| slug_matches(p, slug)) || c["status"] == "paused" {
            continue;
        }
        let Some(url) = c["pause_url"].as_str() else { continue };
        match agent.post(url).set("X-Api-Key", &key).send_string("") {
            Ok(_) => paused.push(slug.to_string()),
            Err(e) => eprintln!("pi-health: pause {slug}: {e}"),
        }
    }
    Ok(paused)
}

pub fn slug_matches(pattern: &str, slug: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => slug.starts_with(prefix),
        None => slug == pattern,
    }
}

fn alert(title: &str, body: &str) {
    let host = env::hostname();
    if let Err(err) = mail::send(&mail::subject(title), body) {
        eprintln!("pi-health: mail: {err:#}");
    }
    let client = secretary::Client::from_env();
    if let Err(err) = client.notify(&format!("{host}: {title}"), body, &format!("{host}:pi-health")) {
        secretary::log_err("notify pi-health", &err);
    }
}

fn stamp(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0).map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_default()
}

/// `--maintenance <duration> --reason …` / `--end-maintenance`.
pub fn maintenance(duration: Option<&str>, reason: &str, end: bool) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let mut state = load();
    let host = env::hostname();
    if end {
        state.maintenance_until = now;
        save(&state)?;
        println!("pi-health: maintenance ended; the next probe alerts if the Pi is still down");
        return Ok(());
    }
    let secs = parse_duration(duration.unwrap_or_default())?;
    state.maintenance_until = now + secs;
    state.maintenance_reason = if reason.trim().is_empty() { "planned work".into() } else { reason.trim().into() };
    save(&state)?;
    let paused = hc_pause(&list("POKOIN_PI_HC_PAUSE", DEFAULT_HC_PAUSE)).unwrap_or_else(|e| {
        eprintln!("pi-health: healthchecks pause: {e:#}");
        vec![]
    });
    let until = stamp(state.maintenance_until);
    let body = format!(
        "Pi maintenance declared on {host} until {until}: {}.\n\nNo Pi offline/back alerts until then, and the Pi's \
         healthchecks are paused ({}). If the Pi is still down when the window ends, that alert goes out then.\n\
         End early: pokoin-ops pi-health --end-maintenance",
        state.maintenance_reason,
        if paused.is_empty() { "none paused".to_string() } else { paused.join(", ") },
    );
    alert(&format!("Pi maintenance until {until}"), &body);
    println!("pi-health: maintenance until {until} ({})", state.maintenance_reason);
    Ok(())
}

pub fn run() -> Result<()> {
    let addr = env::get_or("POKOIN_PI_ADDR", DEFAULT_ADDR);
    let down_after = env::get_num("POKOIN_PI_DOWN_AFTER", 3u32);
    let now = chrono::Utc::now().timestamp();
    let mut state = load();
    let probed = probe(&addr);
    let err = probed.as_ref().err().map(|e| format!("{e:#}")).unwrap_or_default();
    let transition = step(&mut state, probed.is_ok(), now, down_after, &err);
    let window = (state.maintenance_until > now).then(|| format!("{} (until {})", state.maintenance_reason, stamp(state.maintenance_until)));
    let held_window = (state.maintenance_until != 0).then(|| state.maintenance_reason.clone());
    let say = notice(&mut state, &transition, now);
    save(&state)?;
    let units = list("POKOIN_PI_UNITS", DEFAULT_UNITS);
    if let Transition::WentDown { .. } = transition {
        if let Err(e) = hc_pause(&list("POKOIN_PI_HC_PAUSE", DEFAULT_HC_PAUSE)) {
            eprintln!("pi-health: healthchecks pause: {e:#}");
        }
    }
    if let Transition::CameBack { .. } = transition {
        ensure_started(&units);
        for u in &list("POKOIN_PI_CATCHUP_UNITS", DEFAULT_CATCHUP) {
            if let Err(e) = systemctl_user(&["start", "--no-block", u]) {
                eprintln!("pi-health: start {u}: {e:#}");
            }
        }
    }
    match (&transition, &say) {
        (_, Notice::Down) => {
            let since = state.since;
            let late = held_window.filter(|_| !matches!(transition, Transition::WentDown { .. }));
            let body = format!(
                "The Pi ({addr}) has not answered since {} ({} probes): {err}\n\n\
                 Until it is back, the Pi-dependent units on nezopt skip (ExecCondition), the sentinel \
                 mutes them and replication, and there is no further mail about them.\n\
                 Units: {}\nHealthchecks paused: {}\n{}\n\
                 The overflow pods keep serving with their last release and env.",
                stamp(since),
                state.fails,
                units.join(", "),
                list("POKOIN_PI_HC_PAUSE", DEFAULT_HC_PAUSE).join(", "),
                late.map(|r| format!("The declared maintenance window ({r}) is over and the Pi is still down.\n")).unwrap_or_default(),
            );
            alert("Pi offline", &body);
            println!("pi-health: DOWN since {}, alerted", stamp(since));
        }
        (Transition::CameBack { down_s }, Notice::Back) => {
            let body = format!(
                "The Pi ({addr}) answers again after {} offline.\n\nThe Pi tunnels were started again and \
                 {} ran once. Paused healthchecks resume on their next ping.",
                human(*down_s),
                list("POKOIN_PI_CATCHUP_UNITS", DEFAULT_CATCHUP).join(", "),
            );
            alert(&format!("Pi back after {}", human(*down_s)), &body);
            println!("pi-health: UP again after {}", human(*down_s));
        }
        (Transition::WentDown { .. } | Transition::CameBack { .. }, Notice::None) => {
            println!("pi-health: {:?} during maintenance {}, no alert", state.link, window.unwrap_or_default());
        }
        (Transition::Learned(link), _) => println!("pi-health: first probe, Pi {link:?}"),
        (_, Notice::Back) | (Transition::None, Notice::None) => {
            if state.link == Link::Up {
                // A blip shorter than POKOIN_PI_DOWN_AFTER can still skip a tunnel's restart.
                let started = ensure_started(&units);
                if !started.is_empty() {
                    println!("pi-health: started {}", started.join(", "));
                }
            }
            println!("pi-health: {:?}, {} failed probe(s){}", state.link, state.fails, if err.is_empty() { String::new() } else { format!(": {err}") });
        }
    }
    // No dead-man check of its own (the healthchecks plan is at its check limit): a failing
    // run alerts through OnFailure=, a stopped timer through the sentinel's timer check.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sentinel::Finding;

    #[test]
    fn one_transition_each_way() {
        let mut s = State::default();
        assert_eq!(step(&mut s, true, 0, 3, ""), Transition::Learned(Link::Up));
        assert_eq!(step(&mut s, true, 60, 3, ""), Transition::None);
        assert_eq!(step(&mut s, false, 120, 3, "refused"), Transition::None);
        assert_eq!(step(&mut s, false, 180, 3, "refused"), Transition::None);
        assert_eq!(step(&mut s, false, 240, 3, "refused"), Transition::WentDown { since: 120 });
        for t in 0..100 {
            assert_eq!(step(&mut s, false, 300 + t * 60, 3, "refused"), Transition::None, "no repeat alerts");
        }
        assert_eq!(s.since, 120);
        assert_eq!(step(&mut s, true, 7320, 3, ""), Transition::CameBack { down_s: 7200 });
        assert_eq!(step(&mut s, true, 7380, 3, ""), Transition::None);
        assert_eq!(s.fails, 0);
    }

    #[test]
    fn a_blip_shorter_than_the_threshold_is_quiet() {
        let mut s = State { link: Link::Up, ..Default::default() };
        assert_eq!(step(&mut s, false, 0, 3, "x"), Transition::None);
        assert_eq!(step(&mut s, false, 60, 3, "x"), Transition::None);
        assert_eq!(step(&mut s, true, 120, 3, ""), Transition::None);
        assert_eq!(step(&mut s, false, 180, 3, "x"), Transition::None);
        assert_eq!(s.first_fail, 180, "a new run of failures starts the count again");
        assert_eq!(s.link, Link::Up);
    }

    #[test]
    fn down_at_first_sight_is_learned_not_alerted() {
        let mut s = State::default();
        step(&mut s, false, 0, 2, "x");
        assert_eq!(step(&mut s, false, 60, 2, "x"), Transition::Learned(Link::Down));
        assert_eq!(step(&mut s, true, 660, 2, ""), Transition::CameBack { down_s: 660 });
    }

    #[test]
    fn unit_mentions_respect_boundaries() {
        assert!(mentions_unit("unit.user.poko-video-mirror.service", "poko-video-mirror"));
        assert!(mentions_unit("timer.poko-video-mirror.timer", "poko-video-mirror"));
        assert!(mentions_unit("forward.pokoin-scan-pi-tunnel:8098", "pokoin-scan-pi-tunnel"));
        assert!(mentions_unit("restarts.user.tcgprices-pi-reader-tunnel.service", "tcgprices-pi-reader-tunnel"));
        assert!(!mentions_unit("unit.user.poko-video-mirror-x.service", "poko-video-mirror"));
        assert!(!mentions_unit("unit.user.xpoko-video-mirror.service", "poko-video-mirror"));
    }

    #[test]
    fn mute_only_touches_pi_findings() {
        let mut outs = vec![CheckOut {
            prefix: "unit",
            findings: vec![
                Finding::new("unit.user.pokoin-overflow-sync.service", Sev::Crit, "failed", 1),
                Finding::new("replication.standby", Sev::Crit, "no standby", 2),
                Finding::new("slot.pokoin_pi_replica", Sev::Warn, "retains 41 GB", 2),
                Finding::new("unit.user.lucina-rs.service", Sev::Crit, "failed", 1),
            ],
            complete: true,
        }];
        assert_eq!(mute(&mut outs, 0, 3900), 2);
        let f = &outs[0].findings;
        assert_eq!((f[0].sev, f[1].sev, f[2].sev, f[3].sev), (Sev::Ok, Sev::Ok, Sev::Warn, Sev::Crit));
        assert!(f[0].detail.starts_with("Pi offline for 1h 5m (pi-health): failed"), "{}", f[0].detail);
    }

    #[test]
    fn slug_patterns() {
        assert!(slug_matches("pi-*", "pi-wal-push"));
        assert!(!slug_matches("pi-*", "nezopt-pi-health"));
        assert!(slug_matches("nezopt-overflow-sync", "nezopt-overflow-sync"));
        assert!(!slug_matches("nezopt-overflow-sync", "nezopt-overflow-sync-2"));
    }

    #[test]
    fn maintenance_holds_alerts_and_releases_a_late_down() {
        let mut s = State { link: Link::Up, maintenance_until: 1000, ..Default::default() };
        let t = step(&mut s, false, 100, 1, "x");
        assert_eq!(t, Transition::WentDown { since: 100 });
        assert_eq!(notice(&mut s, &t, 100), Notice::None, "inside the window");
        let t = step(&mut s, false, 500, 1, "x");
        assert_eq!(notice(&mut s, &t, 500), Notice::None);
        // The window ends with the Pi still down: the held alert goes out, once.
        let t = step(&mut s, false, 1060, 1, "x");
        assert_eq!(notice(&mut s, &t, 1060), Notice::Down);
        let t = step(&mut s, false, 1120, 1, "x");
        assert_eq!(notice(&mut s, &t, 1120), Notice::None);
        let t = step(&mut s, true, 1180, 1, "");
        assert_eq!(notice(&mut s, &t, 1180), Notice::Back);
        assert_eq!(s.maintenance_until, 0, "a finished window is cleared once the Pi is up");
    }

    #[test]
    fn an_outage_inside_the_window_is_silent_both_ways() {
        let mut s = State { link: Link::Up, maintenance_until: 7200, maintenance_reason: "SSD move".into(), ..Default::default() };
        let t = step(&mut s, false, 60, 1, "x");
        assert_eq!(notice(&mut s, &t, 60), Notice::None);
        let t = step(&mut s, true, 6600, 1, "");
        assert_eq!(t, Transition::CameBack { down_s: 6540 });
        assert_eq!(notice(&mut s, &t, 6600), Notice::None);
    }

    #[test]
    fn without_a_window_alerts_are_unchanged() {
        let mut s = State { link: Link::Up, ..Default::default() };
        let t = step(&mut s, false, 0, 1, "x");
        assert_eq!(notice(&mut s, &t, 0), Notice::Down);
        let t = step(&mut s, false, 60, 1, "x");
        assert_eq!(notice(&mut s, &t, 60), Notice::None);
        let t = step(&mut s, true, 120, 1, "");
        assert_eq!(notice(&mut s, &t, 120), Notice::Back);
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("2h").unwrap(), 7200);
        assert_eq!(parse_duration("1h30m").unwrap(), 5400);
        assert_eq!(parse_duration("90m").unwrap(), 5400);
        assert!(parse_duration("2").is_err());
        assert!(parse_duration("").is_err());
        assert!(parse_duration("2d").is_err());
    }

    #[test]
    fn human_durations() {
        assert_eq!(human(40), "40s");
        assert_eq!(human(720), "12m");
        assert_eq!(human(7200), "2h");
        assert_eq!(human(23_400), "6h 30m");
    }
}
