//! `GET|HEAD /api/marketplace-card-shortlink` — port of `marketplace-card-shortlink.js`.

use std::sync::OnceLock;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use pokoin_api_common::{http, RouteState};
use regex::Regex;
use serde_json::{json, Value};
use sqlx::PgPool;

use super::card_url::{self, Lookup};
use super::util;
use crate::shared::{canonical_path, js, sql_json};

fn root_path_id_with_slug(value: &str) -> i64 {
    static R: OnceLock<Regex> = OnceLock::new();
    if value.trim().is_empty() {
        return 0;
    }
    let path = util::url_pathname(value);
    let re = R.get_or_init(|| Regex::new(r"^/(\d+)/([^/]+)/?$").expect("valid regex"));
    match re.captures(&path) {
        Some(c) if !c[2].trim().is_empty() => canonical_path::clean_card_id(Some(&Value::String(c[1].to_owned()))),
        _ => 0,
    }
}

async fn canonical_path_for_card_id(pool: &PgPool, card_id: i64) -> Result<String, sqlx::Error> {
    if card_id == 0 {
        return Ok(String::new());
    }
    let lookup = Lookup { card_id: card_id.to_string(), ..Default::default() };
    if let Some(found) = card_url::canonical_card_url_for_lookup(pool, &lookup).await? {
        let path = js::string_or_empty(js::get(&found, "canonicalPath"));
        if !path.is_empty() {
            return Ok(path);
        }
    }
    let row = sql_json::row_json(
        pool,
        "
      select
        card_id,
        canonical_path,
        name,
        set_name,
        card_number,
        rarity
      from public.marketplace_card_urls
      where (card_id = $1::bigint or public_number = $1::bigint or ct_id = $1::bigint)
        and language = 'en'
      order by (card_id = $1::bigint) desc
      limit 1
    ",
        &[sql_json::SqlBind::Int(card_id)],
    )
    .await?;
    Ok(row.map(|row| canonical_path::canonical_path_for_row(&row)).unwrap_or_default())
}

async fn canonical_path_for_shortlink_path(pool: &PgPool, path: &str, language: &str) -> Result<String, sqlx::Error> {
    let lookup = Lookup { path: path.to_owned(), language: language.to_owned(), ..Default::default() };
    if let Some(found) = card_url::canonical_card_url_for_lookup(pool, &lookup).await? {
        let path = js::string_or_empty(js::get(&found, "canonicalPath"));
        if !path.is_empty() {
            return Ok(path);
        }
    }
    let root_id = root_path_id_with_slug(path);
    if root_id == 0 || root_id % 2 != 0 {
        return Ok(String::new());
    }
    let lookup = Lookup { url_card_id: root_id.to_string(), ..lookup };
    Ok(card_url::canonical_card_url_for_lookup(pool, &lookup)
        .await?
        .map(|found| js::string_or_empty(js::get(&found, "canonicalPath")))
        .unwrap_or_default())
}

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return util::method_not_allowed("GET, HEAD");
    }
    let q = http::Query::from_uri(&uri);
    let card_id = canonical_path::clean_card_id(q.search_param("cardId").map(|v| Value::String(v.to_owned())).as_ref());
    let language = util::first_of(&q, &["language", "lang"]).unwrap_or("");
    let requested_path = q.search_param("path").filter(|p| !p.is_empty());
    let pool = state.api.read();
    let path = match requested_path {
        Some(p) => canonical_path_for_shortlink_path(pool, p, language).await,
        None => canonical_path_for_card_id(pool, card_id).await,
    };
    match path {
        Ok(path) if path.is_empty() => http::json(StatusCode::NOT_FOUND, json!({ "error": "Card shortlink not found." })),
        Ok(path) => {
            let mut response = (StatusCode::FOUND, Body::empty()).into_response();
            let headers = response.headers_mut();
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=60, s-maxage=300"));
            if let Ok(location) = HeaderValue::from_str(&path) {
                headers.insert(header::LOCATION, location);
            }
            response
        }
        Err(error) => util::db_error("marketplace-card-shortlink", &error, "Marketplace card shortlink failed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_ids() {
        assert_eq!(root_path_id_with_slug("/239324/gambler"), 239324);
        assert_eq!(root_path_id_with_slug("/239324"), 0);
        assert_eq!(root_path_id_with_slug("https://pokoin.com/12/x/"), 12);
    }
}
