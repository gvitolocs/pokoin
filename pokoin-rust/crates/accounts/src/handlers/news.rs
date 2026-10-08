//! `news-comments` — Pokoin News reader comments.
//!
//! GET is public and returns visible comments oldest-first, plus the caller's
//! own pending/held comments when signed in. POST stores a `pending` comment
//! and answers 202: nothing a reader writes is visible before moderation.
//! Stored one document per comment in Firestore `news_comments`, queried by
//! `articleId` only so no composite index is needed.

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::{DocData, Query as FirestoreQuery};
use crate::rate_limit::RateLimitRequest;
use crate::state::DomainState;

use super::{
    json_cached, json_with_cors, method_not_allowed, ok, optional_claims, parse_body,
    require_claims, string_field,
};

pub const COLLECTION: &str = "news_comments";
const MIN_BODY: usize = 2;
const MAX_BODY: usize = 1500;
const MAX_READ: i64 = 500;
const RATE_LIMIT: i64 = 5;
const RATE_WINDOW_SECONDS: u64 = 600;

/// `^art_[A-Za-z0-9_-]{4,120}$`.
pub fn is_article_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("art_") else {
        return false;
    };
    (4..=120).contains(&rest.len())
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `^\/(?:[a-z0-9-]+\/)?news\/[a-z0-9]+(?:-[a-z0-9]+)*$`.
pub fn is_article_path(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let slug = match segments.as_slice() {
        // /news/slug
        ["news", slug] => *slug,
        // /<prefix>/news/slug
        [prefix, "news", slug]
            if !prefix.is_empty()
                && prefix.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                }) =>
        {
            *slug
        }
        _ => return false,
    };
    if slug.is_empty() {
        return false;
    }
    slug.split('-').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

/// `cleanBody`: normalize CRLF, drop control characters, collapse 3+ newlines.
pub fn clean_body(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let filtered: String = normalized
        .chars()
        .filter(|character| {
            let code = *character as u32;
            !matches!(code, 0x00..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F | 0x7F)
        })
        .collect();
    // Collapse runs of three or more newlines to exactly two.
    let mut out = String::with_capacity(filtered.len());
    let mut pending_newlines = 0usize;
    for character in filtered.chars() {
        if character == '\n' {
            pending_newlines += 1;
            continue;
        }
        if pending_newlines > 0 {
            let keep = pending_newlines.min(2);
            for _ in 0..keep {
                out.push('\n');
            }
            pending_newlines = 0;
        }
        out.push(character);
    }
    if pending_newlines > 0 {
        out.push('\n');
    }
    out.trim().to_string()
}

pub fn comment_author_name(profile: Option<&Json>, fallback_name: &str) -> String {
    let username = profile
        .and_then(|profile| profile.get("username"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .trim();
    if !username.is_empty() {
        return username.chars().take(40).collect();
    }
    let display = profile
        .and_then(|profile| profile.get("displayName"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .trim();
    let name = if !display.is_empty() {
        display.to_string()
    } else {
        fallback_name.trim().to_string()
    };
    let name = if name.is_empty() {
        "Pokoin user".to_string()
    } else {
        name
    };
    name.chars().take(40).collect()
}

fn iso_of(document: &crate::firestore::Document, field: &str) -> Option<String> {
    document
        .get(field)
        .and_then(|value| crate::domain::collection::iso_timestamp(&value))
}

/// `publicComment(id, data)`.
pub fn public_comment(id: &str, document: &crate::firestore::Document) -> Json {
    let raw_author = document.get_str("authorName");
    let author = if raw_author.is_empty() {
        "Pokoin user".to_string()
    } else {
        raw_author
    };
    json!({
        "id": id,
        "authorName": author,
        "body": document.get_str("body"),
        "createdAt": iso_of(document, "createdAt"),
    })
}

/// `GET|POST /api/news-comments`.
pub async fn news_comments(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match news_comments_inner(&state, &query, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn news_comments_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
    headers: &HeaderMap,
    _body: &Bytes,
) -> Result<Response> {
    let article_id = query
        .get("articleId")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if !is_article_id(&article_id) {
        return Err(ApiError::bad_request("articleId is required."));
    }

    let uid = optional_claims(state, headers).await.map(|claims| claims.uid);
    let firestore = state.firestore()?;
    let documents = firestore
        .run_query(
            &FirestoreQuery::collection(COLLECTION)
                .where_eq("articleId", article_id.clone())
                .limit(MAX_READ),
        )
        .await?;

    let mut visible: Vec<Json> = Vec::new();
    let mut mine: Vec<Json> = Vec::new();
    for document in &documents {
        let status = document.get_str("status");
        match status.as_str() {
            "visible" => visible.push(public_comment(&document.id(), document)),
            "pending" | "held" => {
                if let Some(uid) = &uid {
                    if document.get_str("uid") == *uid {
                        let mut comment = public_comment(&document.id(), document);
                        if let Some(object) = comment.as_object_mut() {
                            object.insert("status".into(), json!(status));
                        }
                        mine.push(comment);
                    }
                }
            }
            _ => {}
        }
    }
    let by_date = |a: &Json, b: &Json| {
        let key = |value: &Json| {
            value
                .get("createdAt")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string()
        };
        key(a).cmp(&key(b))
    };
    visible.sort_by(by_date);
    mine.sort_by(by_date);

    let cache_control = if uid.is_some() {
        "private, no-store"
    } else {
        "public, max-age=30"
    };
    Ok(json_cached(
        StatusCode::OK,
        json!({
            "articleId": article_id,
            "count": visible.len(),
            "comments": visible,
            "mine": mine,
        }),
        cache_control,
    ))
}

/// `POST /api/news-comments`.
pub async fn news_comments_create(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match news_comments_create_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => {
            if error.status() == StatusCode::UNAUTHORIZED {
                json_with_cors(StatusCode::UNAUTHORIZED, json!({ "error": "Sign in to comment." }))
            } else {
                error.into_response()
            }
        }
    }
}

async fn news_comments_create_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = match require_claims(state, headers).await {
        Ok(claims) => claims,
        Err(_) => {
            return Err(ApiError::unauthorized("Sign in to comment."));
        }
    };
    let body = parse_body(body);
    let article_id = string_field(&body, "articleId").trim().to_string();
    let article_path = string_field(&body, "articlePath").trim().to_string();
    let text = clean_body(&string_field(&body, "body"));
    if !is_article_id(&article_id) || !is_article_path(&article_path) {
        return Err(ApiError::bad_request("Unknown article."));
    }
    let length = text.chars().count();
    if length < MIN_BODY || length > MAX_BODY {
        return Err(ApiError::bad_request(format!(
            "Comments are {MIN_BODY}–{MAX_BODY} characters."
        )));
    }

    let verdict = state
        .limiter()
        .check(RateLimitRequest {
            scope: "news-comments",
            identity: &claims.uid,
            limit: RATE_LIMIT,
            window_seconds: RATE_WINDOW_SECONDS,
        })
        .await;
    if !verdict.allowed {
        let retry_after = verdict.retry_after_sec.unwrap_or(RATE_WINDOW_SECONDS);
        return Err(ApiError::too_many_requests(
            "You are commenting too fast. Try again in a few minutes.",
        )
        .with_field("retryAfterSec", json!(retry_after)));
    }

    let firestore = state.firestore()?;
    let profile = firestore
        .doc(format!("users/{}", claims.uid))
        .get()
        .await
        .ok()
        .flatten()
        .map(|document| {
            let mut object = serde_json::Map::new();
            for (key, value) in document.values().iter() {
                object.insert(key.clone(), value.to_plain_json());
            }
            Json::Object(object)
        });

    let created_at = state
        .clock()
        .now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let author = comment_author_name(profile.as_ref(), &claims.name);
    let reference = firestore
        .collection(COLLECTION)
        .add(
            DocData::new()
                .string("articleId", article_id)
                .string("articlePath", article_path)
                .string("uid", claims.uid.clone())
                .string("authorName", author.clone())
                .string("body", text.clone())
                .string("status", "pending")
                .string("createdAt", created_at.clone())
                .set("moderation", crate::firestore::Value::Null),
        )
        .await?;

    let document = crate::firestore::Document {
        name: reference.name(),
        create_time: None,
        update_time: None,
        fields: Some(
            serde_json::from_value(json!({
                "authorName": { "stringValue": author },
                "body": { "stringValue": text },
                "createdAt": { "stringValue": created_at },
            }))
            .unwrap_or_default(),
        ),
    };
    let mut comment = public_comment(&reference.id(), &document);
    if let Some(object) = comment.as_object_mut() {
        object.insert("status".into(), json!("pending"));
    }
    Ok(json_cached(
        StatusCode::ACCEPTED,
        json!({ "comment": comment }),
        "no-store",
    ))
}

/// `Allow: GET, POST` for anything else.
pub async fn method_not_allowed_response() -> Response {
    method_not_allowed("GET, POST")
}

/// Kept public so the router can mount the write path separately.
pub fn created(body: Json) -> Response {
    json_with_cors(StatusCode::ACCEPTED, body)
}

/// `ok` re-export keeps the shared helper import meaningful.
pub fn plain_ok(body: Json) -> Response {
    ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn article_ids_match_the_node_regex() {
        assert!(is_article_id("art_abcd"));
        assert!(is_article_id("art_AbC-123_xyz"));
        assert!(is_article_id(&format!("art_{}", "a".repeat(120))));
        assert!(!is_article_id(&format!("art_{}", "a".repeat(121))));
        assert!(!is_article_id("art_abc"));
        assert!(!is_article_id("abcd"));
        assert!(!is_article_id("art_ab cd"));
        assert!(!is_article_id(""));
    }

    #[test]
    fn article_paths_match_the_node_regex() {
        assert!(is_article_path("/news/hello"));
        assert!(is_article_path("/news/hello-world"));
        assert!(is_article_path("/en/news/hello-world"));
        assert!(is_article_path("/pokoin/news/a1-b2"));
        assert!(!is_article_path("news/hello"));
        assert!(!is_article_path("/news/"));
        assert!(!is_article_path("/news/Hello"));
        assert!(!is_article_path("/news/hello_world"));
        assert!(!is_article_path("/news/hello--"));
        assert!(!is_article_path("/blog/hello"));
    }

    #[test]
    fn body_cleaning_matches_clean_body() {
        assert_eq!(clean_body("  hi  "), "hi");
        assert_eq!(clean_body("a\r\nb"), "a\nb");
        assert_eq!(clean_body("a\rb"), "a\nb");
        assert_eq!(clean_body("a\n\n\n\nb"), "a\n\nb");
        assert_eq!(clean_body("a\u{0}b"), "ab");
        assert_eq!(clean_body("a\u{7f}b"), "ab");
        assert_eq!(clean_body("tab\tkept"), "tab\tkept");
    }

    #[test]
    fn author_names_are_capped_at_forty_characters() {
        let long = "a".repeat(60);
        let profile = json!({ "username": long });
        assert_eq!(comment_author_name(Some(&profile), "").len(), 40);
        let profile = json!({ "displayName": "Ash Ketchum" });
        assert_eq!(comment_author_name(Some(&profile), ""), "Ash Ketchum");
        assert_eq!(comment_author_name(None, "Fallback"), "Fallback");
        assert_eq!(comment_author_name(None, ""), "Pokoin user");
        let profile = json!({});
        assert_eq!(comment_author_name(Some(&profile), ""), "Pokoin user");
    }

    #[test]
    fn public_comment_defaults_the_author_name() {
        let document = crate::firestore::Document {
            name: "projects/p/databases/(default)/documents/news_comments/c1".into(),
            create_time: None,
            update_time: None,
            fields: Some(
                serde_json::from_value(json!({
                    "body": { "stringValue": "hello" },
                    "createdAt": { "stringValue": "2026-10-08T00:00:00Z" }
                }))
                .unwrap(),
            ),
        };
        let comment = public_comment("c1", &document);
        assert_eq!(comment["id"], json!("c1"));
        assert_eq!(comment["authorName"], json!("Pokoin user"));
        assert_eq!(comment["body"], json!("hello"));
        assert_eq!(comment["createdAt"], json!("2026-10-08T00:00:00.000Z"));
    }

    #[test]
    fn body_length_bounds_match_the_constants() {
        assert_eq!(MIN_BODY, 2);
        assert_eq!(MAX_BODY, 1500);
        assert_eq!(clean_body("a").chars().count(), 1);
        assert!(clean_body(&"a".repeat(1500)).chars().count() <= MAX_BODY);
    }
}
