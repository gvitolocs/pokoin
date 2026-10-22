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
    ) -> Result<Value> {
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
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("model connection unavailable"))?;
        if !response.status().is_success() {
            bail!("model HTTP {}", response.status().as_u16());
        }
        let mut stream = response.bytes_stream();
        let mut decoder = Sse::default();
        while let Some(chunk) = stream.next().await {
            decoder.feed(&chunk.map_err(|_| anyhow::anyhow!("model stream interrupted"))?)?;
        }
        decoder.finish()
    }
}
#[derive(Default)]
pub struct Sse {
    pending: Vec<u8>,
    blocks: HashMap<u64, String>,
    model: String,
    stop: String,
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
                        self.stop = crate::text(&event["delta"], "stop_reason").into()
                    }
                    "message_stop" => self.ended = true,
                    "error" => bail!("model streamed error"),
                    _ => {}
                }
            }
        }
        Ok(())
    }
    pub fn finish(self) -> Result<Value> {
        if !self.ended {
            bail!("model stream incomplete");
        }
        if self.stop == "refusal" {
            bail!("model refused");
        }
        if self.stop == "max_tokens" {
            bail!("model truncated");
        }
        let raw = self
            .blocks
            .keys()
            .min()
            .and_then(|index| self.blocks.get(index))
            .cloned()
            .unwrap_or_default();
        match serde_json::from_str::<Value>(&raw) {
            Ok(value) => Ok(json!({"json":value,"model":self.model})),
            Err(_) => Ok(json!({"reason":"malformed","raw":raw,"model":self.model})),
        }
    }
}
