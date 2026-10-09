//! Route handlers. One module per route family.

pub mod addresses;
pub mod cart;
pub mod crypto;
pub mod listings;
pub mod orders;
pub mod seller;
pub mod stripe;
pub mod wallet;
pub mod earn_pkn;

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;

/// `res.status(200).json(body)` with private caching, like the Node handlers.
pub fn private_json(body: Value) -> Response {
    let mut response = (StatusCode::OK, Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

pub fn public_json(body: Value, max_age_seconds: u32) -> Response {
    let mut response = (StatusCode::OK, Json(body)).into_response();
    if let Ok(value) = HeaderValue::from_str(&format!(
        "public, max-age={max_age_seconds}, stale-while-revalidate=600"
    )) {
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    response
}

pub fn created_json(body: Value) -> Response {
    let mut response = (StatusCode::CREATED, Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

pub fn empty_no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

/// Read a request body as an object, defaulting to `{}` like `req.body || {}`.
pub fn body_object(body: &Value) -> &serde_json::Map<String, Value> {
    static EMPTY: std::sync::OnceLock<serde_json::Map<String, Value>> = std::sync::OnceLock::new();
    body.as_object()
        .unwrap_or_else(|| EMPTY.get_or_init(serde_json::Map::new))
}

pub fn text_field(body: &Value, keys: &[&str], max: usize) -> String {
    for key in keys {
        if let Some(value) = body.get(*key) {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Number(number) => number.to_string(),
                Value::Bool(flag) => flag.to_string(),
                _ => continue,
            };
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.chars().take(max).collect();
            }
        }
    }
    String::new()
}

pub fn bool_field(body: &Value, key: &str) -> Option<bool> {
    match body.get(key) {
        Some(Value::Bool(flag)) => Some(*flag),
        Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

pub fn number_field(body: &Value, key: &str) -> Option<f64> {
    crate::domain::js_number(body.get(key))
}

pub fn uuid_field(body: &Value, keys: &[&str]) -> Option<String> {
    let text = text_field(body, keys, 80);
    if uuid::Uuid::parse_str(&text).is_ok() {
        Some(text)
    } else {
        None
    }
}

/// Listing ids are UUIDs in `marketplace_user_listings`.
pub fn clean_listing_id(value: &str) -> String {
    let text = value.trim();
    let parsed = uuid::Uuid::parse_str(text).ok();
    match parsed {
        Some(uuid) => uuid.to_string(),
        None => String::new(),
    }
}

/// JSON body parse failures become the same 400 the Node handlers produce.
pub fn parse_json_body(bytes: &[u8]) -> Result<Value, ApiError> {
    if bytes.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("Invalid JSON body.").with_code("invalid_json"))
}

/// Public auth responses expose verifier messages without internal codes.
pub struct PublicAuthedUser(pub crate::auth::Claims);
impl axum::extract::FromRequestParts<crate::state::DomainState> for PublicAuthedUser {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &crate::state::DomainState) -> Result<Self, Self::Rejection> {
        crate::state::AuthedUser::from_request_parts(parts, state).await
            .map(|user| Self(user.0))
            .map_err(|mut error| { error.code = None; error })
    }
}
/// Cart auth and failures carry private caching too.
pub struct CartAuthedUser(pub crate::auth::Claims);
impl axum::extract::FromRequestParts<crate::state::DomainState> for CartAuthedUser {
    type Rejection = Response;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &crate::state::DomainState) -> Result<Self, Self::Rejection> {
        PublicAuthedUser::from_request_parts(parts, state).await
            .map(|user| Self(user.0))
            .map_err(|error| {
                let mut response = error.into_response();
                response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
                response
            })
    }
}
