//! Native CardTrader product push (`_cardtrader_seller_listings.js`
//! `pushListingToCardTrader` / `pushAndLinkListing`), shared by the listings
//! sync engine and Scan Connect submit.

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::cardtrader::client::CardTraderClient;
use crate::cardtrader::integration;
use crate::error::{ApiError, ApiResult};
use crate::firebase::FirestoreStore;

fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().map(|n| n != 0.0).unwrap_or(false),
        _ => true,
    }
}

/// `String(value || '').trim().slice(0, max)` (UTF-16 units).
fn text(value: &Value, max: usize) -> String {
    let raw = if truthy(value) { js_string(value) } else { String::new() };
    raw.trim()
        .chars()
        .scan(0usize, |used, ch| {
            *used += ch.len_utf16();
            (*used <= max).then_some(ch)
        })
        .collect()
}

fn field(value: &Value, key: &str, max: usize) -> String {
    text(&value[key], max)
}

fn first(value: &Value, keys: &[&str], max: usize) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|v| truthy(v)))
        .map(|v| text(v, max))
        .unwrap_or_default()
}

/// JS `Number(value)`.
fn number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => pokoin_api_common::http::js_number(s).unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

fn json_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// Public card id -> CardTrader blueprint id (public ids are leftover × 2).
pub fn blueprint(card: &str) -> Option<i64> {
    let n = card.trim().parse::<i64>().ok()?;
    (n > 0).then_some(if n % 2 == 0 { n / 2 } else { n })
}

/// CardTrader `POST /products` body for a Pokoin listing.
pub fn product_body(listing: &Value) -> ApiResult<Value> {
    let id = blueprint(&first(listing, &["cardId", "card_id"], 80))
        .ok_or_else(|| ApiError::bad_request("CardTrader listing needs a CardTrader blueprint id."))?;
    let pkn = number(listing.get("pricePkn").or_else(|| listing.get("price_pkn")).unwrap_or(&Value::Null));
    let price = (pkn * 0.005 * 100.0).round() / 100.0;
    if !price.is_finite() || price <= 0.0 {
        return Err(ApiError::bad_request("CardTrader listing needs a positive EUR price."));
    }
    let qty = number(
        listing
            .get("quantityAvailable")
            .or_else(|| listing.get("quantity_available"))
            .or_else(|| listing.get("quantity"))
            .unwrap_or(&Value::Null),
    );
    let qty = if qty.is_finite() && qty != 0.0 { qty.trunc().max(1.0) } else { 1.0 };
    let condition = match field(listing, "condition", 20).to_uppercase().as_str() {
        "SP" | "LP" => "Slightly Played",
        "MP" => "Moderately Played",
        "PL" | "HP" => "Heavily Played",
        "PO" => "Poor",
        _ => "Near Mint",
    };
    let language = match field(listing, "language", 10).to_uppercase().as_str() {
        "JP" | "JA" | "JPN" => "jp",
        "KO" | "KR" => "ko",
        "ZH" | "CN" | "ZHS" => "zh",
        "ZHT" | "TW" => "zht",
        "FR" => "fr",
        "DE" => "de",
        "IT" => "it",
        "ES" => "es",
        "PT" => "pt",
        "ID" => "id",
        "TH" => "th",
        _ => "en",
    };
    let mut body = json!({
        "blueprint_id": id,
        "price": json_number(price),
        "quantity": json_number(qty),
        "graded": listing["graded"] == true,
        "properties": {
            "condition": condition,
            "pokemon_language": language,
            "signed": listing["signed"] == true,
            "altered": listing["altered"] == true,
        },
    });
    if first(listing, &["foilState", "foil_state"], 40).eq_ignore_ascii_case("reverse") || listing["reverse"] == true {
        body["properties"]["pokemon_reverse"] = json!(true);
    }
    if listing["firstEdition"] == true || listing["first_edition"] == true {
        body["properties"]["pokemon_first_edition"] = json!(true);
    }
    let id = first(listing, &["id", "listingId"], 80);
    if !id.is_empty() {
        body["user_data_field"] = json!(format!("pokoin:{id}"));
    }
    let comment = first(listing, &["sellerComment", "seller_comment"], 500);
    if !comment.is_empty() {
        body["description"] = json!(comment);
    }
    Ok(body)
}

/// What a CardTrader create did, as far as Pokoin can know.
#[derive(Debug)]
pub enum PushOutcome {
    /// Created: `{"productId", "sourceListingId"}`.
    Created(Value),
    /// Nothing was created (bad listing, no token, a 4xx answer).
    Rejected(ApiError),
    /// The product may exist (no answer, a 5xx, or no id in the answer). Its
    /// `user_data_field` (`pokoin:<listing id>`) lets the reconcile link it.
    InDoubt(ApiError),
}

/// `pushListingToCardTrader`, telling a rejected create from one in doubt.
pub async fn push_product_outcome(fs: &dyn FirestoreStore, ct: &CardTraderClient, uid: &str, listing: &Value) -> PushOutcome {
    let prepared = async {
        let doc = integration::read_integration_doc(fs, uid).await?;
        if integration::is_one_day_ready_integration(&doc) {
            return Err(ApiError::conflict(
                "CardTrader 1-Day Ready accounts are stocked by CardTrader. List this card on Pokoin only.",
            ));
        }
        let token = integration::decrypt_integration_token(fs, uid).await?;
        Ok((token, product_body(listing)?))
    }
    .await;
    let (token, body) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => return PushOutcome::Rejected(error),
    };
    let payload = match ct.create_product(&token, body).await {
        Ok(payload) => payload,
        Err(error) if crate::cardtrader::client::write_in_doubt(&error) => return PushOutcome::InDoubt(error),
        Err(error) => return PushOutcome::Rejected(error),
    };
    let resource = payload.get("resource").or_else(|| payload.get("product")).unwrap_or(&payload);
    let mut id = first(resource, &["id"], 80);
    if id.is_empty() {
        id = field(&payload, "id", 80);
    }
    if id.is_empty() {
        return PushOutcome::InDoubt(ApiError::new(502, "CardTrader did not return a product id."));
    }
    PushOutcome::Created(json!({ "productId": id, "sourceListingId": format!("ct:{id}") }))
}

/// `pushListingToCardTrader`: create the product with the seller's token.
pub async fn push_product(fs: &dyn FirestoreStore, ct: &CardTraderClient, uid: &str, listing: &Value) -> ApiResult<Value> {
    match push_product_outcome(fs, ct, uid, listing).await {
        PushOutcome::Created(pushed) => Ok(pushed),
        PushOutcome::Rejected(error) | PushOutcome::InDoubt(error) => Err(error),
    }
}

/// `source_listing_id` of a listing whose CardTrader push is claimed by outbox
/// event `event_id` and not yet linked. Not a `ct:<digits>` id, so no reconcile
/// removal, destroy or sale sync ever acts on it.
pub fn pending_source(event_id: i64) -> String {
    format!("ct:pending:{event_id}")
}

pub fn is_pending_source(source: &str) -> bool {
    source.starts_with("ct:pending:")
}

/// Statuses in which a listing must not stay for sale on CardTrader.
pub fn off_sale(status: &str) -> bool {
    matches!(status, "inactive" | "sold_out")
}

/// Upsert the push link row (`marketplace_cardtrader_product_links`).
pub async fn upsert_push_link(writer: &PgPool, uid: &str, listing: &Value, pushed: &Value, id: uuid::Uuid, seller: &str, qty: i32) -> ApiResult<()> {
    let bp = blueprint(&first(listing, &["cardId", "card_id"], 80)).map(|n| n.to_string()).unwrap_or_default();
    let linked = sqlx::query(
        "insert into public.marketplace_cardtrader_product_links (seller_uid, ct_product_id, listing_id, blueprint_id, last_ct_quantity, last_seen_at, origin, missing_from_ct, updated_at) \
         values ($1, $2, $3::uuid, $4, $5, now(), 'push', false, now()) \
         on conflict (seller_uid, ct_product_id) do update set listing_id = excluded.listing_id, blueprint_id = excluded.blueprint_id, \
         last_ct_quantity = excluded.last_ct_quantity, last_seen_at = now(), origin = 'push', missing_from_ct = false, updated_at = now()",
    )
    .bind(if uid.is_empty() { seller } else { uid })
    .bind(field(pushed, "productId", 80))
    .bind(id)
    .bind(bp)
    .bind(qty)
    .execute(writer)
    .await;
    match linked {
        Err(error) if !is_missing_table(&error) => Err(error.into()),
        _ => Ok(()),
    }
}

fn is_missing_table(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("42P01")
}

/// `pushAndLinkListing`: push, then link the Pokoin listing to the product.
pub async fn push_and_link(
    fs: &dyn FirestoreStore,
    ct: &CardTraderClient,
    writer: &PgPool,
    uid: &str,
    listing: &Value,
) -> ApiResult<Value> {
    let pushed = push_product(fs, ct, uid, listing).await?;
    let raw_id = field(listing, "id", 80);
    if raw_id.is_empty() {
        return Ok(pushed);
    }
    let id = uuid::Uuid::parse_str(&raw_id).map_err(|_| ApiError::bad_request("Listing id invalid."))?;
    let row = sqlx::query(
        "update public.marketplace_user_listings set source_listing_id = $2, updated_at = now() where id = $1 \
         returning id, source_listing_id, card_id, seller_uid, quantity_available",
    )
    .bind(id)
    .bind(field(&pushed, "sourceListingId", 160))
    .fetch_optional(writer)
    .await?;
    if let Some(row) = row {
        use sqlx::Row;
        let qty = row.try_get::<i32, _>("quantity_available").unwrap_or(0);
        let seller = row.try_get::<String, _>("seller_uid").unwrap_or_default();
        upsert_push_link(writer, uid, listing, &pushed, id, &seller, qty).await?;
    }
    Ok(pushed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same key as the webhook tests: the test binary shares one environment.
    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn create_outcomes_tell_rejected_from_in_doubt() {
        use axum::{routing::post, Json, Router};
        // CardTrader stand-in: the blueprint id picks the answer.
        let app = Router::new().route(
            "/products",
            post(|Json(body): Json<Value>| async move {
                match body["blueprint_id"].as_i64() {
                    Some(1) => (axum::http::StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"error":"bad"}))),
                    Some(2) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))),
                    Some(3) => (axum::http::StatusCode::OK, Json(json!({"resource":{"id":9}}))),
                    _ => (axum::http::StatusCode::OK, Json(json!({}))),
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", KEY);
        let fs = crate::firebase::MemoryFirestore::new();
        fs.seed(
            "seller_integrations",
            &integration::integration_doc_id("u1"),
            json!({"enabled": true, "encryptedToken": crate::crypto::encrypt_secret("test-push-token-0123456789", Some(KEY))}),
        )
        .await;
        let ct = CardTraderClient::with_base(format!("http://{address}"));
        let listing = |card: &str| json!({"id": "6f1c", "cardId": card, "pricePkn": 200, "quantityAvailable": 1});
        assert!(matches!(push_product_outcome(&fs, &ct, "u1", &listing("2")).await, PushOutcome::Rejected(_)));
        assert!(matches!(push_product_outcome(&fs, &ct, "u1", &listing("4")).await, PushOutcome::InDoubt(_)));
        assert!(matches!(push_product_outcome(&fs, &ct, "u1", &listing("8")).await, PushOutcome::InDoubt(_)));
        match push_product_outcome(&fs, &ct, "u1", &listing("6")).await {
            PushOutcome::Created(pushed) => assert_eq!(pushed["sourceListingId"], "ct:9"),
            other => panic!("expected Created, got {other:?}"),
        }
        server.abort();
        // No answer at all (nothing listening): the product may exist.
        let closed = CardTraderClient::with_base("http://127.0.0.1:1".into());
        assert!(matches!(push_product_outcome(&fs, &closed, "u1", &listing("6")).await, PushOutcome::InDoubt(_)));
        // A listing that cannot be sent was never created.
        assert!(matches!(push_product_outcome(&fs, &ct, "u1", &json!({"cardId": "x", "pricePkn": 200})).await, PushOutcome::Rejected(_)));
        assert!(is_pending_source(&pending_source(41)) && !is_pending_source("ct:41"));
        assert!(off_sale("inactive") && off_sale("sold_out") && !off_sale("active") && !off_sale("paused"));
    }

    #[test]
    fn product_body_matches_node() {
        let body = product_body(&json!({
            "id": "6f1c", "cardId": "238", "pricePkn": 2000, "quantityAvailable": 3,
            "condition": "LP", "language": "jp", "foilState": "reverse", "firstEdition": true,
            "sellerComment": "  mint  ",
        }))
        .unwrap();
        assert_eq!(body["blueprint_id"], json!(119));
        assert_eq!(body["price"], json!(10));
        assert_eq!(body["quantity"], json!(3));
        assert_eq!(body["properties"]["condition"], json!("Slightly Played"));
        assert_eq!(body["properties"]["pokemon_language"], json!("jp"));
        assert_eq!(body["properties"]["pokemon_reverse"], json!(true));
        assert_eq!(body["properties"]["pokemon_first_edition"], json!(true));
        assert_eq!(body["user_data_field"], json!("pokoin:6f1c"));
        assert_eq!(body["description"], json!("mint"));
        assert!(product_body(&json!({ "cardId": "238", "pricePkn": 0 })).is_err());
        assert!(product_body(&json!({ "cardId": "x", "pricePkn": 10 })).is_err());
    }
}
