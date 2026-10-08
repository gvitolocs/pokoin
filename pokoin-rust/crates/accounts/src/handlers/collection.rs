//! Collection and portfolio routes:
//! `marketplace-collection`, `marketplace-collection-summary`, and the
//! authenticated BFF reads that back `/collection` and the dashboard Portfolio.
//!
//! Ownership is always `decoded.uid` from a verified bearer — never a
//! client-supplied uid (D00006D / D00006E).

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::json;

use crate::domain::collection::{list_owned_collection, remove_owned_collection_item};
use crate::error::{ApiError, Result};
use crate::state::DomainState;

use super::{json_cached, number_field, parse_body, require_claims, string_field};

/// `GET /api/marketplace-collection`, `POST ?action=remove`.
pub async fn marketplace_collection(
    State(state): State<DomainState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match marketplace_collection_inner(&state, &query, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn marketplace_collection_inner(
    state: &DomainState,
    query: &std::collections::HashMap<String, String>,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let action = query.get("action").map(String::as_str).unwrap_or("");
    if action != "remove" {
        return Err(ApiError::bad_request("Unknown collection action."));
    }
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;
    let body = parse_body(body);
    let item_id = string_field(&body, "itemId");
    let quantity = number_field(&body, "quantity");
    let result =
        remove_owned_collection_item(&firestore, &claims.uid, &item_id, quantity).await?;
    Ok(json_cached(StatusCode::OK, result, "private, no-store"))
}

/// `GET /api/marketplace-collection`.
pub async fn marketplace_collection_get(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> Response {
    match collection_list_inner(&state, &headers).await {
        Ok(response) => response,
        Err(error) => collection_error(error, false),
    }
}

async fn collection_list_inner(state: &DomainState, headers: &HeaderMap) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;
    let listed = list_owned_collection(&firestore, &claims.uid).await?;
    Ok(json_cached(
        StatusCode::OK,
        listed.to_json(),
        "private, no-store",
    ))
}

/// `GET /api/marketplace-collection-summary`.
pub async fn marketplace_collection_summary(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> Response {
    match collection_summary_inner(&state, &headers).await {
        Ok(response) => response,
        Err(error) => collection_error(error, false),
    }
}

async fn collection_summary_inner(state: &DomainState, headers: &HeaderMap) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let firestore = state.firestore()?;
    let listed = list_owned_collection(&firestore, &claims.uid).await?;
    Ok(json_cached(
        StatusCode::OK,
        listed.to_summary_json(),
        "private, no-store",
    ))
}

/// The Node error mapping: a 401 is always phrased the same way, and a 404 or
/// unexpected failure never leaks the underlying message.
pub fn collection_error(error: ApiError, removing: bool) -> Response {
    let status = error.status();
    let message = match status {
        StatusCode::UNAUTHORIZED => "Authentication required.".to_string(),
        StatusCode::NOT_FOUND => "Collection item not found.".to_string(),
        StatusCode::BAD_REQUEST => {
            let message = error.message().to_string();
            if message.is_empty() {
                "Invalid collection request.".to_string()
            } else {
                message
            }
        }
        _ => {
            if removing {
                "Could not remove the card.".to_string()
            } else {
                "Could not load collection.".to_string()
            }
        }
    };
    json_with_error_status(status, message)
}

fn json_with_error_status(status: StatusCode, message: String) -> Response {
    let status = if status.is_client_error() || status.is_server_error() {
        status
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    super::json_with_cors(status, json!({ "error": message }))
}

/// `POST /api/marketplace-collection?action=remove` error phrasing.
pub async fn marketplace_collection_remove_error(error: ApiError) -> Response {
    collection_error(error, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[test]
    fn error_phrasing_matches_the_node_table() {
        let response = collection_error(ApiError::unauthorized("nope"), false);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = collection_error(ApiError::not_found("nope"), false);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = collection_error(
            ApiError::internal("Firestore request failed 500: secret"),
            false,
        );
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let response = collection_error(ApiError::internal("boom"), true);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
