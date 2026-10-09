//! Supabase PostgREST client — a port of `api/_supabase.js`.
//!
//! The forum routes read and write PostgREST tables. Same request shape, same
//! `encodeFilterValue` escaping policy and the same status mapping: a 4xx from
//! Supabase stays a 4xx (so a handler can answer 404/409), anything else is a
//! 500.

use std::sync::Arc;

use serde_json::Value as Json;

use crate::error::{ApiError, Result};
use crate::http::{send_with_retry, HttpRequest, RetryPolicy, SharedTransport};

#[derive(Clone)]
pub struct SupabaseClient {
    inner: Arc<SupabaseInner>,
}

struct SupabaseInner {
    base: String,
    anon_key: Option<String>,
    service_key: Option<String>,
    transport: SharedTransport,
    retry: RetryPolicy,
}

/// `encodeFilterValue`: percent-encode and escape embedded double quotes.
pub fn encode_filter_value(value: &str) -> String {
    let escaped = value.replace('"', "\\\"");
    let mut out = String::with_capacity(escaped.len());
    for byte in escaped.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

impl SupabaseClient {
    pub fn new(
        base: impl Into<String>,
        anon_key: Option<String>,
        service_key: Option<String>,
        transport: SharedTransport,
    ) -> Self {
        Self {
            inner: Arc::new(SupabaseInner {
                base: base.into().trim_end_matches('/').to_string(),
                anon_key: anon_key.filter(|key| !key.is_empty()),
                service_key: service_key.filter(|key| !key.is_empty()),
                transport,
                retry: RetryPolicy::default(),
            }),
        }
    }

    /// Build from the environment, or `None` when Supabase is not configured.
    pub fn from_env(transport: SharedTransport) -> Option<Self> {
        let url = std::env::var("SUPABASE_URL")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())?;
        let anon = std::env::var("SUPABASE_ANON_KEY").ok();
        let service = std::env::var("SUPABASE_SERVICE_ROLE_KEY").ok();
        Some(Self::new(url, anon, service, transport))
    }

    fn key(&self, service_role: bool) -> Result<&str> {
        let key = if service_role {
            self.inner.service_key.as_deref()
        } else {
            self.inner.anon_key.as_deref()
        };
        key.ok_or_else(|| ApiError::internal("Supabase is not configured."))
    }

    async fn send(
        &self,
        path: &str,
        method: &str,
        body: Option<Json>,
        service_role: bool,
        prefer: Option<&str>,
    ) -> Result<Option<Json>> {
        let key = self.key(service_role)?;
        let url = format!("{}{}", self.inner.base, path);
        let mut request = HttpRequest::new(method, url)
            .header("apikey", key)
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json");
        if let Some(prefer) = prefer {
            request = request.header("Prefer", prefer);
        }
        if let Some(body) = body {
            request = request
                .json(&body)
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }

        let response = send_with_retry(&self.inner.transport, request, self.inner.retry)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;

        if !response.is_success() {
            let detail = response.text();
            let truncated: String = detail.chars().take(300).collect();
            let status = if (400..500).contains(&response.status) {
                response.status
            } else {
                500
            };
            let status = axum::http::StatusCode::from_u16(status)
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
            return Err(ApiError::new(
                status,
                format!("Supabase request failed {}: {}", response.status, truncated),
            ));
        }
        if response.status == 204 || response.body.is_empty() {
            return Ok(None);
        }
        Ok(serde_json::from_slice(&response.body).ok())
    }

    pub async fn get(&self, path: &str, service_role: bool) -> Result<Json> {
        Ok(self
            .send(path, "GET", None, service_role, None)
            .await?
            .unwrap_or(Json::Array(vec![])))
    }

    /// `supabaseFetch(path, { method: 'POST', serviceRole, headers, body })`.
    pub async fn post(
        &self,
        path: &str,
        body: Json,
        service_role: bool,
        prefer: Option<&str>,
    ) -> Result<Json> {
        Ok(self
            .send(path, "POST", Some(body), service_role, prefer)
            .await?
            .unwrap_or(Json::Null))
    }
}

/// The default `Prefer` header used when a write wants the row back.
pub const PREFER_REPRESENTATION: &str = "return=representation";
/// The default `Prefer` header used for idempotent secondary writes.
pub const PREFER_IGNORE_DUPLICATES: &str =
    "resolution=ignore-duplicates,return=minimal";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_values_escape_quotes_and_reserved_characters() {
        assert_eq!(encode_filter_value("abc"), "abc");
        assert_eq!(encode_filter_value("a b"), "a%20b");
        assert_eq!(encode_filter_value("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_filter_value("say \"hi\""), "say%20%5C%22hi%5C%22");
        // A uuid is untouched, so PostgREST filters stay readable.
        assert_eq!(
            encode_filter_value("0f8fad5b-d9cb-469f-a165-70867728950e"),
            "0f8fad5b-d9cb-469f-a165-70867728950e"
        );
    }
}
