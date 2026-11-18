use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::format::Card;

pub const BRAIN_TIMEOUT: Duration = Duration::from_secs(60);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const HERMES_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    Message(String),
    #[error("timeout")]
    Timeout,
}

impl ApiError {
    pub fn from_reqwest(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else {
            Self::Message(error.to_string())
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrainRequest {
    pub platform: String,
    pub scope: String,
    pub user_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firebase_uid: Option<String>,
    pub session_id: String,
    pub display_name: String,
    pub message: String,
    pub history: Vec<HistoryItem>,
    pub context_blocks: Vec<String>,
    pub images: Vec<ImagePart>,
    pub game: String,
    /// Honcho peer. Omitted when the caller has no id yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_peer_id: Option<String>,
    /// Honcho session. Omitted when the caller has no id yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrainResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub reply: String,
    #[serde(default)]
    pub cards: Vec<Card>,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    pub elapsed_ms: Option<u64>,
    #[serde(default)]
    pub blocked: bool,
    #[serde(default)]
    pub error: String,
}

#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    api_base: String,
    service_token: String,
}

impl ApiClient {
    pub fn new(http: reqwest::Client, api_base: String, service_token: String) -> Self {
        Self {
            http,
            api_base: api_base.trim_end_matches('/').to_string(),
            service_token,
        }
    }

    pub async fn brain(&self, body: &BrainRequest) -> Result<BrainResponse, ApiError> {
        let url = format!("{}/api/poko-bot-chat", self.api_base);
        self.post(&url, &self.service_token, body, BRAIN_TIMEOUT)
            .await
    }

    pub async fn connect(&self, body: &Value) -> Result<Value, ApiError> {
        let url = format!("{}/api/poko-connect", self.api_base);
        self.post_value(&url, &self.service_token, body, CONNECT_TIMEOUT)
            .await
    }

    async fn post<T: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        url: &str,
        token: &str,
        body: &T,
        timeout: Duration,
    ) -> Result<R, ApiError> {
        let bytes = self.send(url, token, body, timeout).await?;
        serde_json::from_slice(&bytes).map_err(|error| ApiError::Message(error.to_string()))
    }

    async fn post_value(
        &self,
        url: &str,
        token: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, ApiError> {
        let bytes = self.send(url, token, body, timeout).await?;
        serde_json::from_slice(&bytes).map_err(|error| ApiError::Message(error.to_string()))
    }

    async fn send(
        &self,
        url: &str,
        token: &str,
        body: &impl Serialize,
        timeout: Duration,
    ) -> Result<Vec<u8>, ApiError> {
        if token.is_empty() {
            return Err(ApiError::Message("service token missing".into()));
        }
        let response = self
            .http
            .post(url)
            .timeout(timeout)
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(ApiError::from_reqwest)?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(ApiError::from_reqwest)?
            .to_vec();
        if !status.is_success() {
            let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let message = parsed
                .get("error")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("http {}", status.as_u16()));
            return Err(ApiError::Message(message));
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    fn sample() -> BrainRequest {
        BrainRequest {
            platform: "telegram".into(),
            scope: "dm".into(),
            user_key: "telegram:5".into(),
            firebase_uid: Some("fb-1".into()),
            session_id: "telegram_chat_9".into(),
            display_name: "Ash".into(),
            message: "hi".into(),
            history: vec![HistoryItem {
                role: "user".into(),
                text: "prev".into(),
            }],
            context_blocks: vec!["block".into()],
            images: vec![ImagePart {
                mime_type: "image/jpeg".into(),
                data: "YQ==".into(),
            }],
            game: "pokemon".into(),
            memory_peer_id: None,
            memory_session_id: None,
        }
    }

    #[tokio::test]
    async fn brain_and_connect_send_bearer_and_map_the_error_field() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/poko-bot-chat"))
            .and(header("authorization", "Bearer svc"))
            .and(body_json(json!({
                "platform": "telegram",
                "scope": "dm",
                "userKey": "telegram:5",
                "firebaseUid": "fb-1",
                "sessionId": "telegram_chat_9",
                "displayName": "Ash",
                "message": "hi",
                "history": [{ "role": "user", "text": "prev" }],
                "contextBlocks": ["block"],
                "images": [{ "mimeType": "image/jpeg", "data": "YQ==" }],
                "game": "pokemon"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ok": true,
                "reply": "yo",
                "cards": [],
                "provider": "deepseek",
                "model": "v3",
                "elapsedMs": 12
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/poko-connect"))
            .and(header("authorization", "Bearer svc"))
            .and(body_json(
                json!({ "action": "status", "telegramUserId": "5" }),
            ))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({ "error": "nope" })))
            .mount(&server)
            .await;
        let client = ApiClient::new(reqwest::Client::new(), server.uri(), "svc".into());
        let brain = client.brain(&sample()).await.unwrap();
        assert_eq!(brain.reply, "yo");
        assert_eq!(brain.provider, "deepseek");
        let err = client
            .connect(&json!({ "action": "status", "telegramUserId": "5" }))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "nope");
    }
}
