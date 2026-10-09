//! Identity-adjacent user routes:
//! `search-recipient-emails` (handle/display-name prefix search and my-handle
//! claim) and `user-current-page` (assistant presence, backed by the existing
//! `assistant_user_current_pages` table).

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::{Direction, Query as FirestoreQuery, Value};
use crate::sql::{row_text, SqlParam};
use crate::state::DomainState;
use crate::username::{display_name_search_key, username_for_request};

use super::{json_cached, method_not_allowed, ok, parse_body, require_claims, string_field};

/// The migration that owns the presence table. Never applied by this crate.
pub const CURRENT_PAGE_MIGRATION: &str =
    "oracle-postgres/schema/013_assistant_user_current_pages.sql";
pub const MAX_SESSION_ID_LENGTH: usize = 160;

// ---------------------------------------------------------------------------
// search-recipient-emails
// ---------------------------------------------------------------------------

/// The shared match filter from `pushMatch`.
pub fn push_match(
    bag: &mut Vec<Json>,
    seen: &mut std::collections::HashSet<String>,
    username: &str,
    display_name: &str,
    uid: &str,
    self_uid: &str,
    query: &str,
) {
    let handle = username.trim().to_ascii_lowercase();
    let handle_valid = (3..=32).contains(&handle.len())
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if !handle_valid || uid == self_uid || seen.contains(&handle) {
        return;
    }
    let label = display_name.trim();
    let compact_label = display_name_search_key(label);
    if !(handle.starts_with(query)
        || (!compact_label.is_empty() && compact_label.starts_with(query)))
    {
        return;
    }
    seen.insert(handle.clone());
    bag.push(json!({
        "username": handle,
        "displayName": if !label.is_empty() && label.to_ascii_lowercase() != handle { label } else { "" },
    }));
}

/// `GET /api/search-recipient-emails?q=` — handle and display-name prefixes.
pub async fn search_recipient_emails_get(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    match search_get_inner(&state, &query, &headers).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn search_get_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;

    // "Raffaella Sabatino" / "raf" both compact to letters/digits.
    let raw_query = query.get("q").map(|value| value.trim().to_ascii_lowercase());
    let query = display_name_search_key(&raw_query.unwrap_or_default());
    if query.len() < 2 {
        return Ok(ok(json!({ "usernames": [], "results": [] })));
    }

    let mut seen = std::collections::HashSet::new();
    let mut results: Vec<Json> = Vec::new();

    // 1) Handle prefix (document id === username). Failures are logged and the
    //    display-name scan still runs, exactly like the Node try/catch.
    let by_id = FirestoreQuery::collection("usernames")
        .order_by("__name__", Direction::Ascending)
        .start_at_inclusive(vec![Value::Reference(
            firestore.document_name(&format!("usernames/{query}")),
        )])
        .end_at_inclusive(vec![Value::Reference(firestore.document_name(&format!(
            "usernames/{}",
            FirestoreQuery::prefix_end(&query)
        )))])
        .limit(12);
    match firestore.run_query(&by_id).await {
        Ok(documents) => {
            for document in documents {
                let username = {
                    let stored = document.get_str("username");
                    if stored.is_empty() {
                        document.id()
                    } else {
                        stored
                    }
                };
                push_match(
                    &mut results,
                    &mut seen,
                    &username,
                    &document.get_str("displayName"),
                    &document.get_str("uid"),
                    &claims.uid,
                    &query,
                );
            }
        }
        Err(error) => tracing::warn!(%error, "documentId scan failed"),
    }

    // 2) Display-name prefix (spaces stripped): "raf" -> Raffaella Sabatino.
    if results.len() < 8 {
        let by_display = FirestoreQuery::collection("usernames")
            .order_by("displayNameSearch", Direction::Ascending)
            .start_at_inclusive(vec![Value::String(query.clone())])
            .end_at_inclusive(vec![Value::String(FirestoreQuery::prefix_end(&query))])
            .limit(12);
        match firestore.run_query(&by_display).await {
            Ok(documents) => {
                for document in documents {
                    let username = {
                        let stored = document.get_str("username");
                        if stored.is_empty() {
                            document.id()
                        } else {
                            stored
                        }
                    };
                    push_match(
                        &mut results,
                        &mut seen,
                        &username,
                        &document.get_str("displayName"),
                        &document.get_str("uid"),
                        &claims.uid,
                        &query,
                    );
                }
            }
            Err(error) => tracing::warn!(%error, "displayNameSearch scan failed"),
        }
    }

    let results: Vec<Json> = results.into_iter().take(8).collect();
    let usernames: Vec<Json> = results
        .iter()
        .filter_map(|row| row.get("username").cloned())
        .collect();
    Ok(ok(json!({ "usernames": usernames, "results": results })))
}

/// `POST /api/search-recipient-emails` — claim or repair my handle.
pub async fn search_recipient_emails_post(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match search_post_inner(&state, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn search_post_inner(
    state: &DomainState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;
    let body = parse_body(body);
    let requested = string_field(&body, "username");
    let requested = if requested.trim().is_empty() {
        None
    } else {
        Some(requested)
    };
    let username = username_for_request(
        &firestore,
        &claims.uid,
        &claims.email,
        &claims.name,
        requested.as_deref(),
    )
    .await?;
    Ok(ok(json!({ "username": username })))
}

/// `Allow: GET, POST`.
pub async fn search_recipient_emails_other() -> Response {
    method_not_allowed("GET, POST")
}

// ---------------------------------------------------------------------------
// user-current-page
// ---------------------------------------------------------------------------

/// `cleanSessionId`: 8-160 chars of `[a-zA-Z0-9_.:-]`.
pub fn clean_session_id(value: &str) -> String {
    let text: String = value.trim().chars().take(MAX_SESSION_ID_LENGTH).collect();
    let valid = (8..=160).contains(&text.len())
        && text
            .bytes()
            .all(|byte| {
                byte.is_ascii_alphanumeric()
                    || byte == b'_'
                    || byte == b'.'
                    || byte == b':'
                    || byte == b'-'
            });
    if valid {
        text
    } else {
        String::new()
    }
}

/// `isSafeInternalPath`: an absolute path that cannot escape the site.
///
/// Node checked `/\/\.(?:\.|%2e)(?:\/|$)/i`, which misses a fully
/// percent-encoded `..` (`/a/%2e%2e/b`). This port decodes `%2e` before looking
/// for a `.`/`..` segment, so that traversal is rejected too. A legitimate
/// internal path never contains one, so nothing valid is lost.
pub fn is_safe_internal_path(path: &str) -> bool {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('\r')
        || path.contains('\n')
        || path.len() > 800
    {
        return false;
    }
    let decoded = path.to_ascii_lowercase().replace("%2e", ".");
    !decoded.split('/').any(|segment| segment == "." || segment == "..")
}

/// `cleanInternalPath`: an internal path, or a pokoin.com URL reduced to one.
pub fn clean_internal_path(value: &str) -> String {
    let raw: String = value.trim().chars().take(800).collect();
    if raw.is_empty() || raw.contains('\r') || raw.contains('\n') {
        return String::new();
    }
    if raw.starts_with('/') {
        return if is_safe_internal_path(&raw) {
            raw
        } else {
            String::new()
        };
    }
    // Absolute URL: only https/http on pokoin.com (or www) survives.
    let Some((scheme, rest)) = raw.split_once("://") else {
        return String::new();
    };
    if scheme != "https" && scheme != "http" {
        return String::new();
    }
    let (authority, path_and_query) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if host != "pokoin.com" && host != "www.pokoin.com" {
        return String::new();
    }
    if is_safe_internal_path(path_and_query) {
        path_and_query.to_string()
    } else {
        String::new()
    }
}

/// `currentPageRow(row)`.
pub fn current_page_row(row: &Json) -> Json {
    json!({
        "sessionId": row_text(row, "session_id"),
        "userUid": row_text(row, "user_uid"),
        "path": row_text(row, "path"),
        "source": row_text(row, "source"),
        "updatedAt": row.get("updated_at").cloned().unwrap_or(Json::Null),
    })
}

/// `sessionIdFromRequest`: body, then query string, then the session header.
pub fn session_id_from_request(
    body: &Json,
    query: &std::collections::HashMap<String, String>,
    headers: &HeaderMap,
) -> String {
    let from_body = {
        let primary = string_field(body, "sessionId");
        if primary.trim().is_empty() {
            string_field(body, "session_id")
        } else {
            primary
        }
    };
    if !from_body.trim().is_empty() {
        return clean_session_id(&from_body);
    }
    for key in ["sessionId", "session_id"] {
        if let Some(value) = query.get(key) {
            if !value.trim().is_empty() {
                return clean_session_id(value);
            }
        }
    }
    let header = headers
        .get("x-pokoin-session-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    clean_session_id(header)
}

/// Optional auth: no token means an anonymous session; a present but invalid
/// token is a 401 (never silently anonymous).
pub async fn user_scope(
    state: &DomainState,
    headers: &HeaderMap,
) -> Result<(String, bool)> {
    let Some(raw) = super::authorization(headers) else {
        return Ok((String::new(), false));
    };
    if !raw.starts_with("Bearer ") {
        return Ok((String::new(), false));
    }
    let claims = require_claims(state, headers).await?;
    Ok((claims.uid.chars().take(160).collect(), true))
}

/// `GET|POST /api/user-current-page`.
pub async fn user_current_page(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match user_current_page_inner(&state, &query, &method, &headers, &body).await {
        Ok(response) => response,
        Err(error) => current_page_error(error),
    }
}

async fn user_current_page_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
    method: &Method,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let (user_uid, authenticated) = user_scope(state, headers).await?;
    let body = parse_body(body);
    let session_id = session_id_from_request(&body, query, headers);
    if session_id.is_empty() {
        return Err(ApiError::bad_request("A valid sessionId is required."));
    }
    // Node split strictly on the verb: GET reads, POST writes. The database is
    // only required once the request itself is valid.
    if method == Method::GET {
        let db = state.marketplace_db()?;
        let rows = db
            .query_json(
                "select session_id, user_uid, path, source, updated_at \
                 from public.assistant_user_current_pages \
                 where ($2::text <> '' and user_uid = $2) \
                    or ($2::text = '' and session_id = $1 and user_uid = '') \
                 order by updated_at desc limit 1",
                &[SqlParam::Text(session_id.clone()), SqlParam::Text(user_uid.clone())],
            )
            .await?;
        let page = match rows.first() {
            Some(row) => current_page_row(row),
            None => Json::Null,
        };
        return Ok(json_cached(
            StatusCode::OK,
            json!({ "page": page, "sessionId": session_id, "authenticated": authenticated }),
            "no-store",
        ));
    }

    let path = {
        let primary = string_field(&body, "path");
        if primary.trim().is_empty() {
            clean_internal_path(&string_field(&body, "url"))
        } else {
            clean_internal_path(&primary)
        }
    };
    if path.is_empty() {
        return Err(ApiError::bad_request(
            "A safe internal Pokoin path is required.",
        ));
    }
    let source = {
        let raw: String = string_field(&body, "source").trim().chars().take(80).collect();
        if raw.is_empty() {
            "assistant".to_string()
        } else {
            raw
        }
    };
    let db = state.marketplace_db()?;
    let rows = db
        .query_json(
            "insert into public.assistant_user_current_pages \
               (session_id, user_uid, path, source, updated_at) \
             values ($1, $2, $3, $4, now()) \
             on conflict (session_id, user_uid) do update set \
               path = excluded.path, source = excluded.source, updated_at = now() \
             returning session_id, user_uid, path, source, updated_at",
            &[
                SqlParam::Text(session_id.clone()),
                SqlParam::Text(user_uid),
                SqlParam::Text(path),
                SqlParam::Text(source),
            ],
        )
        .await?;
    let page = rows.first().map(current_page_row).unwrap_or(Json::Null);
    Ok(json_cached(
        StatusCode::OK,
        json!({ "ok": true, "page": page }),
        "no-store",
    ))
}

/// A missing presence table is a deployment state: 503 with the migration path,
/// exactly like Node, instead of a blanket 500.
pub fn current_page_error(error: ApiError) -> Response {
    let message = error.message().to_string();
    if message.contains("42P01") || message.contains("does not exist") {
        return super::json_with_cors(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "error": "Assistant current-page table is not installed yet.",
                "setupRequired": true,
                "migration": CURRENT_PAGE_MIGRATION,
            }),
        );
    }
    error.into_response()
}

/// `Allow: GET, POST`.
pub async fn user_current_page_other() -> Response {
    method_not_allowed("GET, POST")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn session_ids_follow_the_node_regex() {
        assert_eq!(clean_session_id("abcdefgh"), "abcdefgh");
        assert_eq!(clean_session_id("  sess_1.2:3-4  "), "sess_1.2:3-4");
        assert_eq!(clean_session_id("short"), "");
        assert_eq!(clean_session_id("has space"), "");
        // cleanText() truncates to 160 before the pattern test, like Node.
        assert_eq!(clean_session_id(&"a".repeat(161)).len(), 160);
        assert_eq!(clean_session_id(&"a".repeat(160)).len(), 160);
    }

    #[test]
    fn internal_paths_reject_escapes() {
        assert!(is_safe_internal_path("/marketplace/search"));
        assert!(is_safe_internal_path("/"));
        assert!(!is_safe_internal_path("//evil.com"));
        assert!(!is_safe_internal_path("/a\\b"));
        assert!(!is_safe_internal_path("/a/../b"));
        // Hardened beyond Node: a fully percent-encoded `..` is rejected.
        assert!(!is_safe_internal_path("/a/%2e%2e/b"));
        assert!(!is_safe_internal_path("/a/./b"));
        assert!(!is_safe_internal_path("relative"));
    }

    #[test]
    fn clean_internal_path_accepts_only_pokoin_urls() {
        assert_eq!(clean_internal_path("/marketplace"), "/marketplace");
        assert_eq!(
            clean_internal_path("https://pokoin.com/marketplace?q=1"),
            "/marketplace?q=1"
        );
        assert_eq!(
            clean_internal_path("http://www.pokoin.com/wallet"),
            "/wallet"
        );
        assert_eq!(clean_internal_path("https://evil.com/marketplace"), "");
        assert_eq!(clean_internal_path("ftp://pokoin.com/x"), "");
        assert_eq!(clean_internal_path("//evil.com/x"), "");
        assert_eq!(clean_internal_path("/a\nb"), "");
        assert_eq!(clean_internal_path(""), "");
        assert_eq!(clean_internal_path("not a url"), "");
    }

    #[test]
    fn push_match_applies_every_node_guard() {
        let mut bag = Vec::new();
        let mut seen = std::collections::HashSet::new();
        // Handle prefix match.
        push_match(&mut bag, &mut seen, "rafa", "Raffaella", "u2", "u1", "raf");
        assert_eq!(bag.len(), 1);
        assert_eq!(bag[0]["username"], serde_json::json!("rafa"));
        assert_eq!(bag[0]["displayName"], serde_json::json!("Raffaella"));
        // Self is excluded.
        push_match(&mut bag, &mut seen, "rafb", "", "u1", "u1", "raf");
        assert_eq!(bag.len(), 1);
        // Duplicates are excluded.
        push_match(&mut bag, &mut seen, "rafa", "Raffaella", "u2", "u1", "raf");
        assert_eq!(bag.len(), 1);
        // Invalid handle shape is excluded.
        push_match(&mut bag, &mut seen, "ab", "", "u3", "u1", "ab");
        assert_eq!(bag.len(), 1);
        // Display-name prefix match, and the label is dropped when it is the handle.
        push_match(
            &mut bag,
            &mut seen,
            "misty",
            "Misty",
            "u4",
            "u1",
            "mis",
        );
        assert_eq!(bag.len(), 2);
        assert_eq!(bag[1]["displayName"], serde_json::json!(""));
        // Display-name compact prefix ("raf" -> "Raffaella Sabatino").
        push_match(
            &mut bag,
            &mut seen,
            "waterflower",
            "Raffaella Sabatino",
            "u5",
            "u1",
            "raf",
        );
        assert_eq!(bag.len(), 3);
        // No match at all.
        push_match(&mut bag, &mut seen, "brock", "Brock", "u6", "u1", "zz");
        assert_eq!(bag.len(), 3);
    }

    #[test]
    fn current_page_rows_are_reshaped() {
        let row = serde_json::json!({
            "session_id": "s1",
            "user_uid": "u1",
            "path": "/marketplace",
            "source": "assistant",
            "updated_at": "2026-10-08T00:00:00.000Z"
        });
        let page = current_page_row(&row);
        assert_eq!(page["sessionId"], serde_json::json!("s1"));
        assert_eq!(page["userUid"], serde_json::json!("u1"));
        assert_eq!(page["path"], serde_json::json!("/marketplace"));
        assert_eq!(page["source"], serde_json::json!("assistant"));
        assert_eq!(
            page["updatedAt"],
            serde_json::json!("2026-10-08T00:00:00.000Z")
        );
        // Missing fields become empty strings / null, not undefined.
        let page = current_page_row(&serde_json::json!({}));
        assert_eq!(page["sessionId"], serde_json::json!(""));
        assert_eq!(page["updatedAt"], Json::Null);
    }

    #[test]
    fn session_id_resolution_order_matches_node() {
        let mut headers = HeaderMap::new();
        headers.insert("x-pokoin-session-id", HeaderValue::from_static("header1234"));
        let mut query = std::collections::HashMap::new();
        query.insert("sessionId".to_string(), "query12345".to_string());

        // Body wins.
        let body = serde_json::json!({ "session_id": "body12345" });
        assert_eq!(session_id_from_request(&body, &query, &headers), "body12345");
        // Then the query string.
        let body = serde_json::json!({});
        assert_eq!(session_id_from_request(&body, &query, &headers), "query12345");
        // Then the header.
        let empty: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        assert_eq!(
            session_id_from_request(&body, &empty, &headers),
            "header1234"
        );
        // Nothing valid -> empty.
        let no_headers = HeaderMap::new();
        assert_eq!(session_id_from_request(&body, &empty, &no_headers), "");
    }

    #[test]
    fn missing_table_is_a_setup_required_503() {
        let response = current_page_error(ApiError::internal(
            "Postgres error 42P01: relation \"assistant_user_current_pages\" does not exist",
        ));
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let other = current_page_error(ApiError::bad_request("nope"));
        assert_eq!(other.status(), StatusCode::BAD_REQUEST);
    }
}
