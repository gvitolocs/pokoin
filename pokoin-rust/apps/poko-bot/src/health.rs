use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

const SAMPLE_CAP: usize = 200;

pub struct Metrics {
    started: Instant,
    pub telegram_enabled: AtomicBool,
    pub telegram_polling: AtomicBool,
    pub telegram_last_update_ms: AtomicU64,
    pub discord_enabled: AtomicBool,
    pub discord_connected: AtomicBool,
    pub total: AtomicU64,
    pub skipped: AtomicU64,
    pub commands: AtomicU64,
    pub brain_ok: AtomicU64,
    pub brain_fail: AtomicU64,
    pub hermes_ok: AtomicU64,
    pub hermes_fail: AtomicU64,
    pub blocked: AtomicU64,
    pub apologies: AtomicU64,
    brain_latency: Mutex<VecDeque<u64>>,
    reply_latency: Mutex<VecDeque<u64>>,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            telegram_enabled: AtomicBool::new(false),
            telegram_polling: AtomicBool::new(false),
            telegram_last_update_ms: AtomicU64::new(0),
            discord_enabled: AtomicBool::new(false),
            discord_connected: AtomicBool::new(false),
            total: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
            commands: AtomicU64::new(0),
            brain_ok: AtomicU64::new(0),
            brain_fail: AtomicU64::new(0),
            hermes_ok: AtomicU64::new(0),
            hermes_fail: AtomicU64::new(0),
            blocked: AtomicU64::new(0),
            apologies: AtomicU64::new(0),
            brain_latency: Mutex::new(VecDeque::new()),
            reply_latency: Mutex::new(VecDeque::new()),
        }
    }

    pub fn push_brain_latency(&self, ms: u64) {
        push_sample(&self.brain_latency, ms);
    }

    pub fn push_reply_latency(&self, ms: u64) {
        push_sample(&self.reply_latency, ms);
    }

    pub fn snapshot(&self) -> Value {
        let last = self.telegram_last_update_ms.load(Ordering::Relaxed);
        json!({
            "ok": true,
            "version": option_env!("POKO_BOT_BUILD_COMMIT").unwrap_or("dev"),
            "uptimeS": self.started.elapsed().as_secs(),
            "telegram": {
                "enabled": self.telegram_enabled.load(Ordering::Relaxed),
                "polling": self.telegram_polling.load(Ordering::Relaxed),
                "lastUpdateAt": if last == 0 { Value::Null } else { json!(last) },
            },
            "discord": {
                "enabled": self.discord_enabled.load(Ordering::Relaxed),
                "connected": self.discord_connected.load(Ordering::Relaxed),
            },
            "turns": {
                "total": self.total.load(Ordering::Relaxed),
                "skipped": self.skipped.load(Ordering::Relaxed),
                "commands": self.commands.load(Ordering::Relaxed),
                "brainOk": self.brain_ok.load(Ordering::Relaxed),
                "brainFail": self.brain_fail.load(Ordering::Relaxed),
                "hermesOk": self.hermes_ok.load(Ordering::Relaxed),
                "hermesFail": self.hermes_fail.load(Ordering::Relaxed),
                "blocked": self.blocked.load(Ordering::Relaxed),
                "apologies": self.apologies.load(Ordering::Relaxed),
            },
            "brainLatencyMs": latency_json(&self.brain_latency),
            "replyLatencyMs": latency_json(&self.reply_latency),
            "rssKb": rss_kb(),
        })
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

fn push_sample(slot: &Mutex<VecDeque<u64>>, ms: u64) {
    let mut samples = slot.lock().expect("latency");
    if samples.len() == SAMPLE_CAP {
        samples.pop_front();
    }
    samples.push_back(ms);
}

fn latency_json(slot: &Mutex<VecDeque<u64>>) -> Value {
    let samples = slot.lock().expect("latency");
    let mut sorted: Vec<u64> = samples.iter().copied().collect();
    sorted.sort_unstable();
    json!({
        "count": sorted.len(),
        "p50": percentile(&sorted, 50),
        "p95": percentile(&sorted, 95),
    })
}

fn percentile(sorted: &[u64], pct: u64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((pct as f64 / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

pub fn rss_kb() -> u64 {
    let Ok(text) = std::fs::read_to_string("/proc/self/status") else {
        return 0;
    };
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("VmRSS:") else {
            continue;
        };
        return rest
            .split_whitespace()
            .next()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
    }
    0
}

pub async fn serve(
    addr: std::net::SocketAddr,
    metrics: std::sync::Arc<Metrics>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    let app = Router::new()
        .route("/health", get(health))
        .with_state(metrics);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.changed().await;
        })
        .await
}

async fn health(State(metrics): State<std::sync::Arc<Metrics>>) -> Json<Value> {
    Json(metrics.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_use_the_last_samples() {
        let metrics = Metrics::new();
        for value in [10, 20, 30, 40] {
            metrics.push_brain_latency(value);
        }
        let snap = metrics.snapshot();
        assert_eq!(snap["brainLatencyMs"]["count"], 4);
        assert_eq!(snap["brainLatencyMs"]["p50"], 20);
        assert_eq!(snap["brainLatencyMs"]["p95"], 40);
        assert_eq!(snap["version"], "dev");
        assert!(snap["rssKb"].as_u64().unwrap() > 0);
    }
}
