//! HTTP error shape shared by every accounts handler.
//!
//! The Node handlers answer `{ "error": "<message>" }` and, for a few
//! verification paths, an extra machine `code`. This type reproduces exactly
//! that body so the existing web and Flutter clients keep working, and adds
//! `retryAfterSec` for the register-email cooldown.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};

pub type Result<T> = std::result::Result<T, ApiError>;

#[derive(Debug, Clone)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    code: Option<String>,
    extra: Map<String, Value>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: None,
            extra: Map::new(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
    pub fn gone(message: impl Into<String>) -> Self {
        Self::new(StatusCode::GONE, message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message)
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_field(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra.insert(key.into(), value);
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }

    /// Convenience so handler modules do not need `IntoResponse` in scope.
    pub fn into_response(self) -> axum::response::Response {
        <Self as IntoResponse>::into_response(self)
    }

    /// Body used by every failure response.
    pub fn body(&self) -> Value {
        let mut map = Map::new();
        map.insert("error".into(), Value::String(self.message.clone()));
        if let Some(code) = &self.code {
            map.insert("code".into(), Value::String(code.clone()));
        }
        for (key, value) in &self.extra {
            map.insert(key.clone(), value.clone());
        }
        Value::Object(map)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        // 5xx messages are logged, exactly like the Node `console.error` calls,
        // so an operational failure is never silently swallowed.
        if status.is_server_error() {
            tracing::error!(status = status.as_u16(), error = %self.message, "accounts handler failed");
        } else {
            tracing::debug!(status = status.as_u16(), error = %self.message, "accounts handler rejected");
        }
        (status, axum::Json(self.body())).into_response()
    }
}

/// Random 500 for an unexpected internal failure, with the detail logged.
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        ApiError::internal(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_matches_node_error_shape() {
        let error = ApiError::bad_request("Enter a valid wallet address.");
        assert_eq!(
            error.body(),
            serde_json::json!({ "error": "Enter a valid wallet address." })
        );
    }

    #[test]
    fn code_and_extra_fields_are_merged() {
        let error = ApiError::too_many_requests("wait")
            .with_code("invalid_token")
            .with_field("retryAfterSec", serde_json::json!(42));
        assert_eq!(
            error.body(),
            serde_json::json!({ "error": "wait", "code": "invalid_token", "retryAfterSec": 42 })
        );
    }
}
