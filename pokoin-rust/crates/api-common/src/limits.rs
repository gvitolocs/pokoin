//! Port of `api/_rate_limit.js`: three explicit limiter classes.
//!
//! - `limit_best_effort`: per-origin Redis fixed window, bounded local fallback, FAIL-OPEN.
//! - `limit_security_critical`: Postgres `public.marketplace_rate_limits` (writer), FAIL-CLOSED.
//! - `limit_global`: Postgres first; on a store outage the origin Redis with a HALVED
//!   limit; when Redis is down too, FAIL-CLOSED.
//!
//! Keys: `pokoin:rl:v1:{scope}:{sha256(identity)[0:32]}` (identities are hashed).

use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};

use crate::ApiState;

#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub allowed: bool,
    /// `redis` | `local` | `postgres` | `redis-degraded` | `error`
    pub backend: &'static str,
    pub count: Option<i64>,
    pub retry_after_sec: u64,
}

const LOCAL_MAX_IDENTITIES: usize = 10_000;
const LOG_INTERVAL: Duration = Duration::from_secs(30);
const INCR_WINDOW_SCRIPT: &str = "\nlocal count = redis.call('INCR', KEYS[1])\nif count == 1 then\n  redis.call('EXPIRE', KEYS[1], ARGV[1])\nend\nreturn count\n";

pub fn clean_scope(scope: &str) -> String {
    let lower = scope.trim().to_lowercase();
    let mut out = String::new();
    let mut in_run = false;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            out.push(ch);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let out: String = out.chars().take(40).collect();
    if out.is_empty() {
        "scope".into()
    } else {
        out
    }
}

pub fn identity_hash(identity: &str) -> String {
    hex::encode(Sha256::digest(identity.as_bytes()))[..32].to_owned()
}

pub fn rate_limit_bucket(scope: &str, identity: &str) -> String {
    format!("pokoin:rl:v1:{}:{}", clean_scope(scope), identity_hash(identity))
}

fn sampled(map: &'static OnceLock<Mutex<HashMap<String, Instant>>>, stamp: String) -> bool {
    let mut map = map.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    match map.get(&stamp) {
        Some(at) if now.duration_since(*at) < LOG_INTERVAL => false,
        _ => {
            map.insert(stamp, now);
            true
        }
    }
}

fn note_rejection(scope: &str, backend: &str) {
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    if sampled(&LAST, format!("{}:{backend}", clean_scope(scope))) {
        tracing::warn!(scope = %clean_scope(scope), backend, "rate limit rejected");
    }
}

fn note_degraded(scope: &str) {
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    if sampled(&LAST, clean_scope(scope)) {
        tracing::warn!(scope = %clean_scope(scope), "global rate limit degraded to the origin store");
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn window_index(window: u64) -> i64 {
    (now_ms() / u128::from(window * 1000)) as i64
}

#[derive(Default)]
struct LocalWindows {
    map: HashMap<String, (i64, i64)>,
    order: VecDeque<String>,
}

fn local_consume(bucket: &str, window: u64) -> i64 {
    static LOCAL: OnceLock<Mutex<LocalWindows>> = OnceLock::new();
    let mut local = LOCAL.get_or_init(|| Mutex::new(LocalWindows::default())).lock().unwrap_or_else(|e| e.into_inner());
    let start = window_index(window);
    let count = match local.map.get(bucket) {
        Some((ws, count)) if *ws == start => count + 1,
        _ => 1,
    };
    if !local.map.contains_key(bucket) {
        local.order.push_back(bucket.to_owned());
    }
    local.map.insert(bucket.to_owned(), (start, count));
    if local.map.len() >= LOCAL_MAX_IDENTITIES {
        let LocalWindows { map, order } = &mut *local;
        map.retain(|_, (ws, _)| *ws >= start);
        order.retain(|k| map.contains_key(k));
        while map.len() >= LOCAL_MAX_IDENTITIES {
            let Some(oldest) = order.pop_front() else { break };
            map.remove(&oldest);
        }
    }
    count
}

async fn redis_incr_window(api: &ApiState, key: &str, window: u64) -> Option<i64> {
    let mut conn = api.redis().await?;
    let script = redis::Script::new(INCR_WINDOW_SCRIPT);
    let mut invocation = script.key(key);
    invocation.arg(window.max(1));
    let call = invocation.invoke_async::<i64>(&mut conn);
    match tokio::time::timeout(Duration::from_millis(500), call).await {
        Ok(Ok(count)) => Some(count),
        _ => None,
    }
}

fn clamp(limit: i64, window_seconds: i64) -> (i64, u64) {
    (limit.max(1), window_seconds.max(1) as u64)
}

/// `limitBestEffort({ scope, identity, limit, windowSeconds })` — never fails.
pub async fn limit_best_effort(api: &ApiState, scope: &str, identity: &str, limit: i64, window_seconds: i64) -> Verdict {
    let bucket = rate_limit_bucket(scope, identity);
    let (max, window) = clamp(limit, window_seconds);
    if let Some(count) = redis_incr_window(api, &bucket, window).await {
        let allowed = count <= max;
        if !allowed {
            note_rejection(scope, "redis");
        }
        return Verdict { allowed, backend: "redis", count: Some(count), retry_after_sec: if allowed { 0 } else { window } };
    }
    let count = local_consume(&bucket, window);
    let allowed = count <= max;
    if !allowed {
        note_rejection(scope, "local");
    }
    Verdict { allowed, backend: "local", count: Some(count), retry_after_sec: if allowed { 0 } else { window } }
}

async fn postgres_consume(api: &ApiState, bucket: &str, window_start: i64) -> Result<i64, String> {
    let call = sqlx::query_scalar::<_, i64>(
        "\n      insert into public.marketplace_rate_limits (bucket, window_start, hits)\n      values ($1, $2, 1)\n      on conflict (bucket, window_start)\n        do update set hits = public.marketplace_rate_limits.hits + 1\n      returning hits::bigint\n    ",
    )
    .bind(bucket)
    .bind(window_start)
    .fetch_one(api.write());
    match tokio::time::timeout(Duration::from_secs(4), call).await {
        Ok(Ok(hits)) if hits >= 1 => Ok(hits),
        Ok(Ok(_)) => Err("rate limit row returned no usable hit count".into()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("rate limit store timeout".into()),
    }
}

/// `limitSecurityCritical(...)` — FAIL-CLOSED, no local fallback.
pub async fn limit_security_critical(api: &ApiState, scope: &str, identity: &str, limit: i64, window_seconds: i64) -> Verdict {
    let bucket = rate_limit_bucket(scope, identity);
    let (max, window) = clamp(limit, window_seconds);
    match postgres_consume(api, &bucket, window_index(window)).await {
        Ok(hits) => {
            let allowed = hits <= max;
            if !allowed {
                note_rejection(scope, "postgres");
            }
            Verdict { allowed, backend: "postgres", count: Some(hits), retry_after_sec: if allowed { 0 } else { window } }
        }
        Err(message) => {
            tracing::error!(scope = %clean_scope(scope), %message, "security rate limit store unavailable, failing closed");
            Verdict { allowed: false, backend: "error", count: None, retry_after_sec: window }
        }
    }
}

/// `limitGlobal(...)`.
pub async fn limit_global(api: &ApiState, scope: &str, identity: &str, limit: i64, window_seconds: i64) -> Verdict {
    let bucket = rate_limit_bucket(scope, identity);
    let (max, window) = clamp(limit, window_seconds);
    let start = window_index(window);
    match postgres_consume(api, &bucket, start).await {
        Ok(hits) => {
            let allowed = hits <= max;
            if !allowed {
                note_rejection(scope, "postgres");
            }
            if rand_unit() < 0.005 {
                let api = api.clone();
                tokio::spawn(async move {
                    let _ = sqlx::query("delete from public.marketplace_rate_limits where window_start < $1")
                        .bind(start - 2)
                        .execute(api.write())
                        .await;
                });
            }
            Verdict { allowed, backend: "postgres", count: Some(hits), retry_after_sec: if allowed { 0 } else { window } }
        }
        Err(_) => {
            note_degraded(scope);
            let origin = limit_best_effort(api, scope, identity, (limit / 2).max(1), window_seconds).await;
            if origin.backend == "redis" {
                return Verdict { backend: "redis-degraded", ..origin };
            }
            Verdict { allowed: false, backend: "error", count: None, retry_after_sec: window }
        }
    }
}

fn rand_unit() -> f64 {
    // Cheap uniform sample for the 0.5% sweep without a rand dependency.
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    f64::from(nanos % 1_000_000) / 1_000_000.0
}

/// `limitGlobal` behind the accounts crate's limiter seam (news-comments and
/// poko-chat moved from `limitBestEffort` to `limitGlobal` in the 2026-10-08
/// security release).
pub struct GlobalRateLimiter {
    api: ApiState,
}

impl GlobalRateLimiter {
    pub fn new(api: ApiState) -> Self {
        Self { api }
    }
}

#[async_trait::async_trait]
impl pokoin_accounts::rate_limit::RateLimiter for GlobalRateLimiter {
    async fn check(&self, request: pokoin_accounts::rate_limit::RateLimitRequest<'_>) -> pokoin_accounts::rate_limit::RateLimitVerdict {
        let verdict = limit_global(&self.api, request.scope, request.identity, request.limit, request.window_seconds as i64).await;
        if verdict.allowed && verdict.backend != "error" {
            pokoin_accounts::rate_limit::RateLimitVerdict::allowed()
        } else {
            pokoin_accounts::rate_limit::RateLimitVerdict::denied(verdict.retry_after_sec)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_shape_matches_node() {
        assert_eq!(clean_scope(" Poko Chat!! "), "poko-chat-");
        assert_eq!(clean_scope(""), "scope");
        assert_eq!(clean_scope("a".repeat(60).as_str()).len(), 40);
        // sha256("1.2.3.4") prefix
        assert_eq!(identity_hash("1.2.3.4"), "6694f83c9f476da31f5df6bcc520034e");
        assert_eq!(rate_limit_bucket("poko-chat", "1.2.3.4"), "pokoin:rl:v1:poko-chat:6694f83c9f476da31f5df6bcc520034e");
    }

    #[test]
    fn local_window_counts() {
        let b = format!("test-{}", now_ms());
        assert_eq!(local_consume(&b, 60), 1);
        assert_eq!(local_consume(&b, 60), 2);
    }
}
