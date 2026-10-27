//! `notify-unit`: run by pokoin-notify@.service from an OnFailure= drop-in. Mails the
//! unit's state and journal tail, and pings the unit's dead-man check /fail as a second,
//! independent path. A per-unit cooldown keeps a job that fails every few minutes from
//! flooding the inbox; the next mail says how many failures were folded in.
//! Every failure is also pushed to the Secretary app (`/v1/notify`, deduplicated there by
//! `<host>:unit:<unit>`, the same key the sentinel uses); that push never fails the command.

use crate::{env, hc, mail, secretary, sys};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct UnitState {
    pub last_mail: i64,
    pub suppressed: u32,
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    Send { folded: u32 },
    Suppress,
}

pub fn decide(state: &UnitState, now: i64, cooldown_s: i64) -> Decision {
    if state.last_mail > 0 && now - state.last_mail < cooldown_s {
        Decision::Suppress
    } else {
        Decision::Send { folded: state.suppressed }
    }
}

fn state_path(unit: &str) -> PathBuf {
    let safe: String = unit.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    env::state_dir().join("notify").join(format!("{safe}.json"))
}

pub fn run(unit: &str, user: bool) -> Result<()> {
    let mut pushed = None;
    let out = mail_and_ping(unit, user, &mut pushed);
    if let Some((result, journal)) = pushed {
        push(unit, &result, &journal);
    }
    out
}

/// The Secretary push body: the result and the last few journal lines.
pub fn push_body(unit: &str, host: &str, result: &str, journal: &str) -> String {
    let tail: Vec<&str> = journal.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(6)..].join("\n");
    format!("{unit} on {host} failed ({result}).\n\n{tail}")
}

fn push(unit: &str, result: &str, journal: &str) {
    let host = env::hostname();
    let name = unit.strip_suffix(".service").unwrap_or(unit);
    let client = secretary::Client::from_env();
    let title = format!("{host}: {name} failed");
    if let Err(err) = client.notify(&title, &push_body(unit, &host, result, journal), &format!("{host}:unit:{unit}")) {
        secretary::log_err("notify", &err);
    }
}

fn mail_and_ping(unit: &str, user: bool, pushed: &mut Option<(String, String)>) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let cooldown = env::get_num("POKOIN_NOTIFY_COOLDOWN_S", 3 * 3600i64);
    let path = state_path(unit);
    let mut state: UnitState = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();

    let scope: &[&str] = if user { &["--user"] } else { &[] };
    let mut show_args = scope.to_vec();
    show_args.extend([
        "show", unit, "--no-pager",
        "-p", "Description", "-p", "Result", "-p", "ExecMainCode", "-p", "ExecMainStatus",
        "-p", "ActiveEnterTimestamp", "-p", "InactiveEnterTimestamp", "-p", "NRestarts",
    ]);
    let show = sys::output("systemctl", &show_args).unwrap_or_else(|e| format!("systemctl show failed: {e}\n"));
    let result = show
        .lines()
        .find_map(|l| l.strip_prefix("Result="))
        .unwrap_or("unknown")
        .to_string();
    let lines = env::get_or("POKOIN_NOTIFY_JOURNAL_LINES", "80");
    let mut journal_args = scope.to_vec();
    journal_args.extend(["-u", unit, "-n", &lines, "--no-pager", "-o", "short-iso"]);
    let journal = sys::output("journalctl", &journal_args).unwrap_or_else(|e| format!("journalctl failed: {e}\n"));
    *pushed = Some((result.clone(), journal.clone()));

    let slug = hc::slug_for_unit(&hc::host_prefix(), unit);
    let hc_ok = match hc::ping(&slug, hc::Kind::Fail, &mail::truncate(&journal, 8_000)) {
        Ok(_) => true,
        Err(err) => {
            eprintln!("{err:#}");
            false
        }
    };

    match decide(&state, now, cooldown) {
        Decision::Suppress => {
            state.suppressed += 1;
            eprintln!("{unit} failed again; mail suppressed (cooldown {cooldown}s, {} folded)", state.suppressed);
            save(&path, &state);
            Ok(())
        }
        Decision::Send { folded } => {
            let mut body = format!("{unit} on {} failed ({result}).\n\n", env::hostname());
            if folded > 0 {
                body.push_str(&format!(
                    "{folded} earlier failure(s) of this unit in the last {} h were not mailed.\n\n",
                    cooldown / 3600
                ));
            }
            body.push_str(&show);
            body.push_str("\n--- journal ---\n");
            body.push_str(&journal);
            let sent = mail::send(&mail::subject(&format!("{unit} failed ({result})")), &body);
            match sent {
                Ok(()) => {
                    state = UnitState { last_mail: now, suppressed: 0 };
                    save(&path, &state);
                    Ok(())
                }
                // The /fail ping already alerted through healthchecks; still report the mail error.
                Err(err) if hc_ok => {
                    eprintln!("mail failed, healthchecks /fail delivered: {err:#}");
                    Ok(())
                }
                Err(err) => Err(err),
            }
        }
    }
}

fn save(path: &PathBuf, state: &UnitState) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(state) {
        let _ = std::fs::write(path, bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_folds_repeat_failures() {
        let fresh = UnitState::default();
        assert_eq!(decide(&fresh, 1000, 600), Decision::Send { folded: 0 });
        let recent = UnitState { last_mail: 900, suppressed: 2 };
        assert_eq!(decide(&recent, 1000, 600), Decision::Suppress);
        assert_eq!(decide(&recent, 1500, 600), Decision::Send { folded: 2 });
    }

    #[test]
    fn push_body_has_result_and_journal_tail() {
        let journal = (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let b = push_body("poko-shorts.service", "nezopt", "exit-code", &journal);
        assert!(b.starts_with("poko-shorts.service on nezopt failed (exit-code).\n\nline 5\n"), "{b}");
        assert!(b.ends_with("line 10"));
    }

    #[test]
    fn state_file_name_is_safe() {
        let p = state_path("pokoin-rust-job@search-delta.service");
        assert!(p.ends_with("notify/pokoin-rust-job_search-delta.service.json"), "{}", p.display());
    }
}
