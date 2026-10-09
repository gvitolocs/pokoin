//! Port of `_request_timing.js`: per-request span accumulation and the slow
//! request log line (`pokoin_request`).
//!
//! Node kept the span in an `AsyncLocalStorage`; the Rust port scopes a
//! task-local span around the handler future (`with_span`) and buckets
//! durations with [`timed`]. Outside a span `timed` just runs the future —
//! the same no-op as Node's `currentSpan()` returning null.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::Instant;

use serde_json::json;

fn slow_ms() -> f64 {
    std::env::var("POKOIN_TIMING_SLOW_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(40.0)
}

/// One request's timing span (`emptySpan`).
#[derive(Debug)]
pub struct Span {
    pub route: String,
    pub method: String,
    pub buckets: BTreeMap<String, f64>,
    pub sql_n: u64,
    pub t0: Instant,
}

impl Span {
    pub fn new(route: &str, method: &str) -> Self {
        Self {
            route: route.to_string(),
            method: method.to_string(),
            buckets: BTreeMap::new(),
            sql_n: 0,
            t0: Instant::now(),
        }
    }
}

tokio::task_local! {
    static SPAN: RefCell<Span>;
}

/// Run `fut` with a fresh span, the way `beginRequest` entered the storage.
pub async fn with_span<F>(route: &str, method: &str, fut: F) -> F::Output
where
    F: std::future::Future,
{
    SPAN.scope(RefCell::new(Span::new(route, method)), fut)
        .await
}

/// `timed(bucket, fn)` — accumulate the duration of `fut` into `bucket`.
pub async fn timed<F, T>(bucket: &str, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    let started = Instant::now();
    let out = fut.await;
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let _ = SPAN.try_with(|span| {
        let mut span = span.borrow_mut();
        *span.buckets.entry(bucket.to_string()).or_insert(0.0) += ms;
        if bucket == "sqlMs" {
            span.sql_n += 1;
        }
    });
    out
}

fn round(ms: f64) -> f64 {
    (ms * 10.0).round() / 10.0
}

/// `finishRequest(span)` — build the `pokoin_request` line and log it when
/// the request was slow (or `POKOIN_TIMING=all`). Must run inside
/// [`with_span`].
pub fn finish_request() -> Option<serde_json::Value> {
    SPAN.try_with(|cell| {
        let span = cell.borrow();
        let total_ms = span.t0.elapsed().as_secs_f64() * 1000.0;
        let bucket = |name: &str| round(*span.buckets.get(name).unwrap_or(&0.0));
        let line = json!({
            "msg": "pokoin_request",
            "route": span.route,
            "method": span.method,
            "totalMs": round(total_ms),
            "sqlMs": bucket("sqlMs"),
            "sqlN": span.sql_n,
            "meiliMs": bucket("meiliMs"),
            "valkeyMs": bucket("valkeyMs"),
            "firestoreMs": bucket("firestoreMs"),
            "cardtraderMs": bucket("cardtraderMs"),
            "serializeMs": bucket("serializeMs"),
        });
        let log_all = std::env::var("POKOIN_TIMING").as_deref() == Ok("all");
        if log_all || total_ms >= slow_ms() {
            tracing::info!(target: "pokoin_request", "{line}");
        }
        line
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timed_accumulates_and_finishes() {
        with_span("/api/x", "GET", async {
            timed("sqlMs", async { 1 }).await;
            timed("sqlMs", async { 2 }).await;
            timed("redisCacheMs", std::future::ready(3)).await;
            let line = finish_request().unwrap();
            assert_eq!(line["route"], "/api/x");
            assert_eq!(line["sqlN"], 2);
            // Instant futures round to 0.0 at one decimal, exactly like Node.
            assert!(line["sqlMs"].as_f64().unwrap() >= 0.0);
        })
        .await;
    }

    #[tokio::test]
    async fn outside_a_span_timed_is_a_no_op() {
        assert_eq!(timed("sqlMs", async { 7 }).await, 7);
        assert!(finish_request().is_none());
    }
}
