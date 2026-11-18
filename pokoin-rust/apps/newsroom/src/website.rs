use crate::{array, store, text};
use axum::{
    extract::{OriginalUri, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use serde_json::{json, Value};
use std::path::PathBuf;
#[derive(Clone)]
pub struct Website {
    pub data_dir: PathBuf,
    pub legacy_data_dir: PathBuf,
    pub export_token: String,
}
fn public_article(a: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in [
        "slug",
        "headline",
        "dek",
        "body",
        "author",
        "datePublished",
        "dateModified",
        "sources",
        "tags",
        "confidence",
        "reporterStyleVersion",
    ] {
        if let Some(v) = a.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(v) = a.get("canonical_story_id") {
        out.insert("canonicalStoryId".into(), v.clone());
    }
    out.insert(
        "updateHistory".into(),
        a.get("updateHistory")
            .filter(|v| !v.is_null() && **v != false)
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    Value::Object(out)
}
pub fn answer(config: &Website, method: &str, query: &str, auth: &str) -> (u16, Value) {
    if method != "GET" {
        return (405, json!({"error":"method_not_allowed"}));
    }
    let pairs: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
    let param = |key: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
            .unwrap_or("")
    };
    let scope = param("export");
    if !scope.is_empty() {
        if !["published", "all"].contains(&scope) {
            return (400, json!({"error":"export must be published or all"}));
        }
        if scope == "all"
            && (config.export_token.is_empty() || auth != format!("Bearer {}", config.export_token))
        {
            return (401, json!({"error":"unauthorized"}));
        }
        let records = store::export_records(
            &store::load_array(&config.data_dir.join(store::RECORDS)),
            scope,
            true,
        );
        return (
            200,
            json!({"ok":true,"scope":scope,"count":records.len(),"articles":records}),
        );
    }
    let mut articles = store::load_array(&config.legacy_data_dir.join("newsroom-articles.json"));
    let slug = param("slug");
    if !slug.is_empty() {
        return articles
            .iter()
            .find(|a| text(a, "slug") == slug)
            .map(|a| (200, json!({"ok":true,"article":public_article(a)})))
            .unwrap_or((404, json!({"error":"not_found"})));
    }
    let story = param("story");
    if !story.is_empty() {
        let matching: Vec<_> = articles
            .iter()
            .filter(|a| text(a, "canonical_story_id") == story)
            .map(public_article)
            .collect();
        return (
            200,
            json!({"ok":true,"count":matching.len(),"articles":matching}),
        );
    }
    let date = |a: &Value| {
        let m = text(a, "dateModified");
        if m.is_empty() {
            text(a, "datePublished").to_owned()
        } else {
            m.to_owned()
        }
    };
    articles.sort_by_key(|b| std::cmp::Reverse(date(b)));
    (
        200,
        json!({"ok":true,"count":articles.len(),"articles":array(&Value::Array(articles.clone())).iter().take(50).map(public_article).collect::<Vec<_>>()}),
    )
}
async fn handler(
    State(config): State<Website>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let (status, body) = answer(
        &config,
        method.as_str(),
        uri.query().unwrap_or(""),
        headers
            .get("authorization")
            .and_then(|s| s.to_str().ok())
            .unwrap_or(""),
    );
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [
            ("content-type", "application/json"),
            ("access-control-allow-origin", "*"),
            ("cache-control", "public, max-age=60"),
        ],
        serde_json::to_string(&body).unwrap_or_default(),
    )
        .into_response()
}
pub fn router(config: Website) -> Router {
    Router::new()
        .route("/api/poko/news", any(handler))
        .with_state(config)
}
