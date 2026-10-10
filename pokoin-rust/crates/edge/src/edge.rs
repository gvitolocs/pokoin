//! Public origin of api.pokoin.com / api2.pokoin.com — port of the retired Node `pokoin-api-edge.js`.
//!
//! API paths go to the in-process API router, everything else to the in-process
//! disk CDN (`/card-images/*` is stripped like the old Oracle api2 Caddy site).
//! Public GETs are micro-cached for the API's own s-maxage and coalesced, so a
//! hot or expiring URL is built once, not once per visitor. The Node edge's
//! k3s overflow, rust-routes.json split and shadow comparison are gone: there
//! is one native origin now.

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::Response,
    Router,
};
use regex::Regex;
use tokio::sync::watch;
use tower::ServiceExt;

#[derive(Clone, Debug)]
pub struct EdgeConfig {
    pub seo_dir: PathBuf,
    pub cache_max_bytes: usize,
    pub cache_max_ttl: u64,
    /// Longest a coalesced fetch may run, and a follower may wait for it,
    /// before both answer `504`. Below Cloudflare's 100 s origin timeout.
    pub flight_timeout: Duration,
}

impl EdgeConfig {
    /// `POKOIN_SEO_DIR` (/srv/pokoin/seo), `POKOIN_API_CACHE_MB` (64), `POKOIN_API_CACHE_MAX_TTL` (300),
    /// `POKOIN_API_FLIGHT_TIMEOUT_SECS` (60).
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
            seo_dir: PathBuf::from(env("POKOIN_SEO_DIR").unwrap_or_else(|| "/srv/pokoin/seo".into())),
            cache_max_bytes: env("POKOIN_API_CACHE_MB").and_then(|v| v.parse::<f64>().ok()).map(|mb| (mb * 1024.0 * 1024.0) as usize).unwrap_or(64 * 1024 * 1024),
            cache_max_ttl: env("POKOIN_API_CACHE_MAX_TTL").and_then(|v| v.parse().ok()).unwrap_or(300),
            flight_timeout: Duration::from_secs(env("POKOIN_API_FLIGHT_TIMEOUT_SECS").and_then(|v| v.parse().ok()).filter(|s| *s > 0).unwrap_or(60)),
        }
    }
}

const CACHE_MAX_ENTRY: usize = 2 * 1024 * 1024;
const UNCACHEABLE_MS: u64 = 5 * 60 * 1000;
const HOP_HEADERS: [&str; 5] = ["connection", "keep-alive", "transfer-encoding", "content-length", "date"];
const SITEMAP_FILES: [&str; 4] = ["sitemap.xml", "sitemap-hubs.xml", "sitemap-pokemon.xml", "sitemap-sets.xml"];
const ORIGIN_LABEL: &str = "rust";

/// `rewritePath(pathname)`.
pub fn rewrite_path(pathname: &str) -> String {
    if pathname == "/card-images" || pathname.starts_with("/card-images/") {
        let stripped = &pathname["/card-images".len()..];
        if stripped.is_empty() {
            return "/".into();
        }
        return if stripped.starts_with('/') { stripped.to_owned() } else { format!("/{stripped}") };
    }
    pathname.to_owned()
}

/// `isApiPath(pathname)`.
pub fn is_api_path(pathname: &str) -> bool {
    matches!(
        pathname,
        "/" | "/marketplace" | "/healthz" | "/livez" | "/readyz" | "/api" | "/api/healthz" | "/api/livez" | "/api/readyz"
    ) || (pathname.starts_with("/api/") && pathname != "/api/health")
}

fn sitemap_file(pathname: &str) -> Option<&'static str> {
    let name = pathname.strip_prefix('/').unwrap_or(pathname);
    SITEMAP_FILES.iter().copied().find(|f| *f == name)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CachePolicy {
    pub ttl: u64,
    pub swr: u64,
}

fn cc_num(cc: &str, name: &str) -> Option<u64> {
    static RES: OnceLock<HashMap<&'static str, Regex>> = OnceLock::new();
    let map = RES.get_or_init(|| {
        ["s-maxage", "max-age", "stale-while-revalidate"]
            .into_iter()
            .map(|n| (n, Regex::new(&format!(r"\b{}=(\d+)", regex::escape(n))).expect("valid regex")))
            .collect()
    });
    map.get(name)?.captures(cc)?.get(1)?.as_str().parse().ok()
}

fn word(cc: &str, words: &[&str]) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"[a-z\-]+").expect("valid regex"));
    re.find_iter(cc).any(|m| words.contains(&m.as_str()))
}

/// `cachePolicy(status, headers, maxTtl)`.
pub fn cache_policy(status: StatusCode, headers: &HeaderMap, max_ttl: u64) -> Option<CachePolicy> {
    if status != StatusCode::OK || headers.contains_key(header::SET_COOKIE) {
        return None;
    }
    let cc = headers.get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if !word(&cc, &["public"]) || word(&cc, &["private", "no-store", "no-cache"]) {
        return None;
    }
    let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if ct.contains("text/event-stream") {
        return None;
    }
    let ttl = cc_num(&cc, "s-maxage").or_else(|| cc_num(&cc, "max-age"))?;
    if ttl == 0 {
        return None;
    }
    Some(CachePolicy { ttl: ttl.min(max_ttl), swr: cc_num(&cc, "stale-while-revalidate").unwrap_or(0).min(600) })
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// `cacheKey(req, pathname, search)`: `None` when the request is personal.
pub fn cache_key(method: &Method, headers: &HeaderMap, pathname: &str, search: &str) -> Option<String> {
    if method != Method::GET || pathname == "/api/marketplace-live" {
        return None;
    }
    if headers.contains_key(header::AUTHORIZATION) || headers.contains_key(header::COOKIE) {
        return None;
    }
    Some(format!("{pathname}{search}\n{}\n{}", header_str(headers, "x-pokoin-game"), header_str(headers, "x-pokoin-host")))
}

fn never_storable(headers: &HeaderMap) -> bool {
    let cc = header_str(headers, "cache-control").to_ascii_lowercase();
    !word(&cc, &["public"]) || word(&cc, &["private", "no-store"])
}

/// `browserCors(req)` is the shared `_cors_policy.corsHeaders` since the
/// 2026-10-08 security release.
pub fn browser_cors(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    pokoin_api_common::security::cors_headers(headers)
}

#[derive(Debug)]
struct CacheEntry {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
    stored_at: Instant,
    fresh_until: Instant,
    stale_until: Instant,
}

/// Byte-capped LRU (`ResponseCache`).
#[derive(Default)]
struct ResponseCache {
    max_bytes: usize,
    bytes: usize,
    seq: u64,
    map: HashMap<String, (Arc<CacheEntry>, u64)>,
    order: BTreeMap<u64, String>,
}

impl ResponseCache {
    fn new(max_bytes: usize) -> Self {
        Self { max_bytes, ..Default::default() }
    }

    fn get(&mut self, key: &str) -> Option<Arc<CacheEntry>> {
        let (entry, old) = self.map.get(key).cloned()?;
        self.order.remove(&old);
        self.seq += 1;
        self.order.insert(self.seq, key.to_owned());
        self.map.insert(key.to_owned(), (entry.clone(), self.seq));
        Some(entry)
    }

    fn set(&mut self, key: &str, entry: Arc<CacheEntry>) {
        self.delete(key);
        self.seq += 1;
        self.bytes += entry.body.len();
        self.order.insert(self.seq, key.to_owned());
        self.map.insert(key.to_owned(), (entry, self.seq));
        while self.bytes > self.max_bytes {
            let Some((_, oldest)) = self.order.iter().next().map(|(s, k)| (*s, k.clone())) else {
                break;
            };
            self.delete(&oldest);
        }
    }

    fn delete(&mut self, key: &str) {
        if let Some((entry, seq)) = self.map.remove(key) {
            self.bytes -= entry.body.len();
            self.order.remove(&seq);
        }
    }
}

#[derive(Clone, Debug)]
enum Flight {
    Pending,
    /// Stored response: followers replay it.
    Entry(Arc<CacheEntry>),
    /// The leader's 5xx: followers replay it, nothing is stored.
    Error(Arc<CacheEntry>),
    /// Personal or not storable: each follower forwards its own request.
    Uncacheable,
    /// The leader went away without an answer (client disconnect): elect a new one.
    Abandoned,
    /// No upstream answer (timeout, unreadable body, edge panic): followers send this status.
    Failed(StatusCode),
}

/// The leader's claim on a key in `flights`. Every way out of the leader —
/// `finish`, a timeout, an unwinding panic, the client hanging up — settles
/// the flight, so followers never wait on a key nobody is fetching.
struct FlightGuard {
    edge: Edge,
    key: String,
    tx: Option<watch::Sender<Flight>>,
}

impl FlightGuard {
    fn finish(mut self, outcome: Flight) {
        self.settle(outcome);
    }

    fn settle(&mut self, outcome: Flight) {
        let Some(tx) = self.tx.take() else { return };
        self.edge.inner.flights.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
        let _ = tx.send(outcome);
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        let outcome = if std::thread::panicking() { Flight::Failed(StatusCode::BAD_GATEWAY) } else { Flight::Abandoned };
        self.settle(outcome);
    }
}

enum Role {
    Lead(FlightGuard),
    Follow(watch::Receiver<Flight>),
}

#[derive(Default)]
struct Stats {
    hits: AtomicU64,
    misses: AtomicU64,
    bypass: AtomicU64,
}

struct Inner {
    cfg: EdgeConfig,
    api: Router,
    cdn: Router,
    cache: Mutex<ResponseCache>,
    /// Running fetches by cache key; the sender lives in the leader's [`FlightGuard`].
    flights: Mutex<HashMap<String, watch::Receiver<Flight>>>,
    uncacheable: Mutex<HashMap<String, Instant>>,
    stats: Stats,
}

#[derive(Clone)]
struct Edge {
    inner: Arc<Inner>,
}

/// `edge_router(cfg, api, cdn)`: every path of api.pokoin.com.
pub fn edge_router(cfg: EdgeConfig, api: Router, cdn: Router) -> Router {
    let edge = Edge::new(cfg, api, cdn);
    let stats = edge.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let s = &stats.inner.stats;
            let (hits, misses, bypass) = (s.hits.swap(0, Ordering::Relaxed), s.misses.swap(0, Ordering::Relaxed), s.bypass.swap(0, Ordering::Relaxed));
            if hits + misses + bypass > 0 {
                let (entries, mb) = {
                    let cache = stats.inner.cache.lock().unwrap_or_else(|e| e.into_inner());
                    (cache.map.len(), cache.bytes as f64 / 1_048_576.0)
                };
                tracing::info!(hits, misses, bypass, entries, mb = format!("{mb:.1}"), "pokoin-api-edge minute");
            }
        }
    });
    Router::new().fallback(proxy).with_state(edge)
}

fn with_uri(req: Request, path_and_query: &str) -> Request {
    let (mut parts, body) = req.into_parts();
    if let Ok(uri) = Uri::try_from(path_and_query) {
        parts.uri = uri;
    }
    Request::from_parts(parts, body)
}

/// `withNoindex` + the authoritative CORS merge (`mergeCorsIntoHeaders`).
fn decorate(response: &mut Response, api: bool, request: &HeaderMap) {
    if !api {
        return;
    }
    let headers = response.headers_mut();
    headers.insert(HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex"));
    pokoin_api_common::security::merge_cors(headers, request);
}

async fn proxy(State(edge): State<Edge>, req: Request) -> Response {
    let pathname = rewrite_path(req.uri().path());
    let search = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let api = is_api_path(&pathname);
    let request_headers = if api { req.headers().clone() } else { HeaderMap::new() };
    if api && req.method() == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        for (k, v) in browser_cors(&request_headers) {
            response.headers_mut().insert(k, v);
        }
        return response;
    }
    if let Some(name) = sitemap_file(&pathname) {
        if req.method() == Method::GET || req.method() == Method::HEAD {
            return send_sitemap(&edge.inner.cfg.seo_dir, name, req.method() == Method::HEAD).await;
        }
    }
    let target = format!("{pathname}{search}");
    if !api {
        let req = with_uri(req, &target);
        return edge.inner.cdn.clone().oneshot(req).await.unwrap_or_else(|never| match never {});
    }
    let key = if edge.inner.cfg.cache_max_bytes > 0 && !edge.known_uncacheable(&pathname) {
        cache_key(req.method(), req.headers(), &pathname, &search)
    } else {
        None
    };
    let mut response = match key {
        Some(key) => edge.serve_cacheable(req, key, &pathname, &target).await,
        None => edge.forward_api(req, &target).await,
    };
    decorate(&mut response, true, &request_headers);
    response
}

impl Edge {
    /// The API router is called in-process, so its panics are caught here: a
    /// panic answers `500` (never cached) instead of unwinding through a flight.
    fn new(cfg: EdgeConfig, api: Router, cdn: Router) -> Self {
        Self {
            inner: Arc::new(Inner {
                cache: Mutex::new(ResponseCache::new(cfg.cache_max_bytes)),
                cfg,
                api: api.layer(axum::middleware::from_fn(pokoin_api_common::panic::catch_panic)),
                cdn,
                flights: Mutex::new(HashMap::new()),
                uncacheable: Mutex::new(HashMap::new()),
                stats: Stats::default(),
            }),
        }
    }

    fn known_uncacheable(&self, pathname: &str) -> bool {
        let mut map = self.inner.uncacheable.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(pathname) {
            Some(until) if Instant::now() < *until => true,
            Some(_) => {
                map.remove(pathname);
                false
            }
            None => false,
        }
    }

    fn mark_uncacheable(&self, pathname: &str) {
        let mut map = self.inner.uncacheable.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 500 {
            map.clear();
        }
        map.insert(pathname.to_owned(), Instant::now() + Duration::from_millis(UNCACHEABLE_MS));
    }

    /// Streamed request (writes, personal or uncacheable GETs, SSE).
    async fn forward_api(&self, req: Request, target: &str) -> Response {
        self.inner.stats.bypass.fetch_add(1, Ordering::Relaxed);
        let req = with_uri(req, target);
        let mut response = self.inner.api.clone().oneshot(req).await.unwrap_or_else(|never| match never {});
        response.headers_mut().insert(HeaderName::from_static("x-pokoin-origin"), HeaderValue::from_static(ORIGIN_LABEL));
        response
    }

    async fn serve_cacheable(&self, req: Request, key: String, pathname: &str, target: &str) -> Response {
        let now = Instant::now();
        let hit = self.inner.cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key);
        if let Some(hit) = hit.as_ref() {
            if now < hit.fresh_until {
                self.inner.stats.hits.fetch_add(1, Ordering::Relaxed);
                return send_entry(hit, "HIT");
            }
            if now < hit.stale_until {
                self.inner.stats.hits.fetch_add(1, Ordering::Relaxed);
                // Refresh in the background unless a fetch for this key is already running.
                if let Role::Lead(flight) = self.start_flight(&key) {
                    let (parts, _) = req.into_parts();
                    let request = rebuild(&parts, target);
                    let (me, pathname) = (self.clone(), pathname.to_owned());
                    tokio::spawn(async move {
                        let _ = me.lead(request, flight, &pathname).await;
                    });
                }
                return send_entry(hit, "STALE");
            }
        }
        self.inner.stats.misses.fetch_add(1, Ordering::Relaxed);
        let deadline = tokio::time::Instant::now() + self.inner.cfg.flight_timeout;
        let outcome = loop {
            match self.start_flight(&key) {
                // Leader: fetch, store, answer (or stream an uncacheable answer straight through).
                Role::Lead(flight) => return self.lead(req, flight, pathname).await,
                Role::Follow(rx) => match follow(rx, deadline).await {
                    Flight::Abandoned => continue,
                    outcome => break outcome,
                },
            }
        };
        match outcome {
            Flight::Entry(entry) | Flight::Error(entry) => send_entry(&entry, "COALESCED"),
            Flight::Failed(status) => gateway_error(status),
            Flight::Uncacheable | Flight::Pending | Flight::Abandoned => self.forward_api(req, target).await,
        }
    }

    /// Register a pending flight for `key` (the caller leads it) or join the running one.
    fn start_flight(&self, key: &str) -> Role {
        let mut flights = self.inner.flights.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rx) = flights.get(key) {
            return Role::Follow(rx.clone());
        }
        let (tx, rx) = watch::channel(Flight::Pending);
        flights.insert(key.to_owned(), rx);
        Role::Lead(FlightGuard { edge: self.clone(), key: key.to_owned(), tx: Some(tx) })
    }

    /// One buffered upstream fetch for a cacheable key (`fetchEntry` + `refresh`),
    /// bounded by `flight_timeout`. A background stale refresh drops the answer.
    async fn lead(&self, req: Request, flight: FlightGuard, pathname: &str) -> Response {
        let deadline = tokio::time::Instant::now() + self.inner.cfg.flight_timeout;
        let target = format!("{}{}", pathname, req.uri().query().map(|q| format!("?{q}")).unwrap_or_default());
        let req = with_uri(req, &target);
        let Ok(response) = tokio::time::timeout_at(deadline, self.inner.api.clone().oneshot(req)).await else {
            tracing::warn!(path = pathname, timeout_s = self.inner.cfg.flight_timeout.as_secs(), "edge flight timed out");
            flight.finish(Flight::Failed(StatusCode::GATEWAY_TIMEOUT));
            return gateway_error(StatusCode::GATEWAY_TIMEOUT);
        };
        let response = response.unwrap_or_else(|never| match never {});
        let status = response.status();
        let policy = cache_policy(status, response.headers(), self.inner.cfg.cache_max_ttl);
        if policy.is_none() && !status.is_server_error() {
            // An error says nothing about the path, so only answers mark it uncacheable.
            if status.as_u16() < 400 && never_storable(response.headers()) {
                self.mark_uncacheable(pathname);
            }
            flight.finish(Flight::Uncacheable);
            let mut response = response;
            response.headers_mut().insert(HeaderName::from_static("x-pokoin-origin"), HeaderValue::from_static(ORIGIN_LABEL));
            response.headers_mut().insert(HeaderName::from_static("x-pokoin-edge-cache"), HeaderValue::from_static("BYPASS"));
            return response;
        }
        let (parts, body) = response.into_parts();
        let body = match tokio::time::timeout_at(deadline, to_bytes(body, usize::MAX)).await {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                flight.finish(Flight::Failed(StatusCode::BAD_GATEWAY));
                return gateway_error(StatusCode::BAD_GATEWAY);
            }
            Err(_) => {
                tracing::warn!(path = pathname, timeout_s = self.inner.cfg.flight_timeout.as_secs(), "edge flight body timed out");
                flight.finish(Flight::Failed(StatusCode::GATEWAY_TIMEOUT));
                return gateway_error(StatusCode::GATEWAY_TIMEOUT);
            }
        };
        let mut headers = HeaderMap::new();
        for (name, value) in parts.headers.iter() {
            if !HOP_HEADERS.contains(&name.as_str()) {
                headers.append(name.clone(), value.clone());
            }
        }
        headers.insert(HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex"));
        let now = Instant::now();
        let Some(policy) = policy else {
            // 5xx: every waiting follower gets this answer; the next request fetches again.
            let entry = Arc::new(CacheEntry { status: parts.status, headers, body, stored_at: now, fresh_until: now, stale_until: now });
            flight.finish(Flight::Error(entry.clone()));
            return send_entry(&entry, "BYPASS");
        };
        let entry = Arc::new(CacheEntry {
            status: parts.status,
            headers,
            body,
            stored_at: now,
            fresh_until: now + Duration::from_secs(policy.ttl),
            stale_until: now + Duration::from_secs(policy.ttl + policy.swr),
        });
        if entry.body.len() <= CACHE_MAX_ENTRY {
            self.inner.cache.lock().unwrap_or_else(|e| e.into_inner()).set(&flight.key, entry.clone());
        }
        flight.finish(Flight::Entry(entry.clone()));
        send_entry(&entry, "MISS")
    }
}

/// A follower's wait for the leader, bounded by the follower's own deadline.
async fn follow(mut rx: watch::Receiver<Flight>, deadline: tokio::time::Instant) -> Flight {
    match tokio::time::timeout_at(deadline, rx.wait_for(|flight| !matches!(flight, Flight::Pending))).await {
        Ok(Ok(outcome)) => outcome.clone(),
        // The sender is gone without an outcome (cannot happen with FlightGuard): fetch it yourself.
        Ok(Err(_)) => Flight::Uncacheable,
        Err(_) => Flight::Failed(StatusCode::GATEWAY_TIMEOUT),
    }
}

fn rebuild(parts: &axum::http::request::Parts, target: &str) -> Request {
    let mut builder = Request::builder().method(parts.method.clone()).uri(target);
    if let Some(headers) = builder.headers_mut() {
        *headers = parts.headers.clone();
    }
    builder.body(Body::empty()).unwrap_or_else(|_| Request::new(Body::empty()))
}

fn send_entry(entry: &CacheEntry, label: &'static str) -> Response {
    let mut response = Response::new(Body::from(entry.body.clone()));
    *response.status_mut() = entry.status;
    let headers = response.headers_mut();
    *headers = entry.headers.clone();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(entry.body.len()));
    headers.insert(header::AGE, HeaderValue::from(entry.stored_at.elapsed().as_secs()));
    headers.insert(HeaderName::from_static("x-pokoin-origin"), HeaderValue::from_static(ORIGIN_LABEL));
    headers.insert(HeaderName::from_static("x-pokoin-edge-cache"), HeaderValue::from_static(label));
    response
}

/// `502` / `504` when no upstream answer came back; never cached.
fn gateway_error(status: StatusCode) -> Response {
    let mut response = Response::new(Body::from(status.canonical_reason().unwrap_or("Bad Gateway")));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(HeaderName::from_static("x-pokoin-origin"), HeaderValue::from_static(ORIGIN_LABEL));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

async fn send_sitemap(dir: &std::path::Path, name: &str, head: bool) -> Response {
    let file = dir.join(name);
    let meta = match tokio::fs::metadata(&file).await {
        Ok(meta) if meta.is_file() => meta,
        _ => {
            let mut response = Response::new(Body::from("Not Found"));
            *response.status_mut() = StatusCode::NOT_FOUND;
            response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
            return response;
        }
    };
    let body = if head {
        Body::empty()
    } else {
        match tokio::fs::File::open(&file).await {
            Ok(f) => Body::from_stream(tokio_util::io::ReaderStream::new(f)),
            Err(_) => Body::empty(),
        }
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/xml; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    fn policy(cc: &str, ct: &str) -> Option<CachePolicy> {
        let mut h = HeaderMap::new();
        h.insert(header::CACHE_CONTROL, HeaderValue::from_str(cc).unwrap());
        h.insert(header::CONTENT_TYPE, HeaderValue::from_str(ct).unwrap());
        cache_policy(StatusCode::OK, &h, 300)
    }

    #[test]
    fn cache_policy_matches_node() {
        assert_eq!(policy("public, max-age=60", "application/json"), Some(CachePolicy { ttl: 60, swr: 0 }));
        assert_eq!(policy("public, max-age=15, s-maxage=60, stale-while-revalidate=120", "application/json"), Some(CachePolicy { ttl: 60, swr: 120 }));
        assert_eq!(policy("public, s-maxage=900, stale-while-revalidate=9000", "x"), Some(CachePolicy { ttl: 300, swr: 600 }));
        assert_eq!(policy("private, max-age=60", "x"), None);
        assert_eq!(policy("public, no-cache, max-age=60", "x"), None);
        assert_eq!(policy("public", "x"), None);
        assert_eq!(policy("public, max-age=0", "x"), None);
        assert_eq!(policy("public, max-age=60", "text/event-stream"), None);
        assert_eq!(policy("publicity, max-age=60", "x"), None);
    }

    #[test]
    fn path_helpers_match_node() {
        assert_eq!(rewrite_path("/card-images/1_a.jpg"), "/1_a.jpg");
        assert_eq!(rewrite_path("/card-images"), "/");
        assert_eq!(rewrite_path("/card-imagesx"), "/card-imagesx");
        assert!(is_api_path("/api/marketplace-suggest"));
        assert!(is_api_path("/healthz"));
        assert!(is_api_path("/"));
        assert!(!is_api_path("/api/health"));
        assert!(!is_api_path("/1_a.jpg"));
        let mut h = HeaderMap::new();
        assert!(cache_key(&Method::GET, &h, "/api/x", "?a=1").is_some());
        assert!(cache_key(&Method::POST, &h, "/api/x", "").is_none());
        assert!(cache_key(&Method::GET, &h, "/api/marketplace-live", "").is_none());
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer x"));
        assert!(cache_key(&Method::GET, &h, "/api/x", "").is_none());
    }

    #[test]
    fn cors_uses_the_shared_policy() {
        let mut h = HeaderMap::new();
        h.insert("origin", HeaderValue::from_static("https://onepiece.pokoin.com"));
        let c = browser_cors(&h);
        assert!(c.iter().any(|(k, v)| k == "access-control-allow-origin" && v == "https://onepiece.pokoin.com"));
        assert!(c.iter().any(|(k, v)| k == "access-control-allow-credentials" && v == "true"));
        h.insert("origin", HeaderValue::from_static("https://evil.example"));
        let c = browser_cors(&h);
        assert!(c.iter().any(|(k, v)| k == "access-control-allow-origin" && v == "*"));
        assert!(!c.iter().any(|(k, _)| k == "access-control-allow-credentials"));
    }

    #[test]
    fn lru_evicts_oldest() {
        let mut cache = ResponseCache::new(10);
        let entry = |n: usize| {
            let now = Instant::now();
            Arc::new(CacheEntry { status: StatusCode::OK, headers: HeaderMap::new(), body: Bytes::from(vec![0u8; n]), stored_at: now, fresh_until: now, stale_until: now })
        };
        cache.set("a", entry(4));
        cache.set("b", entry(4));
        assert!(cache.get("a").is_some());
        cache.set("c", entry(4));
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some() && cache.get("c").is_some());
        assert_eq!(cache.bytes, 8);
    }

    fn counting_api(counter: Arc<AtomicU64>) -> Router {
        let c1 = counter.clone();
        Router::new()
            .route(
                "/api/public",
                get(move || {
                    let c = c1.clone();
                    async move {
                        c.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        ([(header::CACHE_CONTROL, "public, s-maxage=60"), (header::CONTENT_TYPE, "application/json")], "{\"ok\":true}")
                    }
                }),
            )
            .route("/api/private", get(|| async { ([(header::CACHE_CONTROL, "private, no-store")], "{}") }))
    }

    fn config(seo: PathBuf, flight_timeout: Duration) -> EdgeConfig {
        EdgeConfig { seo_dir: seo, cache_max_bytes: 1 << 20, cache_max_ttl: 300, flight_timeout }
    }

    fn edge(counter: Arc<AtomicU64>, seo: PathBuf) -> Router {
        let cdn = Router::new().fallback(|req: Request| async move { format!("cdn:{}", req.uri()) });
        edge_router(config(seo, Duration::from_secs(30)), counting_api(counter), cdn)
    }

    /// `/api/flaky`: the first call panics after 50 ms, later calls answer a cacheable 200.
    /// `/api/stuck`: the first call never answers, later calls answer a cacheable 200.
    fn first_call_fails_api(calls: Arc<AtomicU64>) -> Router {
        let (flaky, stuck) = (calls.clone(), calls);
        let ok = || ([(header::CACHE_CONTROL, "public, s-maxage=60"), (header::CONTENT_TYPE, "application/json")], "{\"ok\":true}");
        Router::new()
            .route(
                "/api/flaky",
                get(move || {
                    let calls = flaky.clone();
                    async move {
                        let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        if first {
                            panic!("user-provided comparison function does not correctly implement a total order");
                        }
                        ok()
                    }
                }),
            )
            .route(
                "/api/stuck",
                get(move || {
                    let calls = stuck.clone();
                    async move {
                        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            std::future::pending::<()>().await;
                        }
                        ok()
                    }
                }),
            )
    }

    fn req(method: &str, uri: &str, headers: &[(&str, &str)]) -> Request {
        let mut b = Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn caches_coalesces_and_bypasses() {
        let counter = Arc::new(AtomicU64::new(0));
        let dir = tempfile::tempdir().unwrap();
        let app = edge(counter.clone(), dir.path().to_path_buf());
        let (a, b) = tokio::join!(app.clone().oneshot(req("GET", "/api/public?x=1", &[])), app.clone().oneshot(req("GET", "/api/public?x=1", &[])));
        let labels: Vec<String> = [a.unwrap(), b.unwrap()].iter().map(|r| r.headers()["x-pokoin-edge-cache"].to_str().unwrap().to_owned()).collect();
        assert!(labels.contains(&"MISS".to_owned()) && labels.contains(&"COALESCED".to_owned()), "{labels:?}");
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        let hit = app.clone().oneshot(req("GET", "/api/public?x=1", &[("origin", "https://pokoin.com")])).await.unwrap();
        assert_eq!(hit.headers()["x-pokoin-edge-cache"], "HIT");
        assert_eq!(hit.headers()["access-control-allow-origin"], "https://pokoin.com");
        assert_eq!(hit.headers()["x-robots-tag"], "noindex");
        let personal = app.clone().oneshot(req("GET", "/api/public?x=1", &[("authorization", "Bearer t")])).await.unwrap();
        assert!(personal.headers().get("x-pokoin-edge-cache").is_none());
        assert_eq!(counter.load(Ordering::SeqCst), 2);
        let private = app.clone().oneshot(req("GET", "/api/private", &[])).await.unwrap();
        assert_eq!(private.headers()["x-pokoin-edge-cache"], "BYPASS");
        let pre = app.clone().oneshot(req("OPTIONS", "/api/public", &[("origin", "https://dashboard.pokoin.com")])).await.unwrap();
        assert_eq!(pre.status(), StatusCode::NO_CONTENT);
        assert_eq!(pre.headers()["access-control-allow-credentials"], "true");
        assert_eq!(pre.headers()["vary"], "Origin");
    }

    #[tokio::test]
    async fn panicking_handler_fails_fast_and_frees_the_key() {
        let calls = Arc::new(AtomicU64::new(0));
        let dir = tempfile::tempdir().unwrap();
        let app = edge_router(config(dir.path().to_path_buf(), Duration::from_secs(30)), first_call_fails_api(calls.clone()), Router::new());
        let get = || app.clone().oneshot(req("GET", "/api/flaky?warmup=1", &[]));
        let (leader, follower) = tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(get(), get()) })
            .await
            .expect("leader and follower answer instead of waiting on the flight");
        let labels: Vec<String> = [leader.unwrap(), follower.unwrap()]
            .iter()
            .map(|r| {
                assert_eq!(r.status(), StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(r.headers()["cache-control"], "no-store");
                r.headers()["x-pokoin-edge-cache"].to_str().unwrap().to_owned()
            })
            .collect();
        assert!(labels.contains(&"BYPASS".to_owned()) && labels.contains(&"COALESCED".to_owned()), "{labels:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "the follower replays the leader's error");
        let next = tokio::time::timeout(Duration::from_secs(5), get()).await.unwrap().unwrap();
        assert_eq!(next.status(), StatusCode::OK);
        assert_eq!(next.headers()["x-pokoin-edge-cache"], "MISS", "a 500 does not mark the path uncacheable");
        let hit = get().await.unwrap();
        assert_eq!(hit.headers()["x-pokoin-edge-cache"], "HIT");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn hung_handler_times_out_and_frees_the_key() {
        let calls = Arc::new(AtomicU64::new(0));
        let dir = tempfile::tempdir().unwrap();
        let app = edge_router(config(dir.path().to_path_buf(), Duration::from_millis(200)), first_call_fails_api(calls.clone()), Router::new());
        let get = || app.clone().oneshot(req("GET", "/api/stuck", &[]));
        let (leader, follower) = tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(get(), get()) }).await.unwrap();
        assert_eq!(leader.unwrap().status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(follower.unwrap().status(), StatusCode::GATEWAY_TIMEOUT);
        let next = tokio::time::timeout(Duration::from_secs(5), get()).await.unwrap().unwrap();
        assert_eq!(next.status(), StatusCode::OK);
        assert_eq!(next.headers()["x-pokoin-edge-cache"], "MISS");
    }

    #[tokio::test]
    async fn follower_takes_over_when_the_leader_hangs_up() {
        let calls = Arc::new(AtomicU64::new(0));
        let dir = tempfile::tempdir().unwrap();
        let app = edge_router(config(dir.path().to_path_buf(), Duration::from_secs(30)), first_call_fails_api(calls.clone()), Router::new());
        let leader = tokio::spawn(app.clone().oneshot(req("GET", "/api/stuck", &[])));
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let follower = tokio::spawn(app.clone().oneshot(req("GET", "/api/stuck", &[])));
        tokio::time::sleep(Duration::from_millis(20)).await;
        leader.abort(); // the leader's client disconnects
        let response = tokio::time::timeout(Duration::from_secs(5), follower).await.unwrap().unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-pokoin-edge-cache"], "MISS");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn every_way_out_of_a_leader_settles_the_flight() {
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(config(dir.path().to_path_buf(), Duration::from_secs(30)), Router::new(), Router::new());
        let deadline = || tokio::time::Instant::now() + Duration::from_secs(1);
        // Unwinding through the leader (a panic the router layer did not catch): followers answer 502.
        let Role::Lead(flight) = edge.start_flight("k") else { panic!("the first caller leads") };
        let Role::Follow(rx) = edge.start_flight("k") else { panic!("the second caller follows") };
        let leader = tokio::spawn(async move {
            let _flight = flight;
            panic!("bug in the leader");
        });
        assert!(leader.await.unwrap_err().is_panic());
        assert!(matches!(follow(rx, deadline()).await, Flight::Failed(StatusCode::BAD_GATEWAY)));
        assert!(edge.inner.flights.lock().unwrap().is_empty());
        // Dropped without an answer (client gone): followers elect a new leader.
        let Role::Lead(flight) = edge.start_flight("k") else { panic!("the key is free again") };
        let Role::Follow(rx) = edge.start_flight("k") else { panic!("the second caller follows") };
        drop(flight);
        assert!(matches!(follow(rx, deadline()).await, Flight::Abandoned));
        assert!(matches!(edge.start_flight("k"), Role::Lead(_)));
        // A follower's own wait is bounded too.
        let Role::Lead(_flight) = edge.start_flight("k") else { panic!("the key is free again") };
        let Role::Follow(rx) = edge.start_flight("k") else { panic!("the second caller follows") };
        let waited = tokio::time::timeout(Duration::from_secs(5), follow(rx, tokio::time::Instant::now() + Duration::from_millis(50))).await;
        assert!(matches!(waited, Ok(Flight::Failed(StatusCode::GATEWAY_TIMEOUT))));
    }

    #[tokio::test]
    async fn cdn_paths_and_sitemaps() {
        let counter = Arc::new(AtomicU64::new(0));
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("sitemap.xml"), "<urlset/>").unwrap();
        let app = edge(counter, dir.path().to_path_buf());
        let res = app.clone().oneshot(req("GET", "/card-images/1_a.jpg?v=2", &[])).await.unwrap();
        let body = to_bytes(res.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"cdn:/1_a.jpg?v=2");
        let res = app.clone().oneshot(req("GET", "/sitemap.xml", &[])).await.unwrap();
        assert_eq!(res.headers()["content-type"], "application/xml; charset=utf-8");
        assert_eq!(res.headers()["content-length"], "9");
        let res = app.clone().oneshot(req("GET", "/sitemap-hubs.xml", &[])).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = app.oneshot(req("GET", "/api/health", &[])).await.unwrap();
        let body = to_bytes(res.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"cdn:/api/health");
    }
}
