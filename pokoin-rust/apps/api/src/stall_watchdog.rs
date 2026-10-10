//! Runtime stall watchdog.
//!
//! A tokio task bumps a heartbeat every 250 ms; a plain OS thread checks it.
//! When the heartbeat is older than [`STALL_AFTER`], the whole runtime has stopped
//! making progress: a task is blocking a worker (sync CPU work, a sync syscall),
//! and in tokio's multi-thread scheduler that can also starve the I/O and timer
//! driver, so every other request waits too. The thread then logs one
//! `runtime_stall` line with the oldest in-flight request paths and each
//! thread's scheduler state (R = burning CPU, S/D = blocked), and a
//! `runtime_stall_end` line with the total once the heartbeat resumes.
//!
//! 2026-10-10 a MyPokoin listings read compiled ~800 Unicode regexes on one
//! worker and froze the Pi API for 56 s with no log line at all.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const BEAT: Duration = Duration::from_millis(250);
const CHECK: Duration = Duration::from_millis(500);
const STALL_AFTER: Duration = Duration::from_secs(2);

pub fn start() {
    let origin = Instant::now();
    let beat = Arc::new(AtomicU64::new(0));
    let writer = beat.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(BEAT);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            writer.store(origin.elapsed().as_millis() as u64, Ordering::Relaxed);
        }
    });
    let spawned = std::thread::Builder::new()
        .name("stall-watchdog".into())
        .spawn(move || watch(origin, &beat));
    if let Err(error) = spawned {
        tracing::warn!(%error, "runtime stall watchdog not started");
    }
}

fn watch(origin: Instant, beat: &AtomicU64) {
    let mut stalled_since: Option<u64> = None;
    loop {
        std::thread::sleep(CHECK);
        let now = origin.elapsed().as_millis() as u64;
        let last = beat.load(Ordering::Relaxed);
        let behind = now.saturating_sub(last);
        if behind >= STALL_AFTER.as_millis() as u64 {
            if stalled_since.is_none() {
                stalled_since = Some(last);
                tracing::warn!(
                    stalled_ms = behind,
                    in_flight = %crate::request_log::in_flight_summary(8),
                    threads = %thread_states(),
                    "runtime_stall"
                );
            }
        } else if let Some(since) = stalled_since.take() {
            tracing::warn!(stalled_ms = last.saturating_sub(since), "runtime_stall_end");
        }
    }
}

/// `comm:state` for every thread of this process (Linux `/proc`; empty elsewhere).
fn thread_states() -> String {
    let Ok(tasks) = std::fs::read_dir("/proc/self/task") else {
        return String::new();
    };
    let mut out = Vec::new();
    for task in tasks.flatten() {
        let Ok(stat) = std::fs::read_to_string(task.path().join("stat")) else {
            continue;
        };
        // `pid (comm) state ...`; comm may contain spaces, so split at the last ')'.
        let Some((head, rest)) = stat.rsplit_once(')') else { continue };
        let comm = head.split_once('(').map(|(_, c)| c).unwrap_or("?");
        let state = rest.trim_start().chars().next().unwrap_or('?');
        out.push(format!("{comm}:{state}"));
    }
    out.join(",")
}

#[cfg(test)]
mod tests {
    #[test]
    fn thread_states_lists_this_thread() {
        let states = super::thread_states();
        if cfg!(target_os = "linux") {
            assert!(states.contains(":R"), "{states}");
        }
    }
}
