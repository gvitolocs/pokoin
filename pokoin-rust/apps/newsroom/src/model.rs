//! Native Anthropic Messages protocol, including streamed tool-free text.
//! No HTTP error body, credential, request or draft is ever logged.
use anyhow::{bail, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

/// Why one Messages call did not yield usable JSON — claude.js:198-214.
/// Only `Malformed` is worth a repair call (claude.js:563).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// stop_reason "refusal"; the detail is stop_details.category.
    Refused,
    /// stop_reason "max_tokens".
    Truncated,
    /// No text block, or a text block that is not JSON.
    Malformed,
    /// HTTP 401 or 403.
    Auth,
    /// HTTP 429 or 5xx, a transport failure, or an unusable stream.
    Unavailable,
    /// Any other HTTP status.
    ApiError,
}
impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Refused => "refused",
            Reason::Truncated => "truncated",
            Reason::Malformed => "malformed",
            Reason::Auth => "auth",
            Reason::Unavailable => "unavailable",
            Reason::ApiError => "api_error",
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub reason: Reason,
    /// Refusal category or transport/status text. Never a response body or key.
    pub detail: Option<String>,
    /// The text block for a `Malformed` failure, empty for every other reason.
    pub raw: String,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Completion {
    Ready {
        json: Value,
        raw: String,
        model: String,
    },
    Failed(Failure),
}
fn unavailable(detail: impl Into<String>) -> Completion {
    Completion::Failed(Failure {
        reason: Reason::Unavailable,
        detail: Some(detail.into()),
        raw: String::new(),
    })
}
#[derive(Clone)]
pub struct Budget(Arc<AtomicUsize>);
impl Budget {
    pub fn new(limit: usize) -> Self {
        Self(Arc::new(AtomicUsize::new(limit)))
    }
    pub fn take(&self) -> Result<()> {
        self.0
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .map(|_| ())
            .map_err(|_| anyhow::anyhow!("model call budget exhausted"))
    }
    pub fn remaining(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}
#[derive(Clone)]
pub struct Provider {
    pub name: String,
    pub base_url: String,
    pub models: HashMap<String, String>,
    pub effort: String,
    pub strict: bool,
    key: String,
    auth_token: bool,
    client: reqwest::Client,
    pub budget: Budget,
}
fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}
fn first(keys: &[&str], default: &str) -> String {
    keys.iter()
        .map(|k| env(k))
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| default.into())
}
impl Provider {
    pub fn from_env(budget: Budget) -> Result<Self> {
        let name = first(
            &["POKO_NEWSROOM_CLAUDE_PROVIDER"],
            if !first(&["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], "").is_empty() {
                "anthropic"
            } else {
                "none"
            },
        );
        let deep = name == "deepseek";
        let base_url = if deep {
            first(
                &["DEEPSEEK_ANTHROPIC_BASE_URL"],
                "https://api.deepseek.com/anthropic",
            )
        } else {
            first(
                &["POKO_NEWSROOM_ANTHROPIC_BASE_URL"],
                "https://api.anthropic.com",
            )
        };
        let key = if deep {
            first(&["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"], "")
        } else {
            first(
                &[
                    "POKO_NEWSROOM_ANTHROPIC_API_KEY",
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                ],
                "",
            )
        };
        let auth_token = !deep
            && env("POKO_NEWSROOM_ANTHROPIC_API_KEY").is_empty()
            && env("ANTHROPIC_API_KEY").is_empty()
            && !env("ANTHROPIC_AUTH_TOKEN").is_empty();
        let mut models = HashMap::new();
        for (pass, var) in [
            ("reporter", "POKO_NEWSROOM_REPORTER_MODEL"),
            ("editor", "POKO_NEWSROOM_EDITOR_MODEL"),
            ("repair", "POKO_NEWSROOM_REPAIR_MODEL"),
        ] {
            models.insert(
                pass.into(),
                first(
                    &[var],
                    if deep {
                        "deepseek-flash"
                    } else if pass == "repair" {
                        "claude-sonnet-5-5"
                    } else {
                        "claude-opus-5-5"
                    },
                ),
            );
        }
        Ok(Self {
            name,
            base_url,
            models,
            effort: first(&["POKO_NEWSROOM_EFFORT"], "high"),
            strict: !deep,
            key,
            auth_token,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(600))
                .build()?,
            budget,
        })
    }
    /// Explicit client injection for isolated fake-server tests only.
    pub fn test_endpoint(&mut self, url: String) {
        self.base_url = url;
        self.key = "local-fake".into();
    }
    pub fn request(&self, pass: &str, system: &str, user: &str, schema: &Value) -> Value {
        let deep = self.name == "deepseek";
        let mut body = json!({"model":self.models.get(pass).or_else(||self.models.get("reporter")),"max_tokens":if deep {96000}else{32000},"system":system,
            "messages":[{"role":"user","content":user}],"thinking":{"type":"adaptive"},
            "output_config":{"effort":if deep && pass=="editor" {"max"}else{&self.effort},"format":{"type":"json_schema","schema":schema}},"stream":true});
        if !deep && env("POKO_NEWSROOM_ANTHROPIC_BASE_URL").is_empty() {
            body["fallbacks"] = json!("default");
        }
        body
    }
    pub async fn generate(
        &self,
        pass: &str,
        system: &str,
        user: &str,
        schema: &Value,
    ) -> Result<Completion> {
        if !["anthropic", "deepseek"].contains(&self.name.as_str()) || self.key.is_empty() {
            bail!("no native Messages provider configured");
        }
        self.budget.take()?;
        let body = self.request(pass, system, user, schema);
        let mut request = self
            .client
            .post(format!(
                "{}/v1/messages",
                self.base_url.trim_end_matches('/')
            ))
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body);
        request = if self.auth_token {
            request.bearer_auth(&self.key)
        } else {
            request.header("x-api-key", &self.key)
        };
        if body.get("fallbacks").is_some() {
            request = request.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        let response = match request.send().await {
            Ok(response) => response,
            // claude.js:208 — an APIConnectionError is an availability failure.
            Err(_) => return Ok(unavailable("model connection unavailable")),
        };
        let status = response.status().as_u16();
        if !response.status().is_success() {
            // claude.js:207-212 — the status alone picks the class, and the
            // error body is never read.
            let reason = if matches!(status, 401 | 403) {
                Reason::Auth
            } else if status == 429 || status >= 500 {
                Reason::Unavailable
            } else {
                Reason::ApiError
            };
            return Ok(Completion::Failed(Failure {
                reason,
                detail: Some(format!("model HTTP {status}")),
                raw: String::new(),
            }));
        }
        let mut stream = response.bytes_stream();
        let mut decoder = Sse::default();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    if let Err(error) = decoder.feed(&chunk) {
                        return Ok(unavailable(error.to_string()));
                    }
                }
                Err(_) => return Ok(unavailable("model stream interrupted")),
            }
        }
        Ok(decoder.finish())
    }
}
#[derive(Default)]
pub struct Sse {
    pending: Vec<u8>,
    blocks: HashMap<u64, String>,
    model: String,
    stop: String,
    details: Value,
    ended: bool,
}
impl Sse {
    pub fn feed(&mut self, chunk: &[u8]) -> Result<()> {
        self.pending.extend_from_slice(chunk);
        if self.pending.len() > 4 * 1024 * 1024 {
            bail!("model SSE event too large");
        }
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line = self.pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line)?.trim_end_matches(['\r', '\n']);
            if let Some(data) = line
                .strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
            {
                if data.trim() == "[DONE]" {
                    continue;
                }
                let event: Value = serde_json::from_str(data)?;
                let index = event["index"].as_u64().unwrap_or(0);
                match crate::text(&event, "type") {
                    "message_start" => self.model = crate::text(&event["message"], "model").into(),
                    "content_block_start" if event["content_block"]["type"] == "text" => {
                        self.blocks
                            .insert(index, crate::text(&event["content_block"], "text").into());
                    }
                    "content_block_delta" if event["delta"]["type"] == "text_delta" => {
                        self.blocks
                            .entry(index)
                            .or_default()
                            .push_str(crate::text(&event["delta"], "text"));
                    }
                    "message_delta" => {
                        self.stop = crate::text(&event["delta"], "stop_reason").into();
                        self.details = event["delta"]["stop_details"].clone();
                    }
                    "message_stop" => self.ended = true,
                    "error" => bail!("model streamed error"),
                    _ => {}
                }
            }
        }
        Ok(())
    }
    pub fn finish(self) -> Completion {
        if !self.ended {
            return unavailable("model stream incomplete");
        }
        if self.stop == "refusal" {
            // claude.js:200 — stop_details.category, or nothing.
            return Completion::Failed(Failure {
                reason: Reason::Refused,
                detail: self
                    .details
                    .get("category")
                    .and_then(Value::as_str)
                    .filter(|category| !category.is_empty())
                    .map(str::to_owned),
                raw: String::new(),
            });
        }
        if self.stop == "max_tokens" {
            return Completion::Failed(Failure {
                reason: Reason::Truncated,
                detail: None,
                raw: String::new(),
            });
        }
        let raw = self
            .blocks
            .keys()
            .min()
            .and_then(|index| self.blocks.get(index))
            .cloned()
            .unwrap_or_default();
        match serde_json::from_str::<Value>(&raw) {
            Ok(json) => Completion::Ready {
                json,
                raw,
                model: self.model,
            },
            Err(_) => Completion::Failed(Failure {
                reason: Reason::Malformed,
                detail: None,
                raw,
            }),
        }
    }
}
