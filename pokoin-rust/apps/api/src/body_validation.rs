//! Runtime body validation precedes handler authentication, as in Node.
use axum::{body::{to_bytes, Body}, extract::Request, middleware::Next, response::Response};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::sync::OnceLock;
use pokoin_api_common::http;

fn route_body_mode(path: &str) -> Option<bool> {
    static MANIFEST: OnceLock<Vec<Value>> = OnceLock::new();
    let routes = MANIFEST.get_or_init(|| serde_json::from_str(include_str!("../fixtures/route-manifest.json")).unwrap_or_default());
    routes.iter().find(|route| {
        let Some(pattern) = route["path"].as_str() else { return false };
        let a: Vec<_> = pattern.trim_matches('/').split('/').collect();
        let b: Vec<_> = path.trim_matches('/').split('/').collect();
        a.len() == b.len() && a.iter().zip(&b).all(|(part, value)| {
            (part.starts_with(':') && !value.is_empty()) || part == value
        })
    }).map(|route| route["rawBody"].as_bool().unwrap_or(false))
}

pub async fn validate(req: Request, next: Next) -> Response {
    let Some(raw) = route_body_mode(req.uri().path()) else { return next.run(req).await };
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, http::JSON_LIMIT_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return http::json(StatusCode::PAYLOAD_TOO_LARGE, json!({"error":"Request body too large."})),
    };
    if !raw {
        if let Err(response) = http::parse_body(&parts.headers, &bytes) { return response }
    }
    next.run(Request::from_parts(parts, Body::from(bytes))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::any};
    use tower::ServiceExt;

    #[tokio::test]
    async fn invalid_json_is_rejected_before_auth_on_a_known_route() {
        let app = Router::new().route("/api/marketplace-listings", any(|| async { http::json(StatusCode::UNAUTHORIZED,json!({"error":"Missing Pokoin bearer token."})) }))
            .layer(axum::middleware::from_fn(validate));
        for (body, status) in [("{bad",400), ("{}",401), ("   ",401)] {
            let request = Request::builder().method("POST").uri("/api/marketplace-listings").header("content-type","application/json").body(Body::from(body)).unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status().as_u16(),status);
            if status == 400 {
                let body = to_bytes(response.into_body(),1024).await.unwrap();
                assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(),json!({"error":"Invalid JSON request body."}));
            }
        }
    }
    #[test]
    fn manifest_matches_dynamic_routes_and_preserves_raw_payloads() {
        assert_eq!(route_body_mode("/api/marketplace-listings"),Some(false));
        assert_eq!(route_body_mode("/api/stripe-webhook"),Some(true));
        assert_eq!(route_body_mode("/api/cardtrader-webhook/uid"),Some(true));
        assert_eq!(route_body_mode("/api/unknown"),None);
    }
    #[tokio::test]
    async fn raw_webhook_payload_is_delivered_unchanged() {
        let app = Router::new().route("/api/stripe-webhook",any(|body: axum::body::Bytes| async move { body }))
            .layer(axum::middleware::from_fn(validate));
        let response = app.oneshot(Request::builder().method("POST").uri("/api/stripe-webhook").header("content-type","application/json").body(Body::from("{bad")).unwrap()).await.unwrap();
        assert_eq!(response.status(),StatusCode::OK);
        assert_eq!(to_bytes(response.into_body(),1024).await.unwrap(),"{bad");
    }
}
