use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::ApiError;
use crate::format::Card;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HermesUser {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HermesRequest {
    pub message: String,
    pub user_message: String,
    pub user_id: String,
    pub session_id: String,
    pub user: HermesUser,
    pub platform: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HermesResponse {
    #[serde(default)]
    pub reply: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub cards: Vec<Card>,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
}

impl HermesResponse {
    pub fn reply_text(&self) -> String {
        let reply = self.reply.trim();
        if !reply.is_empty() {
            reply.to_string()
        } else {
            self.text.trim().to_string()
        }
    }
}

pub async fn chat(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    body: &HermesRequest,
    timeout: Duration,
) -> Result<HermesResponse, ApiError> {
    if token.is_empty() {
        return Err(ApiError::Message("hermes token missing".into()));
    }
    let response = http
        .post(url)
        .timeout(timeout)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(ApiError::from_reqwest)?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(ApiError::from_reqwest)?;
    if !status.is_success() {
        return Err(api_error(status.as_u16(), &bytes));
    }
    serde_json::from_slice(&bytes).map_err(|error| ApiError::Message(error.to_string()))
}

fn api_error(status: u16, bytes: &[u8]) -> ApiError {
    let parsed: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let message = parsed
        .get("error")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("hermes {status}"));
    ApiError::Message(message)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    #[tokio::test]
    async fn posts_the_hermes_body_with_bearer_and_maps_errors() {
        let server = MockServer::start().await;
        let request = HermesRequest {
            message: "ctx\n\nhi".into(),
            user_message: "hi".into(),
            user_id: "telegram_user_5".into(),
            session_id: "telegram_chat_9".into(),
            user: HermesUser {
                id: "telegram_user_5".into(),
                display_name: "Ash".into(),
            },
            platform: "telegram".into(),
        };
        Mock::given(method("POST"))
            .and(path("/api/poko/chat"))
            .and(header("authorization", "Bearer hermes-token"))
            .and(body_json(json!({
                "message": "ctx\n\nhi",
                "userMessage": "hi",
                "userId": "telegram_user_5",
                "sessionId": "telegram_chat_9",
                "user": { "id": "telegram_user_5", "displayName": "Ash" },
                "platform": "telegram"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "text": "hey",
                "cards": []
            })))
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        let ok = chat(
            &http,
            &format!("{}/api/poko/chat", server.uri()),
            "hermes-token",
            &request,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(ok.reply_text(), "hey");

        Mock::given(method("POST"))
            .and(path("/fail"))
            .respond_with(ResponseTemplate::new(500).set_body_json(json!({ "error": "down" })))
            .mount(&server)
            .await;
        let err = chat(
            &http,
            &format!("{}/fail", server.uri()),
            "hermes-token",
            &request,
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "down");
    }
}
