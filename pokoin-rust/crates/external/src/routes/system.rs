//! System routes: edge client country and the wPKN/PKN currency quote.

use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::json;

use crate::error::json_response;
use crate::geo;
use crate::ApiResult;

/// `GET /api/client-country` — edge IP country for local marketplace links.
pub async fn client_country(headers: HeaderMap) -> ApiResult<Response> {
    let country = geo::country_from_headers(&headers);
    let mut response = json_response(200, json!({ "country": country }));
    let map = response.headers_mut();
    map.insert("Cache-Control", "private, no-store".parse().unwrap());
    map.insert("CDN-Cache-Control", "no-store".parse().unwrap());
    map.insert("Vary", "CF-IPCountry".parse().unwrap());
    Ok(response)
}

