//! A tiny injectable HTTP transport.
//!
//! Every outbound call this crate makes (Google JWKS, the OAuth token
//! endpoint, the Firestore REST API, the Identity Toolkit, Cloudflare R2) goes
//! through [`HttpTransport`]. Production wires [`ReqwestTransport`]; tests wire
//! a scripted transport, so the retry/encoding logic is exercised for real
//! without any network access.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn new(method: &str, url: impl Into<String>) -> Self {
        Self {
            method: method.to_string(),
            url: url.into(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn header(mut self, key: &str, value: impl Into<String>) -> Self {
        self.headers.push((key.to_string(), value.into()));
        self
    }

    pub fn json<T: serde::Serialize>(mut self, value: &T) -> Result<Self, serde_json::Error> {
        self.body = serde_json::to_vec(value)?;
        self.headers
            .push(("Content-Type".into(), "application/json".into()));
        Ok(self)
    }

    pub fn header_value(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body,
        }
    }

    pub fn json(status: u16, value: serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(&value).unwrap_or_default(),
        }
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn retryable(&self) -> bool {
        matches!(self.status, 429 | 500 | 502 | 503 | 504)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    pub fn json_value(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }

    pub fn header_value(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("network error: {0}")]
    Network(String),
    #[error("timed out")]
    Timeout,
}

#[async_trait]
pub trait HttpTransport: Send + Sync + 'static {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, TransportError>;
}

/// Production transport. Timeouts are short on purpose: the accounts paths are
/// on the interactive hot path of the web app.
#[derive(Clone)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new(timeout: Duration) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }

    pub fn from_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|e| TransportError::Network(e.to_string()))?;
        let mut builder = self.client.request(method, &request.url);
        for (key, value) in &request.headers {
            builder = builder.header(key, value);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body.clone());
        }
        let response = builder.send().await.map_err(|error| {
            if error.is_timeout() {
                TransportError::Timeout
            } else {
                TransportError::Network(error.to_string())
            }
        })?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|error| TransportError::Network(error.to_string()))?
            .to_vec();
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

pub type SharedTransport = Arc<dyn HttpTransport>;

/// Retry policy for the REST surfaces that are safe to replay (reads, OAuth
/// token exchange, whole-transaction commit).
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 4,
            base_delay: Duration::from_millis(60),
            max_delay: Duration::from_millis(800),
        }
    }
}

impl RetryPolicy {
    pub fn none() -> Self {
        Self {
            max_attempts: 1,
            base_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
        }
    }

    pub fn delay_for(&self, attempt: u32) -> Duration {
        if attempt == 0 {
            return Duration::ZERO;
        }
        let factor = 1u32 << (attempt.min(6) - 1).min(6);
        let millis = self.base_delay.as_millis() as u64 * factor as u64;
        Duration::from_millis(millis.min(self.max_delay.as_millis() as u64))
    }
}

/// Send a request, retrying transport failures and retryable HTTP statuses with
/// exponential backoff and a small deterministic-free jitter window.
pub async fn send_with_retry(
    transport: &SharedTransport,
    request: HttpRequest,
    policy: RetryPolicy,
) -> Result<HttpResponse, TransportError> {
    let mut last_error = TransportError::Network("no attempt was made".into());
    for attempt in 0..policy.max_attempts {
        let delay = policy.delay_for(attempt);
        if !delay.is_zero() {
            // Jitter keeps a fleet of workers from retrying in lockstep.
            let jitter = rand::random::<u64>() % (delay.as_millis().max(1) as u64 + 1);
            tokio::time::sleep(delay + Duration::from_millis(jitter)).await;
        }
        match transport.execute(request.clone()).await {
            Ok(response) if response.retryable() && attempt + 1 < policy.max_attempts => {
                last_error = TransportError::Network(format!("retryable status {}", response.status));
            }
            Ok(response) => return Ok(response),
            Err(error) => {
                if attempt + 1 >= policy.max_attempts {
                    return Err(error);
                }
                last_error = error;
            }
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_policy_backs_off_then_caps() {
        let policy = RetryPolicy {
            max_attempts: 5,
            base_delay: Duration::from_millis(50),
            max_delay: Duration::from_millis(200),
        };
        assert_eq!(policy.delay_for(0), Duration::ZERO);
        assert_eq!(policy.delay_for(1), Duration::from_millis(50));
        assert_eq!(policy.delay_for(2), Duration::from_millis(100));
        assert_eq!(policy.delay_for(3), Duration::from_millis(200));
        assert_eq!(policy.delay_for(4), Duration::from_millis(200));
    }

    #[test]
    fn request_builder_sets_content_type_for_json() {
        let request = HttpRequest::new("POST", "https://example.test")
            .json(&serde_json::json!({ "a": 1 }))
            .unwrap();
        assert_eq!(request.header_value("content-type"), Some("application/json"));
        assert_eq!(request.body, br#"{"a":1}"#);
    }

    #[test]
    fn retryable_statuses_are_the_transient_ones() {
        assert!(HttpResponse::new(503, vec![]).retryable());
        assert!(HttpResponse::new(429, vec![]).retryable());
        assert!(!HttpResponse::new(404, vec![]).retryable());
        assert!(!HttpResponse::new(200, vec![]).retryable());
    }
}
