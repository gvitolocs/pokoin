//! Disk CDN of cdn.pokoin.com — port of `pokoin-pi-cdn-server.js`.
//!
//! Same path/remap contract as the `pokoin-cdn-card-images` Worker: a requested
//! key is served from `root`, else through the leftover alias index (public id
//! `ct_id * 2` -> leftover `ct_id`, slug-checked), else through the jpeg/homepage
//! candidate ladder, else (game prefixes only) from the fallback origin.

use std::{
    cmp::Ordering,
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::Response,
    Router,
};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use tokio::sync::RwLock;
use tokio_util::io::ReaderStream;

#[derive(Clone, Debug)]
pub struct CdnConfig {
    pub root: PathBuf,
    pub name: String,
    pub index_ms: u64,
    /// `POKOIN_CDN_FALLBACK_ORIGIN` without the trailing slash; empty = off.
    pub fallback_origin: String,
}

impl CdnConfig {
    /// `POKOIN_CDN_ROOT`, `POKOIN_CDN_NAME`, `POKOIN_CDN_INDEX_MS`, `POKOIN_CDN_FALLBACK_ORIGIN`.
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let root = env("POKOIN_CDN_ROOT").unwrap_or_else(|| "/srv/pokoin/card-images/objects".into());
        let root = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
        Self {
            root,
            name: env("POKOIN_CDN_NAME").unwrap_or_else(|| "pi-local".into()),
            index_ms: env("POKOIN_CDN_INDEX_MS").and_then(|v| v.parse().ok()).unwrap_or(120_000),
            fallback_origin: env("POKOIN_CDN_FALLBACK_ORIGIN")
                .map(|v| v.trim_end_matches('/').to_owned())
                .unwrap_or_default(),
        }
    }
}

const SKIP_INDEX_PREFIXES: [&str; 18] = [
    "originals/", "manifests/", "previews/", "competitive/", "one-piece/", "riftbound/", "artcut/",
    "magic/", "yugioh/", "lorcana/", "flesh-and-blood/", "digimon/", "dragon-ball-super/", "vanguard/",
    "star-wars/", "union-arena/", "gundam/", "sorcery/",
];

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

fn game_prefix_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^(one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery)/")
}

fn homepage_webp_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)_homepage\.webp$")
}

fn jpeg_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)\.jpe?g$")
}

fn strip_leading_slashes(value: &str) -> &str {
    value.trim_start_matches('/')
}

/// Halve a positive even decimal integer (JS `BigInt(id) / 2n`); `None` otherwise.
fn half_decimal(digits: &str) -> Option<String> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return None; // zero
    }
    if (digits.as_bytes()[digits.len() - 1] - b'0') % 2 != 0 {
        return None;
    }
    let mut out = String::with_capacity(digits.len());
    let mut rem = 0u32;
    for b in digits.bytes() {
        let cur = rem * 10 + u32::from(b - b'0');
        let q = cur / 2;
        rem = cur % 2;
        if !(out.is_empty() && q == 0) {
            out.push(char::from(b'0' + q as u8));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// `leftoverCdnObjectKey(requestedKey)`: public id `ct_id * 2` -> leftover `ct_id`.
pub fn leftover_cdn_object_key(requested_key: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let key = strip_leading_slashes(requested_key);
    let caps = re(&R, r"^(previews/)?(\d+)(_.*)$").captures(key)?;
    let prefix = caps.get(2)?.as_str();
    if prefix.len() > 16 {
        return None;
    }
    let leftover = half_decimal(prefix)?;
    Some(format!(
        "{}{}{}",
        caps.get(1).map(|m| m.as_str()).unwrap_or(""),
        leftover,
        caps.get(3)?.as_str()
    ))
}

fn keep_raw_object_key(key: &str) -> bool {
    key.starts_with("originals/")
        || key.starts_with("manifests/")
        || key.starts_with("previews/")
        || key.starts_with("competitive/")
        || homepage_webp_re().is_match(key)
}

/// `jpegCatalogKey(requestedKey)`.
pub fn jpeg_catalog_key(requested_key: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let key = strip_leading_slashes(requested_key);
    if key.is_empty() {
        return None;
    }
    if keep_raw_object_key(key) || jpeg_re().is_match(key) {
        return Some(key.to_owned());
    }
    Some(re(&R, r"(?i)\.(png|webp)$").replace(key, ".jpg").into_owned())
}

/// `homepageJpegKey(requestedKey)`.
pub fn homepage_jpeg_key(requested_key: &str) -> Option<String> {
    let key = strip_leading_slashes(requested_key);
    if !homepage_webp_re().is_match(key) {
        return None;
    }
    Some(homepage_webp_re().replace(key, ".jpg").into_owned())
}

fn leftover_id_from_key(requested_key: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^(?:previews/)?(\d+)_")
        .captures(strip_leading_slashes(requested_key))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
        .unwrap_or_default()
}

fn half_leftover_id(id: &str) -> String {
    half_decimal(id).unwrap_or_default()
}

/// `leftoverLookupIds(requestedKey)`: requested id first, its half as fallback.
pub fn leftover_lookup_ids(requested_key: &str) -> Vec<String> {
    let id = leftover_id_from_key(requested_key);
    if id.is_empty() {
        return Vec::new();
    }
    let half = half_leftover_id(&id);
    let mut ids = vec![id];
    if !half.is_empty() {
        ids.push(half);
    }
    ids
}

fn leftover_image_slug(key: &str) -> String {
    static HOMEPAGE: OnceLock<Regex> = OnceLock::new();
    static EXT: OnceLock<Regex> = OnceLock::new();
    static ID: OnceLock<Regex> = OnceLock::new();
    let key = strip_leading_slashes(key);
    let key = key.strip_prefix("previews/").unwrap_or(key);
    let file = key.rsplit('/').next().unwrap_or("");
    // JS: /_homepage(?=\.(?:webp|jpe?g|png))/i — the regex crate has no lookahead.
    let file = re(&HOMEPAGE, r"(?i)_homepage(\.(?:webp|jpe?g|png))").replace(file, "$1");
    let file = re(&EXT, r"(?i)\.(?:jpe?g|png|webp)$").replace(&file, "");
    let file = re(&ID, r"^\d+_").replace(&file, "");
    file.to_lowercase()
}

/// `leftoverSlugCompatible(requestedSlug, dumpName)`.
pub fn leftover_slug_compatible(requested_slug: &str, dump_name: &str) -> bool {
    let dump = leftover_image_slug(dump_name);
    let want = requested_slug.to_lowercase();
    if dump.is_empty() {
        return false;
    }
    if want.is_empty() {
        return true;
    }
    want == dump || dump.starts_with(&format!("{want}-")) || want.starts_with(&format!("{dump}-"))
}

fn dumps_have_foreign_slug(files: &[String], requested_slug: &str) -> bool {
    files.iter().any(|name| !leftover_slug_compatible(requested_slug, name))
}

fn wants_homepage(requested_key: &str) -> bool {
    homepage_webp_re().is_match(requested_key)
}

/// JS `a.length - b.length || a.localeCompare(b)`. localeCompare (ICU root) orders
/// case-insensitively before case; an ASCII approximation is exact for the
/// lowercase dump names the CDN stores.
fn shortest(a: &String, b: &String) -> Ordering {
    a.len()
        .cmp(&b.len())
        .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
        .then_with(|| b.cmp(a))
}

/// `pickLeftoverAlias(files, wantHomepage)`.
pub fn pick_leftover_alias(files: &[String], want_homepage: bool) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let mut homepages: Vec<String> = files.iter().filter(|n| homepage_webp_re().is_match(n)).cloned().collect();
    let mut jpegs: Vec<String> = files.iter().filter(|n| jpeg_re().is_match(n)).cloned().collect();
    homepages.sort_by(shortest);
    jpegs.sort_by(shortest);
    if want_homepage {
        if let Some(first) = homepages.first() {
            return Some(first.clone());
        }
        if let Some(first) = jpegs.first() {
            return Some(first.clone());
        }
    }
    if let Some(first) = jpegs.first() {
        return Some(first.clone());
    }
    let mut names = files.to_vec();
    names.sort_by(shortest);
    names.first().cloned()
}

fn skip_indexed_key(name: &str) -> bool {
    SKIP_INDEX_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix) || name.contains(&format!("/{prefix}")))
}

pub type LeftoverIndex = HashMap<String, Vec<String>>;

/// `buildLeftoverIndex(root)`: root-level `<digits>_...` names grouped by id.
pub fn build_leftover_index(root: &Path) -> LeftoverIndex {
    static R: OnceLock<Regex> = OnceLock::new();
    let mut by_id: LeftoverIndex = HashMap::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return by_id;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if skip_indexed_key(&name) {
            continue;
        }
        let Some(id) = re(&R, r"^(\d+)_").captures(&name).and_then(|c| c.get(1)) else {
            continue;
        };
        by_id.entry(id.as_str().to_owned()).or_default().push(name);
    }
    by_id
}

/// `candidateKeys(requestedKey)`.
pub fn candidate_keys(requested_key: &str) -> Vec<String> {
    static HOME_ANY: OnceLock<Regex> = OnceLock::new();
    static EXT: OnceLock<Regex> = OnceLock::new();
    let key = strip_leading_slashes(requested_key).to_owned();
    let mut out: Vec<String> = Vec::new();
    let mut add = |value: Option<String>| {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            if !out.contains(&v) {
                out.push(v);
            }
        }
    };
    let catalog = jpeg_catalog_key(&key);
    add(Some(key.clone()));
    add(catalog.clone());
    let jpeg = homepage_jpeg_key(&key);
    if jpeg.is_some() {
        add(jpeg.clone());
    }
    add(leftover_cdn_object_key(&key));
    add(catalog.as_deref().and_then(leftover_cdn_object_key));
    if let Some(j) = jpeg.as_deref() {
        add(leftover_cdn_object_key(j));
    }
    if game_prefix_re().is_match(&key) {
        let stem = re(&HOME_ANY, r"(?i)_homepage\.(jpe?g|png|webp)$").replace(&key, "");
        let stem = re(&EXT, r"(?i)\.(jpe?g|png|webp)$").replace(&stem, "").into_owned();
        for ext in [".jpg", ".jpeg", ".png", ".webp"] {
            add(Some(format!("{stem}{ext}")));
        }
    }
    out
}

/// `getObjectKey(urlPath)`: `None` for empty keys, `..`, or malformed escapes.
pub fn get_object_key(url_path: &str) -> Option<String> {
    let raw = strip_leading_slashes(url_path);
    let mut key = percent_decode_str(raw).decode_utf8().ok()?.into_owned();
    if let Some(rest) = key.strip_prefix("card-images/") {
        key = rest.to_owned();
    }
    if key.is_empty() || key.contains("..") {
        return None;
    }
    Some(key)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[derive(Clone, Debug)]
pub struct FileHit {
    pub full: PathBuf,
    pub key: String,
    pub size: u64,
    pub mtime: SystemTime,
}

/// `path.join(root, key)` with the `startsWith(root)` guard and lexical `..` handling.
fn stat_file(root: &Path, key: &str) -> Option<FileHit> {
    let mut full = root.to_path_buf();
    for part in key.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                full.pop();
            }
            other => full.push(other),
        }
    }
    if !full.starts_with(root) {
        return None;
    }
    let meta = std::fs::metadata(&full).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(FileHit { full, key: key.to_owned(), size: meta.len(), mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH) })
}

/// `resolveFile(key, { root, index })`.
pub fn resolve_file(key: &str, root: &Path, by_id: &LeftoverIndex) -> Option<FileHit> {
    let want_homepage = wants_homepage(key);
    let slug = leftover_image_slug(key);
    let requested_id = leftover_id_from_key(key);
    let half_id = half_leftover_id(&requested_id);
    let empty: Vec<String> = Vec::new();
    let files_for = |id: &str| by_id.get(id).unwrap_or(&empty);
    let alias_hit = |id: &str| -> Option<FileHit> {
        if id.is_empty() {
            return None;
        }
        let matches: Vec<String> = files_for(id).iter().filter(|n| leftover_slug_compatible(&slug, n)).cloned().collect();
        let alias = pick_leftover_alias(&matches, want_homepage)?;
        stat_file(root, &alias)
    };
    if !requested_id.is_empty() {
        let same_files = files_for(&requested_id);
        let foreign = dumps_have_foreign_slug(same_files, &slug);
        if !foreign {
            if let Some(hit) = alias_hit(&requested_id) {
                return Some(hit);
            }
        }
        if let Some(hit) = alias_hit(&half_id) {
            return Some(hit);
        }
        if foreign {
            if let Some(hit) = alias_hit(&requested_id) {
                return Some(hit);
            }
        }
        if let Some(dump) = pick_leftover_alias(same_files, want_homepage) {
            if let Some(hit) = stat_file(root, &dump) {
                return Some(hit);
            }
        }
        if let Some(dump) = pick_leftover_alias(files_for(&half_id), want_homepage) {
            if let Some(hit) = stat_file(root, &dump) {
                return Some(hit);
            }
        }
    }
    let candidates = candidate_keys(key);
    let (primary, fallback): (Vec<&String>, Vec<&String>) = if want_homepage {
        (
            candidates.iter().filter(|n| homepage_webp_re().is_match(n)).collect(),
            candidates.iter().filter(|n| !homepage_webp_re().is_match(n)).collect(),
        )
    } else {
        (candidates.iter().collect(), Vec::new())
    };
    primary.into_iter().chain(fallback).find_map(|c| stat_file(root, c))
}

struct Inner {
    cfg: CdnConfig,
    index: RwLock<Arc<LeftoverIndex>>,
    index_at: RwLock<Option<Instant>>,
    http: reqwest::Client,
}

#[derive(Clone)]
pub struct Cdn {
    inner: Arc<Inner>,
}

async fn build_index(root: PathBuf) -> LeftoverIndex {
    tokio::task::spawn_blocking(move || build_leftover_index(&root)).await.unwrap_or_default()
}

impl Cdn {
    /// Builds the leftover index once (like Node before `listen`) and refreshes it
    /// every `index_ms` in the background, keeping the last index on failure.
    pub async fn start(cfg: CdnConfig) -> Self {
        let index = build_index(cfg.root.clone()).await;
        tracing::info!(name = %cfg.name, root = %cfg.root.display(), indexed = index.len(), "pokoin cdn index built");
        let cdn = Self {
            inner: Arc::new(Inner {
                http: reqwest::Client::builder()
                    .timeout(Duration::from_secs(30))
                    .build()
                    .unwrap_or_else(|_| reqwest::Client::new()),
                index: RwLock::new(Arc::new(index)),
                index_at: RwLock::new(Some(Instant::now())),
                cfg,
            }),
        };
        let refresher = cdn.clone();
        tokio::spawn(async move {
            let every = Duration::from_millis(refresher.inner.cfg.index_ms.max(1_000));
            loop {
                tokio::time::sleep(every).await;
                let index = build_index(refresher.inner.cfg.root.clone()).await;
                *refresher.inner.index.write().await = Arc::new(index);
                *refresher.inner.index_at.write().await = Some(Instant::now());
            }
        });
        cdn
    }

    pub fn router(&self) -> Router {
        Router::new().fallback(serve).with_state(self.clone())
    }
}

/// `cdn_router(cfg)`: build the index, then serve every path.
pub async fn cdn_router(cfg: CdnConfig) -> Router {
    Cdn::start(cfg).await.router()
}

fn send_headers(headers: &mut HeaderMap, name: &str) {
    let mut set = |k: &'static str, v: &str| {
        if let Ok(v) = HeaderValue::from_str(v) {
            headers.insert(HeaderName::from_static(k), v);
        }
    };
    set("access-control-allow-origin", "*");
    set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    set("access-control-allow-headers", "Content-Type, Range");
    set("access-control-max-age", "86400");
    set("x-content-type-options", "nosniff");
    set("referrer-policy", "strict-origin-when-cross-origin");
    set("x-robots-tag", "noai, noimageai");
    set("x-pokoin-cdn", name);
    set("x-pokoin-cdn-origin", name);
}

fn reply(status: StatusCode, name: &str, extra: &[(&'static str, String)], body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    send_headers(headers, name);
    for (k, v) in extra {
        if let Ok(v) = HeaderValue::from_str(v) {
            headers.insert(HeaderName::from_static(k), v);
        }
    }
    response
}

fn not_found(name: &str, extra: &[(&'static str, String)]) -> Response {
    reply(StatusCode::NOT_FOUND, name, extra, Body::from("Not Found"))
}

const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~')
    .remove(b'*').remove(b'\'').remove(b'(').remove(b')');

/// `proxyGamePrefix(req, res, key)`; `None` when the fallback does not apply.
async fn proxy_game_prefix(inner: &Inner, head: bool, key: &str) -> Option<Response> {
    if inner.cfg.fallback_origin.is_empty() || !game_prefix_re().is_match(key) {
        return None;
    }
    let name = &inner.cfg.name;
    let encoded: Vec<String> = key.split('/').map(|p| utf8_percent_encode(p, URI_COMPONENT).to_string()).collect();
    let target = format!("{}/{}", inner.cfg.fallback_origin, encoded.join("/"));
    let method = if head { reqwest::Method::HEAD } else { reqwest::Method::GET };
    let upstream = inner.http.request(method, &target).header("user-agent", "pokoin-cdn-fallback").send().await;
    let no_store = ("cache-control", "private, no-store".to_owned());
    let Ok(up) = upstream else {
        return Some(not_found(name, &[no_store]));
    };
    if up.status() != reqwest::StatusCode::OK {
        return Some(not_found(name, &[no_store, ("x-pokoin-cdn-fallback", "miss".into())]));
    }
    let content_type = up
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| content_type(Path::new(key)).to_owned());
    let mut extra = vec![
        ("content-type", content_type),
        ("cache-control", "public, max-age=86400".to_owned()),
        ("x-pokoin-cdn-fallback", "nezopt".to_owned()),
    ];
    if let Some(len) = up.headers().get(reqwest::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()) {
        extra.push(("content-length", len.to_owned()));
    }
    let body = if head { Body::empty() } else { Body::from_stream(up.bytes_stream()) };
    Some(reply(StatusCode::OK, name, &extra, body))
}

async fn serve(State(cdn): State<Cdn>, req: Request) -> Response {
    let inner = &cdn.inner;
    let name = inner.cfg.name.as_str();
    let method = req.method().clone();
    if method == Method::OPTIONS {
        return reply(StatusCode::NO_CONTENT, name, &[], Body::empty());
    }
    if method != Method::GET && method != Method::HEAD {
        return reply(StatusCode::METHOD_NOT_ALLOWED, name, &[], Body::from("Method Not Allowed"));
    }
    let head = method == Method::HEAD;
    let path = req.uri().path();
    if path == "/health" || path == "/api/health" {
        let index = inner.index.read().await.len();
        let age = inner.index_at.read().await.map(|at| at.elapsed().as_millis() as u64);
        let body = serde_json::json!({
            "ok": true,
            "root": inner.cfg.root.display().to_string(),
            "host": name,
            "indexed": index,
            "indexAgeMs": age,
        });
        return reply(
            StatusCode::OK,
            name,
            &[("content-type", "application/json; charset=utf-8".to_owned())],
            Body::from(body.to_string()),
        );
    }
    let Some(key) = get_object_key(path) else {
        return not_found(name, &[]);
    };
    let index = inner.index.read().await.clone();
    let root = inner.cfg.root.clone();
    let lookup_key = key.clone();
    let hit = tokio::task::spawn_blocking(move || resolve_file(&lookup_key, &root, &index)).await.ok().flatten();
    let Some(hit) = hit else {
        if let Some(response) = proxy_game_prefix(inner, head, &key).await {
            return response;
        }
        return not_found(name, &[("cache-control", "private, no-store".to_owned())]);
    };
    let mut extra = vec![
        ("content-type", content_type(&hit.full).to_owned()),
        ("content-length", hit.size.to_string()),
        ("cache-control", "public, max-age=31536000, immutable".to_owned()),
        ("x-pokoin-cdn-object-key", hit.key.clone()),
        ("last-modified", httpdate::fmt_http_date(hit.mtime)),
    ];
    if hit.key != key {
        extra.push(("x-pokoin-cdn-mapped-from", key.clone()));
    }
    if head {
        return reply(StatusCode::OK, name, &extra, Body::empty());
    }
    match tokio::fs::File::open(&hit.full).await {
        Ok(file) => reply(StatusCode::OK, name, &extra, Body::from_stream(ReaderStream::new(file))),
        Err(_) => not_found(name, &[("cache-control", "private, no-store".to_owned())]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(names: &[&str]) -> LeftoverIndex {
        let mut by_id: LeftoverIndex = HashMap::new();
        for n in names {
            let id = n.split('_').next().unwrap().to_owned();
            by_id.entry(id).or_default().push((*n).to_owned());
        }
        by_id
    }

    fn root_with(names: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for n in names {
            let p = dir.path().join(n);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, n.as_bytes()).unwrap();
        }
        dir
    }

    #[test]
    fn key_helpers_match_node() {
        assert_eq!(leftover_cdn_object_key("/490584_net-ball.jpg").as_deref(), Some("245292_net-ball.jpg"));
        assert_eq!(leftover_cdn_object_key("previews/10_x.webp").as_deref(), Some("previews/5_x.webp"));
        assert_eq!(leftover_cdn_object_key("7_odd.jpg"), None);
        assert_eq!(leftover_cdn_object_key("12345678901234567_long.jpg"), None);
        assert_eq!(leftover_cdn_object_key("0_zero.jpg"), None);
        assert_eq!(jpeg_catalog_key("1_a.PNG").as_deref(), Some("1_a.jpg"));
        assert_eq!(jpeg_catalog_key("1_a_homepage.webp").as_deref(), Some("1_a_homepage.webp"));
        assert_eq!(jpeg_catalog_key("previews/1_a.webp").as_deref(), Some("previews/1_a.webp"));
        assert_eq!(jpeg_catalog_key(""), None);
        assert_eq!(homepage_jpeg_key("1_a_homepage.webp").as_deref(), Some("1_a.jpg"));
        assert_eq!(homepage_jpeg_key("1_a.webp"), None);
        assert_eq!(leftover_lookup_ids("244980_meloetta.jpg"), vec!["244980", "122490"]);
        assert_eq!(leftover_lookup_ids("122490_meloetta.jpg"), vec!["122490", "61245"]);
        assert!(leftover_lookup_ids("abc.jpg").is_empty());
        assert_eq!(leftover_image_slug("previews/12_Great-Tusk_homepage.webp"), "great-tusk");
        assert!(leftover_slug_compatible("great-tusk", "321834_great-tusk-ex.jpg"));
        assert!(leftover_slug_compatible("", "1_x.jpg"));
        assert!(!leftover_slug_compatible("metang", "321834_great-tusk.jpg"));
        assert_eq!(get_object_key("/card-images/1_a%20b.jpg").as_deref(), Some("1_a b.jpg"));
        assert_eq!(get_object_key("/../etc/passwd"), None);
        assert_eq!(get_object_key("/%E0%A4%A"), None);
        assert_eq!(half_decimal("0012").as_deref(), Some("6"));
    }

    #[test]
    fn candidate_ladder_matches_node() {
        assert_eq!(
            candidate_keys("490584_net-ball_homepage.webp"),
            vec!["490584_net-ball_homepage.webp", "490584_net-ball.jpg", "245292_net-ball_homepage.webp", "245292_net-ball.jpg"]
        );
        assert_eq!(
            candidate_keys("one-piece/OP01-001.png"),
            vec!["one-piece/OP01-001.png", "one-piece/OP01-001.jpg", "one-piece/OP01-001.jpeg", "one-piece/OP01-001.webp"]
        );
    }

    #[test]
    fn alias_picking() {
        let files = vec!["5_abc_homepage.webp".to_owned(), "5_abc.jpg".to_owned(), "5_ab.png".to_owned()];
        assert_eq!(pick_leftover_alias(&files, true).as_deref(), Some("5_abc_homepage.webp"));
        assert_eq!(pick_leftover_alias(&files, false).as_deref(), Some("5_abc.jpg"));
        assert_eq!(pick_leftover_alias(&["5_ab.png".to_owned()], false).as_deref(), Some("5_ab.png"));
        assert_eq!(pick_leftover_alias(&[], false), None);
    }

    #[test]
    fn net_ball_halves_when_requested_id_is_another_card() {
        // Public id 490584 dumps belong to Cyndaquil; the Net Ball leftover is 245292.
        let names = ["490584_cyndaquil.jpg", "245292_net-ball.jpg"];
        let dir = root_with(&names);
        let hit = resolve_file("490584_net-ball.jpg", dir.path(), &index(&names)).unwrap();
        assert_eq!(hit.key, "245292_net-ball.jpg");
    }

    #[test]
    fn even_leftover_is_not_halved_again() {
        // Meloetta leftover 122490 is even; its own dump wins over 61245.
        let names = ["122490_meloetta.jpg", "61245_other.jpg"];
        let dir = root_with(&names);
        let hit = resolve_file("122490_meloetta.jpg", dir.path(), &index(&names)).unwrap();
        assert_eq!(hit.key, "122490_meloetta.jpg");
    }

    #[test]
    fn metang_serves_foreign_named_dump_when_half_misses() {
        // Metang 321834 files are still named great-tusk; half 160917 has nothing.
        let names = ["321834_great-tusk.jpg"];
        let dir = root_with(&names);
        let hit = resolve_file("321834_metang.jpg", dir.path(), &index(&names)).unwrap();
        assert_eq!(hit.key, "321834_great-tusk.jpg");
    }

    #[test]
    fn homepage_falls_back_to_jpeg_and_index_skips_prefixes() {
        let names = ["8_pika.jpg"];
        let dir = root_with(&names);
        let hit = resolve_file("8_pika_homepage.webp", dir.path(), &index(&names)).unwrap();
        assert_eq!(hit.key, "8_pika.jpg");
        let dir = root_with(&["9_a.jpg", "previews/9_a.webp", "x.jpg"]);
        let built = build_leftover_index(dir.path());
        assert_eq!(built.len(), 1);
        assert_eq!(built["9"], vec!["9_a.jpg"]);
    }

    #[tokio::test]
    async fn serves_files_health_and_errors() {
        use tower::ServiceExt;
        let dir = root_with(&["4_card.jpg"]);
        let cfg = CdnConfig { root: dir.path().to_path_buf(), name: "test".into(), index_ms: 60_000, fallback_origin: String::new() };
        let app = cdn_router(cfg).await;
        let get = |p: &str, m: &str| Request::builder().method(m).uri(p).body(Body::empty()).unwrap();
        let res = app.clone().oneshot(get("/card-images/4_card.png", "GET")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["content-type"], "image/jpeg");
        assert_eq!(res.headers()["x-pokoin-cdn-object-key"], "4_card.jpg");
        assert_eq!(res.headers()["x-pokoin-cdn-mapped-from"], "4_card.png");
        assert_eq!(res.headers()["x-pokoin-cdn"], "test");
        let res = app.clone().oneshot(get("/nope_x.jpg", "GET")).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(res.headers()["cache-control"], "private, no-store");
        let res = app.clone().oneshot(get("/4_card.jpg", "POST")).await.unwrap();
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
        let res = app.clone().oneshot(get("/x", "OPTIONS")).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let res = app.clone().oneshot(get("/health", "GET")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app.oneshot(get("/4_card.jpg", "HEAD")).await.unwrap();
        assert_eq!(res.headers()["content-length"], "10");
    }
}
