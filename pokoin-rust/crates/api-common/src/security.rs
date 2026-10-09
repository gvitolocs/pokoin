//! Ports of `api/_http_security.js`, `api/_cors_policy.js`, `api/_client_ip.js` and
//! `api/_route_limits.js`: the request-security pass every response goes through.

use std::{
    net::{IpAddr, SocketAddr},
    sync::OnceLock,
};

use axum::{
    body::Body,
    extract::{ConnectInfo, Request},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::Response,
};
use serde_json::json;

use crate::{limits, ApiState};

pub const SATELLITE_HOSTS: [&str; 17] = [
    "magic", "yugioh", "fab", "fleshandblood", "digimon", "dbs", "dragonball", "vanguard", "onepiece",
    "lorcana", "starwars", "unionarena", "riftbound", "gundam", "sorcery", "palworld", "cyberpunk",
];

const BASE_ORIGINS: [&str; 7] = [
    "https://pokoin.com",
    "https://www.pokoin.com",
    "https://dashboard.pokoin.com",
    "https://test.pokoin.com",
    "https://scan.pokoin.com",
    "https://cardscan.pokoin.com",
    "https://app.pokoin.com",
];

const DEFAULT_ALLOW_HEADERS: &str = "authorization,content-type,accept,x-pokoin-game,x-pokoin-host";
const MAX_ALLOW_HEADERS: usize = 32;

/// `allowedOrigins(env)`.
pub fn allowed_origins() -> Vec<String> {
    let mut set: Vec<String> = BASE_ORIGINS.iter().map(|s| (*s).to_owned()).collect();
    set.extend(SATELLITE_HOSTS.iter().map(|h| format!("https://{h}.pokoin.com")));
    for raw in std::env::var("POKOIN_CORS_EXTRA_ORIGINS").unwrap_or_default().split(',') {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        if let Ok(url) = url_origin(entry) {
            if !set.contains(&url) {
                set.push(url);
            }
        }
    }
    if matches!(std::env::var("NODE_ENV").as_deref(), Ok("development") | Ok("test")) {
        for dev in ["http://localhost:5173", "http://localhost:4173", "http://127.0.0.1:5173"] {
            set.push(dev.to_owned());
        }
    }
    set
}

/// `new URL(entry).origin` for http(s) URLs.
fn url_origin(entry: &str) -> Result<String, ()> {
    let (scheme, rest) = entry.split_once("://").ok_or(())?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    if host_port.is_empty() {
        return Err(());
    }
    let default_port = if scheme == "https" { ":443" } else { ":80" };
    let host_port = host_port.strip_suffix(default_port).unwrap_or(&host_port).to_owned();
    Ok(format!("{scheme}://{host_port}"))
}

fn first_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `corsHeaders(req)`.
pub fn cors_headers(request: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    let mut out: Vec<(HeaderName, HeaderValue)> = vec![
        (header::VARY, HeaderValue::from_static("Origin")),
        (header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS")),
        (header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400")),
    ];
    let origin = first_header(request, "origin").unwrap_or("");
    if !origin.is_empty() && origin != "null" && allowed_origins().iter().any(|o| o == origin) {
        if let Ok(v) = HeaderValue::from_str(origin) {
            out.push((header::ACCESS_CONTROL_ALLOW_ORIGIN, v));
            out.push((header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true")));
        }
    } else {
        out.push((header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*")));
    }
    let mut kept: Vec<String> = Vec::new();
    if let Some(requested) = first_header(request, "access-control-request-headers") {
        for raw in requested.split(',') {
            let token = raw.trim().to_ascii_lowercase();
            if token.is_empty() || kept.contains(&token) || kept.len() >= MAX_ALLOW_HEADERS {
                continue;
            }
            if token.len() > 64 || !token.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
                continue;
            }
            kept.push(token);
        }
    }
    let allow = if kept.is_empty() { DEFAULT_ALLOW_HEADERS.to_owned() } else { kept.join(",") };
    if let Ok(v) = HeaderValue::from_str(&allow) {
        out.push((header::ACCESS_CONTROL_ALLOW_HEADERS, v));
    }
    out
}

/// `mergeCorsIntoHeaders(headers, req)` applied to a response in place: the policy
/// is authoritative (handler access-control-* dropped), other Vary tokens are kept.
pub fn merge_cors(response: &mut HeaderMap, request: &HeaderMap) {
    let mut vary: Vec<String> = vec!["Origin".into()];
    for value in response.get_all(header::VARY).iter() {
        for token in value.to_str().unwrap_or("").split(',') {
            let t = token.trim();
            if !t.is_empty() && t != "*" && !t.eq_ignore_ascii_case("origin") && !vary.iter().any(|v| v == t) {
                vary.push(t.to_owned());
            }
        }
    }
    let names: Vec<HeaderName> = response.keys().filter(|k| k.as_str().starts_with("access-control-") || *k == header::VARY).cloned().collect();
    for name in names {
        response.remove(&name);
    }
    for (k, v) in cors_headers(request) {
        response.insert(k, v);
    }
    if let Ok(v) = HeaderValue::from_str(&vary.join(", ")) {
        response.insert(header::VARY, v);
    }
}

// ---- client IP -----------------------------------------------------------------

#[derive(Clone, Debug)]
struct Cidr {
    net: IpAddr,
    prefix: u8,
}

impl Cidr {
    fn contains(&self, ip: &IpAddr) -> bool {
        match (self.net, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => {
                let mask = if self.prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(self.prefix)) };
                u32::from(n) & mask == u32::from(*a) & mask
            }
            (IpAddr::V6(n), IpAddr::V6(a)) => {
                let mask = if self.prefix == 0 { 0 } else { u128::MAX << (128 - u32::from(self.prefix)) };
                u128::from(n) & mask == u128::from(*a) & mask
            }
            _ => false,
        }
    }
}

fn parse_cidrs(text: &str) -> Vec<Cidr> {
    let mut out = Vec::new();
    for raw in text.split(',') {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        let (addr, prefix) = entry.split_once('/').map(|(a, p)| (a, Some(p))).unwrap_or((entry, None));
        let Some(ip) = normalize_ip(addr) else {
            tracing::error!(entry, "invalid trusted proxy entry");
            continue;
        };
        let max = if ip.is_ipv6() { 128 } else { 32 };
        let prefix = match prefix {
            None => max,
            Some(p) => match p.parse::<u8>() {
                Ok(p) if p <= max => p,
                _ => {
                    tracing::error!(entry, "invalid trusted proxy entry");
                    continue;
                }
            },
        };
        out.push(Cidr { net: ip, prefix });
    }
    out
}

fn trusted_proxies() -> &'static Vec<Cidr> {
    static LIST: OnceLock<Vec<Cidr>> = OnceLock::new();
    LIST.get_or_init(|| {
        let text = std::env::var("POKOIN_TRUSTED_PROXY_CIDRS").unwrap_or_else(|_| "127.0.0.1/32,::1/128".into());
        parse_cidrs(&text)
    })
}

/// `normalizeIp(value)`.
pub fn normalize_ip(value: &str) -> Option<IpAddr> {
    let mut ip = value.trim();
    if ip.len() >= 2 && ip.starts_with('[') && ip.ends_with(']') {
        ip = ip[1..ip.len() - 1].trim();
    }
    let ip = ip.split('%').next().unwrap_or("").to_ascii_lowercase();
    let parsed: IpAddr = ip.parse().ok()?;
    if let IpAddr::V6(v6) = parsed {
        if let Some(v4) = v6.to_ipv4_mapped() {
            return Some(IpAddr::V4(v4));
        }
    }
    Some(parsed)
}

fn is_trusted(ip: &IpAddr, list: &[Cidr]) -> bool {
    list.iter().any(|c| c.contains(ip))
}

/// `resolveClientIp(req)` -> (ip, source).
pub fn resolve_client_ip(peer: Option<IpAddr>, headers: &HeaderMap) -> (String, &'static str) {
    resolve_with(peer, headers, trusted_proxies())
}

fn resolve_with(peer: Option<IpAddr>, headers: &HeaderMap, list: &[Cidr]) -> (String, &'static str) {
    let peer = peer.map(|p| normalize_ip(&p.to_string()).unwrap_or(p));
    let peer_text = peer.map(|p| p.to_string()).unwrap_or_else(|| "unknown".into());
    let Some(peer_ip) = peer.filter(|p| is_trusted(p, list)) else {
        return (peer_text, "peer");
    };
    let _ = peer_ip;
    if let Some(cf) = first_header(headers, "cf-connecting-ip") {
        if !cf.contains(',') {
            if let Some(ip) = normalize_ip(cf) {
                return (ip.to_string(), "cf-connecting-ip");
            }
        }
    }
    let xff: Vec<&str> = headers.get_all("x-forwarded-for").iter().filter_map(|v| v.to_str().ok()).collect();
    if !xff.is_empty() {
        let joined = xff.join(",");
        let entries: Vec<&str> = joined.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if entries.len() <= 20 {
            for entry in entries.iter().rev() {
                match normalize_ip(entry) {
                    Some(ip) if is_trusted(&ip, list) => continue,
                    Some(ip) => return (ip.to_string(), "x-forwarded-for"),
                    None => return (peer_text, "peer"),
                }
            }
        }
    }
    (peer_text, "peer")
}

const CLIENT_IP_HEADERS: [&str; 5] = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "true-client-ip", "x-client-ip"];

/// `applyTrustedClientIp(req)`: only the trusted answer reaches handlers.
pub fn apply_trusted_client_ip(peer: Option<IpAddr>, headers: &mut HeaderMap) -> String {
    let (ip, _source) = resolve_client_ip(peer, headers);
    for name in CLIENT_IP_HEADERS {
        headers.remove(name);
    }
    if let Ok(v) = HeaderValue::from_str(&ip) {
        for name in ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "x-pokoin-client-ip"] {
            headers.insert(HeaderName::from_static(name), v.clone());
        }
    }
    ip
}

/// `clientIp(req)` for handlers (the security layer stamped `x-pokoin-client-ip`).
pub fn client_ip(headers: &HeaderMap) -> String {
    first_header(headers, "x-pokoin-client-ip").filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(|| resolve_client_ip(None, headers).0)
}

// ---- cache-poisoning guard -------------------------------------------------------

/// `gameSelectedOutsideUrl(req)`.
pub fn game_selected_outside_url(uri: &Uri, headers: &HeaderMap) -> bool {
    let query = crate::http::Query::from_uri(uri);
    if query.has("game") {
        return false;
    }
    for name in ["x-pokoin-game", "x-pokoin-host", "x-forwarded-host", "x-original-host"] {
        if first_header(headers, name).is_some_and(|v| !v.trim().is_empty()) {
            return true;
        }
    }
    let origin = first_header(headers, "origin").unwrap_or("").trim();
    if !origin.is_empty() {
        if let Ok(o) = url_origin(origin) {
            let host = o.split("://").nth(1).unwrap_or("").split(':').next().unwrap_or("");
            return SATELLITE_HOSTS.iter().any(|s| host == format!("{s}.pokoin.com"));
        }
    }
    false
}

// ---- route limits ----------------------------------------------------------------

struct RouteLimit {
    method: Method,
    path: &'static str,
    scope: &'static str,
    limit: i64,
    window_seconds: i64,
}

fn route_limits() -> [RouteLimit; 3] {
    [
        RouteLimit { method: Method::POST, path: "/api/register-email", scope: "register-email-ip", limit: 10, window_seconds: 3600 },
        RouteLimit { method: Method::POST, path: "/api/verify-email-signup", scope: "verify-signup-ip", limit: 30, window_seconds: 3600 },
        RouteLimit { method: Method::POST, path: "/api/pokoin-assistant", scope: "pokoin-assistant-ip", limit: 20, window_seconds: 60 },
    ]
}

/// The request-security middleware (`prepareRequest` + `enforceRouteLimits` + the
/// securedWriteHead response pass). Apply it as the outermost API layer.
pub async fn security_layer(api: ApiState, mut req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    let ip = apply_trusted_client_ip(peer, req.headers_mut());
    let request_headers = req.headers().clone();
    if req.method() == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        for (k, v) in cors_headers(&request_headers) {
            response.headers_mut().insert(k, v);
        }
        return response;
    }
    let mut pathname = req.uri().path().to_owned();
    if pathname.len() > 1 && pathname.ends_with('/') {
        pathname.pop();
    }
    if let Some(entry) = route_limits().into_iter().find(|e| e.method == *req.method() && e.path == pathname) {
        let verdict = limits::limit_global(&api, entry.scope, &ip, entry.limit, entry.window_seconds).await;
        if !verdict.allowed || verdict.backend == "error" {
            let retry = if verdict.retry_after_sec > 0 { verdict.retry_after_sec } else { entry.window_seconds as u64 };
            let mut response = Response::new(Body::from(json!({"error": "Too many requests. Try again later.", "code": "rate_limited"}).to_string()));
            *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
            let h = response.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            h.insert(header::RETRY_AFTER, HeaderValue::from(retry));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            merge_cors(h, &request_headers);
            return response;
        }
    }
    let outside = game_selected_outside_url(req.uri(), &request_headers);
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    merge_cors(headers, &request_headers);
    if outside {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
        headers.insert(HeaderName::from_static("cdn-cache-control"), HeaderValue::from_static("no-store"));
    }
    response
}

/// `routeManifestEnabled()`.
pub fn route_manifest_enabled() -> bool {
    std::env::var("POKOIN_EXPOSE_ROUTE_MANIFEST").as_deref() == Ok("1")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(HeaderName::from_static(k), HeaderValue::from_static(v));
        }
        m
    }

    #[test]
    fn cors_policy() {
        let c = cors_headers(&h(&[("origin", "https://onepiece.pokoin.com")]));
        let get = |c: &Vec<(HeaderName, HeaderValue)>, k: &str| c.iter().find(|(n, _)| n == k).map(|(_, v)| v.to_str().unwrap().to_owned());
        assert_eq!(get(&c, "access-control-allow-origin").unwrap(), "https://onepiece.pokoin.com");
        assert_eq!(get(&c, "access-control-allow-credentials").unwrap(), "true");
        let c = cors_headers(&h(&[("origin", "https://evil.pokoin.com.example"), ("access-control-request-headers", "X-Foo, authorization,BAD_HEADER,x-foo")]));
        assert_eq!(get(&c, "access-control-allow-origin").unwrap(), "*");
        assert!(get(&c, "access-control-allow-credentials").is_none());
        assert_eq!(get(&c, "access-control-allow-headers").unwrap(), "x-foo,authorization");
        assert_eq!(get(&cors_headers(&h(&[("origin", "http://localhost:5173")])), "access-control-allow-origin").unwrap(), "*");
        let mut resp = h(&[("access-control-allow-origin", "*"), ("vary", "Accept-Encoding, origin")]);
        merge_cors(&mut resp, &h(&[("origin", "https://pokoin.com")]));
        assert_eq!(resp["access-control-allow-origin"], "https://pokoin.com");
        assert_eq!(resp["vary"], "Origin, Accept-Encoding");
    }

    #[test]
    fn client_ip_resolution() {
        let list = parse_cidrs("127.0.0.1/32,::1/128");
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(resolve_with(Some(lo), &h(&[("cf-connecting-ip", "203.0.113.9")]), &list).0, "203.0.113.9");
        assert_eq!(resolve_with(Some(lo), &h(&[("cf-connecting-ip", "1.1.1.1, 2.2.2.2"), ("x-forwarded-for", "9.9.9.9, 127.0.0.1")]), &list).0, "9.9.9.9");
        let outsider: IpAddr = "198.51.100.7".parse().unwrap();
        assert_eq!(resolve_with(Some(outsider), &h(&[("cf-connecting-ip", "1.2.3.4")]), &list), ("198.51.100.7".into(), "peer"));
        assert_eq!(normalize_ip("[::ffff:10.0.0.1]").unwrap().to_string(), "10.0.0.1");
        assert_eq!(resolve_with(Some(lo), &h(&[("x-forwarded-for", "garbage")]), &list).0, "127.0.0.1");
    }

    #[test]
    fn game_outside_url() {
        let u: Uri = "/api/x?q=1".parse().unwrap();
        assert!(game_selected_outside_url(&u, &h(&[("x-pokoin-game", "one_piece")])));
        assert!(game_selected_outside_url(&u, &h(&[("origin", "https://onepiece.pokoin.com")])));
        assert!(!game_selected_outside_url(&u, &h(&[("origin", "https://pokoin.com")])));
        let u: Uri = "/api/x?game=one_piece".parse().unwrap();
        assert!(!game_selected_outside_url(&u, &h(&[("x-pokoin-game", "one_piece")])));
    }
}
