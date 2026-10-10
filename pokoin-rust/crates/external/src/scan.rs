//! HTTP adapter to the Pokoin recognition workers (YOLO + Milo).
//!
//! Faithful port of the retired Node `scan-identify.js`: nezopt GPU first
//! (`SCAN_PRIMARY_URL`, default `http://127.0.0.1:18151`), then the Pi CPU
//! worker (`SCAN_FALLBACK_URL`, default `http://127.0.0.1:18150`). A primary
//! failure starts a cooldown so every later scan does not pay its timeout.
//! The worker JSON is returned unchanged; this crate never runs Node or any
//! recognition model itself.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use serde_json::{json, Value};

use crate::error::{clean_text, ApiError, ApiResult};

const QUERY_KEYS: [&str; 7] = ["catalog", "top_k", "live", "multi", "album", "ids", "wait_ms"];

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Sanitize the client query exactly like `workerPath`: cap generic values at
/// 64 chars, `ids` to `[0-9a-f,]`, `wait_ms` to 0–3000.
pub fn worker_query(query: &[(String, String)]) -> String {
    let mut out: Vec<(String, String)> = Vec::new();
    for key in QUERY_KEYS {
        let Some((_, raw)) = query.iter().find(|(name, _)| name == key) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        match key {
            "ids" => {
                let ok = raw.len() <= 1200
                    && !raw.is_empty()
                    && raw.chars().all(|c| c.is_ascii_hexdigit() || c == ',');
                if ok {
                    out.push((key.to_string(), raw.clone()));
                }
            }
            "wait_ms" => {
                if let Ok(value) = raw.parse::<f64>() {
                    let clamped = value.round().clamp(0.0, 3000.0) as i64;
                    out.push((key.to_string(), clamped.to_string()));
                }
            }
            _ => out.push((key.to_string(), raw.chars().take(64).collect())),
        }
    }
    out.iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                key,
                crate::crypto::uri_encode(value, false)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// One worker reply, passed through by the route.
pub struct WorkerReply {
    pub status: u16,
    pub content_type: String,
    pub worker: &'static str,
    pub body: Bytes,
}

#[derive(Clone)]
pub struct RecognitionClient {
    http: reqwest::Client,
    primary: String,
    fallback: String,
    primary_timeout: Duration,
    fallback_timeout: Duration,
    cooldown: Duration,
    primary_down_until: Arc<AtomicU64>,
}

impl std::fmt::Debug for RecognitionClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecognitionClient")
            .field("primary", &self.primary)
            .field("fallback", &self.fallback)
            .finish_non_exhaustive()
    }
}

impl RecognitionClient {
    pub fn new(primary: String, fallback: String) -> Self {
        let ms = |name: &str, default: u64| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(default)
        };
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(35))
                .build()
                .expect("reqwest client"),
            primary: primary.trim_end_matches('/').to_string(),
            fallback: fallback.trim_end_matches('/').to_string(),
            primary_timeout: Duration::from_millis(ms("SCAN_PRIMARY_TIMEOUT_MS", 6000)),
            fallback_timeout: Duration::from_millis(ms("SCAN_FALLBACK_TIMEOUT_MS", 30000)),
            cooldown: Duration::from_millis(ms("SCAN_PRIMARY_COOLDOWN_MS", 15000)),
            primary_down_until: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn from_env() -> Self {
        Self::new(
            std::env::var("SCAN_PRIMARY_URL").unwrap_or_else(|_| "http://127.0.0.1:18151".into()),
            std::env::var("SCAN_FALLBACK_URL").unwrap_or_else(|_| "http://127.0.0.1:18150".into()),
        )
    }

    /// No workers configured: every recognition route fails closed with 503.
    pub fn disabled() -> Self {
        Self::new(String::new(), String::new())
    }

    fn primary_available(&self) -> bool {
        !self.primary.is_empty() && now_ms() >= self.primary_down_until.load(Ordering::Relaxed)
    }

    async fn call(
        &self,
        base: &str,
        path: &str,
        method: &str,
        body: Option<Bytes>,
        content_type: Option<&str>,
        client_ip: &str,
        timeout: Duration,
    ) -> Result<(u16, String, Bytes), String> {
        if base.is_empty() {
            return Err("worker not configured".to_string());
        }
        let url = format!("{base}{path}");
        let request = match method {
            "POST" => self.http.post(&url),
            _ => self.http.get(&url),
        }
        .header("X-Forwarded-For", client_ip)
        .timeout(timeout);
        let request = match (body, content_type) {
            (Some(bytes), Some(kind)) => request.header("Content-Type", kind).body(bytes),
            (Some(bytes), None) => request
                .header("Content-Type", "application/octet-stream")
                .body(bytes),
            _ => request,
        };
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        let body = response.bytes().await.map_err(|error| error.to_string())?;
        Ok((status, content_type, body))
    }

    /// `viaWorkers` — primary, then fallback; 5xx on a non-final attempt falls
    /// through, and a primary failure triggers the cooldown.
    pub async fn forward(
        &self,
        route: &str,
        method: &str,
        query: &[(String, String)],
        body: Option<Bytes>,
        content_type: Option<&str>,
        client_ip: &str,
    ) -> ApiResult<WorkerReply> {
        let qs = worker_query(query);
        let path = if qs.is_empty() { route.to_string() } else { format!("{route}?{qs}") };
        let mut attempts: Vec<(&'static str, String, Duration)> = Vec::new();
        if self.primary_available() {
            attempts.push(("nezopt", self.primary.clone(), self.primary_timeout));
        }
        if !self.fallback.is_empty() {
            attempts.push(("pi", self.fallback.clone(), self.fallback_timeout));
        }
        if attempts.is_empty() {
            return Err(ApiError::unavailable(
                "Card recognition is unavailable right now. Try again in a moment.",
            ));
        }
        let last_index = attempts.len() - 1;
        let mut last_error = String::from("No recognition worker answered.");
        for (index, (name, base, timeout)) in attempts.iter().enumerate() {
            match self
                .call(base, &path, method, body.clone(), content_type, client_ip, *timeout)
                .await
            {
                Ok((status, content_type, bytes)) => {
                    if status >= 500 && index != last_index {
                        last_error = format!("{name} answered {status}");
                        if *name == "nezopt" {
                            self.primary_down_until
                                .store(now_ms() + self.cooldown.as_millis() as u64, Ordering::Relaxed);
                        }
                        continue;
                    }
                    if *name == "nezopt" {
                        self.primary_down_until.store(0, Ordering::Relaxed);
                    }
                    return Ok(WorkerReply {
                        status,
                        content_type,
                        worker: name,
                        body: bytes,
                    });
                }
                Err(error) => {
                    last_error = error;
                    if *name == "nezopt" {
                        self.primary_down_until
                            .store(now_ms() + self.cooldown.as_millis() as u64, Ordering::Relaxed);
                    }
                }
            }
        }
        Err(ApiError::unavailable(format!(
            "Card recognition is unavailable right now. Try again in a moment. ({})",
            clean_text(Some(&last_error), 160)
        )))
    }

    /// `GET /api/scan/health` — probe both workers without falling back.
    pub async fn health(&self) -> (bool, Value) {
        let probe = |base: String, client: reqwest::Client| async move {
            let started = now_ms();
            if base.is_empty() {
                return json!({ "ok": false, "error": "not_configured" });
            }
            let url = format!("{base}/health");
            match client.get(&url).timeout(Duration::from_millis(3000)).send().await {
                Ok(response) => {
                    let ok = response.status().as_u16() == 200;
                    json!({ "ok": ok, "ms": now_ms().saturating_sub(started) })
                }
                Err(error) => json!({ "ok": false, "error": clean_text(Some(&error.to_string()), 120) }),
            }
        };
        let (nezopt, pi) = tokio::join!(
            probe(self.primary.clone(), self.http.clone()),
            probe(self.fallback.clone(), self.http.clone())
        );
        let ok = nezopt["ok"] == json!(true) || pi["ok"] == json!(true);
        (ok, json!({ "ok": ok, "workers": { "nezopt": nezopt, "pi": pi } }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn worker_query_sanitizes_like_the_reference() {
        assert_eq!(worker_query(&q(&[("catalog", "pokemon-en"), ("top_k", "5")])), "catalog=pokemon-en&top_k=5");
        // ids must be hex + commas
        assert_eq!(worker_query(&q(&[("ids", "aa,bb")])), "ids=aa%2Cbb");
        assert_eq!(worker_query(&q(&[("ids", "../etc")])), "");
        // wait_ms clamps to 0..=3000
        assert_eq!(worker_query(&q(&[("wait_ms", "99999")])), "wait_ms=3000");
        assert_eq!(worker_query(&q(&[("wait_ms", "-4")])), "wait_ms=0");
        assert_eq!(worker_query(&q(&[("wait_ms", "nope")])), "");
        // unknown keys are dropped, long values truncated
        assert_eq!(worker_query(&q(&[("evil", "x")])), "");
        let long = "a".repeat(200);
        assert_eq!(worker_query(&q(&[("catalog", &long)])).len(), "catalog=".len() + 64);
    }

    #[test]
    fn empty_workers_fail_closed() {
        let client = RecognitionClient::disabled();
        assert!(!client.primary_available());
        assert!(client.fallback.is_empty());
    }
}
