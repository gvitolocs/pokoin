//! Handler panics answer `500` instead of unwinding out of the router.
//!
//! An unwound request takes down its connection task, and anything the task
//! held with it: on 2026-10-10 a sort-comparator panic in
//! `/api/searchbar-token-predict` left the edge's coalesced flight for that URL
//! pending, and every later request for it hung until the watchdog restarted
//! the API.

use std::{any::Any, panic::AssertUnwindSafe};

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use futures_util::FutureExt;

/// Middleware: runs the rest of the stack under `catch_unwind`, logs the
/// panic with its route and answers [`panic_response`].
pub async fn catch_panic(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    match AssertUnwindSafe(next.run(req)).catch_unwind().await {
        Ok(response) => response,
        Err(payload) => {
            tracing::error!(%method, %path, panic = panic_message(payload.as_ref()), "handler panicked");
            panic_response()
        }
    }
}

/// The `&str` / `String` a `panic!` carries.
pub fn panic_message(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

/// `500` JSON with `no-store`, so neither the edge nor Cloudflare keeps it.
pub fn panic_response() -> Response {
    let mut response = Response::new(Body::from(r#"{"error":"Internal server error."}"#));
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, routing::get, Router};
    use tower::ServiceExt;

    async fn boom() -> &'static str {
        panic!("user-provided comparison function does not correctly implement a total order")
    }

    #[tokio::test]
    async fn panics_become_a_no_store_500() {
        let app = Router::new()
            .route("/boom", get(boom))
            .route("/ok", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(catch_panic));
        let request = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();
        let response = app.clone().oneshot(request("/boom")).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], br#"{"error":"Internal server error."}"#);
        let response = app.oneshot(request("/ok")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn panic_message_reads_str_and_string_payloads() {
        let payload: Box<dyn Any + Send> = Box::new("static");
        assert_eq!(panic_message(payload.as_ref()), "static");
        let payload: Box<dyn Any + Send> = Box::new(format!("formatted {}", 1));
        assert_eq!(panic_message(payload.as_ref()), "formatted 1");
        let payload: Box<dyn Any + Send> = Box::new(7_u8);
        assert_eq!(panic_message(payload.as_ref()), "non-string panic payload");
    }
}
