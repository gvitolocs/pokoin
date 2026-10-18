//! HTTP caching glue around the routers: validators, compact negotiation at
//! the edge, and the `Server-Timing` of an edge answer.
//!
//! - Every public, cacheable `GET /api/*` 200 gets a strong `ETag` (a hash of
//!   the body) and answers `304` to a matching `If-None-Match`. The header is
//!   taken off the request first, so the edge micro-cache always stores the
//!   full 200 and a revalidation is answered from that entry.
//! - The edge and Cloudflare key their caches on the URL only, so `c1` is
//!   chosen by `?format=` alone there: a request that asks for it only with
//!   `Accept` is answered as plain JSON, and the two representations can never
//!   share an entry.

use std::time::Instant;

use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::Response,
};
use pokoin_api_common::compact::Wanted;
use pokoin_api_common::http::Query;

/// Bodies above this are sent without a validator instead of being buffered.
const ETAG_MAX_BYTES: usize = 8 * 1024 * 1024;

fn api_path(path: &str) -> bool {
    path.starts_with("/api/")
}

/// FNV-1a 64 over the body, with its length: cheap on the Pi (no SHA
/// extensions on a Cortex-A72) and identical on every origin for the same bytes.
pub fn etag_of(body: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in body {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("\"{hash:016x}-{:x}\"", body.len())
}

/// `If-None-Match` matches `etag` (weak comparison, list or `*`).
pub fn none_match(if_none_match: &str, etag: &str) -> bool {
    let strong = |tag: &str| tag.trim().trim_start_matches("W/").to_owned();
    let wanted = strong(etag);
    if_none_match.split(',').any(|candidate| candidate.trim() == "*" || strong(candidate) == wanted)
}

fn publicly_cacheable(headers: &HeaderMap) -> bool {
    let cc = headers.get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let has = |word: &str| cc.split(',').any(|part| part.trim() == word);
    has("public") && !has("no-store") && !has("private")
}

/// Add the validator to a cacheable 200 and turn it into a 304 when the
/// client already holds that body.
async fn validate(response: Response, if_none_match: Option<HeaderValue>) -> Response {
    if response.status() != StatusCode::OK || !publicly_cacheable(response.headers()) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let etag = match parts.headers.get(header::ETAG).and_then(|v| v.to_str().ok()) {
        Some(etag) => (etag.to_owned(), body),
        None => {
            // Only bodies of a known, bounded size are buffered; a stream or a
            // large body goes out untouched, without a validator.
            let known = axum::body::HttpBody::size_hint(&body).exact();
            if !known.is_some_and(|n| n as usize <= ETAG_MAX_BYTES) {
                return Response::from_parts(parts, body);
            }
            let Ok(bytes) = to_bytes(body, ETAG_MAX_BYTES).await else {
                // Unreachable for an exact size under the cap; never a half body.
                return StatusCode::INTERNAL_SERVER_ERROR.into_response_empty();
            };
            let etag = etag_of(&bytes);
            if let Ok(value) = HeaderValue::from_str(&etag) {
                parts.headers.insert(header::ETAG, value);
            }
            (etag, Body::from(bytes))
        }
    };
    let matched = if_none_match.as_ref().and_then(|v| v.to_str().ok()).is_some_and(|inm| none_match(inm, &etag.0));
    if !matched {
        return Response::from_parts(parts, etag.1);
    }
    parts.status = StatusCode::NOT_MODIFIED;
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::CONTENT_TYPE);
    Response::from_parts(parts, Body::empty())
}

trait EmptyResponse {
    fn into_response_empty(self) -> Response;
}

impl EmptyResponse for StatusCode {
    fn into_response_empty(self) -> Response {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = self;
        response
    }
}

fn take_validator(req: &mut Request) -> Option<HeaderValue> {
    if req.method() != Method::GET || !api_path(req.uri().path()) {
        return None;
    }
    req.headers_mut().remove(header::IF_NONE_MATCH)
}

fn conditional_target(req: &Request) -> bool {
    req.method() == Method::GET && api_path(req.uri().path())
}

/// Outermost layer of the API router.
pub async fn conditional(mut req: Request, next: Next) -> Response {
    if !conditional_target(&req) {
        return next.run(req).await;
    }
    let validator = take_validator(&mut req);
    validate(next.run(req).await, validator).await
}

/// `Accept: application/vnd.pokoin.c1+json` on a URL without `?format=`.
/// Cloudflare keys on the URL and ignores `Vary: Accept`, so answering `c1`
/// there would cache it for every JSON client of that URL; the edge answers
/// plain JSON instead, which every c1 reader passes through.
pub fn c1_only_in_accept(uri: &Uri, headers: &HeaderMap) -> bool {
    let parsed = Query::parse(uri.query().unwrap_or(""));
    parsed.first("format").is_none() && Wanted::from_request(headers, &parsed).c1()
}

/// Wraps the edge router (api.pokoin.com origin).
pub async fn edge(mut req: Request, next: Next) -> Response {
    if !conditional_target(&req) {
        return next.run(req).await;
    }
    let started = Instant::now();
    if c1_only_in_accept(req.uri(), req.headers()) {
        req.headers_mut().insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    }
    let validator = take_validator(&mut req);
    let mut response = validate(next.run(req).await, validator).await;
    // A cached answer replays the origin's stage timings; say what happened here.
    let state = response.headers().get("x-pokoin-edge-cache").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    if !state.is_empty() {
        let dur = started.elapsed().as_secs_f64() * 1000.0;
        let edge = format!("edge;desc=\"{state}\";dur={dur:.1}");
        let value = match (state.as_str(), response.headers().get("server-timing").and_then(|v| v.to_str().ok())) {
            ("MISS" | "BYPASS", Some(origin)) => format!("{origin}, {edge}"),
            _ => edge,
        };
        if let Ok(value) = HeaderValue::from_str(&value) {
            response.headers_mut().insert("server-timing", value);
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use tower::ServiceExt;

    fn app() -> Router {
        Router::new()
            .route("/api/public", get(|| async { ([(header::CACHE_CONTROL, "public, max-age=60")], "{\"ok\":true}") }))
            .route("/api/private", get(|| async { ([(header::CACHE_CONTROL, "private, no-store")], "{}") }))
            .route("/api/big", get(|| async { ([(header::CACHE_CONTROL, "public, max-age=60")], vec![b'x'; ETAG_MAX_BYTES + 1]) }))
            .route("/api/echo", get(|uri: Uri, headers: HeaderMap| async move {
                let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("-").to_owned();
                ([(header::CACHE_CONTROL, "public, max-age=60")], format!("{uri} {accept}"))
            }))
            .layer(axum::middleware::from_fn(edge))
    }

    async fn call(headers: &[(&str, &str)], path: &str) -> Response {
        let mut req = Request::builder().uri(path);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        app().oneshot(req.body(Body::empty()).unwrap()).await.unwrap()
    }

    #[tokio::test]
    async fn a_public_read_gets_a_validator_and_answers_304() {
        let first = call(&[], "/api/public").await;
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
        assert_eq!(etag, etag_of(b"{\"ok\":true}"));
        let again = call(&[("if-none-match", &etag)], "/api/public").await;
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(again.headers()[header::CACHE_CONTROL], "public, max-age=60");
        assert_eq!(again.headers()[header::ETAG].to_str().unwrap(), etag);
        assert!(to_bytes(again.into_body(), 64).await.unwrap().is_empty());
        let weak = call(&[("if-none-match", &format!("\"x\", W/{etag}"))], "/api/public").await;
        assert_eq!(weak.status(), StatusCode::NOT_MODIFIED);
        let other = call(&[("if-none-match", "\"nope\"")], "/api/public").await;
        assert_eq!(other.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_sent_whole_without_a_validator() {
        let response = call(&[], "/api/big").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key(header::ETAG));
        assert_eq!(to_bytes(response.into_body(), usize::MAX).await.unwrap().len(), ETAG_MAX_BYTES + 1);
    }

    #[tokio::test]
    async fn personal_answers_are_left_alone() {
        let response = call(&[("if-none-match", "*")], "/api/private").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key(header::ETAG));
    }

    #[tokio::test]
    async fn only_the_url_chooses_c1_at_the_edge() {
        // Cloudflare caches the bare URL whatever `Vary` says: an `Accept`-only
        // ask must not put a c1 body there.
        let body = |r: Response| async move { String::from_utf8(to_bytes(r.into_body(), 1024).await.unwrap().to_vec()).unwrap() };
        let c1 = [("accept", "application/vnd.pokoin.c1+json")];
        assert_eq!(body(call(&c1, "/api/echo?slug=151").await).await, "/api/echo?slug=151 application/json");
        assert_eq!(body(call(&c1, "/api/echo").await).await, "/api/echo application/json");
        let v2 = [("accept", "application/vnd.pokoin.c1+json; v=2")];
        assert_eq!(body(call(&v2, "/api/echo?slug=151").await).await, "/api/echo?slug=151 application/json");
        assert_eq!(body(call(&c1, "/api/echo?format=c1").await).await, "/api/echo?format=c1 application/vnd.pokoin.c1+json");
        assert_eq!(body(call(&[], "/api/echo?format=c1v2").await).await, "/api/echo?format=c1v2 -");
        assert_eq!(body(call(&[("accept", "*/*")], "/api/echo?slug=151").await).await, "/api/echo?slug=151 */*");
    }
}
