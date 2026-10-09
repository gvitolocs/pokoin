//! Associate / partner surfaces.
//!
//! * `marketplace-associate-suggest` — the public Users-search supplement: it
//!   matches the active associates roster by display name or email prefix so
//!   partners are findable before they have listings. Only public facts are
//!   returned (display name, claimed username, role badge) — never roster emails.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value as Json};

use crate::error::{ApiError, Result};
use crate::sql::{row_text, SqlParam};
use crate::state::DomainState;

use axum::response::IntoResponse;

use super::{apply_cors, json_with_cors, method_not_allowed, require_claims};

pub const SUGGEST_MAX: i64 = 5;

/// `cleanQuery`: lowercase, whitespace collapsed, 64 characters.
pub fn clean_query(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(64)
        .collect()
}

pub fn clean_username(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

/// `q.replace(/[%_]/g, '')` — LIKE wildcards are stripped before the prefix.
pub fn like_prefix(value: &str) -> String {
    value.replace(['%', '_'], "")
}

async fn username_for_uid(
    firestore: &crate::firestore::Firestore,
    uid: &str,
) -> String {
    if uid.is_empty() {
        return String::new();
    }
    match firestore.doc(format!("users/{uid}")).get().await {
        Ok(Some(document)) => {
            let username = document.get_str("username");
            if username.is_empty() {
                clean_username(&document.get_str("usernameLower"))
            } else {
                clean_username(&username)
            }
        }
        _ => String::new(),
    }
}

/// `readAssociateSuggestions` — roster prefix search, then resolve each roster
/// email to a claimed Pokoin username.
pub async fn read_associate_suggestions(
    state: &DomainState,
    query: &str,
) -> Result<Vec<Json>> {
    let q = clean_query(query);
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let db = state.marketplace_db()?;
    let firestore = state.firestore()?;
    let auth = state.auth()?;

    let rows = db
        .query_json(
            "select email, role, display_name from public.marketplace_associates \
             where active \
               and (lower(coalesce(display_name, '')) like $1 || '%' \
                 or lower(email) like $1 || '%') \
             order by display_name, email limit $2",
            &[SqlParam::Text(like_prefix(&q)), SqlParam::Int(SUGGEST_MAX)],
        )
        .await?;

    let mut out: Vec<Json> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        let email = row_text(&row, "email").trim().to_ascii_lowercase();
        // A roster row without an account (or an auth hiccup) is simply not
        // suggestable yet.
        if let Ok(user) = auth.get_user_by_email(&email).await {
            let username = username_for_uid(&firestore, &user.uid).await;
            if username.is_empty() || seen.contains(&username) {
                continue;
            }
            seen.insert(username.clone());
            let display = row_text(&row, "display_name").trim().to_string();
            let name = if display.is_empty() {
                username.clone()
            } else {
                display
            };
            let role = row_text(&row, "role").trim().to_ascii_lowercase();
            let role = if role.is_empty() {
                "associate".to_string()
            } else {
                role
            };
            out.push(json!({
                "name": name,
                "username": username,
                "role": role,
            }));
        }
        if out.len() as i64 >= SUGGEST_MAX {
            break;
        }
    }
    Ok(out)
}

/// `GET /api/marketplace-associate-suggest?q=`.
pub async fn marketplace_associate_suggest(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    match marketplace_associate_suggest_inner(&state, &query).await {
        Ok(response) => response,
        Err(error) => associate_error(error),
    }
}

async fn marketplace_associate_suggest_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
) -> Result<Response> {
    let raw = query.get("q").map(String::as_str).unwrap_or("");
    let cleaned = raw.chars().take(64).collect::<String>();
    let associates = read_associate_suggestions(state, raw).await?;
    let mut response = json_with_cors(
        StatusCode::OK,
        json!({ "query": cleaned, "associates": associates }),
    );
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("public, max-age=60"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, OPTIONS"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("Authorization, Content-Type"),
    );
    Ok(response)
}

/// The Node error shape for the associate surfaces.
pub fn associate_error(error: ApiError) -> Response {
    let status = error.status();
    let status = if status.is_client_error() || status.is_server_error() {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    if status.is_server_error() {
        tracing::error!(%error, "associate surface failed");
    }
    let mut response = json_with_cors(
        status,
        json!({
            "error": if error.message().is_empty() { "Associate desk failed." } else { error.message() }
        }),
    );
    apply_cors(response.headers_mut());
    response
}

/// `Allow: GET, OPTIONS`.
pub async fn marketplace_associate_suggest_other() -> Response {
    method_not_allowed("GET, OPTIONS")
}

/// `Allow: GET, OPTIONS` for the Associate desk.
pub async fn marketplace_associate_other() -> Response {
    marketplace_associate_allow_only().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_are_compacted_and_capped() {
        assert_eq!(clean_query("  Raffaella   Sabatino "), "raffaella sabatino");
        assert_eq!(clean_query("ABC"), "abc");
        assert_eq!(clean_query(&"a".repeat(80)).len(), 64);
        assert_eq!(clean_query(""), "");
    }

    #[test]
    fn like_wildcards_are_stripped_from_the_prefix() {
        assert_eq!(like_prefix("raf%"), "raf");
        assert_eq!(like_prefix("r_f"), "rf");
        assert_eq!(like_prefix("%_%"), "");
        assert_eq!(like_prefix("raf"), "raf");
    }

    #[test]
    fn usernames_are_lowercased() {
        assert_eq!(clean_username("  Ash  "), "ash");
        assert_eq!(clean_username(""), "");
    }
}

// ---------------------------------------------------------------------------
// marketplace-associate (the Associates desk)
// ---------------------------------------------------------------------------

/// `GET /api/marketplace-associate` — the caller's own campaign desk, plus the
/// full roster overview for admins.
pub async fn marketplace_associate(
    State(state): State<DomainState>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Response {
    if method == axum::http::Method::OPTIONS {
        return associate_preflight().await;
    }
    if method != axum::http::Method::GET {
        return associate_allow_only_sync();
    }

    let claims = match require_claims(&state, &headers).await {
        Ok(claims) => claims,
        Err(error) => return associate_auth_error(error),
    };
    let firestore = match state.firestore() {
        Ok(firestore) => firestore,
        Err(error) => return associate_error(error),
    };
    let db = match state.marketplace_db() {
        Ok(db) => db,
        Err(error) => return associate_error(error),
    };
    let now_ms = state.clock().now().timestamp_millis();

    match crate::domain::associate::read_associate_payload(
        &db,
        &firestore,
        &claims.uid,
        &claims.email,
        claims.admin_claim(),
        now_ms,
    )
    .await
    {
        Ok(payload) => associate_private_ok(payload),
        Err(error) if error.status() == StatusCode::FORBIDDEN => {
            // The 403 body keeps the `associate: null` marker the SPA reads.
            associate_cors(json_with_cors(
                StatusCode::FORBIDDEN,
                json!({ "error": error.message(), "associate": Json::Null }),
            ))
        }
        Err(error) => {
            if associate_is_auth_error(&error) {
                return associate_auth_error(error);
            }
            associate_error(error)
        }
    }
}

/// `authErrorResponse(error)` — a bare `{error}` body at the error's status.
fn associate_auth_error(error: ApiError) -> Response {
    let status = if error.status().is_client_error() {
        error.status()
    } else {
        StatusCode::UNAUTHORIZED
    };
    let body = if error.message().is_empty() {
        "Pokoin authentication failed.".to_string()
    } else {
        error.message().to_string()
    };
    associate_cors(json_with_cors(status, json!({ "error": body })))
}

/// The Node predicate that decided an error was about authentication.
fn associate_is_auth_error(error: &ApiError) -> bool {
    if error.status() == StatusCode::UNAUTHORIZED {
        return true;
    }
    if error.code().map(|code| code.starts_with("auth/")).unwrap_or(false) {
        return true;
    }
    let message = error.message().to_ascii_lowercase();
    message.contains("bearer") || message.contains("id token") || message.contains("authentication")
}

/// `jsonPrivate(res, body)` — 200 with `private, no-store`.
fn associate_private_ok(body: Json) -> Response {
    let mut response = associate_cors(json_with_cors(StatusCode::OK, body));
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}

/// The associate CORS set: `GET, OPTIONS` and the auth headers.
fn associate_cors(mut response: Response) -> Response {
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, OPTIONS"),
    );
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("Authorization, Content-Type"),
    );
    response
}

async fn associate_preflight() -> Response {
    associate_preflight_response()
}

/// The Associate desk preflight, exposed so the router can mount it.
pub async fn marketplace_associate_preflight() -> Response {
    associate_preflight_response()
}

fn associate_preflight_response() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors(response.headers_mut());
    associate_cors(response)
}

pub async fn marketplace_associate_allow_only() -> Response {
    associate_allow_only_sync()
}

fn associate_allow_only_sync() -> Response {
    let mut response = associate_cors(json_with_cors(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({ "error": "GET only." }),
    ));
    response.headers_mut().insert(
        axum::http::header::ALLOW,
        axum::http::HeaderValue::from_static("GET, OPTIONS"),
    );
    response
}
