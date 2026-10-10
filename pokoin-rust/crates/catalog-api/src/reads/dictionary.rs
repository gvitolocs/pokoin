//! `GET /api/dictionary` — the versioned, append-only numeric code tables the
//! compact (`c1`) encoding codes against.
//!
//! The body is static: it is built from `pokoin_api_common::compact::dict`, not
//! from the database, so the route never touches a pool and can be cached for a
//! long time.
//!
//! Caching has two modes, because "append-only" and "immutable" are not the
//! same promise:
//!
//! - `GET /api/dictionary` — the *current* dictionary, whatever that is. It can
//!   gain entries, so it is revalidated: a short `max-age`, a long
//!   `s-maxage`/`stale-while-revalidate`, and an `ETag` so a revalidation is a
//!   304 rather than a re-download.
//! - `GET /api/dictionary?v=<version>` — a pinned version. The tables of a
//!   given version can never change (entries are only appended, under a new
//!   version), so that response is genuinely `immutable`. A client that pins
//!   the version a `c1` payload declared gets one request, ever.
//!
//! A `?v=` that is not the current version is a 409 rather than a wrong body:
//! old versions are not retained as separate documents, and silently answering
//! with the current tables would defeat the point of pinning.

use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::compact::dict;
use pokoin_api_common::http;
use serde_json::json;

use super::util;

/// Revalidated caching for the unpinned document.
const CACHE_CURRENT: &str = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

/// A pinned version can never change its bytes.
const CACHE_PINNED: &str = "public, max-age=31536000, s-maxage=31536000, immutable";

pub async fn handler(method: Method, headers: HeaderMap, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    let pinned = q.search_param("v").map(str::trim).filter(|v| !v.is_empty());

    if let Some(pinned) = pinned {
        if pinned != dict::VERSION {
            return http::json_with(
                StatusCode::CONFLICT,
                json!({
                    "error": "Unknown dictionary version.",
                    "requested": pinned,
                    "version": dict::VERSION,
                }),
                &cors_with("no-store"),
            );
        }
    }

    let etag = etag();
    let cache_control = if pinned.is_some() {
        CACHE_PINNED
    } else {
        CACHE_CURRENT
    };

    if if_none_match_has(&headers, &etag) {
        let mut headers = cors_with(cache_control);
        headers.push(("etag", &etag));
        return http::raw(
            StatusCode::NOT_MODIFIED,
            "application/json; charset=utf-8",
            axum::body::Body::empty(),
            &headers,
        );
    }

    let mut response_headers = cors_with(cache_control);
    response_headers.push(("etag", &etag));
    http::json_with(StatusCode::OK, dict::document(), &response_headers)
}

/// A strong validator: the version pins the bytes, because entries are only
/// ever appended under a new version.
fn etag() -> String {
    format!("\"c1-dict-{}\"", dict::VERSION)
}

fn cors_with<'a>(cache_control: &'a str) -> Vec<(&'a str, &'a str)> {
    let mut headers: Vec<(&str, &str)> = http::READ_CORS.to_vec();
    headers.push(("cache-control", cache_control));
    headers
}

/// `If-None-Match` listing this entity tag (or `*`). Weak comparison, which is
/// what a cache revalidation of a GET is allowed to use.
fn if_none_match_has(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|candidate| {
            candidate == "*" || candidate.trim_start_matches("W/").trim() == etag
        })
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    async fn get(uri: &str, if_none_match: Option<&str>) -> (StatusCode, HeaderMap, Value) {
        let router = axum::Router::new().route("/api/dictionary", axum::routing::any(handler));
        let mut request = Request::builder().uri(uri);
        if let Some(value) = if_none_match {
            request = request.header(header::IF_NONE_MATCH, value);
        }
        let response = router
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, body)
    }

    #[tokio::test]
    async fn serves_the_tables_with_an_etag() {
        let (status, headers, body) = get("/api/dictionary", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["version"], json!(dict::VERSION));
        assert_eq!(body["codeBase"], json!(1));
        assert_eq!(body["tables"]["languages"][0], json!("EN"));
        assert_eq!(body["urlPrefixes"][0], json!("https://cdn.pokoin.com/"));
        assert_eq!(headers["etag"], format!("\"c1-dict-{}\"", dict::VERSION));
        assert_eq!(headers["cache-control"], CACHE_CURRENT);
        assert_eq!(headers["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn a_pinned_version_is_immutable() {
        let (status, headers, _) =
            get(&format!("/api/dictionary?v={}", dict::VERSION), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["cache-control"], CACHE_PINNED);
    }

    #[tokio::test]
    async fn an_unknown_pinned_version_is_a_conflict() {
        let (status, _, body) = get("/api/dictionary?v=0", None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["version"], json!(dict::VERSION));
        assert_eq!(body["requested"], json!("0"));
    }

    #[tokio::test]
    async fn a_matching_etag_is_a_304() {
        let etag = format!("\"c1-dict-{}\"", dict::VERSION);
        for value in [etag.as_str(), "*", &format!("W/{etag}"), &format!("\"other\", {etag}")] {
            let (status, headers, _) = get("/api/dictionary", Some(value)).await;
            assert_eq!(status, StatusCode::NOT_MODIFIED, "{value}");
            assert_eq!(headers["etag"], etag);
        }
        let (status, _, _) = get("/api/dictionary", Some("\"c1-dict-other\"")).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn only_get_is_allowed() {
        let router = axum::Router::new().route("/api/dictionary", axum::routing::any(handler));
        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/dictionary")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers()["allow"], "GET");
    }
}
