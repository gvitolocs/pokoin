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
    /// How long past its stale window the cache will still answer a failing
    /// origin with its last good copy. [`STALE_IF_ERROR`]; a field, not a use of
    /// the constant, so a test can watch the window close.
    pub stale_if_error: Duration,
}

impl EdgeConfig {
    /// `POKOIN_SEO_DIR` (/srv/pokoin/seo), `POKOIN_API_CACHE_MB` (64), `POKOIN_API_CACHE_MAX_TTL` (300),
    /// `POKOIN_API_FLIGHT_TIMEOUT_SECS` (60).
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
            seo_dir: PathBuf::from(
                env("POKOIN_SEO_DIR").unwrap_or_else(|| "/srv/pokoin/seo".into()),
            ),
            cache_max_bytes: env("POKOIN_API_CACHE_MB")
                .and_then(|v| v.parse::<f64>().ok())
                .map(|mb| (mb * 1024.0 * 1024.0) as usize)
                .unwrap_or(64 * 1024 * 1024),
            cache_max_ttl: env("POKOIN_API_CACHE_MAX_TTL")
                .and_then(|v| v.parse().ok())
                .unwrap_or(300),
            flight_timeout: Duration::from_secs(
                env("POKOIN_API_FLIGHT_TIMEOUT_SECS")
                    .and_then(|v| v.parse().ok())
                    .filter(|s| *s > 0)
                    .unwrap_or(60),
            ),
            stale_if_error: STALE_IF_ERROR,
        }
    }
}

const CACHE_MAX_ENTRY: usize = 2 * 1024 * 1024;
const UNCACHEABLE_MS: u64 = 5 * 60 * 1000;
/// How long past its own stale window a cached entry may still answer, when the
/// origin is answering an error rather than being slow. The same ten minutes the
/// longest `stale-while-revalidate` buys (`cache_policy`'s 600 s cap): a copy the
/// shared caches were already allowed to serve while revalidating is good enough
/// to serve once revalidating has failed.
const STALE_IF_ERROR: Duration = Duration::from_secs(600);
/// The catalogue read routes a stale copy may answer when the origin fails.
/// Every other path passes its error through even when this cache holds a copy
/// of it: outside the catalogue reads there is no last-good answer whose being
/// a little stale beats knowing the request failed.
///
/// An entry without a trailing `/` is one exact pathname, not a prefix —
/// `/api/marketplace-list` is the prebuilt-list BFF, while
/// `/api/marketplace-listings` is a seller's own route and must not inherit the
/// catalogue's copy. `/api/marketplace-home/` is a prefix: the homepage rails
/// (`new-cards`, `best-sellers`, `spotlight`), one entry each.
const STALE_ERROR_PATHS: [&str; 12] = [
    "/api/marketplace-card-page",
    "/api/marketplace-card-tiles",
    "/api/marketplace-search-page",
    "/api/marketplace-list",
    "/api/marketplace-suggest",
    "/api/marketplace-version-set",
    "/api/marketplace-expansion-page",
    "/api/marketplace-card-url",
    "/api/marketplace-card-versions",
    "/api/marketplace-card-sales",
    "/api/marketplace-rails",
    "/api/marketplace-home/",
];

/// Whether `pathname` is one of [`STALE_ERROR_PATHS`]. A personal request never
/// gets this far: `cache_key` refuses `Authorization` and `Cookie`, so those are
/// forwarded and their error stays their own.
fn is_stale_error_path(pathname: &str) -> bool {
    STALE_ERROR_PATHS.iter().any(|route| {
        if route.ends_with('/') {
            pathname.starts_with(route)
        } else {
            pathname == *route
        }
    })
}
/// The four statuses the origin is failing rather than refusing: a server error
/// a last good copy is worth answering. `is_server_error` would take 501 and 505
/// as well, and those say the request itself was not something the origin does —
/// a copy of a page is the wrong answer to that, so they pass through.
fn answers_error(status: StatusCode) -> bool {
    matches!(status.as_u16(), 500 | 502 | 503 | 504)
}

/// The game this request resolves to, from the same resolver the catalogue page
/// routes use (`support::resolve_game` in `catalog_api::pages`, which is this
/// function over the `game` and `marketplaceGame` query parameters): query, then
/// `x-pokoin-game`/`x-marketplace-game`, then the host candidates.
fn request_game(req: &Request) -> String {
    let query = pokoin_api_common::http::Query::from_uri(req.uri());
    let game = query.first("game").filter(|value| !value.is_empty());
    let marketplace = query
        .first("marketplaceGame")
        .filter(|value| !value.is_empty());
    pokoin_api_common::game::parse_game_from_request(
        &pokoin_api_common::http::header_pairs(req.headers()),
        game,
        marketplace,
    )
}

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

/// The longest a homepage rail lives in this cache, whatever its handler asked
/// for: the publisher rewrites the rails every few minutes and nothing else
/// notices a publish until this entry is gone.
const RAIL_MAX_TTL: u64 = 15;

/// The rail URLs the homepage paints, one per rail: the three dedicated
/// handlers and the shared `?id=` one. The `?id=` is not part of the pathname,
/// so every rail shares this entry space and is capped the same way.
fn is_rail_path(pathname: &str) -> bool {
    pathname.starts_with("/api/marketplace-home/") || pathname == "/api/marketplace-rails"
}

/// `cache_policy` with the edge's own per-path cap on top (`RAIL_MAX_TTL`).
/// A rail never has a stale window: this cache must refetch it rather than
/// replay an order the publisher has already replaced.
fn policy_for_path(
    pathname: &str,
    status: StatusCode,
    headers: &HeaderMap,
    max_ttl: u64,
) -> Option<CachePolicy> {
    let policy = cache_policy(status, headers, max_ttl)?;
    if !is_rail_path(pathname) {
        return Some(policy);
    }
    Some(CachePolicy {
        ttl: policy.ttl.min(RAIL_MAX_TTL),
        swr: 0,
    })
}

/// The `cache-control` of a replayed-stale answer: what the browser may still
/// use, and nothing a shared cache may store. `s-maxage` is pinned to 0 and
/// `stale-while-revalidate` is dropped, because an answer that is already stale
/// must not buy a second freshness window at every cache in front of this one.
/// Directives this function does not touch keep their spelling.
fn stale_cache_control(value: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut pinned = false;
    for part in value.split(',') {
        let directive = part.trim();
        let name = directive.split('=').next().unwrap_or("");
        match name.trim().to_ascii_lowercase().as_str() {
            "" | "stale-while-revalidate" => {}
            "s-maxage" => {
                pinned = true;
                parts.push("s-maxage=0".to_owned());
            }
            _ => parts.push(directive.to_owned()),
        }
    }
    if !pinned {
        parts.push("s-maxage=0".to_owned());
    }
    parts.join(", ")
}

/// `cacheKey(req, pathname, search)`: `None` when the request is personal.
/// The key carries `Accept` and the strongest content coding the client can
/// decode, so a `br` or `dcb` body is only ever replayed to a client that
/// asked for it (the origin negotiates both; see `encoding_variant`).
pub fn cache_key(method: &Method, headers: &HeaderMap, pathname: &str, search: &str) -> Option<String> {
    if method != Method::GET || pathname == "/api/marketplace-live" {
        return None;
    }
    if headers.contains_key(header::AUTHORIZATION) || headers.contains_key(header::COOKIE) {
        return None;
    }
    Some(format!(
        "{pathname}{search}\n{}\n{}\n{}\n{}",
        header_str(headers, "x-pokoin-game"),
        header_str(headers, "x-pokoin-host"),
        header_str(headers, "accept"),
        encoding_variant(headers),
    ))
}

fn accepts_coding(headers: &HeaderMap, wanted: &str) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|entry| {
            let mut parts = entry.split(';');
            parts.next().unwrap_or("").trim().eq_ignore_ascii_case(wanted)
                && !parts.any(|param| param.trim().replace(' ', "") == "q=0")
        })
}

/// The coding a cached response may use for this request: `dcb` against the
/// dictionary the client named, else `br`, else none.
fn encoding_variant(headers: &HeaderMap) -> String {
    let dictionary = header_str(headers, "available-dictionary").trim();
    if !dictionary.is_empty() && accepts_coding(headers, "dcb") {
        format!("dcb {dictionary}")
    } else if accepts_coding(headers, "br") {
        "br".to_owned()
    } else {
        String::new()
    }
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
    /// The game the request that stored this was resolved to, by the resolver the
    /// routes use ([`request_game`]). The key cannot carry it — the key is
    /// `cacheKey(req, pathname, search)` as the Node edge computes it, and it
    /// reads only `x-pokoin-game` and `x-pokoin-host`, while a route also honours
    /// `Host`, `x-forwarded-host`, `x-original-host`, `Origin`, `Referer` and
    /// `x-marketplace-game`. So two requests can share a key and still be asking
    /// for different games' data; this says which one this copy is.
    game: String,
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
    /// The leader's answer came from the cache's last good copy while the
    /// origin failed: a follower of the same game replays that copy, and one of
    /// another game is answered by `status` — the failure the leader met.
    /// The leader's answer came from the cache's last good copy while the
    /// origin failed: a follower of the same game replays that copy, and one of
    /// another game is answered by `status` — the failure the leader met.
    StaleError {
        copy: Arc<CacheEntry>,
        status: StatusCode,
    },
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
    /// Answers of the last good copy while the origin returned an error.
    stale_error: AtomicU64,
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
            let (hits, misses, bypass, stale_error) = (
                s.hits.swap(0, Ordering::Relaxed),
                s.misses.swap(0, Ordering::Relaxed),
                s.bypass.swap(0, Ordering::Relaxed),
                s.stale_error.swap(0, Ordering::Relaxed),
            );
            if hits + misses + bypass + stale_error > 0 {
                let (entries, mb) = {
                    let cache = stats.inner.cache.lock().unwrap_or_else(|e| e.into_inner());
                    (cache.map.len(), cache.bytes as f64 / 1_048_576.0)
                };
                tracing::info!(
                    hits,
                    misses,
                    bypass,
                    stale_error,
                    entries,
                    mb = format!("{mb:.1}"),
                    "pokoin-api-edge minute"
                );
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

    /// `parse_game_from_request`'s answer for a request. Only a copy of the same
    /// game may answer it: the cache key does not carry what [`request_game`]
    /// makes of `Host` and its friends, so the two would otherwise disagree
    /// silently — and a follower of a stale-error flight is compared the same
    /// way as the direct lookup, or a satellite would be handed the Pokémon page
    /// that shares its key.
    fn copy_answers(entry: &CacheEntry, game: &str) -> bool {
        entry.game == game
    }

    /// The cache's last good copy of `key`, when its stale window closed no more
    /// than `stale_if_error` ago: what answers an origin that is answering
    /// errors rather than being slow. A copy past that is a copy about a page
    /// nobody has seen in ten minutes, and the error is the truer answer.
    /// Reading a copy leaves its `fresh_until` and `stale_until` as they were.
    /// Only a path in [`STALE_ERROR_PATHS`] is answered from a copy at all, and
    /// only by a copy of the same game ([`copy_answers`]).
    fn last_good(&self, pathname: &str, game: &str, key: &str) -> Option<Arc<CacheEntry>> {
        if !is_stale_error_path(pathname) {
            return None;
        }
        let mut cache = self.inner.cache.lock().unwrap_or_else(|e| e.into_inner());
        let entry = cache.get(key)?;
        if !Self::copy_answers(&entry, game) {
            return None;
        }
        let overdue = Instant::now().saturating_duration_since(entry.stale_until);
        (overdue <= self.inner.cfg.stale_if_error).then_some(entry)
    }

    /// [`last_good`]'s answer: the entry's own status and body, `age` telling how
    /// old it is, and the stale replay's `cache-control` so no cache downstream
    /// keeps an answer this one already knows is out of date.
    fn send_last_good(&self, entry: &CacheEntry) -> Response {
        self.inner.stats.stale_error.fetch_add(1, Ordering::Relaxed);
        send_entry(entry, "STALE-ERROR")
    }

    /// A flight that got no answer from the API at all (timed out, unreadable
    /// body): the last good copy if the cache holds one and [`lead`] was allowed
    /// to replace this response with one (`replaceable`), `502`/`504` if it does
    /// not or if the headers already refused the swap. Either way the flight is
    /// settled, so every follower is told the same thing this request was.
    fn fail_flight(
        &self,
        pathname: &str,
        game: &str,
        flight: FlightGuard,
        status: StatusCode,
        replaceable: bool,
    ) -> Response {
        let copy = if replaceable {
            self.last_good(pathname, game, &flight.key)
        } else {
            None
        };
        match copy {
            Some(entry) => {
                flight.finish(Flight::StaleError {
                    copy: entry.clone(),
                    status,
                });
                self.send_last_good(&entry)
            }
            None => {
                flight.finish(Flight::Failed(status));
                gateway_error(status)
            }
        }
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
        let game = request_game(&req);
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
                    let (me, pathname, game) = (self.clone(), pathname.to_owned(), game.clone());
                    tokio::spawn(async move {
                        let _ = me.lead(request, flight, &pathname, &game).await;
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
                Role::Lead(flight) => return self.lead(req, flight, pathname, &game).await,
                Role::Follow(rx) => match follow(rx, deadline).await {
                    Flight::Abandoned => continue,
                    outcome => break outcome,
                },
            }
        };
        match outcome {
            Flight::Entry(entry) | Flight::Error(entry) => send_entry(&entry, "COALESCED"),
            // The leader answered the failing origin out of the cache. This
            // follower is the same request when it is the same game, and gets
            // the same copy; of another game it must not be answered with that
            // copy, and it does not fetch behind the leader either — the failure
            // the leader met is its own answer.
            Flight::StaleError { copy, status } => {
                if Self::copy_answers(&copy, &game) {
                    self.send_last_good(&copy)
                } else {
                    gateway_error(status)
                }
            }
            Flight::Failed(status) => match self.last_good(pathname, &game, &key) {
                Some(entry) => self.send_last_good(&entry),
                None => gateway_error(status),
            },
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
    async fn lead(
        &self,
        req: Request,
        flight: FlightGuard,
        pathname: &str,
        game: &str,
    ) -> Response {
        let deadline = tokio::time::Instant::now() + self.inner.cfg.flight_timeout;
        let target = format!("{}{}", pathname, req.uri().query().map(|q| format!("?{q}")).unwrap_or_default());
        let req = with_uri(req, &target);
        let Ok(response) = tokio::time::timeout_at(deadline, self.inner.api.clone().oneshot(req)).await else {
            tracing::warn!(path = pathname, timeout_s = self.inner.cfg.flight_timeout.as_secs(), "edge flight timed out");
            // No headers came at all, so nothing has refused a copy.
            return self.fail_flight(pathname, game, flight, StatusCode::GATEWAY_TIMEOUT, true);
        };
        let response = response.unwrap_or_else(|never| match never {});
        let status = response.status();
        // Whether this response may be answered from the cache's last good copy
        // is decided from the headers, before the body is read: one of
        // [`answers_error`]'s four, and no `Set-Cookie` meant for this client —
        // a cookie is about the request that failed, and the copy would drop it.
        // A body that then fails or runs out the deadline must not unlock the
        // copy the headers refused: the swap belongs to the response the origin
        // was actually giving, not to whatever the edge manages to buffer.
        let replaceable =
            answers_error(status) && !response.headers().contains_key(header::SET_COOKIE);
        let max_ttl = self.inner.cfg.cache_max_ttl;
        let policy = policy_for_path(pathname, status, response.headers(), max_ttl);
        if policy.is_none() && !answers_error(status) {
            // An error says nothing about the path, so only answers mark it uncacheable.
            // Of the errors, only [`answers_error`]'s four go on to the last good copy:
            // a 501 or 505 is streamed as the answer it is.
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
                return self.fail_flight(
                    pathname,
                    game,
                    flight,
                    StatusCode::BAD_GATEWAY,
                    replaceable,
                )
            }
            Err(_) => {
                tracing::warn!(
                    path = pathname,
                    timeout_s = self.inner.cfg.flight_timeout.as_secs(),
                    "edge flight body timed out"
                );
                return self.fail_flight(
                    pathname,
                    game,
                    flight,
                    StatusCode::GATEWAY_TIMEOUT,
                    replaceable,
                );
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
            // One of the four, and [`replaceable`] is what its headers said: every
            // waiting follower gets this answer; the next request fetches again.
            // The cache's last good copy answers instead when the swap is allowed
            // and the cache holds one, and this error is never stored.
            if replaceable {
                if let Some(entry) = self.last_good(pathname, game, &flight.key) {
                    flight.finish(Flight::StaleError {
                        copy: entry.clone(),
                        status,
                    });
                    return self.send_last_good(&entry);
                }
            }
            let entry = Arc::new(CacheEntry {
                status: parts.status,
                headers,
                body,
                stored_at: now,
                fresh_until: now,
                stale_until: now,
                game: game.to_owned(),
            });
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
            game: game.to_owned(),
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
    if label == "STALE-ERROR" {
        // The copy's `x-request-id` is the id of the request that stored it, and
        // this answer belongs to a different one — the request that failed. The
        // origin's id is only ever set by its own middleware (`request_log`),
        // which this response never reached, so the honest answer is no id: an
        // id that points at another request is a false trail in the log.
        headers.remove(HeaderName::from_static("x-request-id"));
    }
    if label == "STALE" || label == "STALE-ERROR" {
        let rewritten = headers
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .map(stale_cache_control);
        if let Some(value) = rewritten.and_then(|v| HeaderValue::from_str(&v).ok()) {
            headers.insert(header::CACHE_CONTROL, value);
        }
    }
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
        assert_eq!(policy("public, max-age=120, s-maxage=0", "application/json"), None, "s-maxage=0 is not stored");
        assert_eq!(policy("public, max-age=60", "text/event-stream"), None);
        assert_eq!(policy("publicity, max-age=60", "x"), None);
    }

    #[test]
    fn a_stale_replay_keeps_the_browser_and_loses_the_shared_cache() {
        let cases = [
            (
                "public, max-age=30, s-maxage=120, stale-while-revalidate=600",
                "public, max-age=30, s-maxage=0",
            ),
            ("public, max-age=30", "public, max-age=30, s-maxage=0"),
            ("public, no-store", "public, no-store, s-maxage=0"),
            (
                "private, max-age=30, stale-while-revalidate=60",
                "private, max-age=30, s-maxage=0",
            ),
            ("", "s-maxage=0"),
            (
                " PUBLIC ,  Max-Age = 30 ,S-MAXAGE=120, Stale-While-Revalidate=600 ",
                "PUBLIC, Max-Age = 30, s-maxage=0",
            ),
        ];
        for (given, want) in cases {
            assert_eq!(stale_cache_control(given), want, "{given}");
        }
    }

    #[test]
    fn a_rail_url_lives_fifteen_seconds_at_the_edge() {
        let rails = "public, max-age=30, s-maxage=120, stale-while-revalidate=600";
        let headers = |cc: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::CACHE_CONTROL, HeaderValue::from_str(cc).unwrap());
            h
        };
        for path in ["/api/marketplace-home/new-cards", "/api/marketplace-rails"] {
            let capped = policy_for_path(path, StatusCode::OK, &headers(rails), 300);
            assert_eq!(capped, Some(CachePolicy { ttl: 15, swr: 0 }), "{path}");
        }
        for path in [
            "/api/marketplace-home",
            "/api/marketplace-rails-x",
            "/api/marketplace-search-page",
        ] {
            let kept = policy_for_path(path, StatusCode::OK, &headers(rails), 300);
            assert_eq!(
                kept,
                Some(CachePolicy { ttl: 120, swr: 600 }),
                "{path} is not a rail URL"
            );
        }
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
    fn cache_key_separates_content_codings() {
        let key = |pairs: &[(&'static str, &'static str)]| {
            let mut h = HeaderMap::new();
            for (name, value) in pairs {
                h.append(*name, HeaderValue::from_static(value));
            }
            cache_key(&Method::GET, &h, "/api/marketplace-list", "?kind=set&key=sv1").unwrap()
        };
        let identity = key(&[]);
        let gzip = key(&[("accept-encoding", "gzip")]);
        let br = key(&[("accept-encoding", "gzip, br")]);
        let br_q0 = key(&[("accept-encoding", "gzip, br;q=0")]);
        let dcb = key(&[("accept-encoding", "gzip, br, dcb"), ("available-dictionary", ":abc=:")]);
        let dcb_other = key(&[("accept-encoding", "gzip, br, dcb"), ("available-dictionary", ":xyz=:")]);
        let dcb_no_dict = key(&[("accept-encoding", "gzip, br, dcb")]);
        assert_eq!(identity, gzip);
        assert_eq!(identity, br_q0);
        assert_ne!(identity, br);
        assert_eq!(br, dcb_no_dict);
        assert_ne!(br, dcb);
        assert_ne!(dcb, dcb_other);
        assert_ne!(key(&[("accept", "application/json")]), key(&[("accept", "application/vnd.pokoin.c1+json")]));
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
            Arc::new(CacheEntry {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from(vec![0u8; n]),
                stored_at: now,
                fresh_until: now,
                stale_until: now,
                game: "pokemon".to_owned(),
            })
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

    /// The rails' own `cache-control` with a shared window short enough to wait
    /// out in a test: `RAIL_MAX_TTL` cannot be, and the cap is the same code
    /// path at any length.
    const SHORT_LIVED: &str = "public, max-age=30, s-maxage=1, stale-while-revalidate=600";

    fn short_lived_api(counter: Arc<AtomicU64>) -> Router {
        let c1 = counter.clone();
        let answer = move || {
            let c = c1.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                (
                    [
                        (header::CACHE_CONTROL, SHORT_LIVED),
                        (header::CONTENT_TYPE, "application/json"),
                    ],
                    "{\"ok\":true}",
                )
            }
        };
        Router::new()
            .route("/api/marketplace-home/new-cards", get(answer.clone()))
            .route("/api/marketplace-rails", get(answer.clone()))
            .route("/api/other", get(answer))
    }

    fn config(seo: PathBuf, flight_timeout: Duration) -> EdgeConfig {
        EdgeConfig {
            seo_dir: seo,
            cache_max_bytes: 1 << 20,
            cache_max_ttl: 300,
            flight_timeout,
            stale_if_error: STALE_IF_ERROR,
        }
    }

    /// [`config`] with the last-good-copy window shortened to something a test
    /// can watch close: production always gets [`STALE_IF_ERROR`].
    fn stale_if_error(seo: PathBuf, flight_timeout: Duration, window: Duration) -> EdgeConfig {
        EdgeConfig {
            stale_if_error: window,
            ..config(seo, flight_timeout)
        }
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
    async fn s_maxage_zero_is_not_stored_and_private_marks_the_path() {
        let calls = Arc::new(AtomicU64::new(0));
        let n = calls.clone();
        let api = Router::new().route(
            "/api/marketplace-list",
            get(move |uri: Uri| {
                let n = n.clone();
                async move {
                    n.fetch_add(1, Ordering::SeqCst);
                    let query = uri.query().unwrap_or("");
                    let cc = if query.contains("private=1") {
                        "private, max-age=120"
                    } else if query.contains("zero=1") {
                        "public, max-age=120, s-maxage=0"
                    } else {
                        "public, s-maxage=60"
                    };
                    ([(header::CACHE_CONTROL, cc), (header::CONTENT_TYPE, "application/json")], "{\"ok\":true}")
                }
            }),
        );
        let dir = tempfile::tempdir().unwrap();
        let app = edge_router(config(dir.path().to_path_buf(), Duration::from_secs(30)), api, Router::new());
        let get = |path: &'static str| {
            let app = app.clone();
            async move { app.oneshot(req("GET", path, &[])).await.unwrap() }
        };
        let zero = get("/api/marketplace-list?zero=1").await;
        assert_eq!(zero.headers()["x-pokoin-edge-cache"], "BYPASS");
        assert_eq!(zero.headers()["cache-control"], "public, max-age=120, s-maxage=0");
        let zero_again = get("/api/marketplace-list?zero=1").await;
        assert_eq!(zero_again.headers()["x-pokoin-edge-cache"], "BYPASS", "s-maxage=0 is not stored");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let miss = get("/api/marketplace-list?ok=1").await;
        assert_eq!(miss.headers()["x-pokoin-edge-cache"], "MISS", "the zero answer did not mark the pathname uncacheable");
        let hit = get("/api/marketplace-list?ok=1").await;
        assert_eq!(hit.headers()["x-pokoin-edge-cache"], "HIT");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let private = get("/api/marketplace-list?private=1").await;
        assert_eq!(private.headers()["x-pokoin-edge-cache"], "BYPASS");
        let blocked = get("/api/marketplace-list?ok=1").await;
        assert!(blocked.headers().get("x-pokoin-edge-cache").is_none(), "a private 200 marks the pathname uncacheable");
        assert_eq!(calls.load(Ordering::SeqCst), 5);
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
    async fn a_rail_is_refetched_rather_than_replayed_stale() {
        let counter = Arc::new(AtomicU64::new(0));
        let dir = tempfile::tempdir().unwrap();
        let app = edge_router(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            short_lived_api(counter.clone()),
            Router::new(),
        );
        let rail = "/api/marketplace-rails?id=set%3Adelta-reign";
        let miss = app.clone().oneshot(req("GET", rail, &[])).await.unwrap();
        assert_eq!(miss.headers()["x-pokoin-edge-cache"], "MISS");
        assert_eq!(miss.headers()["cache-control"], SHORT_LIVED);
        let hit = app.clone().oneshot(req("GET", rail, &[])).await.unwrap();
        assert_eq!(hit.headers()["x-pokoin-edge-cache"], "HIT");
        assert_eq!(
            hit.headers()["cache-control"],
            SHORT_LIVED,
            "a HIT keeps the handler's header"
        );
        let age: u64 = hit.headers()["age"].to_str().unwrap().parse().unwrap();
        assert!(
            age < 2,
            "a HIT says how long the entry has been stored: {age}"
        );
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        let after = app.clone().oneshot(req("GET", rail, &[])).await.unwrap();
        assert_eq!(
            after.headers()["x-pokoin-edge-cache"],
            "MISS",
            "the entry is past its cap, so it is fetched again"
        );
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_stale_replay_says_its_age_and_is_not_for_a_shared_cache() {
        let counter = Arc::new(AtomicU64::new(0));
        let dir = tempfile::tempdir().unwrap();
        let app = edge_router(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            short_lived_api(counter),
            Router::new(),
        );
        app.clone()
            .oneshot(req("GET", "/api/other", &[]))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        let stale = app
            .clone()
            .oneshot(req("GET", "/api/other", &[]))
            .await
            .unwrap();
        assert_eq!(
            stale.headers()["x-pokoin-edge-cache"],
            "STALE",
            "another path keeps its stale window"
        );
        let age: u64 = stale.headers()["age"].to_str().unwrap().parse().unwrap();
        assert!(age >= 1, "a stale replay says how old it is: {age}");
        assert_eq!(
            stale.headers()["cache-control"],
            "public, max-age=30, s-maxage=0",
            "the browser part stays; nothing downstream may store it"
        );
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

    /// A URL whose `s-maxage` lives a second and whose stale window closes the
    /// second after: [`STALE_IF_ERROR`] is still open, so a fetch that comes back
    /// an error answers from the copy instead.
    const ONCE_GOOD: &str = "public, max-age=30, s-maxage=1, stale-while-revalidate=1";
    const GOOD_BODY: &str = "{\"ok\":true}";
    const GOOD: &str = "public, max-age=30, s-maxage=0";

    fn good_answer() -> (StatusCode, [(HeaderName, &'static str); 2], String) {
        (
            StatusCode::OK,
            [
                (header::CACHE_CONTROL, ONCE_GOOD),
                (header::CONTENT_TYPE, "application/json"),
            ],
            GOOD_BODY.to_owned(),
        )
    }

    /// The origin that has gone bad: both paths answer one cacheable 200, then
    /// `/api/marketplace-list` refuses every caller with a 503 (after 50 ms, so a
    /// follower has time to coalesce) and `/api/marketplace-search-page` never
    /// comes back at all.
    fn sick_api(list: Arc<AtomicU64>, search: Arc<AtomicU64>) -> Router {
        let (l, s) = (list, search);
        Router::new()
            .route(
                "/api/marketplace-list",
                get(move || {
                    let l = l.clone();
                    async move {
                        if l.fetch_add(1, Ordering::SeqCst) > 0 {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                [
                                    (header::CACHE_CONTROL, "no-store"),
                                    (header::CONTENT_TYPE, "application/json"),
                                ],
                                "{\"error\":\"catalog query failed\"}".to_owned(),
                            );
                        }
                        good_answer()
                    }
                }),
            )
            .route(
                "/api/marketplace-search-page",
                get(move || {
                    let s = s.clone();
                    async move {
                        if s.fetch_add(1, Ordering::SeqCst) > 0 {
                            std::future::pending::<()>().await;
                        }
                        good_answer()
                    }
                }),
            )
    }

    /// Past the second of freshness and the second of stale-while-revalidate, the
    /// copy is only worth serving for an origin that is failing.
    const PAST_THE_WINDOW: Duration = Duration::from_millis(2_300);

    #[tokio::test]
    async fn a_failing_origin_answers_its_last_good_copy() {
        let (list, search) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            sick_api(list.clone(), search),
            Router::new(),
        );
        let get = |edge: &Edge| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", "/api/marketplace-list", &[])).await }
        };
        let warm = get(&edge).await;
        assert_eq!(warm.headers()["x-pokoin-edge-cache"], "MISS");
        let key = cache_key(&Method::GET, &HeaderMap::new(), "/api/marketplace-list", "").unwrap();
        let stored = edge
            .inner
            .cache
            .lock()
            .unwrap()
            .map
            .get(&key)
            .cloned()
            .expect("warm stored the page")
            .0;
        let stale_until = stored.stale_until;
        drop(warm);
        tokio::time::sleep(PAST_THE_WINDOW).await;
        let (leader, follower) = tokio::join!(get(&edge), get(&edge));
        for answer in [leader, follower] {
            assert_eq!(
                answer.status(),
                StatusCode::OK,
                "the copy's own status, not the 503"
            );
            assert_eq!(answer.headers()["x-pokoin-edge-cache"], "STALE-ERROR");
            assert_eq!(
                answer.headers()["cache-control"],
                GOOD,
                "nothing downstream may keep it"
            );
            let age: u64 = answer.headers()["age"].to_str().unwrap().parse().unwrap();
            assert!((2..=3).contains(&age), "the copy says how old it is: {age}");
            let body = to_bytes(answer.into_body(), 1024).await.unwrap();
            assert_eq!(&body[..], GOOD_BODY.as_bytes());
        }
        assert_eq!(
            list.load(Ordering::SeqCst),
            2,
            "the pair is one fetch, and it failed"
        );
        assert_eq!(
            edge.inner.stats.stale_error.load(Ordering::Relaxed),
            2,
            "leader and follower both counted"
        );
        // The failure is nowhere in the cache, and serving the copy bought it no
        // time: the next healthy fetch replaces it on its own schedule.
        let after = edge
            .inner
            .cache
            .lock()
            .unwrap()
            .map
            .get(&key)
            .cloned()
            .expect("still the same copy")
            .0;
        assert_eq!(after.status, StatusCode::OK);
        assert_eq!(&after.body[..], GOOD_BODY.as_bytes());
        assert_eq!(
            after.stale_until, stale_until,
            "a stale-error answer does not extend the entry"
        );
    }

    #[tokio::test]
    async fn an_origin_that_never_answers_answers_its_last_good_copy() {
        let (list, search) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_millis(200)),
            sick_api(list, search.clone()),
            Router::new(),
        );
        let get = |edge: &Edge| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", "/api/marketplace-search-page", &[])).await }
        };
        get(&edge).await;
        tokio::time::sleep(PAST_THE_WINDOW).await;
        let (leader, follower) = tokio::join!(get(&edge), get(&edge));
        for answer in [leader, follower] {
            assert_eq!(
                answer.status(),
                StatusCode::OK,
                "the 504 of the hung fetch never reaches the client"
            );
            assert_eq!(answer.headers()["x-pokoin-edge-cache"], "STALE-ERROR");
            assert_eq!(answer.headers()["cache-control"], GOOD);
        }
        assert_eq!(
            search.load(Ordering::SeqCst),
            2,
            "one hung fetch for the pair"
        );
        assert_eq!(edge.inner.stats.stale_error.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn a_copy_older_than_the_window_and_a_key_never_seen_answer_the_error() {
        let (list, search) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let dir = tempfile::tempdir().unwrap();
        // The ten-minute window cut to 100 ms, which is the only way to watch it
        // close in a test; production always uses `STALE_IF_ERROR`.
        let edge = Edge::new(
            stale_if_error(
                dir.path().to_path_buf(),
                Duration::from_secs(30),
                Duration::from_millis(100),
            ),
            sick_api(list.clone(), search),
            Router::new(),
        );
        let get = |edge: &Edge, page: &'static str| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", page, &[])).await }
        };
        get(&edge, "/api/marketplace-list?a=1").await;
        assert_eq!(list.load(Ordering::SeqCst), 1);
        tokio::time::sleep(PAST_THE_WINDOW).await;
        let (leader, follower) = tokio::join!(
            get(&edge, "/api/marketplace-list?a=1"),
            get(&edge, "/api/marketplace-list?a=1")
        );
        let mut labels: Vec<String> = Vec::new();
        for answer in [leader, follower] {
            assert_eq!(
                answer.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "the copy is past what it is worth answering with"
            );
            assert_eq!(answer.headers()["cache-control"], "no-store");
            labels.push(
                answer.headers()["x-pokoin-edge-cache"]
                    .to_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        assert!(
            labels.contains(&"BYPASS".to_owned()) && labels.contains(&"COALESCED".to_owned()),
            "{labels:?}"
        );
        // A key the cache never held has no copy to hide the failure behind.
        let cold = get(&edge, "/api/marketplace-list?a=2").await;
        assert_eq!(cold.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(cold.headers()["x-pokoin-edge-cache"], "BYPASS");
        assert_eq!(
            list.load(Ordering::SeqCst),
            3,
            "one fetch for the pair, one for the cold key"
        );
        assert_eq!(
            edge.inner.stats.stale_error.load(Ordering::Relaxed),
            0,
            "nothing was served from a copy"
        );
    }

    /// The origin of [`sick_api`] for any number of paths: each answers one
    /// cacheable 200, then refuses every later caller with a 503 after 50 ms, so
    /// a follower has time to coalesce behind the fetch that failed.
    fn flaky_api(paths: &[&'static str]) -> Router {
        let hits: Arc<Vec<AtomicU64>> =
            Arc::new((0..paths.len()).map(|_| AtomicU64::new(0)).collect());
        let mut router = Router::new();
        for (index, path) in paths.iter().copied().enumerate() {
            let hits = hits.clone();
            router = router.route(
                path,
                get(move || {
                    let hits = hits.clone();
                    async move {
                        if hits[index].fetch_add(1, Ordering::SeqCst) > 0 {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                [
                                    (header::CACHE_CONTROL, "no-store"),
                                    (header::CONTENT_TYPE, "application/json"),
                                ],
                                "{\"error\":\"catalog query failed\"}".to_owned(),
                            );
                        }
                        good_answer()
                    }
                }),
            );
        }
        router
    }

    /// Requirement 2 of the list: a request that carries a credential is never
    /// answered from a copy. The cache already refuses to key such a request
    /// (`cache_key`), so it has no entry to answer with and the error stays the
    /// client's own — while the same path without the credential is answered from
    /// the copy, which proves the copy was there for the asking.
    #[tokio::test]
    async fn a_credentialled_request_is_never_answered_from_a_copy() {
        let (list, search) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            sick_api(list, search),
            Router::new(),
        );
        let get = |edge: &Edge, headers: &'static [(&'static str, &'static str)]| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", "/api/marketplace-list", headers)).await }
        };
        let warm = get(&edge, &[]).await;
        assert_eq!(warm.headers()["x-pokoin-edge-cache"], "MISS");
        drop(warm);
        tokio::time::sleep(PAST_THE_WINDOW).await;
        for (name, answer) in [
            (
                "Authorization",
                get(&edge, &[("authorization", "Bearer token")]).await,
            ),
            ("Cookie", get(&edge, &[("cookie", "session_id=abc")]).await),
        ] {
            assert_eq!(
                answer.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "the 503 reaches the client of a {name} request"
            );
            assert_eq!(answer.headers()["cache-control"], "no-store");
            assert!(
                answer.headers().get("x-pokoin-edge-cache").is_none(),
                "a personal request is streamed, not served by the cache: {name}"
            );
        }
        assert_eq!(
            edge.inner.stats.stale_error.load(Ordering::Relaxed),
            0,
            "neither credentialled request touched a copy"
        );
        let shared = get(&edge, &[]).await;
        assert_eq!(
            shared.headers()["x-pokoin-edge-cache"],
            "STALE-ERROR",
            "the same entry, for a request that may have it"
        );
    }

    /// Requirement 1: a path that is not in the list passes its error exactly as
    /// it did before, however good the copy of it is. `/api/marketplace-listings`
    /// is here on purpose: it is a seller's own route and shares its opening with
    /// the listed `/api/marketplace-list`, so it pins that the list matches paths
    /// and not prefixes.
    #[tokio::test]
    async fn a_path_off_the_list_keeps_its_own_error() {
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            flaky_api(&[
                "/api/marketplace-listings",
                "/api/other",
                "/api/marketplace-card-page",
            ]),
            Router::new(),
        );
        let get = |edge: &Edge, path: &'static str| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", path, &[])).await }
        };
        let paths = [
            "/api/marketplace-listings",
            "/api/other",
            "/api/marketplace-card-page",
        ];
        let mut labels: Vec<String> = Vec::new();
        for path in paths {
            let warm = get(&edge, path).await;
            assert_eq!(warm.headers()["x-pokoin-edge-cache"], "MISS", "{path}");
            drop(warm);
        }
        tokio::time::sleep(PAST_THE_WINDOW).await;
        for path in [paths[0], paths[1]] {
            let (leader, follower) = tokio::join!(get(&edge, path), get(&edge, path));
            for answer in [leader, follower] {
                assert_eq!(
                    answer.status(),
                    StatusCode::SERVICE_UNAVAILABLE,
                    "the origin's 503, not a copy of {path}"
                );
                assert_eq!(answer.headers()["cache-control"], "no-store");
                labels.push(
                    answer.headers()["x-pokoin-edge-cache"]
                        .to_str()
                        .unwrap()
                        .to_owned(),
                );
            }
        }
        assert!(
            labels.iter().all(|l| l == "BYPASS" || l == "COALESCED"),
            "labelled as today: {labels:?}"
        );
        assert_eq!(
            edge.inner.stats.stale_error.load(Ordering::Relaxed),
            0,
            "nothing was answered from a copy: {labels:?}"
        );
        // The listed path, in the same state and beside these two, is answered.
        let listed = get(&edge, "/api/marketplace-card-page").await;
        assert_eq!(listed.status(), StatusCode::OK);
        assert_eq!(
            listed.headers()["x-pokoin-edge-cache"],
            "STALE-ERROR",
            "the list is what separates these paths"
        );
    }

    /// The list as matched: an entry without a trailing `/` is one pathname, and
    /// only `/api/marketplace-home/` reaches past its own spelling.
    #[test]
    fn the_list_matches_paths_and_only_home_is_a_prefix() {
        for route in STALE_ERROR_PATHS {
            assert!(is_stale_error_path(route), "{route} answers itself");
        }
        assert!(is_stale_error_path("/api/marketplace-home/new-cards"));
        assert!(is_stale_error_path("/api/marketplace-home/best-sellers"));
        assert!(is_stale_error_path("/api/marketplace-home/spotlight"));
        for path in [
            "/api/marketplace-listings",
            "/api/marketplace-list/extra",
            "/api/marketplace-home",
            "/api/marketplace-live",
            "/api/marketplace-orders",
            "/api/other",
            "/",
        ] {
            assert!(!is_stale_error_path(path), "{path} keeps its own error");
        }
    }

    /// A page with a one-second life and no stale window, so a test is only out
    /// of the entry's own time by [`PAST_SHORT_GOOD`], and with the origin's
    /// `x-request-id` on it: `request_log` stamps every API answer with one, and
    /// that is the id a replayed copy must not hand to the next request.
    const SHORT_GOOD: &str = "public, max-age=1, s-maxage=1";
    const PAST_SHORT_GOOD: Duration = Duration::from_millis(1_100);
    const ORIGIN_ID: &str = "rust-1-1";
    const ERROR_BODY: &str = "{\"error\":\"catalog query failed\"}";

    /// One origin answer built by hand, because a test has to name headers the
    /// tuple shape cannot reach: `extra` is added beside a JSON content type.
    fn answered(
        status: StatusCode,
        extra: &[(&'static str, &'static str)],
        body: &str,
    ) -> Response {
        let mut builder = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json");
        for (name, value) in extra {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::from(body.to_owned())).unwrap()
    }

    /// The good page of [`answered`].
    fn good_page() -> Response {
        answered(
            StatusCode::OK,
            &[("cache-control", SHORT_GOOD), ("x-request-id", ORIGIN_ID)],
            GOOD_BODY,
        )
    }

    /// The failing half of [`answered`]: refused, and not for any cache to keep.
    fn failed_page(status: StatusCode, extra: &[(&'static str, &'static str)]) -> Response {
        let mut headers: Vec<(&'static str, &'static str)> = vec![("cache-control", "no-store")];
        headers.extend_from_slice(extra);
        answered(status, &headers, ERROR_BODY)
    }

    /// One path, resolving the game the way a catalogue page route does, and
    /// failing once its first good page is behind it: the Pokémon path answers
    /// one cacheable 200 and then 500s, and any other game 500s at once — which
    /// is what a satellite whose database is not configured does.
    fn sick_by_game_api() -> Router {
        let calls = Arc::new(AtomicU64::new(0));
        Router::new().route(
            "/api/marketplace-expansion-page",
            get(move |headers: HeaderMap, uri: Uri| {
                let calls = calls.clone();
                async move {
                    let query = pokoin_api_common::http::Query::from_uri(&uri);
                    let game = pokoin_api_common::game::parse_game_from_request(
                        &pokoin_api_common::http::header_pairs(&headers),
                        query.first("game"),
                        query.first("marketplaceGame"),
                    );
                    if game != "pokemon" || calls.fetch_add(1, Ordering::SeqCst) > 0 {
                        return failed_page(StatusCode::INTERNAL_SERVER_ERROR, &[]);
                    }
                    good_page()
                }
            }),
        )
    }

    /// How long the failing half of [`slow_sick_by_game_api`] takes to answer:
    /// long enough that a second request joins the first one's flight instead of
    /// starting its own.
    const SLOW_ORIGIN: Duration = Duration::from_millis(300);

    /// [`sick_by_game_api`]'s answers, failing slowly enough that a second
    /// request joins the first one's flight instead of starting its own. Each
    /// game counts its own origin requests, so the Pokémon page is the first
    /// answer ever given *to Pokémon* whatever else arrives in between, and a
    /// test reads the satellite's counter to see that its follower was answered
    /// without a request of its own.
    fn slow_sick_by_game_api(pokemon: Arc<AtomicU64>, other: Arc<AtomicU64>) -> Router {
        Router::new().route(
            "/api/marketplace-expansion-page",
            get(move |headers: HeaderMap, uri: Uri| {
                let (pokemon, other) = (pokemon.clone(), other.clone());
                async move {
                    let query = pokoin_api_common::http::Query::from_uri(&uri);
                    let game = pokoin_api_common::game::parse_game_from_request(
                        &pokoin_api_common::http::header_pairs(&headers),
                        query.first("game"),
                        query.first("marketplaceGame"),
                    );
                    let calls = if game == "pokemon" { &pokemon } else { &other };
                    let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                    if game == "pokemon" && first {
                        return good_page();
                    }
                    tokio::time::sleep(SLOW_ORIGIN).await;
                    failed_page(StatusCode::INTERNAL_SERVER_ERROR, &[])
                }
            }),
        )
    }

    /// `/api/marketplace-card-page`: each of its two URLs answers one cacheable
    /// 200 first, then a 503 — and `?cookie=1` a 503 that also hands the client a
    /// `Set-Cookie`. Two counters, because a test warms both and each key needs
    /// its own good copy to be answered from.
    fn cookie_on_error_api() -> Router {
        let (plain, cookie) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        Router::new().route(
            "/api/marketplace-card-page",
            get(move |uri: Uri| {
                let (plain, cookie) = (plain.clone(), cookie.clone());
                async move {
                    let wants_cookie = uri.query().unwrap_or("").contains("cookie=1");
                    let calls = if wants_cookie { &cookie } else { &plain };
                    if calls.fetch_add(1, Ordering::SeqCst) > 0 {
                        let extra: &[(&'static str, &'static str)] = if wants_cookie {
                            &[("set-cookie", "pokoin_test=1; Path=/")]
                        } else {
                            &[]
                        };
                        return failed_page(StatusCode::SERVICE_UNAVAILABLE, extra);
                    }
                    good_page()
                }
            }),
        )
    }

    /// The origin of point 2: `/api/marketplace-card-page` answers one cacheable
    /// 200 and then only `status`, after 50 ms so a follower can coalesce.
    fn fails_with_api(path: &'static str, status: StatusCode) -> Router {
        let calls = Arc::new(AtomicU64::new(0));
        Router::new().route(
            path,
            get(move || {
                let calls = calls.clone();
                async move {
                    if calls.fetch_add(1, Ordering::SeqCst) > 0 {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        return failed_page(status, &[]);
                    }
                    good_page()
                }
            }),
        )
    }

    /// The key is what both requests share, and the key does not carry `Host`: a
    /// satellite's failing read must not be answered with the Pokémon copy, only
    /// the game the copy was stored for may be.
    #[tokio::test]
    async fn a_copy_is_never_answered_across_games() {
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            sick_by_game_api(),
            Router::new(),
        );
        let get = |edge: &Edge, host: &'static str| {
            let edge = edge.clone();
            async move {
                proxy(
                    State(edge),
                    req("GET", "/api/marketplace-expansion-page", &[("host", host)]),
                )
                .await
            }
        };
        let warm = get(&edge, "pokoin.com").await;
        assert_eq!(warm.headers()["x-pokoin-edge-cache"], "MISS");
        drop(warm);
        tokio::time::sleep(PAST_SHORT_GOOD).await;
        // The same URL and the same key, another game: its own error.
        let other = get(&edge, "magic.pokoin.com").await;
        assert_eq!(
            other.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "the satellite meets the failure of its own database"
        );
        assert_eq!(other.headers()["x-pokoin-edge-cache"], "BYPASS");
        assert_eq!(
            edge.inner.stats.stale_error.load(Ordering::Relaxed),
            0,
            "no copy crossed from one game to another"
        );
        // The game that owns the copy is still answered by it.
        let same = get(&edge, "pokoin.com").await;
        assert_eq!(same.status(), StatusCode::OK);
        assert_eq!(
            same.headers()["x-pokoin-edge-cache"],
            "STALE-ERROR",
            "the copy is worth serving to the game it is a copy of"
        );
    }

    /// The same bound one step further: a follower does not look in the cache at
    /// all, it takes what the leader published — and the leader publishes a copy
    /// for the key, which `Host`, `x-forwarded-host` and `x-marketplace-game`
    /// share. So a follower of another game is answered by the failure the leader
    /// met, never by another game's page, and it does not fetch behind the leader
    /// to find out: one answer per follower.
    #[tokio::test]
    async fn a_follower_of_another_game_is_not_answered_with_the_leaders_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (pokemon, satellite) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            slow_sick_by_game_api(pokemon.clone(), satellite.clone()),
            Router::new(),
        );
        let get = |edge: &Edge, headers: &'static [(&'static str, &'static str)]| {
            let edge = edge.clone();
            async move {
                proxy(
                    State(edge),
                    req("GET", "/api/marketplace-expansion-page", headers),
                )
                .await
            }
        };
        let warm = get(&edge, &[("host", "pokoin.com")]).await;
        assert_eq!(warm.headers()["x-pokoin-edge-cache"], "MISS");
        drop(warm);
        tokio::time::sleep(PAST_SHORT_GOOD).await;
        let body_of = |response: Response| async move {
            String::from_utf8(
                to_bytes(response.into_body(), 1 << 16)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap()
        };
        for follower in [
            &[("host", "magic.pokoin.com")][..],
            &[
                ("host", "pokoin.com"),
                ("x-forwarded-host", "magic.pokoin.com"),
            ][..],
            &[("host", "pokoin.com"), ("x-marketplace-game", "magic")][..],
        ] {
            let (asked, stale) = (
                pokemon.load(Ordering::SeqCst),
                edge.inner.stats.stale_error.load(Ordering::Relaxed),
            );
            let (leader, other) =
                tokio::join!(get(&edge, &[("host", "pokoin.com")]), get(&edge, follower),);
            assert_eq!(
                leader.headers()["x-pokoin-edge-cache"],
                "STALE-ERROR",
                "the Pokémon read is answered from the Pokémon copy: {follower:?}"
            );
            assert_eq!(
                body_of(leader).await,
                GOOD_BODY,
                "and with the page it is a copy of: {follower:?}"
            );
            let leader_copy = edge.inner.stats.stale_error.load(Ordering::Relaxed);
            assert_eq!(leader_copy, stale + 1, "{follower:?}");
            assert_eq!(
                other.status(),
                StatusCode::INTERNAL_SERVER_ERROR,
                "the same failure the leader met is this follower's answer: {follower:?}"
            );
            assert_ne!(
                other
                    .headers()
                    .get("x-pokoin-edge-cache")
                    .and_then(|value| value.to_str().ok()),
                Some("STALE-ERROR"),
                "a satellite is never labelled as answered from a copy: {follower:?}"
            );
            assert_eq!(
                other.headers()["cache-control"],
                "no-store",
                "and it is answered by the synthetic refusal, not by a cached page: {follower:?}"
            );
            assert!(
                !body_of(other).await.contains(GOOD_BODY),
                "the Pokémon page is not the satellite's body: {follower:?}"
            );
            assert_eq!(
                pokemon.load(Ordering::SeqCst),
                asked + 1,
                "the follower was answered from the leader's flight, not a second origin request: {follower:?}"
            );
            assert_eq!(
                satellite.load(Ordering::SeqCst),
                0,
                "and the satellite never reached its own origin: {follower:?}"
            );
        }
    }

    /// Point 2: 500, 502, 503 and 504 are a failing origin; 501 and 505 are the
    /// origin saying what it does not do, and a page from yesterday is not the
    /// answer to that.
    #[tokio::test]
    async fn an_error_the_origin_means_is_the_answer() {
        for status in [
            StatusCode::NOT_IMPLEMENTED,
            StatusCode::HTTP_VERSION_NOT_SUPPORTED,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let edge = Edge::new(
                config(dir.path().to_path_buf(), Duration::from_secs(30)),
                fails_with_api("/api/marketplace-card-page", status),
                Router::new(),
            );
            let get = |edge: &Edge| {
                let edge = edge.clone();
                async move { proxy(State(edge), req("GET", "/api/marketplace-card-page", &[])).await }
            };
            assert_eq!(
                get(&edge).await.headers()["x-pokoin-edge-cache"],
                "MISS",
                "{status}"
            );
            tokio::time::sleep(PAST_SHORT_GOOD).await;
            let answer = get(&edge).await;
            assert_eq!(
                answer.status(),
                status,
                "the origin's {status} reaches the client"
            );
            assert_eq!(answer.headers()["cache-control"], "no-store", "{status}");
            assert_eq!(
                answer.headers()["x-pokoin-edge-cache"],
                "BYPASS",
                "{status}"
            );
            assert_eq!(
                edge.inner.stats.stale_error.load(Ordering::Relaxed),
                0,
                "no copy answers a {status}"
            );
            drop(answer);
        }
    }

    /// Point 3: a `Set-Cookie` on the failing answer belongs to this request. The
    /// copy would answer the page, and quietly drop the cookie the client was
    /// being given, so an error that carries one is returned as it is.
    #[tokio::test]
    async fn an_error_handing_over_a_cookie_is_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            cookie_on_error_api(),
            Router::new(),
        );
        let get = |edge: &Edge, page: &'static str| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", page, &[])).await }
        };
        for page in [
            "/api/marketplace-card-page?cookie=1",
            "/api/marketplace-card-page",
        ] {
            assert_eq!(
                get(&edge, page).await.headers()["x-pokoin-edge-cache"],
                "MISS",
                "{page}"
            );
        }
        tokio::time::sleep(PAST_SHORT_GOOD).await;
        let cookie = get(&edge, "/api/marketplace-card-page?cookie=1").await;
        assert_eq!(
            cookie.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "the 503 is what the client asked to hear"
        );
        assert_eq!(
            cookie.headers()["set-cookie"],
            "pokoin_test=1; Path=/",
            "and so is the cookie it carries"
        );
        assert_eq!(cookie.headers()["x-pokoin-edge-cache"], "BYPASS");
        // The same failure without a cookie is answered from the copy.
        let plain = get(&edge, "/api/marketplace-card-page").await;
        assert_eq!(plain.status(), StatusCode::OK);
        assert_eq!(plain.headers()["x-pokoin-edge-cache"], "STALE-ERROR");
        assert_eq!(
            edge.inner.stats.stale_error.load(Ordering::Relaxed),
            1,
            "only the cookie-free error was replaced"
        );
    }

    /// The origin of point 2 of the second review: `/api/marketplace-card-page`
    /// answers one cacheable 200 — the copy — and then a 503 that hands the client a
    /// `Set-Cookie` and whose body is cut off mid-read. The headers alone say whether
    /// the copy may answer, because the body never gets the chance.
    fn cookie_cut_body_api() -> Router {
        let calls = Arc::new(AtomicU64::new(0));
        Router::new().route(
            "/api/marketplace-card-page",
            get(move || {
                let calls = calls.clone();
                async move {
                    if calls.fetch_add(1, Ordering::SeqCst) > 0 {
                        return Response::builder()
                            .status(StatusCode::SERVICE_UNAVAILABLE)
                            .header(header::CONTENT_TYPE, "application/json")
                            .header("cache-control", "no-store")
                            .header("set-cookie", "pokoin_test=1; Path=/")
                            .body(Body::from_stream(futures_util::stream::iter(
                                std::iter::once(Err::<Bytes, std::io::Error>(std::io::Error::new(
                                    std::io::ErrorKind::UnexpectedEof,
                                    "body cut mid-flight",
                                ))),
                            )))
                            .unwrap();
                    }
                    good_page()
                }
            }),
        )
    }

    /// Point 2 of the second review: whether a copy may replace a failing answer is a
    /// decision about the headers, so it is made before the body is read. An error
    /// that carries a `Set-Cookie` and whose body then broke was falling through to
    /// the stale copy regardless — a 200 page, and the cookie the client was being
    /// handed gone with the error it came in. A body the edge cannot read is now the
    /// synthetic 502 it has always been when no copy exists.
    #[tokio::test]
    async fn a_cookie_error_with_a_cut_body_is_not_answered_from_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            cookie_cut_body_api(),
            Router::new(),
        );
        let get = |edge: &Edge| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", "/api/marketplace-card-page", &[])).await }
        };
        assert_eq!(get(&edge).await.headers()["x-pokoin-edge-cache"], "MISS");
        tokio::time::sleep(PAST_SHORT_GOOD).await;
        let answer = get(&edge).await;
        assert_eq!(
            answer.status(),
            StatusCode::BAD_GATEWAY,
            "a body the edge cannot read is the 502 it always was"
        );
        assert_ne!(
            answer
                .headers()
                .get("x-pokoin-edge-cache")
                .and_then(|value| value.to_str().ok()),
            Some("STALE-ERROR"),
            "and not the copy the headers had already refused"
        );
        assert_eq!(answer.headers()["cache-control"], "no-store");
        assert_eq!(
            edge.inner.stats.stale_error.load(Ordering::Relaxed),
            0,
            "no copy was sent, and none was queued for a follower either"
        );
    }

    /// Point 4: the copy's `x-request-id` is another request's id. A stale-error
    /// answer drops it rather than send a false trail; the ordinary replay of a
    /// copy that is still the origin's own answer keeps what the origin said.
    #[tokio::test]
    async fn a_stale_error_answer_is_not_another_requests_id() {
        let dir = tempfile::tempdir().unwrap();
        let edge = Edge::new(
            config(dir.path().to_path_buf(), Duration::from_secs(30)),
            cookie_on_error_api(),
            Router::new(),
        );
        let get = |edge: &Edge| {
            let edge = edge.clone();
            async move { proxy(State(edge), req("GET", "/api/marketplace-card-page", &[])).await }
        };
        let warm = get(&edge).await;
        assert_eq!(
            warm.headers()["x-request-id"],
            ORIGIN_ID,
            "the origin's id rides along with the page"
        );
        drop(warm);
        tokio::time::sleep(PAST_SHORT_GOOD).await;
        let stale = get(&edge).await;
        assert_eq!(stale.headers()["x-pokoin-edge-cache"], "STALE-ERROR");
        assert!(
            stale.headers().get("x-request-id").is_none(),
            "the copy's id belongs to the request that stored it, not this one"
        );
        // The body is still the page the copy holds.
        let body = to_bytes(stale.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], GOOD_BODY.as_bytes());
    }
}
