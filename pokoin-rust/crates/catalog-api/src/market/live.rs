//! `GET /api/marketplace-live` — SSE port of `marketplace-live.js`.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use bytes::Bytes;
use pokoin_api_common::{http, live};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

fn matches(filter_card: &str, filter_seller: &str, payload: &Value) -> bool {
    let card = payload.get("cardId").and_then(Value::as_str).unwrap_or("");
    let seller = payload.get("sellerUid").and_then(Value::as_str).unwrap_or("");
    if !filter_card.is_empty() && !card.is_empty() && filter_card != card {
        return false;
    }
    if !filter_seller.is_empty() && !seller.is_empty() && filter_seller != seller {
        return false;
    }
    true
}

pub async fn handler(method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        let mut response = Response::new(Body::from("Method not allowed."));
        *response.status_mut() = StatusCode::METHOD_NOT_ALLOWED;
        response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET"));
        return response;
    }
    let q = http::Query::from_uri(&uri);
    let card_id = q.search_param("cardId").unwrap_or("").trim().to_owned();
    let seller_uid = q.search_param("sellerUid").unwrap_or("").trim().to_owned();
    if card_id.is_empty() && seller_uid.is_empty() {
        return http::json(StatusCode::BAD_REQUEST, json!({ "error": "cardId or sellerUid is required." }));
    }
    let mut events = live::subscribe();
    let stream = async_stream::stream! {
        yield Ok::<Bytes, Infallible>(Bytes::from_static(b": ok\n\n"));
        let mut ping = tokio::time::interval(Duration::from_secs(15));
        ping.tick().await;
        loop {
            tokio::select! {
                _ = ping.tick() => yield Ok(Bytes::from_static(b": ping\n\n")),
                event = events.recv() => match event {
                    Ok(payload) => {
                        if matches(&card_id, &seller_uid, &payload) {
                            yield Ok(Bytes::from(format!("event: listing\ndata: {payload}\n\n")));
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                },
            }
        }
    };
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters() {
        let p = json!({ "cardId": "1", "sellerUid": "u" });
        assert!(matches("1", "", &p));
        assert!(!matches("2", "", &p));
        assert!(matches("", "u", &p));
        assert!(matches("2", "", &json!({ "cardId": "", "sellerUid": "" })));
    }
}
