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

/// EUR price CardTrader gets for a PKN price (200 PKN = 1 EUR), to the cent.
/// `None` when that is not a positive amount. A plain conversion: a Pokoin
/// price goes to CardTrader through [`ct_ask_eur`], never this.
pub fn eur_price(pkn: f64) -> Option<f64> {
    let price = (pkn * 0.005 * 100.0).round() / 100.0;
    (price.is_finite() && price > 0.0).then_some(price)
}

/// The CardTrader ask for a Pokoin price: the smallest whole-cent ask that,
/// after the seller's CardTrader commission and its VAT, nets the Pokoin price
/// (`ct_fees::FeeRule::gross_cents`). A Pokoin price is already net of the
/// commission (docs/PRICING.md); listing it unchanged on CardTrader took the
/// commission a second time (2026-10-21: Spiderling 26 PKN went up at €0.13
/// and netted €0.1178; at €0.14 it nets €0.1278 = 26 PKN).
pub fn ct_ask_eur(pkn: f64, channel: crate::ct_fees::Channel) -> Option<f64> {
    crate::ct_fees::rule().gross_eur(pkn, channel).filter(|price| *price > 0.0)
}

/// The seller's CardTrader channel a listing carries for a write
/// (`ctChannel`, set by whoever resolved it); Zero, the higher rate, when
/// unknown, so a seller always nets at least the Pokoin price.
pub fn listing_channel(listing: &Value) -> crate::ct_fees::Channel {
    match first(listing, &["ctChannel"], 10).as_str() {
        "direct" => crate::ct_fees::Channel::Direct,
        _ => crate::ct_fees::Channel::Zero,
    }
}

/// CardTrader `PUT /products/:id` body for a Pokoin price edit: the ask that
/// nets that price for this seller.
pub fn price_body(pkn: f64, channel: crate::ct_fees::Channel) -> Option<Value> {
    ct_ask_eur(pkn, channel).map(|price| json!({ "price": json_number(price) }))
}

/// CardTrader `POST /products` body for a Pokoin listing.
pub fn product_body(listing: &Value) -> ApiResult<Value> {
    let id = blueprint(&first(listing, &["cardId", "card_id"], 80))
        .ok_or_else(|| ApiError::bad_request("CardTrader listing needs a CardTrader blueprint id."))?;
    let pkn = number(listing.get("pricePkn").or_else(|| listing.get("price_pkn")).unwrap_or(&Value::Null));
    let price = ct_ask_eur(pkn, listing_channel(listing))
        .ok_or_else(|| ApiError::bad_request("CardTrader listing needs a positive EUR price."))?;
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

/// A listing's game (`marketplace_game`); Pokémon when unset.
pub fn listing_game(listing: &Value) -> String {
    let raw = first(listing, &["marketplace_game", "marketplaceGame", "game"], 40);
    crate::db::normalize_game(if raw.is_empty() { "pokemon" } else { &raw })
}

/// A Pokoin listing's foil on a game other than Pokémon: imports store it as
/// `reverse` (`foil_state = 'reverse'`), Card Rails as `foil`/`holo`.
fn other_game_foil(listing: &Value) -> bool {
    listing["reverse"] == true
        || matches!(
            first(listing, &["foilState", "foil_state"], 40).to_lowercase().as_str(),
            "reverse" | "foil" | "holo"
        )
}

/// CardTrader's code for a Pokoin language among a blueprint's allowed values
/// (Riftbound: `en`, `zh-CN`, `fr`, `kr`; Magic adds `zh-TW`, …).
pub fn ct_language(language: &str, possible: &[Value]) -> Option<String> {
    let wanted: &[&str] = match language.trim().to_uppercase().as_str() {
        "" | "EN" => &["en"],
        "IT" => &["it"],
        "FR" => &["fr"],
        "DE" => &["de"],
        "ES" => &["es"],
        "PT" => &["pt"],
        "JP" | "JA" | "JPN" => &["jp", "ja"],
        "KO" | "KR" => &["kr", "ko"],
        "ZH" | "CN" | "ZHS" | "ZH-CN" => &["zh-CN", "zh"],
        "ZHT" | "TW" | "ZH-TW" => &["zh-TW", "zht"],
        "RU" => &["ru"],
        "NL" => &["nl"],
        "PL" => &["pl"],
        "ID" => &["id"],
        "TH" => &["th"],
        "VI" => &["vi"],
        _ => &[],
    };
    wanted.iter().find_map(|code| {
        possible
            .iter()
            .filter_map(Value::as_str)
            .find(|value| value.eq_ignore_ascii_case(code))
            .map(str::to_string)
    })
}

/// CardTrader's condition for a Pokoin one among a blueprint's allowed values.
pub fn ct_condition(condition: &str, possible: &[Value]) -> Option<String> {
    let wanted: &[&str] = match condition.trim().to_uppercase().as_str() {
        "M" | "MT" | "MINT" => &["Mint", "Near Mint"],
        "SP" | "LP" | "EX" => &["Slightly Played"],
        "MP" | "GD" => &["Moderately Played"],
        "PL" | "HP" => &["Played", "Heavily Played"],
        "PO" | "POOR" | "DMG" => &["Poor"],
        _ => &["Near Mint"],
    };
    if possible.is_empty() {
        return wanted.first().map(|value| value.to_string());
    }
    wanted.iter().find_map(|want| {
        possible.iter().filter_map(Value::as_str).find(|value| value == want).map(str::to_string)
    })
}

/// `POST /products` body for a listing of a game other than Pokémon, from
/// its blueprint's `editable_properties` (`marketplace_<game>.cardtrader_blueprints`):
/// only properties the blueprint has and values it allows (`riftbound_language`,
/// `riftbound_foil`, `mtg_foil`, `first_edition`, …). A facet the blueprint
/// cannot carry is refused, so nothing is created, rather than listed on
/// CardTrader as another copy.
pub fn product_body_for_blueprint(listing: &Value, editable: &[Value]) -> ApiResult<Value> {
    let mut body = product_body(listing)?;
    let named = |test: &dyn Fn(&str) -> bool| {
        editable.iter().find(|property| property["name"].as_str().is_some_and(|name| test(name)))
    };
    let possible = |property: &Value| property["possible_values"].as_array().cloned().unwrap_or_default();
    let refuse = |what: &str| {
        ApiError::bad_request(format!("CardTrader has no {what} for this card.")).with_code("cardtrader_facet_unsupported")
    };
    let mut properties = serde_json::Map::new();
    let condition = field(listing, "condition", 20);
    let condition = match named(&|name| name == "condition") {
        Some(property) => ct_condition(&condition, &possible(property)).ok_or_else(|| refuse("such condition"))?,
        None => ct_condition(&condition, &[]).unwrap_or_else(|| "Near Mint".into()),
    };
    properties.insert("condition".into(), json!(condition));
    if let Some(property) = named(&|name| name.ends_with("_language")) {
        let language = field(listing, "language", 10);
        let code = ct_language(&language, &possible(property)).ok_or_else(|| refuse("such language"))?;
        properties.insert(property["name"].as_str().unwrap_or_default().to_string(), json!(code));
    }
    let boolean = |property: &Value| property["type"] == "boolean";
    let flags: [(bool, &dyn Fn(&str) -> bool, &str); 4] = [
        (other_game_foil(listing), &|name: &str| name.ends_with("_foil"), "foil"),
        (
            listing["firstEdition"] == true || listing["first_edition"] == true,
            &|name: &str| name == "first_edition" || name.ends_with("_first_edition"),
            "first edition",
        ),
        (listing["signed"] == true, &|name: &str| name == "signed", "signed copy"),
        (listing["altered"] == true, &|name: &str| name == "altered", "altered copy"),
    ];
    for (on, test, what) in flags {
        if !on {
            continue;
        }
        let property = named(test).filter(|property| boolean(property)).ok_or_else(|| refuse(what))?;
        properties.insert(property["name"].as_str().unwrap_or_default().to_string(), json!(true));
    }
    body["properties"] = Value::Object(properties);
    Ok(body)
}

/// The create body for any game: Pokémon's fixed properties, or the
/// blueprint's own for the other games (`None` when its blueprint is unknown:
/// refused, nothing is created).
pub fn product_body_for_game(listing: &Value, editable: Option<&[Value]>) -> ApiResult<Value> {
    if listing_game(listing) == "pokemon" {
        return product_body(listing);
    }
    match editable {
        Some(editable) => product_body_for_blueprint(listing, editable),
        None => Err(ApiError::bad_request("CardTrader blueprint properties are unknown for this card.")
            .with_code("cardtrader_blueprint_unknown")),
    }
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
    push_product_outcome_on(fs, ct, uid, listing, None).await
}

/// [`push_product_outcome`] with a pool of the shared database, so the
/// seller's CardTrader channel comes from the market book
/// (`ct_fees::resolve_seller_channel_pool`); without one it is the stored
/// flag, else Zero.
pub async fn push_product_outcome_on(
    fs: &dyn FirestoreStore,
    ct: &CardTraderClient,
    uid: &str,
    listing: &Value,
    pool: Option<&PgPool>,
) -> PushOutcome {
    let prepared = async {
        let doc = integration::read_integration_doc(fs, uid).await?;
        if integration::is_one_day_ready_integration(&doc) {
            return Err(ApiError::conflict(
                "CardTrader 1-Day Ready accounts are stocked by CardTrader. List this card on Pokoin only.",
            ));
        }
        let channel = match pool {
            Some(pool) => crate::ct_fees::resolve_seller_channel_pool(pool, &doc.data).await,
            None => crate::ct_fees::seller_channel(&doc.data),
        };
        let mut listing = listing.clone();
        if listing.is_object() && listing.get("ctChannel").is_none() {
            listing["ctChannel"] = json!(channel.as_str());
        }
        let token = integration::decrypt_integration_token(fs, uid).await?;
        Ok((token, product_body(&listing)?))
    }
    .await;
    let (token, body) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => return PushOutcome::Rejected(error),
    };
    create_body(ct, &token, body).await
}

/// Create `listing` with a token the caller already holds (the reconcile's
/// push pass). The caller has ruled out 1-Day Ready accounts.
pub async fn create_with_token(ct: &CardTraderClient, token: &str, listing: &Value) -> PushOutcome {
    create_with_token_for(ct, token, listing, None).await
}

/// [`create_with_token`] for any game: `editable` is the blueprint's
/// `editable_properties` (required for the games other than Pokémon).
pub async fn create_with_token_for(
    ct: &CardTraderClient,
    token: &str,
    listing: &Value,
    editable: Option<&[Value]>,
) -> PushOutcome {
    match product_body_for_game(listing, editable) {
        Ok(body) => create_body(ct, token, body).await,
        Err(error) => PushOutcome::Rejected(error),
    }
}

async fn create_body(ct: &CardTraderClient, token: &str, body: Value) -> PushOutcome {
    let payload = match ct.create_product(token, body).await {
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
    push_product_on(fs, ct, uid, listing, None).await
}

/// [`push_product`] with the shared database's pool (the seller's channel
/// from the market book).
pub async fn push_product_on(
    fs: &dyn FirestoreStore,
    ct: &CardTraderClient,
    uid: &str,
    listing: &Value,
    pool: Option<&PgPool>,
) -> ApiResult<Value> {
    match push_product_outcome_on(fs, ct, uid, listing, pool).await {
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
    let pushed = push_product_on(fs, ct, uid, listing, Some(writer)).await?;
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
        // 2000 PKN net, unknown channel (Zero): €10.94 nets €10.0057.
        assert_eq!(body["price"], json!(10.94));
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

    fn riftbound_props() -> Vec<Value> {
        // Punching Poro 400553, from the nightly blueprint export.
        serde_json::from_str(r#"[
          {"name": "condition", "type": "string", "default_value": "Near Mint", "possible_values": ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Poor"]},
          {"name": "signed", "type": "boolean", "default_value": "false", "possible_values": [true, false]},
          {"name": "altered", "type": "boolean", "default_value": "false", "possible_values": [true, false]},
          {"name": "riftbound_language", "type": "string", "default_value": "en", "possible_values": ["en", "zh-CN", "fr", "kr"]},
          {"name": "riftbound_foil", "type": "boolean", "default_value": "false", "possible_values": [true, false]}
        ]"#).unwrap()
    }

    #[test]
    fn other_games_take_the_blueprint_properties() {
        let listing = json!({"id": "l1", "card_id": "801106", "price_pkn": 240, "quantity_available": 1,
                             "condition": "NM", "language": "EN", "foil_state": "standard", "reverse": false,
                             "marketplace_game": "riftbound"});
        let body = product_body_for_game(&listing, Some(&riftbound_props())).unwrap();
        assert_eq!(body["blueprint_id"], json!(400553));
        // 240 PKN net at Zero: listed at €1.31 (nets €1.2002).
        assert_eq!(body["price"], json!(1.31));
        assert_eq!(body["user_data_field"], json!("pokoin:l1"));
        assert_eq!(body["properties"], json!({"condition": "Near Mint", "riftbound_language": "en"}));
        let mut foil = listing.clone();
        foil["foil_state"] = json!("foil");
        foil["language"] = json!("KO");
        foil["condition"] = json!("HP");
        let body = product_body_for_game(&foil, Some(&riftbound_props())).unwrap();
        assert_eq!(body["properties"], json!({"condition": "Played", "riftbound_language": "kr", "riftbound_foil": true}));
        // Facets the blueprint cannot carry are refused: nothing is created.
        let mut italian = listing.clone();
        italian["language"] = json!("IT");
        assert!(product_body_for_game(&italian, Some(&riftbound_props())).is_err());
        let mut first = listing.clone();
        first["first_edition"] = json!(true);
        assert!(product_body_for_game(&first, Some(&riftbound_props())).is_err());
        assert!(product_body_for_game(&listing, None).is_err(), "unknown blueprint");
        // Pokémon keeps its fixed body with or without properties.
        let pokemon = json!({"id": "p", "cardId": "238", "pricePkn": 200, "language": "IT"});
        assert_eq!(listing_game(&pokemon), "pokemon");
        assert_eq!(product_body_for_game(&pokemon, None).unwrap()["properties"]["pokemon_language"], json!("it"));
        assert_eq!(ct_language("ZHT", &[json!("en"), json!("zh-TW")]).as_deref(), Some("zh-TW"));
        assert_eq!(ct_condition("LP", &[]).as_deref(), Some("Slightly Played"));
    }

    #[test]
    fn edit_price_uses_the_push_conversion() {
        use crate::ct_fees::Channel::{Direct, Zero};
        // 200 PKN net = €1.00: a direct seller lists at €1.07 (nets €1.0047), Zero at €1.10.
        assert_eq!(price_body(200.0, Direct), Some(json!({ "price": 1.07 })));
        assert_eq!(price_body(200.0, Zero), Some(json!({ "price": 1.1 })));
        // Spiderling NM EN, 26 PKN: €0.14, not €0.13 (the fee counted once).
        assert_eq!(price_body(26.0, Direct), Some(json!({ "price": 0.14 })));
        assert_eq!(eur_price(1.0), Some(0.01), "half a cent rounds up");
        assert_eq!(eur_price(0.5), None, "a quarter cent rounds to nothing");
        assert_eq!(price_body(0.0, Zero), None);
        assert_eq!(price_body(f64::NAN, Zero), None);
        assert_eq!(listing_channel(&json!({"ctChannel": "direct"})), Direct);
        assert_eq!(listing_channel(&json!({})), Zero);
    }
}
