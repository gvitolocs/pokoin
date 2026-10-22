//! P-OPS Bot Hospital client. The destination is explicit: never infer a local tunnel.
use crate::x_client::env_alias;
use anyhow::{bail, Context};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

#[derive(Clone)]
pub struct Hospital {
    http: reqwest::Client,
    url: Url,
    token: String,
    timeout: Duration,
}

pub fn validate_url(value: &str) -> anyhow::Result<Url> {
    let url = Url::parse(value).context("POKO_HOSPITAL_URL is not a URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "POKO_HOSPITAL_URL must be an HTTP(S) endpoint without credentials, query or fragment"
        );
    }
    if url.path() != "/api/internal/bot-hospital/incident" {
        bail!("POKO_HOSPITAL_URL must target Lucina Rust /api/internal/bot-hospital/incident");
    }
    if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
        && url.port() == Some(18789)
    {
        bail!("POKO_HOSPITAL_URL points to the retired p2 port 18789; configure the P-OPS Rust endpoint");
    }
    Ok(url)
}

impl Hospital {
    pub fn new(
        http: reqwest::Client,
        url: &str,
        token: String,
        timeout_ms: u64,
    ) -> anyhow::Result<Self> {
        if token.trim().is_empty() {
            bail!("POKO_HOSPITAL_TOKEN is required when POKO_HOSPITAL_URL is configured");
        }
        Ok(Self {
            http,
            url: validate_url(url)?,
            token,
            timeout: Duration::from_millis(timeout_ms.max(10_000)),
        })
    }
    pub fn from_env(http: reqwest::Client) -> anyhow::Result<Option<Self>> {
        let url = env_alias(&["POKO_HOSPITAL_URL", "POKO_NEWS_ALERT_URL"]);
        if url.is_empty() {
            return Ok(None);
        }
        let token = env_alias(&[
            "POKO_HOSPITAL_TOKEN",
            "POKO_NEWS_ALERT_TOKEN",
            "BOT_HOSPITAL_TOKEN",
            "HERMES_INTERNAL_ALERT_TOKEN",
        ]);
        let timeout = env_alias(&["POKO_HOSPITAL_TIMEOUT_MS"]);
        let timeout = if timeout.is_empty() {
            60_000
        } else {
            timeout
                .parse()
                .context("POKO_HOSPITAL_TIMEOUT_MS must be milliseconds")?
        };
        Self::new(http, &url, token, timeout).map(Some)
    }
    pub async fn report(&self, payload: &Value) -> anyhow::Result<Value> {
        let response = self
            .http
            .post(self.url.clone())
            .bearer_auth(&self.token)
            .json(payload)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Bot hospital alert transport failed"))?;
        let status = response.status();
        let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            bail!("Bot hospital alert failed {}", status.as_u16());
        }
        Ok(json!({"ok":true,"data":data}))
    }
}
