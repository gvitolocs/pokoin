//! Outbound marketplace redirect routes.

use axum::extract::State;
use axum::http::{StatusCode, Uri, HeaderMap};
use axum::response::Response;
use serde_json::json;

use crate::error::{json_response, ApiError, ApiResult};
use crate::redirects;
use crate::routes::util::query_first;
use crate::state::DomainState;

fn send_redirect(url: &str, wants_json: bool, payload: serde_json::Value) -> ApiResult<Response> {
    if wants_json {
        let mut response=json_response(200, payload);
        response.headers_mut().insert("cache-control",axum::http::HeaderValue::from_static("no-store"));
        response.headers_mut().insert("referrer-policy",axum::http::HeaderValue::from_static("no-referrer"));
        response.headers_mut().insert("x-robots-tag",axum::http::HeaderValue::from_static("noindex, nofollow"));
        return Ok(response);
    }
    Response::builder()
        .status(StatusCode::FOUND)
        .header("Location", url)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Robots-Tag", "noindex, nofollow")
        .body(axum::body::Body::empty())
        .map_err(|_| ApiError::new(500, "Redirect failed."))
}

fn wants_json(uri: &Uri) -> bool {
    query_first(uri, "format").as_deref() == Some("json")
}

fn requested_game(uri: &Uri) -> String {
    query_first(uri, "game").unwrap_or_else(|| "pokemon".to_string())
}

/// `GET /api/cardtrader-redirect` — public card id or leftover ct_id → CT page.
pub async fn cardtrader(State(state): State<DomainState>, uri: Uri) -> ApiResult<Response> {
    let id = redirects::clean_marketplace_id(
        &query_first(&uri, "id")
            .or_else(|| query_first(&uri, "cardId"))
            .unwrap_or_default(),
    );
    let hinted = redirects::clean_marketplace_id(
        &query_first(&uri, "blueprintId")
            .or_else(|| query_first(&uri, "ct_id"))
            .or_else(|| query_first(&uri, "ctId"))
            .unwrap_or_default(),
    );
    if id.is_empty() && hinted.is_empty() {
        return Err(ApiError::bad_request("Missing or invalid CardTrader id."));
    }
    let json = wants_json(&uri);
    // Explicit leftover from the SPA (never a public id — those go in `id`).
    if !hinted.is_empty() && hinted != id {
        return send_redirect(
            &redirects::cardtrader_url(&hinted),
            json,
            json!({ "url": redirects::cardtrader_url(&hinted), "ct_id": hinted }),
        );
    }
    let lookup = if id.is_empty() { &hinted } else { &id };
    let game = requested_game(&uri);
    if let Some((_game, hit)) = redirects::catalog_ids_for_any_game(&state.db, &game, lookup).await? {
        if !hit.ct_id.is_empty() {
            let url = redirects::cardtrader_url(&hit.ct_id);
            return send_redirect(&url, json, json!({ "url": url, "ct_id": hit.ct_id }));
        }
    }
    Err(ApiError::not_found("CardTrader leftover id not found."))
}

/// `GET /api/tcgplayer-redirect` — public card id → TCGplayer product page.
pub async fn tcgplayer(State(state): State<DomainState>, uri: Uri) -> ApiResult<Response> {
    let id = redirects::clean_card_id(
        &query_first(&uri, "id")
            .or_else(|| query_first(&uri, "cardId"))
            .unwrap_or_default(),
    );
    if id.is_empty() {
        return Err(ApiError::bad_request("Missing or invalid card id."));
    }
    let game = requested_game(&uri);
    let product_id = redirects::read_tcgplayer_product_id(&state.db, &game, &id).await?;
    if product_id.is_empty() {
        return Err(ApiError::not_found("No TCGplayer product for this card."));
    }
    let url = redirects::tcgplayer_product_url(&product_id);
    send_redirect(
        &url,
        wants_json(&uri),
        json!({ "url": url, "productId": product_id }),
    )
}

/// `GET /api/cardmarket-redirect` — printing/verified links and native candidate fallback.
pub async fn cardmarket(State(state): State<DomainState>, headers: HeaderMap, uri: Uri) -> ApiResult<Response> {
    let id=redirects::clean_marketplace_id(&query_first(&uri,"id").or_else(||query_first(&uri,"cardId")).unwrap_or_default());
    let hint=redirects::clean_marketplace_id(&query_first(&uri,"blueprintId").or_else(||query_first(&uri,"ct_id")).or_else(||query_first(&uri,"ctId")).unwrap_or_default());
    if id.is_empty()&&hint.is_empty(){return Err(ApiError::bad_request("Missing or invalid blueprint id."))}
    let game=pokoin_api_common::game::parse_game_from_request(&pokoin_api_common::http::header_pairs(&headers),query_first(&uri,"game").as_deref(),query_first(&uri,"marketplaceGame").as_deref());
    let locale=query_first(&uri,"locale").filter(|s|s.len()==2&&s.chars().all(|c|c.is_ascii_lowercase())).unwrap_or_else(||"en".into());
    let target=crate::cardmarket::resolve(&state.db,&game,&id,&hint,&locale).await?;
    let mut response=send_redirect(&target,wants_json(&uri),json!({"url":target}))?;
    for (k,v) in [("cache-control","no-store"),("referrer-policy","no-referrer"),("x-robots-tag","noindex, nofollow")] {response.headers_mut().insert(axum::http::HeaderName::from_static(k),axum::http::HeaderValue::from_static(v));}
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(raw: &str) -> Uri {
        raw.parse().unwrap()
    }

    #[test]
    fn json_and_game_query() {
        assert!(wants_json(&uri("/api/x?format=json")));
        assert!(!wants_json(&uri("/api/x")));
        assert_eq!(requested_game(&uri("/api/x?game=magic")), "magic");
        assert_eq!(requested_game(&uri("/api/x")), "pokemon");
    }

    #[test]
    fn redirect_response_sets_location() {
        let response = send_redirect("https://www.cardtrader.com/en/cards/1", false, json!({})).unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(
            response.headers().get("Location").unwrap(),
            "https://www.cardtrader.com/en/cards/1"
        );
        let response = send_redirect("https://x", true, json!({"url": "https://x"})).unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
