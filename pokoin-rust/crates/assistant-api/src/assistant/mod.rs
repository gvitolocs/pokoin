//! Assistant route crate: `/api/pokoin-assistant` (POST) and
//! `/api/trainingai-card-classify` (POST/OPTIONS).

pub mod classify;
pub mod context;
pub mod external;
pub mod grounding;
pub mod handler;
pub mod intent;
pub mod text;

use axum::Router;
use pokoin_api_common::RouteState;

/// Routes owned by this module (paths carry the `/api` prefix). The body
/// limit mirrors the 10 MiB cap the Node runtime applied (`JSON_LIMIT_BYTES`).
pub fn routes() -> Router<RouteState> {
    use axum::extract::DefaultBodyLimit;
    Router::new()
        .route(
            "/api/pokoin-assistant",
            axum::routing::any(handler::pokoin_assistant),
        )
        .route(
            "/api/trainingai-card-classify",
            axum::routing::any(classify::trainingai_card_classify),
        )
        .layer(DefaultBodyLimit::max(
            pokoin_api_common::http::JSON_LIMIT_BYTES,
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    fn test_state() -> RouteState {
        static STATE: std::sync::OnceLock<RouteState> = std::sync::OnceLock::new();
        STATE
            .get_or_init(|| {
                let pool = PgPoolOptions::new()
                    .max_connections(1)
                    .connect_lazy("postgres://x@127.0.0.1:1/x")
                    .expect("lazy pool");
                RouteState::new(
                    pokoin_api_common::ApiState::new(pool.clone(), pool, None, 1),
                    pokoin_accounts::DomainState::default(),
                )
            })
            .clone()
    }

    fn app() -> axum::Router {
        routes().with_state(test_state())
    }

    async fn call(
        method: &str,
        uri: &str,
        body: &str,
        content_type: Option<&str>,
    ) -> (StatusCode, String, axum::http::HeaderMap) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(content_type) = content_type {
            builder = builder.header("content-type", content_type);
        }
        let response = app()
            .oneshot(builder.body(Body::from(body.to_owned())).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("body");
        (
            status,
            String::from_utf8_lossy(&bytes).into_owned(),
            headers,
        )
    }

    #[tokio::test]
    async fn assistant_answers_post_and_405s_others() {
        let (status, body, _) = call(
            "POST",
            "/api/pokoin-assistant",
            "{}",
            Some("application/json"),
        )
        .await;
        // Empty body: `message.length < 2` -> the Node 400.
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"error":"Write a message for Pokontact."}"#);
        let (status, body, headers) = call("GET", "/api/pokoin-assistant", "", None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(headers.get("allow").expect("allow header"), "POST");
        assert_eq!(body, r#"{"error":"Method not allowed."}"#);
        let (status, _, _) = call("PUT", "/api/pokoin-assistant", "", None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn assistant_rate_limit_returns_429_after_twenty() {
        let ip = format!("10.9.9.{}", std::process::id());
        let mut last = (StatusCode::OK, String::new());
        for index in 0..25 {
            let request = Request::builder()
                .method("POST")
                .uri("/api/pokoin-assistant")
                .header("content-type", "application/json")
                .header("x-forwarded-for", ip.as_str());
            let response = app()
                .oneshot(
                    request
                        .body(Body::from(r#"{"message":"hi"}"#))
                        .expect("request"),
                )
                .await
                .expect("response");
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .expect("body");
            last = (status, String::from_utf8_lossy(&bytes).into_owned());
            if index < 20 {
                assert_ne!(
                    status,
                    StatusCode::TOO_MANY_REQUESTS,
                    "request {index} limited early"
                );
            }
        }
        assert_eq!(last.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(last.1, r#"{"error":"Too many Pokontact messages."}"#);
    }

    #[tokio::test]
    async fn classify_answers_options_post_and_405() {
        let (status, body, headers) =
            call("OPTIONS", "/api/trainingai-card-classify", "", None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(body.is_empty());
        assert_eq!(
            headers.get("access-control-allow-origin").expect("cors"),
            "*"
        );
        assert_eq!(
            headers
                .get("access-control-allow-headers")
                .expect("cors headers"),
            "Content-Type, Authorization, X-TrainingAI-Token"
        );
        assert_eq!(
            headers.get("access-control-max-age").expect("max age"),
            "86400"
        );
        // `{}` has no usable image: the Node 400 fires before the classifier
        // configuration check.
        let (status, body, headers) = call(
            "POST",
            "/api/trainingai-card-classify",
            "{}",
            Some("application/json"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"ok":false,"error":"imageBase64 is required."}"#);
        assert_eq!(
            headers.get("access-control-allow-origin").expect("cors"),
            "*"
        );
        let (status, body, headers) = call("GET", "/api/trainingai-card-classify", "", None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(headers.get("allow").expect("allow"), "POST, OPTIONS");
        assert_eq!(body, r#"{"error":"Method not allowed."}"#);
    }

    #[tokio::test]
    async fn classify_unconfigured_classifier_is_503() {
        // A decodable image reaches the classifier configuration check.
        let (status, body, _) = call(
            "POST",
            "/api/trainingai-card-classify",
            r#"{"imageBase64": "aGVsbG8="}"#,
            Some("application/json"),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            r#"{"ok":false,"error":"TRAININGAI_CLASSIFIER_URL is not configured.","setupRequired":true}"#
        );
    }

    #[tokio::test]
    async fn classify_requires_image_base64() {
        // An empty imageBase64 fails before the classifier configuration check.
        let (status, body, _) = call(
            "POST",
            "/api/trainingai-card-classify",
            r#"{"imageBase64": ""}"#,
            Some("application/json"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"ok":false,"error":"imageBase64 is required."}"#);
    }

    #[tokio::test]
    async fn classify_validates_multipart_size() {
        let oversized: Vec<u8> = vec![b'a'; (super::classify::max_image_bytes() as usize) + 1];
        let (status, body, _) = call(
            "POST",
            "/api/trainingai-card-classify",
            std::str::from_utf8(&oversized).expect("ascii"),
            Some("multipart/form-data; boundary=x"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            format!(
                r#"{{"ok":false,"error":"Multipart image request must be smaller than {} bytes."}}"#,
                super::classify::max_image_bytes()
            )
        );
    }
}
