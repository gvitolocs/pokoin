//! `GET /api/marketplace-card-versions` — port of `marketplace-card-versions.js` (handler).

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::{http, RouteState};
use serde_json::{Value, json};

use super::util;
use crate::shared::{card_versions, image_log};

pub async fn handler(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    // Opt-in compact encoding; the default representation is unchanged.
    let wanted = util::wanted(&headers, &q);
    let text = |k: &str| q.search_param(k).unwrap_or("").to_owned();
    let (card_id, card_slug) = card_versions::resolve_card_route(
        &text("cardId"),
        util::first_of(&q, &["cardSlug", "slug"]).unwrap_or(""),
        util::first_of(&q, &["doubledCardId", "urlCardId"]).unwrap_or(""),
    );
    let args = card_versions::RowsForVersionsArgs {
        query: text("query"),
        expansion_name: text("expansionName"),
        card_id: card_id.clone(),
        card_slug,
        same_as_card_id: text("sameAsCardId"),
        limit: util::js_limit(q.search_param("limit"), 240, 1000),
        product_type: text("productType"),
        product_category: util::first_of(&q, &["productCategory", "category"]).unwrap_or("").to_owned(),
        search_language: util::first_of(&q, &["search_language", "lang", "language"]).unwrap_or("").to_owned(),
    };
    match card_versions::rows_for_versions(state.api.read(), &args).await {
        Ok(rows) => {
            let route = match uri.query() {
                Some(query) => format!("{}?{query}", uri.path()),
                None => uri.path().to_owned(),
            };
            image_log::record_version_images(&rows, &route, &card_id);
            util::json_cache_c1(wanted, StatusCode::OK, Value::Array(rows), "public, max-age=20, s-maxage=120")
        }
        Err(error) => {
            let _ = json!({});
            util::db_error("marketplace-card-versions", &error, "Marketplace card versions failed.")
        }
    }
}
