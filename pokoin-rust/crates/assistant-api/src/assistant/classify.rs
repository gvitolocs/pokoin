//! `/api/trainingai-card-classify` — port of `api/trainingai-card-classify.js`
//! (pure helpers + the axum handler with its own CORS headers).

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine as _;
use serde_json::{json, Map, Value};

use pokoin_api_common::http::{json_with, parse_body};
use pokoin_api_common::RouteState;

use crate::assistant::external::{identity_from_headers, limit_best_effort};

const CLASSIFY_CORS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "POST, OPTIONS"),
    (
        "access-control-allow-headers",
        "Content-Type, Authorization, X-TrainingAI-Token",
    ),
    ("access-control-max-age", "86400"),
];

/// `MAX_IMAGE_BYTES`.
pub fn max_image_bytes() -> f64 {
    std::env::var("TRAININGAI_CLASSIFIER_MAX_IMAGE_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(8.0 * 1024.0 * 1024.0)
}

/// `DEFAULT_TIMEOUT_MS`.
pub fn classifier_timeout_ms() -> u64 {
    std::env::var("TRAININGAI_CLASSIFIER_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(120_000.0) as u64
}

/// `configuredSpaceUrl`.
pub fn configured_space_url() -> String {
    let raw = [
        "TRAININGAI_CLASSIFIER_URL",
        "TRAININGAI_HF_SPACE_URL",
        "HF_SPACE_URL",
    ]
    .iter()
    .find_map(|key| std::env::var(key).ok())
    .unwrap_or_default();
    let raw = raw.trim().to_owned();
    raw.trim_end_matches('/').to_owned()
}

/// `configuredPublicEndpoint`.
pub fn configured_public_endpoint() -> String {
    std::env::var("TRAININGAI_PUBLIC_ENDPOINT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://trainingai.pokoin.com/api/classify".to_owned())
        .trim()
        .to_owned()
}

/// `bearerToken`.
pub fn bearer_token() -> String {
    ["TRAININGAI_HF_TOKEN", "HF_TOKEN"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// `cleanTopK`.
pub fn clean_top_k(value: &Value) -> i32 {
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => pokoin_api_common::http::js_number(text),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None, // undefined/null -> NaN -> 3
    };
    match parsed {
        Some(parsed) if parsed.is_finite() => parsed.trunc().clamp(1.0, 10.0) as i32,
        _ => 3,
    }
}

/// `normalizeImageBase64`.
pub fn normalize_image_base64(value: &Value) -> String {
    let raw = crate::assistant::text::js_string(value);
    let raw = raw.trim().to_owned();
    // `/^data:image\/[a-z0-9.+-]+;base64,/i`
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("data:image/") {
        if let Some(position) = lower.find(";base64,") {
            let header = &lower["data:image/".len()..position];
            if !header.is_empty()
                && header.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'.' | b'+' | b'-')
                })
            {
                return raw[position + ";base64,".len()..].to_owned();
            }
        }
    }
    raw
}

fn lenient_base64_engine() -> GeneralPurpose {
    GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
}

/// `decodeImageBase64`: Node `Buffer.from(text, 'base64')` ignores invalid
/// characters, accepts base64url `-`/`_`, does not require padding, and drops
/// a trailing lone character.
pub fn decode_image_base64(value: &Value) -> Result<Vec<u8>, (u16, String)> {
    let normalized = normalize_image_base64(value);
    if normalized.is_empty() {
        return Err((400, "imageBase64 is required.".to_owned()));
    }
    let mut cleaned = String::with_capacity(normalized.len());
    for c in normalized.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_') {
            cleaned.push(match c {
                '-' => '+',
                '_' => '/',
                other => other,
            });
        }
    }
    let mut cleaned = cleaned.trim_end_matches('=').to_owned();
    // A trailing lone character contributes no bytes to Node's decoder.
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    let buffer = lenient_base64_engine().decode(&cleaned).unwrap_or_default();
    let max = max_image_bytes();
    if buffer.is_empty() || buffer.len() as f64 > max {
        return Err((
            400,
            format!(
                "Image must be smaller than {} bytes.",
                crate::assistant::text::js_number_to_string(max)
            ),
        ));
    }
    Ok(buffer)
}

enum ClassifierError {
    /// `{ statusCode, message, details? }` like the JS `error.statusCode`.
    WithStatus(u16, String, Option<Value>),
    Timeout,
}

fn base_classifier_request() -> Result<String, ClassifierError> {
    let base_url = configured_space_url();
    if base_url.is_empty() {
        return Err(ClassifierError::WithStatus(
            503,
            "TRAININGAI_CLASSIFIER_URL is not configured.".to_owned(),
            None,
        ));
    }
    Ok(base_url)
}

async fn read_classifier_response(response: reqwest::Response) -> Result<Value, ClassifierError> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let payload: Value = if text.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).unwrap_or(json!({ "raw": text }))
    };
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| payload.get("detail").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .unwrap_or(&format!("Classifier returned {}.", status.as_u16()))
            .to_owned();
        let code = if status.as_u16() >= 500 {
            502
        } else {
            status.as_u16()
        };
        return Err(ClassifierError::WithStatus(code, message, Some(payload)));
    }
    Ok(payload)
}

/// `postBase64ToClassifier`.
async fn post_base64_to_classifier(
    state: &RouteState,
    image_base64: &str,
    top_k: i32,
) -> Result<Value, ClassifierError> {
    let base_url = base_classifier_request()?;
    let mut request = state
        .api
        .http()
        .post(format!("{base_url}/classify/base64"))
        .header("Content-Type", "application/json");
    let token = bearer_token();
    if !token.is_empty() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let request = request.json(&json!({ "imageBase64": image_base64, "topK": top_k }));
    send_classifier(request).await
}

/// `postMultipartToClassifier`.
async fn post_multipart_to_classifier(
    state: &RouteState,
    body: Bytes,
    content_type: &str,
) -> Result<Value, ClassifierError> {
    let base_url = base_classifier_request()?;
    let mut request = state
        .api
        .http()
        .post(format!("{base_url}/classify"))
        .header("Content-Type", content_type)
        .body(body);
    let token = bearer_token();
    if !token.is_empty() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    send_classifier(request).await
}

async fn send_classifier(request: reqwest::RequestBuilder) -> Result<Value, ClassifierError> {
    let budget = classifier_timeout_ms();
    let future = request.send();
    let response = match tokio::time::timeout(Duration::from_millis(budget), future).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return Err(ClassifierError::WithStatus(500, error.to_string(), None));
        }
        Err(_) => return Err(ClassifierError::Timeout),
    };
    read_classifier_response(response).await
}

fn classifier_error_response(error: ClassifierError) -> Response {
    let (status, message, details) = match error {
        ClassifierError::WithStatus(status, message, details) => (status, message, details),
        ClassifierError::Timeout => (504, "Classifier request timed out.".to_owned(), None),
    };
    let mut body = Map::new();
    body.insert("ok".into(), json!(false));
    body.insert(
        "error".into(),
        json!(if message.is_empty() {
            "Card classification failed.".to_owned()
        } else {
            message
        }),
    );
    if let Some(details) = details {
        body.insert("details".into(), details);
    }
    if status == 503 {
        body.insert("setupRequired".into(), json!(true));
    }
    json_with(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Value::Object(body),
        &CLASSIFY_CORS,
    )
}

/// The `/api/trainingai-card-classify` handler.
pub async fn trainingai_card_classify(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if method == Method::OPTIONS {
        return pokoin_api_common::http::raw(
            StatusCode::NO_CONTENT,
            "text/plain; charset=utf-8",
            axum::body::Body::empty(),
            &CLASSIFY_CORS,
        );
    }
    if method != Method::POST {
        return json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "POST, OPTIONS")],
        );
    }
    let verdict = limit_best_effort(
        &state,
        "trainingai-classify",
        &identity_from_headers(&headers),
        30,
        60,
    )
    .await;
    if !verdict
        .get("allowed")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return json_with(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "ok": false, "error": "Too many classification requests." }),
            &CLASSIFY_CORS,
        );
    }

    let content_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let lowered = content_type.to_lowercase();
    let result = if lowered.contains("multipart/form-data") {
        let parsed = parse_body(&headers, &body)
            .unwrap_or(pokoin_api_common::http::NodeBody::Raw(Bytes::new()));
        let source = match parsed {
            pokoin_api_common::http::NodeBody::Raw(bytes) => bytes,
            _ => Bytes::new(),
        };
        let max = max_image_bytes();
        if source.is_empty() || source.len() as f64 > max {
            return json_with(
                StatusCode::BAD_REQUEST,
                json!({
                    "ok": false,
                    "error": format!(
                        "Multipart image request must be smaller than {} bytes.",
                        crate::assistant::text::js_number_to_string(max)
                    ),
                }),
                &CLASSIFY_CORS,
            );
        }
        post_multipart_to_classifier(&state, source, &content_type).await
    } else {
        let parsed = match parse_body(&headers, &body) {
            Ok(parsed) => parsed,
            Err(response) => return response,
        };
        let body_json = parsed.json();
        // `body.imageBase64 || body.image_base64 || body.image`
        let image = ["imageBase64", "image_base64", "image"]
            .iter()
            .map(|key| body_json.get(*key).cloned().unwrap_or(Value::Null))
            .find(|value| match value {
                Value::String(text) => !text.is_empty(),
                Value::Null | Value::Bool(false) => false,
                Value::Number(number) => number.as_f64() != Some(0.0),
                _ => true,
            })
            .unwrap_or(Value::Null);
        let decoded = match decode_image_base64(&image) {
            Ok(decoded) => decoded,
            Err((status, message)) => {
                return json_with(
                    StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                    json!({ "ok": false, "error": message }),
                    &CLASSIFY_CORS,
                );
            }
        };
        let top_k = clean_top_k(
            &[
                body_json.get("topK").cloned().unwrap_or(Value::Null),
                body_json.get("top_k").cloned().unwrap_or(Value::Null),
            ]
            .into_iter()
            .find(|value| !value.is_null())
            .unwrap_or(Value::Null),
        );
        post_base64_to_classifier(
            &state,
            &base64::engine::general_purpose::STANDARD.encode(decoded),
            top_k,
        )
        .await
    };

    match result {
        Ok(payload) => {
            // `{ok, service, classifier, publicEndpoint, ...payload}` — the
            // spread can override the base keys.
            let mut response = Map::new();
            response.insert("ok".into(), json!(true));
            response.insert("service".into(), json!("pokoin-trainingai-card-classify"));
            response.insert("classifier".into(), json!(configured_space_url()));
            response.insert("publicEndpoint".into(), json!(configured_public_endpoint()));
            if let Some(payload_object) = payload.as_object() {
                for (key, value) in payload_object {
                    response.insert(key.clone(), value.clone());
                }
            }
            json_with(StatusCode::OK, Value::Object(response), &CLASSIFY_CORS)
        }
        Err(error) => classifier_error_response(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_top_k_clamps() {
        assert_eq!(clean_top_k(&Value::Null), 3);
        assert_eq!(clean_top_k(&json!(Value::Null)), 3);
        assert_eq!(clean_top_k(&json!("abc")), 3);
        assert_eq!(clean_top_k(&json!(7)), 7);
        assert_eq!(clean_top_k(&json!(0)), 1);
        assert_eq!(clean_top_k(&json!(99)), 10);
        assert_eq!(clean_top_k(&json!(2.9)), 2);
        assert_eq!(clean_top_k(&json!("5")), 5);
    }

    #[test]
    fn image_base64_normalization_and_decode() {
        assert_eq!(
            normalize_image_base64(&json!("data:image/png;base64,aGk=")),
            "aGk="
        );
        assert_eq!(
            normalize_image_base64(&json!("data:image/svg+xml;base64,aGk=")),
            "aGk="
        );
        assert_eq!(normalize_image_base64(&json!("  aGk= ")), "aGk=");
        assert_eq!(normalize_image_base64(&json!(null)), "");
        assert!(decode_image_base64(&json!("")).is_err());
        assert_eq!(
            decode_image_base64(&json!("")).err().expect("error").1,
            "imageBase64 is required."
        );
        // Node tolerates junk characters (`-` is a base64url digit).
        let decoded = decode_image_base64(&json!("not-base64!!!")).expect("decodes");
        assert_eq!(decoded, [0x9e, 0x8b, 0x7e, 0x6d, 0xab, 0x1e, 0xeb]);
        let decoded = decode_image_base64(&json!("aGVsbG8=")).expect("decodes");
        assert_eq!(decoded, b"hello");
        // base64url is accepted like Node.
        let decoded = decode_image_base64(&json!("aGVsbG8")).expect("decodes");
        assert_eq!(decoded, b"hello");
        // A trailing lone character contributes nothing.
        assert!(decode_image_base64(&json!("n")).is_err());
    }

    #[test]
    fn space_url_config_fallback() {
        std::env::remove_var("TRAININGAI_CLASSIFIER_URL");
        std::env::remove_var("TRAININGAI_HF_SPACE_URL");
        std::env::remove_var("HF_SPACE_URL");
        assert_eq!(configured_space_url(), "");
        std::env::set_var("HF_SPACE_URL", "https://space.example/");
        assert_eq!(configured_space_url(), "https://space.example");
        std::env::remove_var("HF_SPACE_URL");
        assert_eq!(
            configured_public_endpoint(),
            "https://trainingai.pokoin.com/api/classify"
        );
        std::env::set_var("TRAININGAI_PUBLIC_ENDPOINT", "https://custom.example/api");
        assert_eq!(configured_public_endpoint(), "https://custom.example/api");
        std::env::remove_var("TRAININGAI_PUBLIC_ENDPOINT");
    }
}
