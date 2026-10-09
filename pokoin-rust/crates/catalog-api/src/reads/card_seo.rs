//! `GET /api/marketplace-card-seo` — port of `marketplace-card-seo.js` (bot HTML).
//!
//! Deviation: absolute URLs use the request `Host` like the JS, but the native
//! edge forwards the public host, so the canonical link is
//! `https://api.pokoin.com/...` instead of the Node edge's leaked
//! `https://127.0.0.1:18080/...`.

use std::sync::OnceLock;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use pokoin_api_common::{http, RouteState};
use regex::Regex;
use serde_json::{json, Value};
use sqlx::PgPool;

use super::util;
use crate::shared::{card_versions, js, slug};

const BOT_CACHE_CONTROL: &str = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
const DEFAULT_IMAGE: &str = "https://pokoin.com/pokoin-project-banner-1360x430.png";
const CARD_IMAGE_ORIGIN: &str = "https://pokoin.com";
const CARD_IMAGE_PREFIX: &str = "/card-images";
const CDN_IMAGE_HOST: &str = "cdn.pokoin.com";

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn field(row: &Value, key: &str) -> String {
    js::string_or_empty(js::get(row, key))
}

fn first_non_empty(values: &[String]) -> String {
    values.iter().map(|v| v.trim()).find(|v| !v.is_empty()).unwrap_or("").to_owned()
}

/// `(scheme, host, path+query)` of an absolute http(s) URL.
fn split_absolute(text: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = text.split_once("://")?;
    if !scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') || scheme.is_empty() {
        return None;
    }
    let cut = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = rest[..cut].to_owned();
    if host.is_empty() {
        return None;
    }
    let tail = &rest[cut..];
    let tail = if tail.starts_with('/') { tail.to_owned() } else { format!("/{tail}") };
    Some((scheme.to_ascii_lowercase(), host, tail))
}

fn absolute_url(headers: &HeaderMap, value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    if let Some((scheme, host, tail)) = split_absolute(text) {
        return format!("{scheme}://{}{tail}", host.to_ascii_lowercase());
    }
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("pokoin.com");
    let path = if text.starts_with('/') { text.to_owned() } else { format!("/{text}") };
    format!("https://{host}{path}")
}

fn card_image_proxy_url(pathname: &str, search: &str) -> String {
    let mut path = pathname.trim().to_owned();
    if path.is_empty() {
        return String::new();
    }
    if !path.starts_with('/') {
        path = format!("/{path}");
    }
    while path == CARD_IMAGE_PREFIX || path.starts_with(&format!("{CARD_IMAGE_PREFIX}/")) {
        path = path[CARD_IMAGE_PREFIX.len()..].to_owned();
        if path.is_empty() {
            path = "/".into();
        }
    }
    format!("{CARD_IMAGE_ORIGIN}{CARD_IMAGE_PREFIX}{path}{search}")
}

fn public_card_image_url(value: &str) -> String {
    let clean = value.trim();
    if clean.is_empty() {
        return String::new();
    }
    if let Some((_, host, tail)) = split_absolute(clean) {
        let (path, search) = match tail.find('?') {
            Some(i) => (tail[..i].to_owned(), tail[i..].split('#').next().unwrap_or("").to_owned()),
            None => (tail.split('#').next().unwrap_or("").to_owned(), String::new()),
        };
        let host = host.to_ascii_lowercase();
        if host == CDN_IMAGE_HOST || (host == "pokoin.com" && (path == CARD_IMAGE_PREFIX || path.starts_with(&format!("{CARD_IMAGE_PREFIX}/")))) {
            return card_image_proxy_url(&path, &search);
        }
        return clean.to_owned();
    }
    if clean == CARD_IMAGE_PREFIX || clean.starts_with(&format!("{CARD_IMAGE_PREFIX}/")) {
        return card_image_proxy_url(clean, "");
    }
    if clean.starts_with("card-images/") {
        return card_image_proxy_url(&format!("/{clean}"), "");
    }
    clean.to_owned()
}

fn preferred_card_image(row: &Value) -> String {
    public_card_image_url(&first_non_empty(&[
        field(row, "cdn_image_url"),
        field(row, "image_url"),
        field(row, "homepage_image_url"),
        field(row, "preview_image_url"),
        DEFAULT_IMAGE.to_owned(),
    ]))
}

fn image_type_for_url(value: &str) -> &'static str {
    let clean = value.trim().to_lowercase();
    let clean = clean.split(['?', '#']).next().unwrap_or("");
    if clean.ends_with(".jpg") || clean.ends_with(".jpeg") {
        "image/jpeg"
    } else if clean.ends_with(".png") {
        "image/png"
    } else if clean.ends_with(".webp") {
        "image/webp"
    } else if clean.ends_with(".gif") {
        "image/gif"
    } else {
        ""
    }
}

pub fn canonical_slug_for_card(row: &Value) -> String {
    [
        first_non_empty(&[field(row, "rarity"), "Card".into()]),
        field(row, "name"),
        first_non_empty(&[field(row, "expansion_number"), field(row, "card_number")]),
        first_non_empty(&[field(row, "expansion_name"), field(row, "set_name")]),
    ]
    .iter()
    .map(|p| slug::slug_part(p))
    .filter(|p| !p.is_empty())
    .collect::<Vec<_>>()
    .join("-")
}

pub fn canonical_path_for_card(row: &Value) -> String {
    let stored = first_non_empty(&[field(row, "canonical_path"), field(row, "canonicalPath")]);
    if stored.starts_with("/marketplace/") && stored.contains("/cards/") {
        return stored;
    }
    let id = first_non_empty(&[field(row, "card_id"), field(row, "id")]);
    let slug = canonical_slug_for_card(row);
    let n = http::js_number(&id).unwrap_or(f64::NAN);
    if !js::is_safe_integer(n) || n <= 0.0 || slug.is_empty() {
        return String::new();
    }
    let n = n as i64;
    let our_id = if n % 2 == 1 { n * 2 } else { n };
    format!("/marketplace/en/cards/{our_id}/{slug}")
}

pub fn card_title(row: &Value) -> String {
    let name = first_non_empty(&[field(row, "name"), "Pokémon card".into()]);
    let suffix = [field(row, "expansion_name"), field(row, "expansion_number")]
        .iter()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if suffix.is_empty() {
        format!("{name} | Pokoin Card Reserve")
    } else {
        format!("{name} - {suffix} | Pokoin Card Reserve")
    }
}

pub fn card_description(row: &Value) -> String {
    let name = first_non_empty(&[field(row, "name"), "this Pokémon card".into()]);
    let set_name = first_non_empty(&[field(row, "expansion_name"), field(row, "set_name")]);
    // `[row.rarity, row.expansion_number, setName].filter(Boolean)` (untrimmed).
    let details = [field(row, "rarity"), field(row, "expansion_number"), set_name]
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" - ");
    let sentence = if details.is_empty() { name } else { format!("{name} ({details})") };
    format!("Buy now {sentence}. Pokoin Card Reserve offers a safe and collector-friendly way to browse Pokémon cards, compare seller listings, and use PKN wallet settlement.")
}

pub fn html_for_card(headers: &HeaderMap, row: &Value, canonical_path: &str) -> String {
    let canonical = escape_html(&absolute_url(headers, canonical_path));
    let image_url = absolute_url(headers, &preferred_card_image(row));
    let title = escape_html(&card_title(row));
    let description = escape_html(&card_description(row));
    let image = escape_html(&image_url);
    let image_type = escape_html(image_type_for_url(&image_url));
    let type_meta = if image_type.is_empty() { String::new() } else { format!("<meta property=\"og:image:type\" content=\"{image_type}\">") };
    let alt_image = escape_html(&first_non_empty(&[field(row, "name"), "Pokoin card image".into()]));
    let alt_card = escape_html(&first_non_empty(&[field(row, "name"), "Pokoin card".into()]));
    format!(
        "<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"UTF-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
  <meta name=\"description\" content=\"{description}\">
  <meta name=\"robots\" content=\"index, follow, max-image-preview:large, max-snippet:-1\">
  <link rel=\"canonical\" href=\"{canonical}\">
  <meta property=\"og:type\" content=\"product\">
  <meta property=\"og:site_name\" content=\"Pokoin Card Reserve\">
  <meta property=\"og:title\" content=\"{title}\">
  <meta property=\"og:description\" content=\"{description}\">
  <meta property=\"og:url\" content=\"{canonical}\">
  <meta property=\"og:image\" content=\"{image}\">
  <meta property=\"og:image:secure_url\" content=\"{image}\">
  {type_meta}
  <meta property=\"og:image:width\" content=\"734\">
  <meta property=\"og:image:height\" content=\"1024\">
  <meta property=\"og:image:alt\" content=\"{alt_image}\">
  <meta name=\"twitter:card\" content=\"summary_large_image\">
  <meta name=\"twitter:title\" content=\"{title}\">
  <meta name=\"twitter:description\" content=\"{description}\">
  <meta name=\"twitter:image\" content=\"{image}\">
  <meta name=\"twitter:image:alt\" content=\"{alt_image}\">
  <link rel=\"icon\" href=\"/favicon.ico\" sizes=\"any\">
  <link rel=\"icon\" type=\"image/png\" sizes=\"32x32\" href=\"/favicon-32x32.png\">
  <link rel=\"manifest\" href=\"/manifest.json\">
  <title>{title}</title>
</head>
<body>
  <main>
    <h1>{title}</h1>
    <p>{description}</p>
    <p><a href=\"{canonical}\">Open this card on Pokoin Card Reserve</a></p>
    <img src=\"{image}\" alt=\"{alt_card}\" style=\"max-width: 320px; height: auto;\">
  </main>
  <script src=\"/seo-bootstrap.js\" defer></script>
</body>
</html>"
    )
}

#[derive(Debug, Default, PartialEq)]
pub struct CardRoute {
    pub card_id: String,
    pub card_slug: String,
    pub decoded_from_doubled_id: bool,
}

fn parse_marketplace_card_parts(parts: &[String]) -> CardRoute {
    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    let Some(cards) = parts.iter().position(|p| p == "cards") else { return CardRoute::default() };
    if cards + 1 >= parts.len() {
        return CardRoute::default();
    }
    let first = util::decode_component(&parts[cards + 1]);
    let rest: Vec<&str> = parts[cards + 2..].iter().map(String::as_str).filter(|p| !p.is_empty() && *p != "versions").collect();
    let rest_slug = util::decode_component(&rest.join("-"));
    let re = NUMERIC.get_or_init(|| Regex::new(r"^(\d+)(?:-(.*))?$").expect("valid regex"));
    if let Some(c) = re.captures(&first) {
        let numeric = c[1].to_owned();
        let inline = c.get(2).map(|m| m.as_str().to_owned()).unwrap_or_default();
        let card_slug = if rest_slug.is_empty() { inline.clone() } else { rest_slug.clone() };
        if !rest_slug.is_empty() {
            let (card_id, card_slug) = card_versions::resolve_card_route("", &card_slug, &numeric);
            return CardRoute { card_id, card_slug, decoded_from_doubled_id: true };
        }
        if !inline.is_empty() {
            let (card_id, card_slug) = card_versions::resolve_card_route(&numeric, &card_slug, "");
            return CardRoute { card_id, card_slug, decoded_from_doubled_id: false };
        }
        return CardRoute { card_id: numeric, card_slug, decoded_from_doubled_id: false };
    }
    CardRoute {
        card_id: String::new(),
        card_slug: [first, rest_slug].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-"),
        decoded_from_doubled_id: false,
    }
}

/// `parseCardRoute(url)` — the request path is the API path, so only the query forms apply.
pub fn parse_card_route(q: &http::Query, pathname: &str) -> CardRoute {
    if let Some(card_path) = q.search_param("cardPath").filter(|v| !v.is_empty()) {
        let mut parts = vec!["marketplace".to_owned(), util::first_of(q, &["language"]).unwrap_or("en").to_owned(), "cards".to_owned()];
        parts.extend(card_path.split('/').filter(|p| !p.is_empty()).map(str::to_owned));
        return parse_marketplace_card_parts(&parts);
    }
    let query_card_id = q.search_param("cardId").unwrap_or("").trim().to_owned();
    let query_slug = util::first_of(q, &["cardSlug", "slug"]).unwrap_or("").trim().to_owned();
    if !query_card_id.is_empty() && query_card_id.bytes().all(|b| b.is_ascii_digit()) {
        return CardRoute { card_id: query_card_id, card_slug: query_slug, decoded_from_doubled_id: false };
    }
    static ROOT: OnceLock<Regex> = OnceLock::new();
    let root = ROOT.get_or_init(|| Regex::new(r"^/(\d+)(?:/([^/?#]+))?/?$").expect("valid regex"));
    if let Some(c) = root.captures(pathname) {
        return CardRoute { card_id: c[1].to_owned(), card_slug: util::decode_component(c.get(2).map(|m| m.as_str()).unwrap_or("")), decoded_from_doubled_id: false };
    }
    let parts: Vec<String> = pathname.split('/').filter(|p| !p.is_empty()).map(str::to_owned).collect();
    parse_marketplace_card_parts(&parts)
}

async fn versions(pool: &PgPool, card_id: &str, card_slug: &str) -> Result<Vec<Value>, sqlx::Error> {
    let args = card_versions::RowsForVersionsArgs {
        card_id: card_id.to_owned(),
        card_slug: card_slug.to_owned(),
        limit: 1,
        search_language: "en".into(),
        ..Default::default()
    };
    card_versions::rows_for_versions(pool, &args).await
}

/// `rowsForCardPreview(route)`.
async fn rows_for_card_preview(pool: &PgPool, route: &CardRoute) -> Result<Vec<Value>, sqlx::Error> {
    if route.decoded_from_doubled_id && !route.card_id.is_empty() {
        let rows = versions(pool, &route.card_id, "").await?;
        if !rows.is_empty() {
            return Ok(rows);
        }
    }
    let rows = versions(pool, &route.card_id, &route.card_slug).await?;
    if !rows.is_empty() || route.card_id.is_empty() || route.card_slug.is_empty() {
        return Ok(rows);
    }
    let id_only = versions(pool, &route.card_id, "").await?;
    if !id_only.is_empty() {
        return Ok(id_only);
    }
    let decoded = card_versions::card_id_from_doubled_id(Some(&Value::String(route.card_id.clone())));
    if decoded.is_empty() || decoded == route.card_id {
        return Ok(Vec::new());
    }
    versions(pool, &decoded, &route.card_slug).await
}

fn html(status: StatusCode, body: String) -> Response {
    let mut response = (status, Body::from(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(BOT_CACHE_CONTROL));
    response
}

pub async fn handler(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri) -> Response {
    if method != Method::GET {
        return http::raw(StatusCode::METHOD_NOT_ALLOWED, "text/plain; charset=utf-8", "Method not allowed", &[("allow", "GET")]);
    }
    let q = http::Query::from_uri(&uri);
    let route = parse_card_route(&q, uri.path());
    match rows_for_card_preview(state.api.read(), &route).await {
        Ok(rows) => match rows.first() {
            None => html(
                StatusCode::NOT_FOUND,
                html_for_card(&headers, &json!({"name": "Pokoin Card Reserve", "preview_image_url": DEFAULT_IMAGE}), uri.path()),
            ),
            Some(card) => {
                let path = canonical_path_for_card(card);
                let path = if path.is_empty() { uri.path().to_owned() } else { path };
                html(StatusCode::OK, html_for_card(&headers, card, &path))
            }
        },
        Err(error) => {
            tracing::error!(%error, "marketplace-card-seo failed");
            http::raw(StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", "Marketplace card preview failed.", &[])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_and_text() {
        assert_eq!(public_card_image_url("https://cdn.pokoin.com/1_a.jpg?v=2"), "https://pokoin.com/card-images/1_a.jpg?v=2");
        assert_eq!(public_card_image_url("/card-images/card-images/1_a.jpg"), "https://pokoin.com/card-images/1_a.jpg");
        assert_eq!(public_card_image_url("card-images/1_a.jpg"), "https://pokoin.com/card-images/1_a.jpg");
        let row = json!({"name": "Gambler", "expansion_name": "Fossil", "expansion_number": "060/062", "rarity": "Common", "card_id": "239324"});
        assert_eq!(card_title(&row), "Gambler - Fossil 060/062 | Pokoin Card Reserve");
        assert!(card_description(&row).starts_with("Buy now Gambler (Common - 060/062 - Fossil)."));
        assert_eq!(image_type_for_url("https://x/y.JPG?z"), "image/jpeg");
    }

    #[test]
    fn routes() {
        let q = http::Query::parse("cardPath=239324/card-gambler&language=en");
        assert_eq!(parse_card_route(&q, "/api/marketplace-card-seo").decoded_from_doubled_id, true);
        let q = http::Query::parse("cardId=239324&slug=x");
        assert_eq!(parse_card_route(&q, "/api/marketplace-card-seo"), CardRoute { card_id: "239324".into(), card_slug: "x".into(), decoded_from_doubled_id: false });
    }
}
