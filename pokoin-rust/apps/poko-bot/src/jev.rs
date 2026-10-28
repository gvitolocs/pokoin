//! Keyed TypeSafe decisions. Secrets and upstream error bodies never leave this module.
use std::collections::{hash_map::DefaultHasher, BTreeMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JevError {
    #[error("disabled")]
    Disabled,
    #[error("no_key")]
    NoKey,
    #[error("cooling_down")]
    CoolingDown,
    #[error("quota")]
    Quota,
    #[error("credits")]
    Credits,
    #[error("auth")]
    Auth,
    #[error("overloaded")]
    Overloaded,
    #[error("bad_request")]
    BadRequest,
    #[error("invalid")]
    Invalid,
    #[error("timeout")]
    Timeout,
    #[error("transport")]
    Transport,
    #[error("malformed")]
    Malformed,
}

/// Explicit configuration also lets tests avoid process-global environment changes.
/// Debug deliberately omits every value, including paths and URLs.
#[derive(Clone)]
pub struct JevConfig {
    pub enabled: bool,
    pub url: String,
    pub model: String,
    pub timeout: Duration,
    pub poko_key: Option<String>,
    pub shared_key: Option<String>,
    pub credentials_directory: Option<PathBuf>,
    pub key_file: Option<PathBuf>,
}
impl std::fmt::Debug for JevConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JevConfig { redacted }")
    }
}
impl Default for JevConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            url: "https://api.typesafe.ai/v1/systemone".into(),
            model: "jev-1.14.0".into(),
            timeout: Duration::from_millis(1200),
            poko_key: None,
            shared_key: None,
            credentials_directory: None,
            key_file: None,
        }
    }
}
impl JevConfig {
    pub fn from_env() -> Self {
        fn env(name: &str) -> Option<String> {
            std::env::var(name).ok().and_then(|v| nonempty(&v))
        }
        Self {
            enabled: !matches!(
                env("POKO_JEV")
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "off" | "0" | "false" | "no"
            ),
            url: env("POKO_JEV_URL").unwrap_or_else(|| Self::default().url),
            model: env("POKO_JEV_MODEL").unwrap_or_else(|| Self::default().model),
            timeout: Duration::from_millis(
                env("POKO_JEV_TIMEOUT_MS")
                    .and_then(|s| s.parse::<u64>().ok())
                    .filter(|n| *n > 0)
                    .unwrap_or(1200),
            ),
            poko_key: env("JEV_API_KEY_POKO"),
            shared_key: env("JEV_API_KEY"),
            credentials_directory: env("CREDENTIALS_DIRECTORY").map(PathBuf::from),
            key_file: env("JEV_API_KEY_FILE").map(PathBuf::from),
        }
    }
    fn key(&self) -> Option<String> {
        self.poko_key
            .as_deref()
            .and_then(nonempty)
            .or_else(|| self.shared_key.as_deref().and_then(nonempty))
            .or_else(|| {
                self.credentials_directory
                    .as_ref()
                    .and_then(|p| read_key(p.join("jev_api_key")))
            })
            .or_else(|| self.key_file.as_ref().and_then(read_key))
    }
}
fn nonempty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_owned())
}
fn read_key(path: impl AsRef<std::path::Path>) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| nonempty(&s))
}

// The live API sends more fields beside `noul`; only `noul` is read (as in Hermes).
#[derive(Debug, Clone, Deserialize)]
pub struct Noul {
    pub noul: f64,
}
#[derive(Debug, Clone)]
pub struct Evaluation {
    pub answers: BTreeMap<String, Noul>,
    pub latency_ms: u64,
    pub cached: bool,
}
#[derive(Default)]
struct State {
    calls: u64,
    network: u64,
    ok: u64,
    cache_hits: u64,
    input_tokens: u64,
    fallbacks: u64,
    failures: BTreeMap<String, u64>,
    open_until: Option<Instant>,
    reason: Option<JevError>,
    consecutive_failures: u32,
    cache: VecDeque<(u64, Instant, Evaluation)>,
}
struct Inner {
    read_env_keys: bool,
    config: JevConfig,
    http: reqwest::Client,
    state: Mutex<State>,
    latency: Mutex<VecDeque<u64>>,
}
#[derive(Clone)]
pub struct Jev(Arc<Inner>);
impl std::fmt::Debug for Jev {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Jev { redacted }")
    }
}
impl Jev {
    pub fn from_env() -> Self {
        Self::build(JevConfig::from_env(), true)
    }

    pub fn new(config: JevConfig) -> Self {
        Self::build(config, false)
    }

    fn build(config: JevConfig, read_env_keys: bool) -> Self {
        // Redirects must not send support messages to an unconfigured endpoint.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("JEV HTTP client");
        Self(Arc::new(Inner {
            read_env_keys,
            config,
            http,
            state: Mutex::new(State::default()),
            latency: Mutex::new(VecDeque::new()),
        }))
    }
    fn key(&self) -> Option<String> {
        if self.0.read_env_keys {
            JevConfig::from_env().key()
        } else {
            self.0.config.key()
        }
    }

    pub fn record_fallback(&self) {
        self.0.state.lock().expect("JEV state").fallbacks += 1;
    }
    pub fn snapshot(&self) -> Value {
        let configured = self.0.config.enabled && self.key().is_some();
        let s = self.0.state.lock().expect("JEV state");
        let remaining = s
            .open_until
            .and_then(|t| t.checked_duration_since(Instant::now()))
            .unwrap_or_default()
            .as_millis() as u64;
        json!({"configured": configured, "enabled": self.0.config.enabled, "calls": s.calls, "network": s.network, "ok": s.ok, "cacheHits": s.cache_hits, "inputTokens": s.input_tokens, "fallbacks": s.fallbacks, "failures": s.failures, "cacheSize": s.cache.len(), "latencyMs": crate::health::latency_json(&self.0.latency), "breaker": {"open": remaining > 0, "reason": if remaining > 0 { s.reason.map(|r| r.to_string()).unwrap_or_default() } else { String::new() }, "reopensInMs": remaining, "consecutiveFailures": s.consecutive_failures}})
    }
    pub async fn evaluate(
        &self,
        state: Value,
        questions: Value,
        purpose: &'static str,
    ) -> Result<Evaluation, JevError> {
        self.0.state.lock().expect("JEV state").calls += 1;
        let result = self.evaluate_inner(state, questions, purpose).await;
        if let Err(error) = result {
            *self
                .0
                .state
                .lock()
                .expect("JEV state")
                .failures
                .entry(error.to_string())
                .or_default() += 1;
        }
        result
    }
    async fn evaluate_inner(
        &self,
        state: Value,
        questions: Value,
        purpose: &'static str,
    ) -> Result<Evaluation, JevError> {
        use JevError::*;
        let c = &self.0.config;
        if !c.enabled {
            return Err(Disabled);
        }
        let key = self.key().ok_or(NoKey)?;
        if !valid_request(&state, &questions) {
            return Err(Invalid);
        }
        let payload = json!({"model": c.model, "state": state, "questions": questions});
        let mut hash = DefaultHasher::new();
        payload.to_string().hash(&mut hash);
        let cache_key = hash.finish();
        {
            let mut s = self.0.state.lock().expect("JEV state");
            s.cache
                .retain(|(_, at, _)| at.elapsed() <= Duration::from_secs(600));
            if let Some(i) = s.cache.iter().position(|(k, _, _)| *k == cache_key) {
                let entry = s.cache.remove(i).expect("cache entry");
                let mut hit = entry.2.clone();
                hit.cached = true;
                hit.latency_ms = 0;
                s.cache.push_back(entry);
                s.cache_hits += 1;
                s.ok += 1;
                return Ok(hit);
            }
            if s.open_until.is_some_and(|t| t > Instant::now()) {
                return Err(CoolingDown);
            }
            s.network += 1;
        }
        let started = Instant::now();
        let network = self.call(&key, &payload).await;
        let latency_ms = started.elapsed().as_millis() as u64;
        let input_tokens = network
            .as_ref()
            .ok()
            .and_then(|v| v.pointer("/usage/input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let parsed = network.and_then(|body| parse_answers(&questions, &body));
        let outcome = parsed
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_else(|| "ok".into());
        tracing::info!(target: "poko_bot::jev", purpose, outcome, latency_ms, input_tokens);
        crate::health::push_sample(&self.0.latency, latency_ms);
        let mut s = self.0.state.lock().expect("JEV state");
        s.input_tokens += input_tokens;
        match parsed {
            Ok(answers) => {
                s.consecutive_failures = 0;
                s.ok += 1;
                let value = Evaluation {
                    answers,
                    latency_ms,
                    cached: false,
                };
                s.cache
                    .push_back((cache_key, Instant::now(), value.clone()));
                while s.cache.len() > 256 {
                    s.cache.pop_front();
                }
                Ok(value)
            }
            Err(error) => {
                let seconds = match error {
                    Quota => Some(120),
                    Credits | Auth => Some(1800),
                    Timeout | Transport | Overloaded | Malformed => {
                        s.consecutive_failures += 1;
                        (s.consecutive_failures >= 3).then_some(60)
                    }
                    _ => None,
                };
                if let Some(seconds) = seconds {
                    s.open_until = Some(Instant::now() + Duration::from_secs(seconds));
                    s.reason = Some(error);
                    s.consecutive_failures = 0;
                }
                Err(error)
            }
        }
    }
    async fn call(&self, key: &str, payload: &Value) -> Result<Value, JevError> {
        let response = self
            .0
            .http
            .post(&self.0.config.url)
            .bearer_auth(key)
            .json(payload)
            .timeout(self.0.config.timeout)
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status();
        let body = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(status_error(status.as_u16(), &body));
        }
        serde_json::from_str(&body).map_err(|_| JevError::Malformed)
    }
}
fn network_error(error: reqwest::Error) -> JevError {
    if error.is_timeout() {
        JevError::Timeout
    } else {
        JevError::Transport
    }
}
fn status_error(status: u16, body: &str) -> JevError {
    use JevError::*;
    let body = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if status == 402
        || body.contains("insufficient credit")
        || body.contains("insufficient balance")
    {
        Credits
    } else if status == 429
        || ["usage limit", "rate limit", "quota"]
            .iter()
            .any(|s| body.contains(s))
    {
        Quota
    } else if status == 401 || status == 403 {
        Auth
    } else if status >= 500 {
        Overloaded
    } else {
        BadRequest
    }
}
fn valid_request(state: &Value, questions: &Value) -> bool {
    let state_valid = match state {
        Value::String(s) => !s.is_empty() && s.chars().count() <= 60_000,
        Value::Object(_) | Value::Array(_) => state.to_string().chars().count() <= 60_000,
        _ => false,
    };
    state_valid
        && questions.as_object().is_some_and(|qs| {
            !qs.is_empty()
                && qs.len() <= 16
                && qs.iter().all(|(name, q)| {
                    !name.is_empty()
                        && name.len() <= 64
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                        && q["type"] == "noul"
                        && q["instructions"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty())
                        && q.get("criteria").is_none_or(|v| {
                            v.as_object().is_some_and(|cs| {
                                cs.iter().all(|(k, v)| {
                                    (k == "true" || k == "false")
                                        && v.as_str().is_some_and(|s| !s.trim().is_empty())
                                })
                            })
                        })
                })
        })
}
fn parse_answers(questions: &Value, body: &Value) -> Result<BTreeMap<String, Noul>, JevError> {
    let mut answers = BTreeMap::new();
    for name in questions.as_object().ok_or(JevError::Malformed)?.keys() {
        let answer: Noul = serde_json::from_value(body["answers"][name].clone())
            .map_err(|_| JevError::Malformed)?;
        if !answer.noul.is_finite() || !(0.0..=1.0).contains(&answer.noul) {
            return Err(JevError::Malformed);
        }
        answers.insert(name.clone(), answer);
    }
    Ok(answers)
}
