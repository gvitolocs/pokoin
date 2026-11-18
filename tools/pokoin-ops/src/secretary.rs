//! Secretary app push (getsecretary.tech): `POST /v1/notify` for alerts and
//! `POST /v1/system/health` for the sentinel's full snapshot, both with the `svc_` service
//! token as a Bearer header (secretary-server `service::require_service`). This channel is
//! best effort: a missing token or an HTTP error is logged once and never fails the command.

use crate::env;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_URL: &str = "https://getsecretary.tech";
pub const DEFAULT_TOKEN_FILE: &str = "/home/nez/Projects/Lucina/private/lucina/secretary-service.token";
pub const ROUTE: &str = "/server-health";
// secretary-server's NotifyBody limits.
const TITLE_MAX: usize = 120;
const BODY_MAX: usize = 2000;

#[derive(Debug, PartialEq)]
pub enum Sent {
    Delivered,
    /// No token (or dry run): nothing to retry.
    Skipped,
}

pub struct Client {
    url: String,
    token: Option<String>,
    dry_run: bool,
}

impl Client {
    pub fn from_env() -> Client {
        let url = env::get_or("POKOIN_SECRETARY_URL", DEFAULT_URL).trim_end_matches('/').to_string();
        let file = env::get_or("POKOIN_SECRETARY_TOKEN_FILE", DEFAULT_TOKEN_FILE);
        let token = std::fs::read_to_string(&file).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if token.is_none() {
            eprintln!("secretary: no service token in {file}; Secretary push disabled");
        }
        Client { url, token, dry_run: env::get("POKOIN_OPS_DRY_RUN").is_some() }
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Sent> {
        if self.dry_run {
            eprintln!("[dry-run secretary] POST {path} {}", crate::mail::truncate(&body.to_string(), 400));
            return Ok(Sent::Skipped);
        }
        let Some(token) = &self.token else { return Ok(Sent::Skipped) };
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
        match agent
            .post(&format!("{}{path}", self.url))
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(body.clone())
        {
            Ok(_) => Ok(Sent::Delivered),
            Err(ureq::Error::Status(code, resp)) => {
                Err(anyhow!("HTTP {code}: {}", clip(&resp.into_string().unwrap_or_default(), 200)))
            }
            Err(err) => Err(anyhow!("{err}")),
        }
    }

    pub fn notify(&self, title: &str, body: &str, dedup_key: &str) -> Result<Sent> {
        self.post("/v1/notify", &notice(title, body, dedup_key))
    }
}

pub fn notice(title: &str, body: &str, dedup_key: &str) -> Value {
    let body = if body.trim().is_empty() { "(no detail)" } else { body.trim() };
    json!({
        "category": "system",
        "title": clip(title, TITLE_MAX),
        "body": clip(body, BODY_MAX),
        "dedupKey": clip(dedup_key, 200),
        "route": ROUTE,
    })
}

/// At most `max` characters (the server counts chars, not bytes).
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The first line of an error, for one-line logs.
pub fn log_err(what: &str, err: &anyhow::Error) {
    eprintln!("secretary: {what} failed: {}", clip(&format!("{err:#}").replace('\n', " "), 300));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notice_matches_the_notify_contract() {
        let v = notice("nezopt: lucina-rs failed", "inactive (dead)", "nezopt:unit:lucina-rs.service");
        assert_eq!(v["category"], "system");
        assert_eq!(v["title"], "nezopt: lucina-rs failed");
        assert_eq!(v["body"], "inactive (dead)");
        assert_eq!(v["dedupKey"], "nezopt:unit:lucina-rs.service");
        assert_eq!(v["route"], "/server-health");
        assert_eq!(v.as_object().unwrap().len(), 5);
    }

    #[test]
    fn notice_respects_server_limits() {
        let long = "é".repeat(5000);
        let v = notice(&long, &long, "k");
        assert_eq!(v["title"].as_str().unwrap().chars().count(), 120);
        assert_eq!(v["body"].as_str().unwrap().chars().count(), 2000);
        assert_eq!(notice("t", "  ", "k")["body"], "(no detail)");
    }
}
