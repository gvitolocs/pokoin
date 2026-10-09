//! `GET|HEAD /api/marketplace-card-url` — port of `marketplace-card-url.js`.

use std::sync::OnceLock;

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::{http, RouteState};
use regex::Regex;
use serde_json::{json, Value};
use sqlx::PgPool;

use super::util;
use crate::shared::{card_versions, js, slug, sql_json};

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Our id 248768 is Drifloon (ct_id 124384 * 2).
fn legacy_override(id: &str) -> Option<&'static str> {
    (id == "248768").then_some("124384")
}

/// `cleanLanguage(value)`.
pub fn clean_language(value: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let language = if value.is_empty() { "en".to_owned() } else { value.trim().to_lowercase() };
    if re(&R, r"^[a-z]{2}(?:-[a-z]{2})?$").is_match(&language) {
        language
    } else {
        "en".into()
    }
}

/// `cleanCardId(value)`: `Number(String(value || '').trim())` as a positive safe integer.
pub fn clean_card_id(value: &str) -> String {
    match http::js_number(value.trim()) {
        Some(n) if js::is_safe_integer(n) && n > 0.0 => js::number_to_string(n),
        _ => String::new(),
    }
}

fn clean_canonical_path(value: &str) -> String {
    let path = value.trim();
    if !path.starts_with("/marketplace/") || !path.contains("/cards/") {
        return String::new();
    }
    path.split(['?', '#']).next().unwrap_or("").to_owned()
}

fn canonical_slug_from_path(value: &str) -> String {
    let path = clean_canonical_path(value);
    if path.is_empty() {
        return String::new();
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.iter().position(|p| *p == "cards") {
        Some(i) if i + 2 < parts.len() => parts[i + 2..].join("-"),
        _ => String::new(),
    }
}

fn slugs_equivalent(left: &str, right: &str) -> bool {
    let l = slug::slug_parts(left);
    let r = slug::slug_parts(right);
    !l.is_empty() && !r.is_empty() && l.join("-") == r.join("-")
}

fn public_number_from_canonical_path(value: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let path = clean_canonical_path(value);
    re(&R, r"/cards/(\d+)(?:/|$)").captures(&path).and_then(|c| c.get(1)).map(|m| m.as_str().to_owned()).unwrap_or_default()
}

/// `parseRootCardPath(value)` -> (cardId, cardSlug).
pub fn parse_root_card_path(value: &str) -> (String, String) {
    static R: OnceLock<Regex> = OnceLock::new();
    if value.trim().is_empty() {
        return (String::new(), String::new());
    }
    let path = util::url_pathname(value);
    match re(&R, r"^/(\d+)(?:/([^/]+))?/?$").captures(&path) {
        Some(c) => (
            clean_card_id(c.get(1).map(|m| m.as_str()).unwrap_or("")),
            util::decode_component(c.get(2).map(|m| m.as_str()).unwrap_or("")).trim().to_owned(),
        ),
        None => (String::new(), String::new()),
    }
}

/// `parseMarketplaceCardPath(value)` -> (language, doubledCardId, cardSlug).
fn parse_marketplace_card_path(value: &str) -> (String, String, String) {
    static R: OnceLock<Regex> = OnceLock::new();
    if value.trim().is_empty() {
        return (String::new(), String::new(), String::new());
    }
    let path = util::url_pathname(value);
    match re(&R, r"(?i)^/marketplace/([a-z]{2}(?:-[a-z]{2})?)/cards/(\d+)(?:/(.+))?/?$").captures(&path) {
        Some(c) => (
            clean_language(c.get(1).map(|m| m.as_str()).unwrap_or("")),
            clean_card_id(c.get(2).map(|m| m.as_str()).unwrap_or("")),
            util::decode_component(c.get(3).map(|m| m.as_str()).unwrap_or("")).trim().to_owned(),
        ),
        None => (String::new(), String::new(), String::new()),
    }
}

fn parse_marketplace_public_short_path(value: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    if value.trim().is_empty() {
        return String::new();
    }
    let path = util::url_pathname(value);
    re(&R, r"(?i)^/marketplace/(\d+)/?$").captures(&path).map(|c| clean_card_id(&c[1])).unwrap_or_default()
}

/// Inputs of `canonicalCardUrlForLookup`.
#[derive(Clone, Debug, Default)]
pub struct Lookup {
    pub card_id: String,
    pub card_slug: String,
    pub path: String,
    pub language: String,
    pub doubled_card_id: String,
    pub url_card_id: String,
}

fn path_public_number(l: &Lookup) -> String {
    [clean_card_id(&l.doubled_card_id), clean_card_id(&l.url_card_id), parse_marketplace_card_path(&l.path).1, parse_marketplace_public_short_path(&l.path), parse_root_card_path(&l.path).0]
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}

fn doubled(id: &str) -> String {
    card_versions::card_id_from_doubled_id(Some(&Value::String(id.to_owned())))
}

fn candidate_card_ids(l: &Lookup) -> Vec<String> {
    let direct = clean_card_id(&l.card_id);
    let path_our_id = path_public_number(l);
    let ct_from_path = if path_our_id.is_empty() { String::new() } else { doubled(&path_our_id) };
    let legacy = legacy_override(&direct).or_else(|| legacy_override(&path_our_id)).unwrap_or("").to_owned();
    let mut out: Vec<String> = Vec::new();
    for id in [path_our_id, direct, ct_from_path, legacy] {
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

const LOOKUP_SQL: &str = "
      select card_id, language, canonical_path, public_number
      from public.marketplace_card_urls
      where (
          card_id = any($1::bigint[])
          or ct_id = any($1::bigint[])
          or (nullif($3::text, '') is not null and public_number = $3::bigint)
          or (nullif($3::text, '') is not null and canonical_path like '%/cards/' || $3::text || '/%')
        )
        and language = $2
      order by
        case
          when nullif($3::text, '') is not null and public_number = $3::bigint then 0
          when $3::text <> '' and canonical_path like '%/cards/' || $3::text || '/%' then 1
          else 2
        end,
        array_position($1::bigint[], card_id)
    ";

fn found(row: &Value, fallback_lang: &str) -> Value {
    let canonical = clean_canonical_path(&js::string_or_empty(js::get(row, "canonical_path")));
    let language = js::string_or_empty(js::get(row, "language"));
    json!({
        "cardId": js::string_or_empty(js::get(row, "card_id")),
        "language": if language.is_empty() { fallback_lang.to_owned() } else { language },
        "canonicalPath": canonical,
        "publicNumber": public_number_from_canonical_path(&js::string_or_empty(js::get(row, "canonical_path"))),
    })
}

/// `canonicalCardUrlForLookup(lookup)`.
pub async fn canonical_card_url_for_lookup(pool: &PgPool, l: &Lookup) -> Result<Option<Value>, sqlx::Error> {
    let candidates = candidate_card_ids(l);
    if candidates.is_empty() {
        return Ok(None);
    }
    let (path_lang, _, path_slug) = parse_marketplace_card_path(&l.path);
    let lang = clean_language(if l.language.is_empty() { &path_lang } else { &l.language });
    let requested_slug = [l.card_slug.clone(), path_slug, parse_root_card_path(&l.path).1]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default()
        .trim()
        .to_owned();
    let numeric: Vec<i64> = candidates.iter().filter_map(|id| id.parse().ok()).collect();
    let requested_url_id = path_public_number(l);
    let decoded_requested = doubled(&requested_url_id);
    let rows = sql_json::rows_json(
        pool,
        LOOKUP_SQL,
        &[sql_json::SqlBind::BigIntArray(numeric), sql_json::SqlBind::Text(lang.clone()), sql_json::SqlBind::Text(requested_url_id.clone())],
    )
    .await?;
    let canonical_of = |row: &Value| clean_canonical_path(&js::string_or_empty(js::get(row, "canonical_path")));
    if !requested_url_id.is_empty() {
        let segment = format!("/cards/{requested_url_id}/");
        if let Some(path_matched) = rows.iter().find(|row| canonical_of(row).contains(&segment)) {
            let matched_slug = canonical_slug_from_path(&canonical_of(path_matched));
            if !requested_slug.is_empty() && !matched_slug.is_empty() && !decoded_requested.is_empty() && !slugs_equivalent(&requested_slug, &matched_slug) {
                // `row.ct_id` is never selected, so only card_id can match here.
                let by_decoded = rows.iter().find(|row| {
                    let id = js::string_or_empty(js::get(row, "card_id"));
                    id == decoded_requested || id == requested_url_id
                });
                if let Some(row) = by_decoded.filter(|row| !canonical_of(row).is_empty()) {
                    return Ok(Some(found(row, &lang)));
                }
            }
            return Ok(Some(found(path_matched, &lang)));
        }
    }
    for id in &candidates {
        if let Some(row) = rows.iter().rev().find(|row| !canonical_of(row).is_empty() && js::string_or_empty(js::get(row, "card_id")) == *id) {
            // Map semantics: the last row with that card_id wins.
            return Ok(Some(found(row, &lang)));
        }
    }
    Ok(rows.iter().find(|row| !canonical_of(row).is_empty()).map(|row| found(row, &lang)))
}

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return util::method_not_allowed("GET, HEAD");
    }
    let q = http::Query::from_uri(&uri);
    let text = |k: &str| q.search_param(k).unwrap_or("").to_owned();
    let lookup = Lookup {
        card_id: text("cardId"),
        card_slug: util::first_of(&q, &["cardSlug", "slug"]).unwrap_or("").to_owned(),
        path: text("path"),
        language: util::first_of(&q, &["language", "lang"]).unwrap_or("").to_owned(),
        doubled_card_id: text("doubledCardId"),
        url_card_id: text("urlCardId"),
    };
    match canonical_card_url_for_lookup(state.api.read(), &lookup).await {
        Ok(Some(found)) => util::json_cache(StatusCode::OK, found, "public, max-age=60, s-maxage=300"),
        Ok(None) => http::json(StatusCode::NOT_FOUND, json!({ "error": "Marketplace card URL not found." })),
        Err(error) => util::db_error("marketplace-card-url", &error, "Marketplace card URL lookup failed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsing_matches_node() {
        assert_eq!(clean_card_id(" 239324 "), "239324");
        assert_eq!(clean_card_id("0"), "");
        assert_eq!(clean_card_id("abc"), "");
        assert_eq!(clean_language("IT"), "it");
        assert_eq!(clean_language("italian"), "en");
        assert_eq!(parse_root_card_path("/239324/gambler"), ("239324".into(), "gambler".into()));
        assert_eq!(parse_marketplace_card_path("/marketplace/it/cards/239324/card-x").1, "239324");
        assert_eq!(parse_marketplace_public_short_path("/marketplace/239324"), "239324");
        let l = Lookup { card_id: "248768".into(), ..Default::default() };
        assert_eq!(candidate_card_ids(&l), vec!["248768", "124384"]);
        let l = Lookup { path: "/marketplace/en/cards/239324/x".into(), ..Default::default() };
        assert_eq!(candidate_card_ids(&l), vec!["239324", "119662"]);
        assert_eq!(canonical_slug_from_path("/marketplace/en/cards/239324/card-gambler-060"), "card-gambler-060");
        assert_eq!(public_number_from_canonical_path("/marketplace/en/cards/239324/x"), "239324");
    }
}
