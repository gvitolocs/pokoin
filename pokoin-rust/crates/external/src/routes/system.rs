//! System routes: edge client country and the wPKN/PKN currency quote.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::Uri;
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{json, Value};

use crate::error::json_response;
use crate::geo;
use crate::routes::util::{body_json, query_first};
use crate::state::DomainState;
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

/// `GET|POST /api/wpkn-pkn-quote` — GeckoTerminal wPKN quote + PKN USD price.
pub async fn wpkn_pkn_quote(
    State(_state): State<DomainState>,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let payload = if body.is_empty() { json!({}) } else { body_json(&body).await? };
    let direction = query_first(&uri, "direction")
        .or_else(|| payload.get("direction").and_then(Value::as_str).map(|s| s.to_string()))
        .unwrap_or_default();
    let amount_in = query_first(&uri, "amountIn")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .or_else(|| payload.get("amountIn").and_then(Value::as_f64))
        .unwrap_or(0.0);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| crate::error::ApiError::new(500, "Quote client failed."))?;
    let out = crate::wpkn_quote::handle(&client, &direction, amount_in).await?;
    let mut response = json_response(200, out);
    let headers = response.headers_mut();
    headers.insert("Cache-Control", "no-store, max-age=0".parse().unwrap());
    headers.insert("Pragma", "no-cache".parse().unwrap());
    Ok(response)
}
