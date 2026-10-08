//! Marketplace listings: public/owner reads, create, quantity decrement, field
//! updates and the PowerTools/Cardmarket/CardTrader/TCGPlayer stock CSV import
//! and export.

use std::collections::HashMap;

use axum::extract::{Query, State};

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use sqlx::Row;

use super::{clean_listing_id, private_json, text_field};
use crate::domain::stock_csv::{self, ImportOptions, PriceMode};
use crate::error::ApiError;
use crate::state::{AuthedUser, DomainState};

const LISTING_LIMIT_DEFAULT: i64 = 500;

fn clean_limit(value: Option<&String>) -> i64 {
    match value.and_then(|value| value.parse::<f64>().ok()) {
        Some(number) if number.is_finite() => (number.trunc() as i64).clamp(1, 1000),
        _ => LISTING_LIMIT_DEFAULT,
    }
}

fn clean_offset(value: Option<&String>) -> i64 {
    match value.and_then(|value| value.parse::<f64>().ok()) {
        Some(number) if number.is_finite() && number > 0.0 => {
            (number.trunc() as i64).min(50_000)
        }
        _ => 0,
    }
}

fn clean_text(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn bind_json<'a>(
    query: sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments>,
    value: &Value,
) -> sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match value {
        Value::String(text) => query.bind(text.clone()),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                query.bind(int)
            } else {
                query.bind(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::Bool(flag) => query.bind(*flag),
        Value::Null => query.bind(Option::<String>::None),
        Value::Array(rows) => query.bind(
            rows.iter()
                .filter_map(|row| row.as_str().map(|value| value.to_string()))
                .collect::<Vec<String>>(),
        ),
        _ => query.bind(value.to_string()),
    }
}


/// `PKNRESERVE_SELLER_USERNAME`.
pub const PKNRESERVE_SELLER_USERNAME: &str = "pknreserve";

/// `getPublicSellerProfiles`: cache-first public fields, display only.
///
/// A profile never authorises anything here; it only decides the name shown for
/// a listing, exactly like `sellerDisplayName`/`listingUsername` in Node.
async fn enrich_listing_sellers(state: &DomainState, listings: &mut [Value]) {
    let uids: Vec<String> = {
        let mut uids: Vec<String> = Vec::new();
        for listing in listings.iter() {
            let uid = listing
                .get("sellerUid")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if !uid.is_empty() && !uids.contains(&uid) {
                uids.push(uid);
            }
        }
        uids
    };
    if uids.is_empty() {
        return;
    }
    let Ok(firestore) = state.firestore() else {
        return;
    };
    let cache = state.profile_cache();
    let profiles = crate::seller_cache::read_public_profiles(
        cache
            .as_ref()
            .map(|cache| cache as &dyn crate::seller_cache::ProfileCache),
        firestore,
        &uids,
    )
    .await
    .unwrap_or_default();
    for listing in listings.iter_mut() {
        let Some(object) = listing.as_object_mut() else {
            continue;
        };
        let uid = object
            .get("sellerUid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let native_name = object
            .get("sellerName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let profile = profiles.get(&uid);
        // `sellerDisplayName`: profile display name, then handle, then the
        // listing's own seller name.
        let display = profile
            .map(|profile| profile.display_name.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                profile
                    .map(|profile| profile.username.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or(native_name.clone());
        object.insert(
            "sellerName".into(),
            json!(if display.trim().is_empty() {
                "Pokoin seller".to_string()
            } else {
                display
            }),
        );
        // `listingUsername`: reserve / CardTrader-live rows are the reserve
        // account; otherwise the claimed handle, then the listing's own name.
        let is_reserve = object.get("reserveAvailable").and_then(Value::as_bool) == Some(true)
            || object
                .get("source")
                .and_then(Value::as_str)
                .map(|source| source.eq_ignore_ascii_case("cardtrader_live"))
                .unwrap_or(false)
            || object
                .get("sourceListingId")
                .and_then(Value::as_str)
                .map(|value| value.starts_with("reserve:"))
                .unwrap_or(false);
        let handle = if is_reserve {
            PKNRESERVE_SELLER_USERNAME.to_string()
        } else {
            profile
                .map(|profile| profile.username.trim().to_string())
                .filter(|value| !value.is_empty() && value != PKNRESERVE_SELLER_USERNAME)
                .unwrap_or(native_name)
        };
        object.insert("sellerUsername".into(), json!(handle));
        if let Some(profile) = profile {
            object.insert("sellerAcceptsPkn".into(), json!(profile.accepts_pkn));
        }
    }
}

fn listing_row(row: &sqlx::postgres::PgRow, owner: bool) -> Value {
    let created: Option<chrono::DateTime<chrono::Utc>> = row.try_get("created_at").ok();
    let updated: Option<chrono::DateTime<chrono::Utc>> = row.try_get("updated_at").ok();
    let mut payload = json!({
        "id": row.try_get::<uuid::Uuid, _>("id").map(|id| id.to_string()).unwrap_or_default(),
        "cardId": row.try_get::<String, _>("card_id").unwrap_or_default(),
        "sellerUid": row.try_get::<String, _>("seller_uid").unwrap_or_default(),
        "sellerName": row.try_get::<Option<String>, _>("seller_name").ok().flatten().unwrap_or_else(|| "Pokoin seller".into()),
        "sellerCountry": row.try_get::<Option<String>, _>("seller_country").ok().flatten(),
        "sellerReputationLabel": row.try_get::<Option<String>, _>("seller_reputation_label").ok().flatten(),
        "marketplaceGame": row.try_get::<Option<String>, _>("marketplace_game").ok().flatten().unwrap_or_else(|| "pokemon".into()),
        "condition": row.try_get::<Option<String>, _>("condition").ok().flatten(),
        "language": row.try_get::<Option<String>, _>("language").ok().flatten(),
        "pricePkn": row.try_get::<f64, _>("price_pkn").unwrap_or(0.0),
        "sellerAcceptsPkn": true,
        "quantityAvailable": row.try_get::<i32, _>("quantity_available").unwrap_or(0),
        "signed": row.try_get::<Option<bool>, _>("signed").ok().flatten().unwrap_or(false),
        "reverse": row.try_get::<Option<bool>, _>("reverse").ok().flatten().unwrap_or(false),
        "firstEdition": row.try_get::<Option<bool>, _>("first_edition").ok().flatten().unwrap_or(false),
        "altered": row.try_get::<Option<bool>, _>("altered").ok().flatten().unwrap_or(false),
        "foilState": row.try_get::<Option<String>, _>("foil_state").ok().flatten().unwrap_or_else(|| "standard".into()),
        "variantState": row.try_get::<Option<String>, _>("variant_state").ok().flatten().unwrap_or_default(),
        "sealed": row.try_get::<Option<bool>, _>("sealed").ok().flatten().unwrap_or(false),
        "graded": row.try_get::<Option<bool>, _>("graded").ok().flatten().unwrap_or(false),
        "gradingCompany": row.try_get::<Option<String>, _>("grading_company").ok().flatten(),
        "grade": row.try_get::<Option<String>, _>("grade").ok().flatten(),
        "certificationId": row.try_get::<Option<String>, _>("certification_id").ok().flatten(),
        "shippingAvailable": row.try_get::<Option<bool>, _>("shipping_available").ok().flatten().unwrap_or(true),
        "reserveAvailable": row.try_get::<Option<bool>, _>("reserve_available").ok().flatten().unwrap_or(false),
        "nftAvailable": row.try_get::<Option<bool>, _>("nft_available").ok().flatten().unwrap_or(false),
        "sellerComment": row.try_get::<Option<String>, _>("seller_comment").ok().flatten().unwrap_or_default(),
        "source": row.try_get::<Option<String>, _>("source").ok().flatten().unwrap_or_else(|| "pokoin_user_listing".into()),
        "sourceListingId": row.try_get::<Option<String>, _>("source_listing_id").ok().flatten().unwrap_or_default(),
        "status": row.try_get::<Option<String>, _>("status").ok().flatten(),
        "cardName": row.try_get::<Option<String>, _>("card_name").ok().flatten(),
        "cardImageUrl": row.try_get::<Option<String>, _>("card_image_url").ok().flatten(),
        "setName": row.try_get::<Option<String>, _>("set_name").ok().flatten(),
        "collectorNumber": row.try_get::<Option<String>, _>("collector_number").ok().flatten(),
        "createdAt": created.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        "updatedAt": updated.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    });
    if owner {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "location".into(),
                json!(row.try_get::<Option<String>, _>("location").ok().flatten().unwrap_or_default()),
            );
        }
    }
    payload
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

pub async fn marketplace_listings_get(
    State(state): State<DomainState>,
    optional: crate::state::OptionalUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let raw_id = query.get("id").cloned().unwrap_or_default();
    let listing_id = clean_listing_id(&raw_id);
    if !raw_id.trim().is_empty() && listing_id.is_empty() {
        return Ok(private_json(json!({ "listings": [] })));
    }
    let card_id = clean_text(query.get("cardId").unwrap_or(&String::new()), 80);
    let seller_uid = clean_text(query.get("sellerUid").unwrap_or(&String::new()), 160);
    let seller_username = clean_text(query.get("sellerUsername").unwrap_or(&String::new()), 64);
    if !seller_uid.is_empty() && !seller_username.is_empty() {
        return Err(ApiError::bad_request(
            "Use either sellerUid or sellerUsername, not both.",
        ));
    }
    let limit = clean_limit(query.get("limit"));
    let offset = clean_offset(query.get("offset"));

    let mut values: Vec<Value> = Vec::new();
    let mut where_clauses: Vec<String> = Vec::new();

    if !card_id.is_empty() {
        values.push(json!(card_id));
        where_clauses.push(format!("listings.card_id = ${}", values.len()));
    }
    if !listing_id.is_empty() {
        values.push(json!(listing_id));
        where_clauses.push(format!("listings.id = ${}::uuid", values.len()));
    }

    let mut owner_uid = String::new();
    if !seller_uid.is_empty() {
        let claims = optional
            .0
            .as_ref()
            .ok_or_else(|| ApiError::unauthorized("Missing Pokoin user."))?;
        if claims.uid != seller_uid {
            return Err(ApiError::forbidden(
                "You can only read your own seller listings.",
            ));
        }
        owner_uid = seller_uid.clone();
        values.push(json!(seller_uid));
        where_clauses.push(format!("listings.seller_uid = ${}", values.len()));
    } else if !seller_username.is_empty() {
        let uid = sqlx::query_scalar::<_, String>(
            "select seller_uid from public.marketplace_user_listings
              where lower(btrim(seller_name)) = $1 and seller_uid is not null
              order by updated_at desc nulls last limit 1",
        )
        .bind(seller_username.to_lowercase())
        .fetch_optional(state.read_db())
        .await?
        .ok_or_else(|| ApiError::not_found("Seller not found."))?;
        owner_uid = uid.clone();
        values.push(json!(uid));
        where_clauses.push(format!("listings.seller_uid = ${}", values.len()));
        where_clauses.push("listings.status = 'active'".into());
        where_clauses.push("listings.quantity_available > 0".into());
    } else {
        where_clauses.push("listings.status = 'active'".into());
        where_clauses.push("listings.quantity_available > 0".into());
    }

    if listing_id.is_empty() && card_id.is_empty() {
        values.push(json!("pokemon"));
        where_clauses.push(format!(
            "coalesce(nullif(listings.marketplace_game, ''), 'pokemon') = ${}",
            values.len()
        ));
    }

    let qualified = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("where {}", where_clauses.join(" and "))
    };
    values.push(json!(limit));
    let limit_index = values.len();
    let offset_sql = if offset > 0 {
        values.push(json!(offset));
        format!(" offset ${}", values.len())
    } else {
        String::new()
    };
    let sql = format!(
        "select listings.* from public.marketplace_user_listings listings
         {qualified}
         order by price_pkn asc, updated_at desc, created_at desc
         limit ${limit_index}{offset_sql}"
    );
    let mut builder = sqlx::query(&sql);
    for value in &values {
        builder = bind_json(builder, value);
    }
    let rows = builder.fetch_all(state.read_db()).await?;
    let owner = !owner_uid.is_empty();
    let mut listings: Vec<Value> = rows.iter().map(|row| listing_row(row, owner)).collect();
    enrich_listing_sellers(&state, &mut listings).await;
    Ok(private_json(json!({ "listings": listings })))
}

// ---------------------------------------------------------------------------
// POST (create / decrement)
// ---------------------------------------------------------------------------

pub async fn marketplace_listings_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let action = clean_text(query.get("action").unwrap_or(&String::new()), 40);
    let id = clean_listing_id(query.get("id").unwrap_or(&String::new()));
    if action == "decrement" && !id.is_empty() {
        let quantity = body.get("quantity").and_then(Value::as_f64).unwrap_or(0.0);
        if !quantity.is_finite() || quantity.fract() != 0.0 || quantity <= 0.0 {
            return Err(ApiError::bad_request("Quantity must be a positive integer."));
        }
        return decrement_listing(&state, &id, &claims.uid, quantity as i64).await;
    }
    create_listing(&state, &claims.uid, &body).await
}

async fn decrement_listing(
    state: &DomainState,
    id: &str,
    seller_uid: &str,
    quantity: i64,
) -> Result<Response, ApiError> {
    let row = sqlx::query(crate::handlers::orders::DECREMENT_SQL)
        .bind(uuid::Uuid::parse_str(id).map_err(|_| ApiError::bad_request("Listing id invalid."))?)
        .bind(seller_uid)
        .bind(quantity as i32)
        .fetch_one(state.write_db())
        .await?;
    let outcome: String = row.try_get("outcome").unwrap_or_else(|_| "missing".into());
    match outcome.as_str() {
        "updated" => {
            let listing: Option<Value> = row.try_get("listing").ok();
            Ok(private_json(json!({
                "listing": listing.map(|value| normalize_listing_json(&value)),
            })))
        }
        "invalid" => Err(ApiError::bad_request("Quantity must be a positive integer.")),
        "forbidden" | "missing" => Err(ApiError::not_found("Listing not found for this seller.")),
        "insufficient" => {
            Err(ApiError::conflict("Not enough quantity.").with_code("insufficient_quantity"))
        }
        _ => Err(ApiError::not_found("Listing not found for this seller.")),
    }
}

fn normalize_listing_json(value: &Value) -> Value {
    let mut out = value.clone();
    if let Some(object) = out.as_object_mut() {
        object.insert(
            "id".into(),
            json!(object.get("id").and_then(Value::as_str).unwrap_or_default()),
        );
    }
    out
}

async fn create_listing(
    state: &DomainState,
    uid: &str,
    body: &Value,
) -> Result<Response, ApiError> {
    let card_id = text_field(body, &["cardId"], 80);
    if card_id.is_empty() {
        return Err(ApiError::bad_request("Missing card id."));
    }
    let price_pkn = body.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
    if !price_pkn.is_finite() || price_pkn <= 0.0 {
        return Err(ApiError::bad_request("Enter a valid PKN price."));
    }
    let quantity = body
        .get("quantityAvailable")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if !(1..=99).contains(&quantity) {
        return Err(ApiError::bad_request("Quantity must be between 1 and 99."));
    }
    let seller_country = crate::domain::country::normalize_country(&text_field(
        body,
        &["sellerCountry", "shipFromCountry"],
        40,
    ));
    if seller_country.is_empty() {
        return Err(ApiError::bad_request(
            "shipFromCountry (ISO country code) is required before listing.",
        )
        .with_code("missing_ship_from"));
    }
    let reverse = body.get("reverse").and_then(Value::as_bool) == Some(true);
    let reserve_available = body.get("reserveAvailable").and_then(Value::as_bool) == Some(true);
    let game = body
        .get("marketplaceGame")
        .and_then(Value::as_str)
        .and_then(super::cart::normalize_game)
        .unwrap_or("pokemon");

    let row = sqlx::query(
        r#"
        insert into public.marketplace_user_listings (
          card_id, seller_uid, seller_name, seller_country, seller_reputation_label,
          condition, language, price_pkn, quantity_available, signed, reverse,
          first_edition, foil_state, variant_state, sealed, graded,
          grading_company, grade, certification_id, shipping_available,
          reserve_available, nft_available, seller_comment, source,
          source_listing_id, card_name, card_image_url, set_name, collector_number,
          location, altered, marketplace_game
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
        ) returning *
        "#,
    )
    .bind(&card_id)
    .bind(uid)
    .bind({
        let name = text_field(body, &["sellerName"], 120);
        if name.is_empty() { "Pokoin seller".to_string() } else { name }
    })
    .bind(&seller_country)
    .bind({
        let label = text_field(body, &["sellerReputationLabel"], 40);
        if label.is_empty() { "New".to_string() } else { label }
    })
    .bind({
        let value = text_field(body, &["condition"], 20);
        if value.is_empty() { "NM".to_string() } else { value }
    })
    .bind({
        let value = text_field(body, &["language"], 10);
        if value.is_empty() { "EN".to_string() } else { value }
    })
    .bind(price_pkn)
    .bind(quantity as i32)
    .bind(body.get("signed").and_then(Value::as_bool) == Some(true))
    .bind(reverse)
    .bind(body.get("firstEdition").and_then(Value::as_bool) == Some(true))
    .bind({
        let value = text_field(body, &["foilState"], 40);
        if value.is_empty() {
            if reverse { "reverse".to_string() } else { "standard".to_string() }
        } else {
            value
        }
    })
    .bind(text_field(body, &["variantState"], 80))
    .bind(body.get("sealed").and_then(Value::as_bool) == Some(true))
    .bind(body.get("graded").and_then(Value::as_bool) == Some(true))
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(body.get("shippingAvailable").and_then(Value::as_bool) != Some(false))
    .bind(reserve_available)
    .bind(body.get("nftAvailable").and_then(Value::as_bool) == Some(true))
    .bind(text_field(body, &["sellerComment"], 500))
    .bind({
        let value = text_field(body, &["source"], 80);
        if value.is_empty() { "pokoin_user_listing".to_string() } else { value }
    })
    .bind(text_field(body, &["sourceListingId"], 160))
    .bind({
        let name = text_field(body, &["cardName"], 240);
        if name.is_empty() { card_id.clone() } else { name }
    })
    .bind(text_field(body, &["cardImageUrl"], 800))
    .bind({
        let value = text_field(body, &["setName"], 240);
        if value.is_empty() { "Pokemon".to_string() } else { value }
    })
    .bind({
        let value = text_field(body, &["collectorNumber"], 80);
        if value.is_empty() { card_id.clone() } else { value }
    })
    .bind(text_field(body, &["location"], 64))
    .bind(body.get("altered").and_then(Value::as_bool) == Some(true))
    .bind(game)
    .fetch_one(state.write_db())
    .await?;

    Ok(private_json(json!({
        "listing": listing_row(&row, true),
        "cardtrader": { "ok": true, "skipped": true, "reason": "not_ported" },
        "targets": { "pokoin": true, "cardtrader": false },
    })))
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

pub async fn marketplace_listings_patch(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let id = clean_listing_id(query.get("id").unwrap_or(&String::new()));
    if id.is_empty() {
        return Err(ApiError::bad_request("Listing id is required."));
    }
    let uuid = uuid::Uuid::parse_str(&id)
        .map_err(|_| ApiError::bad_request("Listing id is required."))?;

    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let push = |column: &str, value: Value, sets: &mut Vec<String>, values: &mut Vec<Value>| {
        values.push(value);
        sets.push(format!("{column} = ${}", values.len()));
    };

    if let Some(price) = body.get("pricePkn").and_then(Value::as_f64) {
        if price > 0.0 {
            push("price_pkn", json!(price), &mut sets, &mut values);
        }
    }
    if let Some(quantity) = body.get("quantityAvailable").and_then(Value::as_i64) {
        if (0..=99).contains(&quantity) {
            push("quantity_available", json!(quantity), &mut sets, &mut values);
        }
    }
    if let Some(status) = body.get("status").and_then(Value::as_str) {
        if ["active", "paused", "inactive", "sold_out"].contains(&status) {
            push("status", json!(status), &mut sets, &mut values);
        }
    }
    for (body_key, column, max) in [
        ("condition", "condition", 20usize),
        ("language", "language", 10),
        ("location", "location", 64),
        ("foilState", "foil_state", 40),
        ("variantState", "variant_state", 80),
        ("gradingCompany", "grading_company", 80),
        ("grade", "grade", 40),
        ("certificationId", "certification_id", 120),
        ("sellerComment", "seller_comment", 500),
        ("cardName", "card_name", 240),
        ("cardImageUrl", "card_image_url", 800),
        ("setName", "set_name", 240),
        ("collectorNumber", "collector_number", 80),
    ] {
        if let Some(value) = body.get(body_key).and_then(Value::as_str) {
            push(column, json!(clean_text(value, max)), &mut sets, &mut values);
        }
    }
    for (body_key, column) in [
        ("signed", "signed"),
        ("reverse", "reverse"),
        ("firstEdition", "first_edition"),
        ("altered", "altered"),
        ("sealed", "sealed"),
        ("graded", "graded"),
        ("reserveAvailable", "reserve_available"),
        ("nftAvailable", "nft_available"),
    ] {
        if let Some(value) = body.get(body_key).and_then(Value::as_bool) {
            push(column, json!(value), &mut sets, &mut values);
        }
    }
    if let Some(value) = body.get("shippingAvailable").and_then(Value::as_bool) {
        push("shipping_available", json!(value), &mut sets, &mut values);
    }
    if sets.is_empty() {
        return Err(ApiError::bad_request("Nothing to update."));
    }
    values.push(json!(uuid.to_string()));
    let id_index = values.len();
    values.push(json!(claims.uid));
    let seller_index = values.len();

    let sql = format!(
        "update public.marketplace_user_listings
            set {}, updated_at = now()
          where id = ${id_index}::uuid and seller_uid = ${seller_index}
        returning *",
        sets.join(", ")
    );
    let mut builder = sqlx::query(&sql);
    for value in &values {
        builder = bind_json(builder, value);
    }
    let row = builder.fetch_optional(state.write_db()).await?;
    let Some(row) = row else {
        return Err(ApiError::not_found("Listing not found for this seller."));
    };
    Ok(private_json(listing_row(&row, true)))
}

// ---------------------------------------------------------------------------
// CSV export / import
// ---------------------------------------------------------------------------

struct SellerListing {
    id: String,
    card_id: String,
    card_name: String,
    set_name: String,
    collector_number: String,
    condition: String,
    language: String,
    price_pkn: f64,
    quantity: i64,
    signed: bool,
    reverse: bool,
    first_edition: bool,
    foil_state: String,
    variant_state: String,
    altered: bool,
    seller_comment: String,
    location: String,
    source: String,
}

impl SellerListing {
    fn to_export_json(&self) -> Value {
        json!({
            "id": self.id,
            "cardId": self.card_id,
            "cardName": self.card_name,
            "setName": self.set_name,
            "collectorNumber": self.collector_number,
            "condition": self.condition,
            "language": self.language,
            "pricePkn": self.price_pkn,
            "quantityAvailable": self.quantity,
            "signed": self.signed,
            "reverse": self.reverse,
            "firstEdition": self.first_edition,
            "foilState": self.foil_state,
            "variantState": self.variant_state,
            "altered": self.altered,
            "sellerComment": self.seller_comment,
            "location": self.location,
            "source": self.source,
            "sourceListingId": self.source,
            "blueprintId": self.card_id,
            "cardmarketId": "",
        })
    }
}

async fn load_seller_listings(
    state: &DomainState,
    uid: &str,
) -> Result<Vec<SellerListing>, ApiError> {
    let rows = sqlx::query(
        "select * from public.marketplace_user_listings
          where seller_uid = $1 and status in ('active', 'paused', 'inactive')
          order by updated_at desc limit 10000",
    )
    .bind(uid)
    .fetch_all(state.read_db())
    .await?;
    Ok(rows
        .iter()
        .map(|row| SellerListing {
            id: row
                .try_get::<uuid::Uuid, _>("id")
                .map(|id| id.to_string())
                .unwrap_or_default(),
            card_id: row.try_get("card_id").unwrap_or_default(),
            card_name: row.try_get::<Option<String>, _>("card_name").ok().flatten().unwrap_or_default(),
            set_name: row.try_get::<Option<String>, _>("set_name").ok().flatten().unwrap_or_default(),
            collector_number: row
                .try_get::<Option<String>, _>("collector_number")
                .ok()
                .flatten()
                .unwrap_or_default(),
            condition: row.try_get::<Option<String>, _>("condition").ok().flatten().unwrap_or_default(),
            language: row.try_get::<Option<String>, _>("language").ok().flatten().unwrap_or_default(),
            price_pkn: row.try_get::<f64, _>("price_pkn").unwrap_or(0.0),
            quantity: row.try_get::<i32, _>("quantity_available").unwrap_or(0) as i64,
            signed: row.try_get::<Option<bool>, _>("signed").ok().flatten().unwrap_or(false),
            reverse: row.try_get::<Option<bool>, _>("reverse").ok().flatten().unwrap_or(false),
            first_edition: row
                .try_get::<Option<bool>, _>("first_edition")
                .ok()
                .flatten()
                .unwrap_or(false),
            foil_state: row
                .try_get::<Option<String>, _>("foil_state")
                .ok()
                .flatten()
                .unwrap_or_else(|| "standard".into()),
            variant_state: row
                .try_get::<Option<String>, _>("variant_state")
                .ok()
                .flatten()
                .unwrap_or_default(),
            altered: row.try_get::<Option<bool>, _>("altered").ok().flatten().unwrap_or(false),
            seller_comment: row
                .try_get::<Option<String>, _>("seller_comment")
                .ok()
                .flatten()
                .unwrap_or_default(),
            location: row.try_get::<Option<String>, _>("location").ok().flatten().unwrap_or_default(),
            source: row.try_get::<Option<String>, _>("source").ok().flatten().unwrap_or_default(),
        })
        .collect())
}

pub async fn marketplace_listings_csv_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let format = query
        .get("format")
        .map(|value| clean_text(value, 40))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "powertools".into());
    if !stock_csv::FORMATS.contains(&format.as_str()) {
        return Err(ApiError::bad_request(
            "format must be powertools, cardmarket, cardtrader, or tcgplayer.",
        ));
    }
    let listings = load_seller_listings(&state, &claims.uid).await?;
    let rows: Vec<Value> = listings.iter().map(|row| row.to_export_json()).collect();
    let body = stock_csv::export_listings_csv(&format, &rows)
        .map_err(|message| ApiError::bad_request(message))?;
    let mut response = body.into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = axum::http::HeaderValue::from_str(&format!(
        "attachment; filename=\"pokoin-stock-{format}.csv\""
    )) {
        response
            .headers_mut()
            .insert(axum::http::header::CONTENT_DISPOSITION, value);
    }
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

pub async fn marketplace_listings_csv_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let csv_text = body.get("csv").and_then(Value::as_str).unwrap_or_default();
    if csv_text.trim().is_empty() {
        return Err(ApiError::bad_request("Missing csv text."));
    }
    let stack_size = body
        .get("stackSize")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| (value.trunc() as i64).max(1))
        .unwrap_or(1);
    let price_mode = match clean_text(
        body.get("priceMode").and_then(Value::as_str).unwrap_or("eur_to_pkn"),
        40,
    )
    .as_str()
    {
        "as_pkn" => PriceMode::AsPkn,
        "cents_eur_to_pkn" => PriceMode::CentsEurToPkn,
        _ => PriceMode::EurToPkn,
    };
    let dry_run = body.get("dryRun").and_then(Value::as_bool) != Some(false);
    let format = body
        .get("format")
        .and_then(Value::as_str)
        .map(|value| clean_text(value, 40))
        .filter(|value| !value.is_empty());
    let preserve_location = body.get("preserveLocation").and_then(Value::as_bool) == Some(true);
    let cardtrader_intent = match body.get("cardtraderIntent").and_then(Value::as_str) {
        Some("link") => "link",
        Some("import") => "import",
        _ => "",
    };

    let options = ImportOptions {
        format,
        price_mode,
        preserve_location,
        stack_size: Some(stack_size),
        ..Default::default()
    };
    let parsed = stock_csv::import_csv_text(csv_text, &options)
        .map_err(|message| ApiError::bad_request(message))?;

    let mut created: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut preview: Vec<Value> = Vec::new();

    for entry in &parsed.results {
        let raw_json = Value::Object(entry.raw.clone());
        if !entry.ok {
            failed.push(json!({
                "line": entry.index,
                "error": entry.error.clone().unwrap_or_else(|| "Invalid row".into()),
                "raw": raw_json,
            }));
            continue;
        }
        let Some(row) = entry.row.clone() else {
            continue;
        };
        let price = row.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
        if !(price > 0.0) {
            failed.push(json!({
                "line": entry.index,
                "error": "Invalid or missing price",
                "raw": raw_json,
                "row": row,
            }));
            continue;
        }
        let resolved = match resolve_card(&state, &row).await? {
            Ok(resolved) => resolved,
            Err(message) => {
                failed.push(json!({
                    "line": entry.index,
                    "error": message,
                    "raw": raw_json,
                    "row": row,
                }));
                continue;
            }
        };
        if dry_run {
            preview.push(json!({
                "line": entry.index,
                "cardId": resolved.card_id,
                "name": resolved.card_name,
                "location": row.get("location").cloned().unwrap_or(json!("")),
                "condition": row.get("condition").cloned().unwrap_or(json!("NM")),
                "language": row.get("language").cloned().unwrap_or(json!("EN")),
                "pricePkn": price,
                "quantity": row.get("quantity").cloned().unwrap_or(json!(1)),
            }));
            continue;
        }
        match insert_import_listing(
            &state,
            &claims.uid,
            &row,
            &resolved,
            &parsed.format,
            cardtrader_intent,
        )
        .await
        {
            Ok(InsertOutcome::Created { id, card_id, location }) => created.push(json!({
                "line": entry.index, "created": true, "id": id, "cardId": card_id, "location": location,
            })),
            Ok(InsertOutcome::Skipped { id, reason }) => skipped.push(json!({
                "line": entry.index, "skipped": true, "id": id, "reason": reason,
            })),
            Err(error) => failed.push(json!({
                "line": entry.index,
                "error": error.to_string(),
                "raw": raw_json,
                "row": row,
            })),
        }
    }

    let failed_csv = if failed.is_empty() {
        String::new()
    } else {
        let mut headers = stock_csv::headers_for(&parsed.format).unwrap_or_default();
        headers.push("importError".into());
        let rows: Vec<Value> = failed
            .iter()
            .map(|row| {
                let mut object = row.get("raw").cloned().unwrap_or(json!({}));
                if let Some(map) = object.as_object_mut() {
                    map.insert(
                        "importError".into(),
                        row.get("error").cloned().unwrap_or(json!("")),
                    );
                }
                object
            })
            .collect();
        stock_csv::to_csv(&headers, &rows)
    };

    Ok(private_json(json!({
        "format": parsed.format,
        "dryRun": dry_run,
        "stackSize": stack_size,
        "priceMode": match price_mode {
            PriceMode::AsPkn => "as_pkn",
            PriceMode::CentsEurToPkn => "cents_eur_to_pkn",
            PriceMode::EurToPkn => "eur_to_pkn",
        },
        "counts": {
            "total": parsed.results.len(),
            "preview": preview.len(),
            "created": created.len(),
            "skipped": skipped.len(),
            "failed": failed.len(),
        },
        "preview": preview,
        "created": created,
        "skipped": skipped,
        "failed": failed,
        "failedCsv": failed_csv,
    })))
}

enum InsertOutcome {
    Created {
        id: String,
        card_id: String,
        location: String,
    },
    Skipped {
        id: String,
        reason: &'static str,
    },
}

struct ResolvedCard {
    card_id: String,
    card_name: String,
    set_name: String,
    collector_number: String,
    image_url: String,
}

/// `resolveCard`: exact name + collector against `marketplace_cards`.
async fn resolve_card(
    state: &DomainState,
    row: &Value,
) -> Result<Result<ResolvedCard, String>, ApiError> {
    let name = clean_text(row.get("name").and_then(Value::as_str).unwrap_or_default(), 240);
    let cn = clean_text(
        row.get("collectorNumber").and_then(Value::as_str).unwrap_or_default(),
        40,
    );
    let set_name = clean_text(row.get("setName").and_then(Value::as_str).unwrap_or_default(), 240);
    if name.is_empty() {
        return Ok(Err("Missing card name".into()));
    }
    let cn_core = {
        let without_prefix = cn.rsplit("| ").next().unwrap_or(&cn).trim().to_string();
        without_prefix
            .split('/')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let mut sql = String::from(
        "select card_id::text as card_id, name, set_name, card_number, image_url, cdn_image_url
           from public.marketplace_cards
          where name = $1
            and set_name not ilike '%Poké Ball%'
            and set_name not ilike '%Master Ball%'",
    );
    if !cn_core.is_empty() {
        sql.push_str(
            " and (card_number = $2 or card_number like $2 || '/%'
               or card_number like '%| ' || $2 or card_number like '%| ' || $2 || '/%')",
        );
    }
    if !set_name.is_empty() {
        sql.push_str(" order by case when set_name ilike $3 then 0 else 1 end, card_id");
    } else {
        sql.push_str(" order by card_id");
    }
    sql.push_str(" limit 5");

    let mut builder = sqlx::query(&sql).bind(&name);
    if !cn_core.is_empty() {
        builder = builder.bind(&cn_core);
    }
    if !set_name.is_empty() {
        builder = builder.bind(format!("%{set_name}%"));
    }
    let rows = builder.fetch_all(state.read_db()).await.unwrap_or_default();
    if rows.is_empty() {
        return Ok(Err(format!("No catalog match for {name} {cn}").trim().to_string()));
    }
    let mapping: Vec<ResolvedCard> = rows
        .iter()
        .map(|row| ResolvedCard {
            card_id: row.try_get("card_id").unwrap_or_default(),
            card_name: row.try_get::<Option<String>, _>("name").ok().flatten().unwrap_or_default(),
            set_name: row.try_get::<Option<String>, _>("set_name").ok().flatten().unwrap_or_default(),
            collector_number: row
                .try_get::<Option<String>, _>("card_number")
                .ok()
                .flatten()
                .unwrap_or_default(),
            image_url: {
                let cdn: Option<String> = row.try_get("cdn_image_url").ok().flatten();
                let image: Option<String> = row.try_get("image_url").ok().flatten();
                cdn.or(image).unwrap_or_default()
            },
        })
        .collect();

    if mapping.len() > 1 && !set_name.is_empty() {
        let narrowed: Vec<&ResolvedCard> = mapping
            .iter()
            .filter(|row| row.set_name.to_lowercase().contains(&set_name.to_lowercase()))
            .collect();
        if narrowed.len() == 1 {
            let hit = narrowed[0];
            return Ok(Ok(ResolvedCard {
                card_id: hit.card_id.clone(),
                card_name: hit.card_name.clone(),
                set_name: hit.set_name.clone(),
                collector_number: hit.collector_number.clone(),
                image_url: hit.image_url.clone(),
            }));
        }
    }
    if mapping.len() > 1 {
        let ids: Vec<&str> = mapping.iter().map(|row| row.card_id.as_str()).collect();
        return Ok(Err(format!("Ambiguous match for {name} ({})", ids.join(", "))));
    }
    let hit = mapping.into_iter().next().expect("non-empty");
    Ok(Ok(hit))
}

async fn insert_import_listing(
    state: &DomainState,
    uid: &str,
    row: &Value,
    resolved: &ResolvedCard,
    format: &str,
    cardtrader_intent: &str,
) -> Result<InsertOutcome, sqlx::Error> {
    let source = stock_csv::source_for_format(format, cardtrader_intent);
    let source_listing_id = stock_csv::source_listing_id_for(format, row);
    if !source_listing_id.is_empty() {
        let existing = sqlx::query_scalar::<_, uuid::Uuid>(
            "select id from public.marketplace_user_listings
              where seller_uid = $1 and source = $2 and source_listing_id = $3 limit 1",
        )
        .bind(uid)
        .bind(source)
        .bind(&source_listing_id)
        .fetch_optional(state.read_db())
        .await
        .unwrap_or(None);
        if let Some(id) = existing {
            return Ok(InsertOutcome::Skipped {
                id: id.to_string(),
                reason: "already_imported",
            });
        }
    }

    let quantity = row.get("quantity").and_then(Value::as_i64).unwrap_or(1).clamp(1, 99);
    let price = row.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
    let row_text = |key: &str, fallback: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    };
    let result = sqlx::query(
        r#"
        insert into public.marketplace_user_listings (
          card_id, seller_uid, seller_name, seller_country, seller_reputation_label,
          condition, language, price_pkn, quantity_available, signed, reverse,
          first_edition, foil_state, variant_state, sealed, graded,
          grading_company, grade, certification_id, shipping_available,
          reserve_available, nft_available, seller_comment, source,
          source_listing_id, card_name, card_image_url, set_name, collector_number,
          location, altered
        ) values (
          $1,$2,$3,'EU','New',$4,$5,$6,$7,$8,$9,$10,$11,$12,false,false,
          null,null,null,true,false,false,$13,$14,$15,$16,$17,$18,$19,$20,$21
        ) returning id, card_id, location
        "#,
    )
    .bind(&resolved.card_id)
    .bind(uid)
    .bind("Pokoin seller")
    .bind(row_text("condition", "NM"))
    .bind(row_text("language", "EN"))
    .bind(price)
    .bind(quantity as i32)
    .bind(row.get("signed").and_then(Value::as_bool) == Some(true))
    .bind(row.get("reverse").and_then(Value::as_bool) == Some(true))
    .bind(row.get("firstEdition").and_then(Value::as_bool) == Some(true))
    .bind(row_text("foilState", "standard"))
    .bind(row_text("variantState", ""))
    .bind(row_text("sellerComment", ""))
    .bind(source)
    .bind(&source_listing_id)
    .bind({
        let name = if resolved.card_name.is_empty() {
            row_text("name", "")
        } else {
            resolved.card_name.clone()
        };
        name
    })
    .bind(&resolved.image_url)
    .bind(if resolved.set_name.is_empty() {
        row_text("setName", "Pokemon")
    } else {
        resolved.set_name.clone()
    })
    .bind(if resolved.collector_number.is_empty() {
        row_text("collectorNumber", &resolved.card_id)
    } else {
        resolved.collector_number.clone()
    })
    .bind(row_text("location", ""))
    .bind(row.get("altered").and_then(Value::as_bool) == Some(true))
    .fetch_one(state.write_db())
    .await?;

    Ok(InsertOutcome::Created {
        id: result
            .try_get::<uuid::Uuid, _>("id")
            .map(|id| id.to_string())
            .unwrap_or_default(),
        card_id: result.try_get("card_id").unwrap_or_default(),
        location: result.try_get::<Option<String>, _>("location").ok().flatten().unwrap_or_default(),
    })
}

/// Public native offers for one card desk — the interface the native card-page
/// handler needs (the Node `readPublicOffersForCard`).
///
/// Reads the Pi replica only. `native_only` mirrors the Node `nativeOnly=1`
/// switch: the live CardTrader merge is not ported (see commerce-coverage.json).
pub async fn read_public_offers_for_card(
    state: &DomainState,
    card_id: &str,
    limit: i64,
    game: &str,
    native_only: bool,
) -> Result<Vec<Value>, ApiError> {
    let card_id = clean_text(card_id, 80);
    if card_id.is_empty() {
        return Ok(Vec::new());
    }
    let game = if game.trim().is_empty() { "pokemon" } else { game.trim() };
    let limit = limit.clamp(1, 1000);
    let mut sql = String::from(
        "select listings.*
           from public.marketplace_user_listings listings
          where listings.card_id = $1
            and listings.status = 'active'
            and listings.quantity_available > 0",
    );
    if !native_only {
        sql.push_str(
            " and coalesce(nullif(listings.marketplace_game, ''), 'pokemon') = $3",
        );
    }
    sql.push_str(" order by price_pkn asc, updated_at desc, created_at desc limit $2");

    let mut builder = sqlx::query(&sql).bind(&card_id).bind(limit);
    if !native_only {
        builder = builder.bind(game);
    }
    let rows = builder.fetch_all(state.read_db()).await?;
    let mut listings: Vec<Value> = rows.iter().map(|row| listing_row(row, false)).collect();
    listings.sort_by(|a, b| {
        let left = a.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
        let right = b.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
        left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(listings)
}

/// Shared method guard for the listings family.
pub fn method_not_allowed(allow: &str) -> Response {
    let mut response = ApiError::method_not_allowed(allow).into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(allow) {
        response.headers_mut().insert("allow", value);
    }
    response
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_limits_and_offsets_match_the_node_guards() {
        assert_eq!(clean_limit(None), 500);
        assert_eq!(clean_limit(Some(&"0".into())), 1);
        assert_eq!(clean_limit(Some(&"100000".into())), 1000);
        assert_eq!(clean_offset(Some(&"-2".into())), 0);
        assert_eq!(clean_offset(Some(&"99999".into())), 50_000);
    }

    #[test]
    fn listing_ids_must_be_uuids() {
        assert_eq!(
            clean_listing_id("2f1c9f7a-4a4f-4a0e-9f2f-7f5b1c2d3e4f"),
            "2f1c9f7a-4a4f-4a0e-9f2f-7f5b1c2d3e4f"
        );
        assert_eq!(clean_listing_id("not-a-uuid"), "");
        assert_eq!(clean_listing_id(""), "");
    }

    #[test]
    fn clean_text_trims_and_caps() {
        assert_eq!(clean_text("  abc  ", 2), "ab");
        assert_eq!(clean_text("", 10), "");
    }
}
