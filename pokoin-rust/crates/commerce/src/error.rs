//! HTTP error type shared by every commerce handler.
//!
//! Mirrors the Node handlers: `{ error, code?, meta? }` with the same status
//! codes the reference handlers set on `error.statusCode`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub code: Option<String>,
    pub meta: Option<Value>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: None,
            meta: None,
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

    pub fn method_not_allowed(allow: &str) -> Self {
        Self {
            status: StatusCode::METHOD_NOT_ALLOWED,
            message: "Method not allowed.".into(),
            code: None,
            meta: Some(json!({ "allow": allow })),
        }
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_meta(mut self, meta: Value) -> Self {
        self.meta = Some(meta);
        self
    }

    pub fn body(&self) -> Value {
        let mut body = json!({ "error": self.message });
        if let Some(code) = &self.code {
            body["code"] = Value::String(code.clone());
        }
        if let Some(meta) = &self.meta {
            body["meta"] = meta.clone();
        }
        body
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.status.as_u16(), self.message)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body())).into_response()
    }
}

/// Storage failures collapse to `500` unless the store already classified them.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("cache error: {0}")]
    Cache(String),
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("insufficient balance")]
    Insufficient,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("{0}")]
    Invalid(String),
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "commerce database error");
        ApiError::internal("Commerce store failed.")
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Conflict(message) => ApiError::conflict(message),
            StoreError::NotFound(message) => ApiError::not_found(message),
            StoreError::Insufficient => ApiError::bad_request("Your account balance is too low."),
            StoreError::Forbidden(message) => ApiError::forbidden(message),
            StoreError::Invalid(message) => ApiError::bad_request(message),
            StoreError::Cache(message) => ApiError::unavailable(message),
            StoreError::Upstream(message) => ApiError::new(StatusCode::BAD_GATEWAY, message),
            StoreError::Database(error) => {
                tracing::error!(%error, "commerce store error");
                ApiError::internal("Commerce store failed.")
            }
        }
    }
}
