//! OpenAI-compatible chat providers, with in-process cooldowns.
//!
//! A missing key or model skips that provider. Transport failures, a short list
//! of HTTP statuses, and an unusable body fall through to the next provider.
//! 401 and 403 also mark the provider down for ten minutes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value as Json};

use crate::http::{HttpRequest, TransportError};

use super::sanitize;
use super::tools::{openai_tools, ModelToolCall};
use super::BrainDeps;

const DEFAULT_ORDER: &str = "deepseek,gemini";
const DEFAULT_CALL_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_BUDGET_MS: u64 = 40_000;
const DEFAULT_MAX_ROUNDS: u32 = 3;
const DOWN_FOR: Duration = Duration::from_secs(10 * 60);
const TEMPERATURE: f64 = 0.4;
const MAX_TOKENS: u32 = 700;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrainMode {
    Hermes,
    Canary,
    Rust,
}

pub fn parse_mode(raw: Option<&str>) -> BrainMode {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "rust" => BrainMode::Rust,
        "canary" => BrainMode::Canary,
        _ => BrainMode::Hermes,
    }
}

/// `canary_list` entries are uids or emails (emails match case-insensitively).
pub fn brain_enabled(mode: BrainMode, canary_list: &str, uid: &str, email: &str) -> bool {
    match mode {
        BrainMode::Hermes => false,
        BrainMode::Rust => true,
        BrainMode::Canary => {
            canary_uid_match(canary_list, uid) || canary_email_match(canary_list, email)
        }
    }
}

pub fn canary_email_match(list: &str, email: &str) -> bool {
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return false;
    }
    list.split(',')
        .map(str::trim)
        .any(|item| item.contains('@') && item.eq_ignore_ascii_case(email))
}

pub fn canary_uid_match(list: &str, uid: &str) -> bool {
    let uid = uid.trim();
    if uid.is_empty() {
        return false;
    }
    list.split(',')
        .map(str::trim)
        .any(|item| !item.is_empty() && item == uid)
}

#[derive(Debug, Clone)]
pub struct Provider {
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub extra: Option<Json>,
}

#[derive(Debug, Clone)]
pub struct BrainConfig {
    pub providers: Vec<Provider>,
    pub call_timeout: Duration,
    pub budget: Duration,
    pub max_tool_rounds: u32,
    pub guard_url: Option<String>,
    pub guard_model: Option<String>,
}

impl BrainConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(&|key| std::env::var(key).ok())
    }

    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Self {
        let guard_url = non_empty(lookup("POKO_GUARD_URL"));
        let guard_model = non_empty(lookup("POKO_GUARD_MODEL"));
        let (guard_url, guard_model) = match (guard_url, guard_model) {
            (Some(url), Some(model)) => (Some(url), Some(model)),
            _ => (None, None),
        };
        Self {
            providers: providers_from(lookup),
            call_timeout: Duration::from_millis(positive_u64(
                lookup("POKO_BRAIN_CALL_TIMEOUT_MS"),
                DEFAULT_CALL_TIMEOUT_MS,
            )),
            budget: Duration::from_millis(positive_u64(
                lookup("POKO_BRAIN_BUDGET_MS"),
                DEFAULT_BUDGET_MS,
            )),
            max_tool_rounds: lookup("POKO_BRAIN_MAX_TOOL_ROUNDS")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(DEFAULT_MAX_ROUNDS),
            guard_url,
            guard_model,
        }
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn positive_u64(value: Option<String>, default: u64) -> u64 {
    value
        .and_then(|text| text.trim().parse::<u64>().ok())
        .filter(|parsed| *parsed > 0)
        .unwrap_or(default)
}

struct Preset {
    name: &'static str,
    base: Option<&'static str>,
    base_env: Option<&'static str>,
    key_env: &'static str,
    key_optional: bool,
    model_env: &'static str,
    default_model: Option<&'static str>,
}

fn presets() -> &'static [Preset] {
    &[
        Preset {
            name: "gemini",
            base: Some("https://generativelanguage.googleapis.com/v1beta/openai"),
            base_env: None,
            key_env: "GEMINI_API_KEY",
            key_optional: false,
            model_env: "POKO_BRAIN_GEMINI_MODEL",
            default_model: Some("gemini-2.5-flash-lite"),
        },
        Preset {
            name: "deepseek",
            base: Some("https://api.deepseek.com/v1"),
            base_env: None,
            key_env: "DEEPSEEK_API_KEY",
            key_optional: false,
            model_env: "POKO_BRAIN_DEEPSEEK_MODEL",
            default_model: Some("deepseek-flash"),
        },
        Preset {
            name: "openrouter",
            base: Some("https://openrouter.ai/api/v1"),
            base_env: None,
            key_env: "OPENROUTER_API_KEY",
            key_optional: false,
            model_env: "POKO_BRAIN_OPENROUTER_MODEL",
            default_model: None,
        },
        Preset {
            name: "local",
            base: None,
            base_env: Some("POKO_BRAIN_LOCAL_URL"),
            key_env: "POKO_BRAIN_LOCAL_KEY",
            key_optional: true,
            model_env: "POKO_BRAIN_LOCAL_MODEL",
            default_model: None,
        },
    ]
}

fn providers_from(lookup: &impl Fn(&str) -> Option<String>) -> Vec<Provider> {
    let order =
        non_empty(lookup("POKO_BRAIN_PROVIDERS")).unwrap_or_else(|| DEFAULT_ORDER.to_string());
    let mut providers = Vec::new();
    for name in order.split(',') {
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let Some(preset) = presets().iter().find(|preset| preset.name == name) else {
            continue;
        };
        let base = preset
            .base
            .map(str::to_string)
            .or_else(|| preset.base_env.and_then(|key| non_empty(lookup(key))));
        let Some(base_url) = base else {
            continue;
        };
        let model = non_empty(lookup(preset.model_env))
            .or_else(|| preset.default_model.map(str::to_string));
        let Some(model) = model else {
            continue;
        };
        let api_key = non_empty(lookup(preset.key_env));
        if api_key.is_none() && !preset.key_optional {
            continue;
        }
        let extra = if name == "local" {
            non_empty(lookup("POKO_BRAIN_LOCAL_EXTRA")).and_then(|raw| {
                serde_json::from_str::<Json>(&raw)
                    .ok()
                    .filter(|value| value.is_object())
            })
        } else {
            None
        };
        providers.push(Provider {
            name,
            base_url,
            api_key,
            model,
            extra,
        });
    }
    providers
}

/// Process-wide 401/403 cooldown. Tests pass their own instance.
#[derive(Debug, Default)]
pub struct ProviderHealth {
    down_until: Mutex<HashMap<String, Instant>>,
}

impl ProviderHealth {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn process_wide() -> std::sync::Arc<Self> {
        static CELL: OnceLock<std::sync::Arc<ProviderHealth>> = OnceLock::new();
        CELL.get_or_init(|| std::sync::Arc::new(ProviderHealth::new()))
            .clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Instant>> {
        self.down_until
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn mark_down(&self, name: &str) {
        self.lock()
            .insert(name.to_string(), Instant::now() + DOWN_FOR);
    }

    pub fn is_down(&self, name: &str) -> bool {
        let mut map = self.lock();
        let now = Instant::now();
        map.retain(|_, until| *until > now);
        map.contains_key(name)
    }

    #[cfg(test)]
    pub(crate) fn suppressed_for(&self, name: &str) -> Option<Duration> {
        let until = *self.lock().get(name)?;
        until.checked_duration_since(Instant::now())
    }
}

pub(crate) fn chat_completions_url(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolChoice {
    Auto,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CompleteOptions {
    pub choice: ToolChoice,
    pub include_tools: bool,
}

impl CompleteOptions {
    pub(crate) fn with_tools(choice: ToolChoice) -> Self {
        Self {
            choice,
            include_tools: true,
        }
    }

    pub(crate) fn plain_text() -> Self {
        Self {
            choice: ToolChoice::None,
            include_tools: false,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Completion {
    pub content: String,
    pub tool_calls: Vec<ModelToolCall>,
    pub assistant_message: Json,
    pub provider: String,
    pub model: String,
    pub attempts: u32,
}

#[derive(Debug)]
pub(crate) enum CompleteError {
    Budget,
    Failed,
}

pub(crate) struct TurnBudget {
    started: Instant,
    budget: Duration,
}

impl TurnBudget {
    pub(crate) fn new(started: Instant, budget: Duration) -> Self {
        Self { started, budget }
    }

    fn remaining(&self) -> Option<Duration> {
        self.budget
            .checked_sub(self.started.elapsed())
            .filter(|left| !left.is_zero())
    }
}

pub(crate) async fn complete(
    deps: &BrainDeps,
    budget: &TurnBudget,
    messages: &[Json],
    options: CompleteOptions,
) -> Result<Completion, CompleteError> {
    if deps.config.providers.is_empty() {
        return Err(CompleteError::Failed);
    }
    let mut attempts = 0u32;
    let mut saw_provider = false;
    for provider in &deps.config.providers {
        if deps.health.is_down(&provider.name) {
            continue;
        }
        saw_provider = true;
        let Some(timeout) = budget.remaining() else {
            return Err(CompleteError::Budget);
        };
        let timeout = deps.config.call_timeout.min(timeout);
        attempts += 1;
        match call_provider(deps, budget, provider, messages, options, timeout).await {
            CallOutcome::Ready(mut completion) => {
                completion.attempts = attempts;
                return Ok(completion);
            }
            CallOutcome::Budget => return Err(CompleteError::Budget),
            CallOutcome::Fallback => continue,
            CallOutcome::Hard => return Err(CompleteError::Failed),
        }
    }
    if !saw_provider && budget.remaining().is_none() {
        return Err(CompleteError::Budget);
    }
    Err(CompleteError::Failed)
}

/// One call to a named provider (for markup recovery retry on the same provider).
pub(crate) async fn complete_named(
    deps: &BrainDeps,
    budget: &TurnBudget,
    provider_name: &str,
    messages: &[Json],
    options: CompleteOptions,
) -> Result<Completion, CompleteError> {
    let provider = deps
        .config
        .providers
        .iter()
        .find(|provider| provider.name == provider_name);
    let Some(provider) = provider else {
        return Err(CompleteError::Failed);
    };
    if deps.health.is_down(&provider.name) {
        return Err(CompleteError::Failed);
    }
    let Some(timeout) = budget.remaining() else {
        return Err(CompleteError::Budget);
    };
    let timeout = deps.config.call_timeout.min(timeout);
    match call_provider(deps, budget, provider, messages, options, timeout).await {
        CallOutcome::Ready(mut completion) => {
            completion.attempts = 1;
            Ok(completion)
        }
        CallOutcome::Budget => Err(CompleteError::Budget),
        CallOutcome::Fallback | CallOutcome::Hard => Err(CompleteError::Failed),
    }
}

enum CallOutcome {
    Ready(Completion),
    Budget,
    Fallback,
    Hard,
}

async fn call_provider(
    deps: &BrainDeps,
    budget: &TurnBudget,
    provider: &Provider,
    messages: &[Json],
    options: CompleteOptions,
    timeout: Duration,
) -> CallOutcome {
    let started = Instant::now();
    let url = chat_completions_url(&provider.base_url);
    let payload = request_body(provider, messages, options);
    let mut request = match HttpRequest::new("POST", url)
        .timeout(timeout)
        .json(&payload)
    {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(provider = %provider.name, error = %error, "poko-brain request encode failed");
            return CallOutcome::Hard;
        }
    };
    if let Some(key) = provider.api_key.as_deref() {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    let response = match deps.transport.execute(request).await {
        Ok(response) => response,
        Err(error) => {
            let ms = elapsed_ms(started);
            log_call(&provider.name, &provider.model, ms, 0, 0);
            if matches!(error, TransportError::Timeout) && budget.remaining().is_none() {
                return CallOutcome::Budget;
            }
            return CallOutcome::Fallback;
        }
    };
    let ms = elapsed_ms(started);
    if matches!(response.status, 401 | 403) {
        deps.health.mark_down(&provider.name);
        log_call(
            &provider.name,
            &provider.model,
            ms,
            i64::from(response.status),
            0,
        );
        return CallOutcome::Fallback;
    }
    if !response.is_success() {
        log_call(
            &provider.name,
            &provider.model,
            ms,
            i64::from(response.status),
            0,
        );
        return match response.status {
            408 | 409 | 425 | 429 | 500..=599 => CallOutcome::Fallback,
            _ => CallOutcome::Hard,
        };
    }
    let body = response.json_value().unwrap_or(Json::Null);
    let completion = match parse_completion(&body, provider) {
        Some(completion) if usable(options, &completion) => completion,
        _ => {
            log_call(
                &provider.name,
                &provider.model,
                ms,
                i64::from(response.status),
                0,
            );
            return CallOutcome::Fallback;
        }
    };
    log_call(
        &provider.name,
        &provider.model,
        ms,
        i64::from(response.status),
        completion.tool_calls.len(),
    );
    CallOutcome::Ready(completion)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn log_call(provider: &str, model: &str, ms: u64, status: i64, tool_calls: usize) {
    tracing::info!(
        provider,
        model,
        ms,
        status,
        tool_calls,
        "poko-brain llm call"
    );
}

fn request_body(provider: &Provider, messages: &[Json], options: CompleteOptions) -> Json {
    let mut payload = Map::new();
    payload.insert("model".into(), json!(provider.model));
    payload.insert("temperature".into(), json!(TEMPERATURE));
    payload.insert("max_tokens".into(), json!(MAX_TOKENS));
    payload.insert("stream".into(), json!(false));
    payload.insert("messages".into(), Json::Array(messages.to_vec()));
    if options.include_tools {
        payload.insert("tools".into(), openai_tools());
        payload.insert(
            "tool_choice".into(),
            json!(match options.choice {
                ToolChoice::Auto => "auto",
                ToolChoice::None => "none",
            }),
        );
    }
    if let Some(extra) = provider.extra.as_ref().and_then(Json::as_object) {
        for (key, value) in extra {
            payload.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    Json::Object(payload)
}

fn usable(options: CompleteOptions, completion: &Completion) -> bool {
    let has_text = !completion.content.trim().is_empty();
    let has_tools = !completion.tool_calls.is_empty();
    let markup_leak =
        sanitize::contains_tool_markup(&completion.content) && completion.tool_calls.is_empty();
    if markup_leak && !options.include_tools {
        return false;
    }
    match options.choice {
        ToolChoice::Auto => has_text || has_tools,
        ToolChoice::None => has_text,
    }
}

fn parse_completion(body: &Json, provider: &Provider) -> Option<Completion> {
    let message = body.pointer("/choices/0/message")?;
    let content = match message.get("content") {
        Some(Json::String(text)) => text.clone(),
        _ => String::new(),
    };
    let mut tool_calls = Vec::new();
    if let Some(list) = message.get("tool_calls").and_then(Json::as_array) {
        for (index, call) in list.iter().enumerate() {
            let function = call.get("function").unwrap_or(call);
            let name = function
                .get("name")
                .and_then(Json::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() {
                return None;
            }
            let arguments = match function.get("arguments") {
                Some(Json::String(text)) => parse_arguments(text)?,
                Some(object @ Json::Object(_)) => object.clone(),
                None | Some(Json::Null) => json!({}),
                Some(_) => return None,
            };
            let id = call
                .get("id")
                .and_then(Json::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{index}"));
            tool_calls.push(ModelToolCall {
                id,
                name,
                arguments,
            });
        }
    }
    let assistant_message = assistant_message(&content, &tool_calls);
    Some(Completion {
        content,
        tool_calls,
        assistant_message,
        provider: provider.name.clone(),
        model: provider.model.clone(),
        attempts: 0,
    })
}

fn assistant_message(content: &str, calls: &[ModelToolCall]) -> Json {
    if calls.is_empty() {
        return json!({ "role": "assistant", "content": content });
    }
    let tool_calls: Vec<Json> = calls
        .iter()
        .map(|call| {
            json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string()),
                }
            })
        })
        .collect();
    json!({
        "role": "assistant",
        "content": if content.is_empty() { Json::Null } else { json!(content) },
        "tool_calls": tool_calls,
    })
}

pub(crate) fn parse_arguments(raw: &str) -> Option<Json> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(json!({}));
    }
    if let Ok(value) = serde_json::from_str::<Json>(trimmed) {
        return value.as_object().cloned().map(Json::Object);
    }
    let repaired = repair_arguments(trimmed);
    serde_json::from_str::<Json>(&repaired)
        .ok()
        .and_then(|value| value.as_object().cloned().map(Json::Object))
}

fn repair_arguments(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    if let Some(rest) = text.strip_prefix("```") {
        text = rest.trim_start().to_string();
        if let Some(rest) = text.strip_prefix("json") {
            text = rest.trim_start().to_string();
        }
        if let Some(rest) = text.strip_suffix("```") {
            text = rest.trim().to_string();
        }
    }
    static COMMAS: OnceLock<regex::Regex> = OnceLock::new();
    let commas = COMMAS.get_or_init(|| regex::Regex::new(r",(\s*[}\]])").expect("trailing comma"));
    commas.replace_all(&text, "$1").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parsing_and_canary_uids() {
        assert_eq!(parse_mode(None), BrainMode::Hermes);
        assert_eq!(parse_mode(Some("")), BrainMode::Hermes);
        assert_eq!(parse_mode(Some("hermes")), BrainMode::Hermes);
        assert_eq!(parse_mode(Some(" HERMES ")), BrainMode::Hermes);
        assert_eq!(parse_mode(Some("nope")), BrainMode::Hermes);
        assert_eq!(parse_mode(Some("canary")), BrainMode::Canary);
        assert_eq!(parse_mode(Some("RUST")), BrainMode::Rust);
        assert!(!brain_enabled(BrainMode::Hermes, "a", "a", ""));
        assert!(brain_enabled(BrainMode::Rust, "", "anyone", ""));
        assert!(brain_enabled(BrainMode::Canary, "aaa, bbb ", "bbb", ""));
        assert!(!brain_enabled(BrainMode::Canary, "aaa, bbb", "ccc", ""));
        assert!(!brain_enabled(BrainMode::Canary, "", "bbb", ""));
        assert!(brain_enabled(
            BrainMode::Canary,
            "aaa, Kid@Example.com",
            "ccc",
            "kid@example.com"
        ));
        assert!(!brain_enabled(
            BrainMode::Canary,
            "aaa, kid@example.com",
            "ccc",
            "other@example.com"
        ));
        assert!(!brain_enabled(BrainMode::Canary, "aaa", "ccc", "aaa"));
        assert!(!canary_uid_match("aaa", ""));
    }

    #[test]
    fn missing_keys_and_models_are_skipped() {
        let config = BrainConfig::from_lookup(&|key| match key {
            "POKO_BRAIN_PROVIDERS" => Some("gemini,openrouter,local,deepseek".into()),
            "DEEPSEEK_API_KEY" => Some("deep-key".into()),
            "OPENROUTER_API_KEY" => Some("or-key".into()),
            "POKO_BRAIN_LOCAL_URL" => Some("http://192.168.178.55:11436/v1".into()),
            "POKO_BRAIN_LOCAL_EXTRA" => {
                Some(r#"{"chat_template_kwargs":{"enable_thinking":false}}"#.into())
            }
            _ => None,
        });
        let names: Vec<&str> = config
            .providers
            .iter()
            .map(|provider| provider.name.as_str())
            .collect();
        assert_eq!(names, vec!["deepseek"]);
        assert!(config.guard_url.is_none());
        assert_eq!(config.max_tool_rounds, 3);
        assert_eq!(config.call_timeout, Duration::from_millis(15_000));
        assert_eq!(config.budget, Duration::from_millis(40_000));
    }

    #[test]
    fn local_provider_keeps_its_extra_body() {
        let config = BrainConfig::from_lookup(&|key| match key {
            "POKO_BRAIN_PROVIDERS" => Some("local".into()),
            "POKO_BRAIN_LOCAL_URL" => Some("http://127.0.0.1:11436/v1".into()),
            "POKO_BRAIN_LOCAL_MODEL" => Some("qwen".into()),
            "POKO_BRAIN_LOCAL_EXTRA" => {
                Some(r#"{"chat_template_kwargs":{"enable_thinking":false}}"#.into())
            }
            "POKO_GUARD_URL" => Some("http://guard.local/v1".into()),
            "POKO_GUARD_MODEL" => Some("qwen3guard".into()),
            "POKO_BRAIN_MAX_TOOL_ROUNDS" => Some("1".into()),
            _ => None,
        });
        assert_eq!(config.providers.len(), 1);
        assert!(config.providers[0].api_key.is_none());
        assert_eq!(
            config.providers[0].extra.as_ref().unwrap()["chat_template_kwargs"]["enable_thinking"],
            json!(false)
        );
        assert_eq!(config.guard_model.as_deref(), Some("qwen3guard"));
        assert_eq!(config.max_tool_rounds, 1);
    }

    #[test]
    fn default_max_tool_rounds_is_three() {
        let config = BrainConfig::from_lookup(&|_| None);
        assert_eq!(config.max_tool_rounds, 3);
    }

    #[test]
    fn trailing_commas_repair_once() {
        let parsed = parse_arguments(r#"{"query":"Lugia",}"#).unwrap();
        assert_eq!(parsed["query"], json!("Lugia"));
        assert!(parse_arguments("not json").is_none());
        assert_eq!(parse_arguments("  ").unwrap(), json!({}));
    }
}
