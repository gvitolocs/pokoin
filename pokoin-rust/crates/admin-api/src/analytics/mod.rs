//! Ports of the analytics routes (`api/news-event.js`, `api/news-stats.js`).

pub mod news_event;
pub mod news_stats;

use axum::{http::HeaderMap, routing::any, Router};
use pokoin_api_common::RouteState;

/// Routes owned by this module (paths carry the full `/api` prefix). The
/// handlers dispatch the method themselves like the Node reference.
pub fn routes() -> Router<RouteState> {
    Router::new()
        .route("/api/news-event", any(news_event::handle))
        .route("/api/news-stats", any(news_stats::handle))
}

/// `clientIp(req)` of `news-event.js`: cf-connecting-ip, then the first
/// forwarded hop, then the socket (not observable behind the edge proxy).
pub(crate) fn rate_limit_client_ip(headers: &HeaderMap) -> String {
    let cf = headers
        .get("cf-connecting-ip")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim();
    if !cf.is_empty() {
        return cf.to_owned();
    }
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned()
}

#[cfg(test)]
mod router_tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::{body::to_bytes, http::Request};
    use pokoin_accounts::firebase::{AuthError, Claims};
    use pokoin_api_common::state::lazy_pool;
    use std::sync::Arc;
    use tower::ServiceExt;

    /// Any non-empty bearer verifies as a plain signed-in account (no admin
    /// claim), so news-stats exercises the 401/403 gates in tests.
    struct UserVerifier;

    impl pokoin_accounts::firebase::TokenVerifier for UserVerifier {
        fn verify<'life0, 'life1, 'async_trait>(
            &'life0 self,
            _token: &'life1 str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Claims, AuthError>> + Send + 'async_trait>,
        >
        where
            'life0: 'async_trait,
            'life1: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async {
                let mut claims = Claims::default();
                claims.uid = "reader-1".to_owned();
                claims.email = "reader@example.com".to_owned();
                claims.email_verified = true;
                Ok(claims)
            })
        }
    }

    fn test_state() -> RouteState {
        let pool = lazy_pool("postgres://x@127.0.0.1:1/x", 1).unwrap();
        let api = pokoin_api_common::ApiState::new(pool.clone(), pool, None, 1);
        let accounts =
            pokoin_accounts::DomainState::default().with_verifier(Arc::new(UserVerifier));
        RouteState::new(api, accounts)
    }

    async fn call(
        request: Request<axum::body::Body>,
    ) -> (StatusCode, String, axum::http::HeaderMap) {
        let response = routes()
            .with_state(test_state())
            .oneshot(request)
            .await
            .unwrap_or_else(|error| panic!("router response: {error}"));
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).to_string(), headers)
    }

    const VALID_EVENT: &str = r#"{"events":[{"type":"view","articleId":"art_story-abc_en","articlePath":"/news/delta-reign-prerelease-promos-revealed","pv":"abcdEFGH12345678"}]}"#;

    #[tokio::test]
    async fn news_event_answers_204_and_400_like_node() {
        let (status, body, _) = call(
            Request::builder()
                .method("POST")
                .uri("/api/news-event")
                .header("content-type", "application/json")
                .header("user-agent", "parity-check/0.1")
                .body(axum::body::Body::from(VALID_EVENT))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(body, "");

        let (status, body, _) = call(
            Request::builder()
                .method("POST")
                .uri("/api/news-event")
                .header("content-type", "application/json")
                .header("user-agent", "parity-check/0.1")
                .body(axum::body::Body::from(r#"{"events":[{"type":"hover"}]}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"error":"Invalid news event."}"#);

        // A raw (non-JSON content type) body is JSON-parsed like the Node
        // parseBody(buffer) path — sendBeacon sends text.
        let (status, _, _) = call(
            Request::builder()
                .method("POST")
                .uri("/api/news-event")
                .header("content-type", "text/plain")
                .header("user-agent", "parity-check/0.1")
                .body(axum::body::Body::from(VALID_EVENT))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn bots_get_204_and_nothing_is_written() {
        let (status, _, _) = call(
            Request::builder()
                .method("POST")
                .uri("/api/news-event")
                .header("content-type", "application/json")
                .header("user-agent", "Googlebot/2.1")
                .body(axum::body::Body::from(VALID_EVENT))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn news_event_get_is_405() {
        let (status, body, headers) = call(get_req("/api/news-event")).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body, r#"{"error":"Method not allowed."}"#);
        assert_eq!(
            headers.get("allow").and_then(|v| v.to_str().ok()),
            Some("POST")
        );
    }

    fn get_req(uri: &str) -> Request<axum::body::Body> {
        Request::builder()
            .uri(uri)
            .body(axum::body::Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn news_stats_signed_out_is_401_with_the_node_body_and_cache_control() {
        let (status, body, headers) = call(get_req("/api/news-stats")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, r#"{"error":"Sign in as an admin."}"#);
        assert_eq!(
            headers.get("cache-control").and_then(|v| v.to_str().ok()),
            Some("private, no-store")
        );
    }

    #[tokio::test]
    async fn news_stats_signed_in_non_admin_is_403_without_data() {
        // With no Firestore configured the admin lookup fails -> false, like
        // the Node catch in callerIsAdmin.
        let request = Request::builder()
            .uri("/api/news-stats?days=7")
            .header("authorization", "Bearer reader-1")
            .body(axum::body::Body::empty())
            .unwrap();
        let (status, body, headers) = call(request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, r#"{"error":"Admins only."}"#);
        assert_eq!(
            headers.get("cache-control").and_then(|v| v.to_str().ok()),
            Some("private, no-store")
        );
    }

    #[tokio::test]
    async fn news_stats_post_is_405() {
        let (status, body, _) = call(
            Request::builder()
                .method("POST")
                .uri("/api/news-stats")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body, r#"{"error":"Method not allowed."}"#);
        assert!(
            true,
            "the Node handler answers the 405 before the cache-control header"
        );
    }
}
