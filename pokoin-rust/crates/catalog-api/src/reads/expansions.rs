//! `GET /api/marketplace-expansions` — port of `marketplace-expansions.js` (handler).

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::{http, RouteState};
use serde_json::json;

use super::util;
use crate::shared::expansions;

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    let slug = q.search_param("slug");
    let limit = util::js_limit(q.search_param("limit"), 1000, 2000);
    let pool = state.api.read();
    if q.search_param("includeCards") == Some("1") {
        return match expansions::snapshot_for_expansion(pool, slug, limit).await {
            Ok(Some(snapshot)) => util::json_cache(StatusCode::OK, snapshot, "public, max-age=60, s-maxage=300"),
            Ok(None) => http::json(StatusCode::NOT_FOUND, json!({ "error": "Expansion not found." })),
            Err(error) => util::db_error("marketplace-expansions", &error, "Marketplace expansions failed."),
        };
    }
    match expansions::rows_for_expansions(pool, slug, limit).await {
        Ok(rows) => util::json_cache(StatusCode::OK, json!({ "expansions": rows }), "public, max-age=60, s-maxage=300"),
        Err(error) => util::db_error("marketplace-expansions", &error, "Marketplace expansions failed."),
    }
}
