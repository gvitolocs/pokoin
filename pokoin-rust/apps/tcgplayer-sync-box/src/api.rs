//! Device calls. The bearer token is read from a file and never logged.
use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};

use crate::ListingTarget;

/// Jobs taken in one pass. The server allows 20; five stays inside the 300s lease.
pub const MAX_CLAIM: i64 = 5;

#[derive(Debug)]
pub enum DeviceError {
    /// 409 `channel_sync/lease-lost`: another run owns the job.
    LeaseLost,
    Http(anyhow::Error),
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LeaseLost => write!(f, "lease lost"),
            Self::Http(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for DeviceError {}

pub struct Heartbeat {
    pub enabled: bool,
}

/// Pokoin device API. `Debug` redacts the bearer token.
pub struct ApiClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl std::fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiClient")
            .field("base", &self.base)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl ApiClient {
    pub fn new(base: impl Into<String>, token: impl Into<String>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("http client")?;
        Ok(Self {
            http,
            base: base.into().trim_end_matches('/').to_string(),
            token: token.into(),
        })
    }

    async fn post(&self, body: &Value) -> Result<Value, DeviceError> {
        let url = format!("{}/api/channel-sync/device", self.base);
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(|error| DeviceError::Http(anyhow::anyhow!("device request failed: {error}")))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"error": "device request failed"}));
        if status.as_u16() == 409 && value["code"] == "channel_sync/lease-lost" {
            return Err(DeviceError::LeaseLost);
        }
        if !status.is_success() {
            let message = value["error"].as_str().unwrap_or("device request failed");
            return Err(DeviceError::Http(anyhow::anyhow!("{status} {message}")));
        }
        Ok(value)
    }

    pub async fn heartbeat(
        &self,
        signed_in: bool,
        running: bool,
        version: &str,
        error: Option<&str>,
    ) -> Result<Heartbeat, DeviceError> {
        let mut body = json!({
            "action": "heartbeat",
            "signedIn": signed_in,
            "running": running,
            "version": version,
        });
        if let Some(error) = error {
            body["error"] = json!(error);
        }
        let value = self.post(&body).await?;
        Ok(Heartbeat { enabled: value["enabled"] == true })
    }

    pub async fn claim(&self, max: i64) -> Result<Vec<ClaimedJob>, DeviceError> {
        let value = self.post(&json!({"action": "claim", "max": max})).await?;
        let jobs = value["jobs"].as_array().cloned().unwrap_or_default();
        Ok(jobs.into_iter().map(ClaimedJob::from_value).collect())
    }

    pub async fn complete(
        &self,
        job_id: i64,
        lease_token: &str,
        outcome: &str,
        external_id: Option<&str>,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> Result<(), DeviceError> {
        let mut body = json!({
            "action": "complete",
            "jobId": job_id,
            "leaseToken": lease_token,
            "outcome": outcome,
        });
        if let Some(external_id) = external_id {
            body["externalId"] = json!(external_id);
        }
        if let Some(result) = result {
            body["result"] = result.clone();
        }
        if let Some(error) = error {
            body["error"] = json!(error);
        }
        self.post(&body).await?;
        Ok(())
    }

    pub async fn post_orders(&self, orders: &[Value]) -> Result<(), DeviceError> {
        self.post(&json!({"action": "orders", "orders": orders})).await?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub job_id: i64,
    pub lease_token: String,
    pub kind: String,
    pub since: Option<String>,
    pub target: ListingTarget,
}

impl ClaimedJob {
    fn from_value(value: Value) -> Self {
        let target = target_from(&value);
        Self {
            job_id: value["jobId"].as_i64().unwrap_or(0),
            lease_token: value["leaseToken"].as_str().unwrap_or("").to_string(),
            kind: value["kind"].as_str().unwrap_or("").to_string(),
            since: value["since"].as_str().map(str::to_string),
            target,
        }
    }
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_string()
}

fn target_from(value: &Value) -> ListingTarget {
    ListingTarget {
        listing_id: text(value, "listingId"),
        external_id: text(value, "externalId"),
        quantity: value["quantity"].as_i64().unwrap_or(0),
        price_cents: value["priceCents"].as_i64(),
        card_id: text(value, "cardId"),
        card_name: text(value, "cardName"),
        set_name: text(value, "setName"),
        collector_number: text(value, "collectorNumber"),
        condition: text(value, "condition"),
        language: text(value, "language"),
        reverse: value["reverse"] == true,
        first_edition: value["firstEdition"] == true,
        kind: text(value, "kind"),
    }
}
