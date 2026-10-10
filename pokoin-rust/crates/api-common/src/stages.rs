//! Per-request stage timings for the `Server-Timing` response header.
//!
//! The request log middleware of the binary opens one scope per request;
//! shared helpers record into it (`pg` every statement as `sql`, the JSON
//! responders as `ser`, cache lookups as `cache`). Whatever is left of the
//! total is `build`: handler CPU between the recorded stages. Outside a scope
//! (jobs, tests, spawned tasks) recording is a no-op.

use std::cell::RefCell;
use std::time::Instant;

pub const SQL: &str = "sql";
pub const SERIALIZE: &str = "ser";
pub const CACHE: &str = "cache";

#[derive(Default)]
struct Stages {
    rows: Vec<(&'static str, f64, u32)>,
    source: Option<&'static str>,
}

tokio::task_local! {
    static STAGES: RefCell<Stages>;
}

/// Run one request with a fresh stage table; returns the response and the
/// `Server-Timing` value for it.
pub async fn scope<F: std::future::Future>(fut: F) -> (F::Output, String) {
    let started = Instant::now();
    STAGES
        .scope(RefCell::new(Stages::default()), async move {
            let out = fut.await;
            let total = ms(started);
            let header = STAGES.with(|cell| header(&cell.borrow(), total));
            (out, header)
        })
        .await
}

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

pub fn record(stage: &'static str, millis: f64) {
    let _ = STAGES.try_with(|cell| {
        let mut stages = cell.borrow_mut();
        match stages.rows.iter_mut().find(|row| row.0 == stage) {
            Some(row) => {
                row.1 += millis;
                row.2 += 1;
            }
            None => stages.rows.push((stage, millis, 1)),
        }
    });
}

/// Where the body came from (`snapshot`, `live`, `index`), shown as `src;desc=`.
pub fn source(name: &'static str) {
    let _ = STAGES.try_with(|cell| cell.borrow_mut().source = Some(name));
}

pub async fn timed<F: std::future::Future>(stage: &'static str, fut: F) -> F::Output {
    let started = Instant::now();
    let out = fut.await;
    record(stage, ms(started));
    out
}

pub fn timed_sync<T>(stage: &'static str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let out = work();
    record(stage, ms(started));
    out
}

fn header(stages: &Stages, total: f64) -> String {
    let mut out = String::new();
    let mut known = 0.0;
    for (stage, millis, count) in &stages.rows {
        known += millis;
        out.push_str(&format!("{stage};dur={millis:.1};desc=\"n={count}\", "));
    }
    out.push_str(&format!("build;dur={:.1}, ", (total - known).max(0.0)));
    if let Some(source) = stages.source {
        out.push_str(&format!("src;desc=\"{source}\", "));
    }
    out.push_str(&format!("total;dur={total:.1}"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stages_add_up_and_build_is_the_remainder() {
        let ((), header) = scope(async {
            record(SQL, 3.0);
            record(SQL, 2.0);
            record(SERIALIZE, 1.0);
            source("snapshot");
        })
        .await;
        assert!(header.starts_with("sql;dur=5.0;desc=\"n=2\", ser;dur=1.0;desc=\"n=1\", build;dur=0.0, src;desc=\"snapshot\", total;dur="), "{header}");
    }

    #[tokio::test]
    async fn recording_outside_a_request_is_a_no_op() {
        record(SQL, 1.0);
        assert_eq!(timed(CACHE, async { 7 }).await, 7);
    }
}
