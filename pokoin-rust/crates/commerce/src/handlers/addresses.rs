//! Saved shipping addresses, live shipping options and checkout quoting.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::{created_json, parse_json_body, private_json, public_json, text_field};
use crate::domain::address::{
    decrypt_address_payload, encrypt_address_payload, validate_address_fields, EncryptedPayload,
};
use crate::domain::shipping::{self, RateCatalog};
use crate::error::ApiError;
use crate::firestore::StructuredQuery;
use crate::state::{AuthedUser, DomainState};
use crate::store;

/// Sub-collection under `users/{uid}` holding encrypted shipping addresses.
const ADDRESSES_COLLECTION: &str = "shipping_addresses";

// ---------------------------------------------------------------------------
// /api/account-addresses
// ---------------------------------------------------------------------------

fn address_id(headers_query: &HashMap<String, String>, body: &Value) -> String {
    let from_query = headers_query
        .get("id")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if !from_query.is_empty() {
        return from_query;
    }
    text_field(body, &["id"], 80)
}

fn public_address_row(row: &Value) -> Value {
    json!({
        "id": row.get("id").and_then(Value::as_str).unwrap_or_default(),
        "countryCode": row
            .get("countryCode")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim(),
        "isDefault": row.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
        "label": row.get("label").and_then(Value::as_str).unwrap_or_default(),
        "createdAt": row.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": row.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

fn decrypted_address_row(state: &DomainState, row: &Value) -> Result<Value, ApiError> {
    let mut public = public_address_row(row);
    let encrypted: Value = row.get("encryptedPayload").cloned().unwrap_or(json!({}));
    let envelope: EncryptedPayload = serde_json::from_value(encrypted)
        .map_err(|_| ApiError::internal("Unsupported address encryption format."))?;
    let fields = decrypt_address_payload(
        &envelope,
        state.config().address_encryption_key.as_deref(),
    )?;
    if let Some(object) = public.as_object_mut() {
        object.insert("fullName".into(), json!(fields.full_name));
        object.insert("companyName".into(), json!(fields.company_name));
        object.insert("addressLine1".into(), json!(fields.address_line1));
        object.insert("addressLine2".into(), json!(fields.address_line2));
        object.insert("postalCode".into(), json!(fields.postal_code));
        object.insert("city".into(), json!(fields.city));
        object.insert("stateProvinceRegion".into(), json!(fields.state_province_region));
        object.insert("phoneNumber".into(), json!(fields.phone_number));
        object.insert("deliveryInstructions".into(), json!(fields.delivery_instructions));
    }
    Ok(public)
}

pub async fn account_addresses_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let reveal = query.get("reveal").map(String::as_str) == Some("1");
    let firestore = state.firestore()?;
    let parent = firestore.document_path(store::USERS, &claims.uid);
    let rows = firestore
        .run_query(
            &StructuredQuery::collection(ADDRESSES_COLLECTION)
                .parent(parent)
                .order_by("createdAt", true)
                .limit(20),
        )
        .await?;
    let mut addresses = Vec::new();
    for row in &rows {
        addresses.push(if reveal {
            decrypted_address_row(&state, row)?
        } else {
            public_address_row(row)
        });
    }
    Ok(private_json(json!({ "addresses": addresses })))
}

pub async fn account_addresses_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let fields = validate_address_fields(&body)?;
    let envelope = encrypt_address_payload(
        &fields,
        state.config().address_encryption_key.as_deref(),
    )?;
    let is_default = body.get("isDefault").and_then(Value::as_bool) == Some(true);
    let label: String = body
        .get("label")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fields.city.clone())
        .chars()
        .take(80)
        .collect();

    let firestore = state.firestore()?;
    let parent = firestore.document_path(store::USERS, &claims.uid);
    if is_default {
        clear_default_address(&state, &parent).await?;
    }
    let id = store::auto_id();
    let document = json!({
        "countryCode": fields.country_code,
        "isDefault": is_default,
        "label": label,
        "encryptedPayload": serde_json::to_value(&envelope).unwrap_or(json!({})),
        "createdAt": store::now_iso(),
        "updatedAt": store::now_iso(),
    });
    firestore
        .create_document_in_parent(&parent, ADDRESSES_COLLECTION, &id, &document)
        .await?;
    let mut saved = document;
    if let Some(object) = saved.as_object_mut() {
        object.insert("id".into(), json!(id));
    }
    Ok(created_json(json!({
        "address": decrypted_address_row(&state, &saved)?,
    })))
}

pub async fn account_addresses_put(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let id = address_id(&query, &body);
    if id.is_empty() {
        return Err(ApiError::bad_request("Address id required."));
    }
    let fields = validate_address_fields(&body)?;
    let envelope = encrypt_address_payload(
        &fields,
        state.config().address_encryption_key.as_deref(),
    )?;
    let label: String = body
        .get("label")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fields.city.clone())
        .chars()
        .take(80)
        .collect();
    let make_default = body.get("isDefault").and_then(Value::as_bool) == Some(true);

    let firestore = state.firestore()?;
    let path = firestore.nested_path((store::USERS, &claims.uid), ADDRESSES_COLLECTION, &id);
    if firestore.get_document(&path).await?.is_none() {
        return Err(ApiError::not_found("Address not found."));
    }
    if make_default {
        let parent = firestore.document_path(store::USERS, &claims.uid);
        clear_default_address(&state, &parent).await?;
    }
    let mut patch = json!({
        "countryCode": fields.country_code,
        "encryptedPayload": serde_json::to_value(&envelope).unwrap_or(json!({})),
        "label": label,
        "updatedAt": store::now_iso(),
    });
    if make_default {
        if let Some(object) = patch.as_object_mut() {
            object.insert("isDefault".into(), json!(true));
        }
    }
    firestore.set_document(&path, &patch).await?;
    let mut saved = firestore.get_document(&path).await?.unwrap_or(json!({}));
    if let Some(object) = saved.as_object_mut() {
        object.insert("id".into(), json!(id));
    }
    Ok(private_json(json!({
        "address": decrypted_address_row(&state, &saved)?,
    })))
}

pub async fn account_addresses_delete(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    let parsed = parse_json_body(&body)?;
    let id = address_id(&query, &parsed);
    if id.is_empty() {
        return Err(ApiError::bad_request("Address id required."));
    }
    let firestore = state.firestore()?;
    let path = firestore.nested_path((store::USERS, &claims.uid), ADDRESSES_COLLECTION, &id);
    if !firestore.delete_document(&path).await? {
        return Err(ApiError::not_found("Address not found."));
    }
    Ok(private_json(json!({ "ok": true, "id": id })))
}

/// Clear the exclusive default flag on the user's other saved addresses.
async fn clear_default_address(state: &DomainState, parent: &str) -> Result<(), ApiError> {
    let firestore = state.firestore()?;
    let rows = firestore
        .run_query(
            &StructuredQuery::collection(ADDRESSES_COLLECTION)
                .parent(parent.to_string())
                .where_eq("isDefault", json!(true)),
        )
        .await?;
    for row in &rows {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        let path = firestore.nested_path((store::USERS, state_uid_of(parent)), ADDRESSES_COLLECTION, id);
        let _ = firestore
            .update_document(&path, &json!({ "isDefault": false }), Some(&["isDefault"]))
            .await;
    }
    Ok(())
}

/// Recover the uid from a `users/{uid}` document path.
fn state_uid_of(parent: &str) -> &str {
    parent.rsplit('/').next().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// /api/marketplace-shipping-options
// ---------------------------------------------------------------------------

fn iso_country(value: Option<&String>) -> String {
    let text = value.map(|value| value.trim().to_ascii_uppercase()).unwrap_or_default();
    if text.len() == 2 && text.chars().all(|c| c.is_ascii_uppercase()) && text != "EU" {
        text
    } else {
        String::new()
    }
}

pub async fn marketplace_shipping_options(
    State(state): State<DomainState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let from_country = iso_country(query.get("fromCountry").or_else(|| query.get("from")));
    let to_country = iso_country(query.get("toCountry").or_else(|| query.get("to")));
    let cards = query
        .get("cards")
        .or_else(|| query.get("cardCount"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0);
    if from_country.is_empty() || to_country.is_empty() || cards < 1 {
        return Err(ApiError::bad_request(
            "fromCountry, toCountry and cards are required.",
        ));
    }

    let catalog = RateCatalog::default_catalog();
    let letters = shipping::seed_letter_options(&from_country, &to_country, cards, catalog)?;
    let package_tier = shipping::package_tier_for_count(cards, catalog)?;

    // Live Packlink carriers: only when a key is configured, and a failure is
    // reported in `sources` exactly like the Node handler.
    let mut packlink: Vec<Value> = Vec::new();
    let mut packlink_error: Option<String> = None;
    if state.config().packlink_api_key.is_some() {
        match fetch_packlink_services(&state, &from_country, &to_country, cards).await {
            Ok(options) => packlink = options,
            Err(error) => packlink_error = Some(error.to_string()),
        }
    }

    let mut options = letters.clone();
    options.extend(packlink.iter().cloned());
    Ok(public_json(
        json!({
            "fromCountry": from_country,
            "toCountry": to_country,
            "cards": cards,
            "packageTier": package_tier,
            "options": options,
            "sources": {
                "seed": !letters.is_empty(),
                "packlink": !packlink.is_empty(),
                "packlinkConfigured": state.config().packlink_api_key.is_some(),
                "packlinkError": packlink_error,
            },
        }),
        120,
    ))
}

/// Packlink's public quote endpoint (`_packlink.js`): country+zip+package
/// weight in grams, mapped to the same option shape as the seeded letters.
async fn fetch_packlink_services(
    state: &DomainState,
    from_country: &str,
    to_country: &str,
    cards: i64,
) -> Result<Vec<Value>, ApiError> {
    let key = state.config().packlink_api_key.clone().unwrap_or_default();
    let response = state
        .http()
        .post("https://api.packlink.com/v1/services")
        .header("Authorization", key)
        .header("Content-Type", "application/json")
        .json(&json!({
            "from": { "country": from_country },
            "to": { "country": to_country },
            "packages": [{ "weight": (cards * 2).max(1) }],
        }))
        .send()
        .await
        .map_err(|_| ApiError::unavailable("Packlink unavailable"))?;
    if !response.status().is_success() {
        return Err(ApiError::unavailable("Packlink unavailable"));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| ApiError::unavailable("Packlink unavailable"))?;
    let rows = payload
        .as_array()
        .cloned()
        .or_else(|| payload.get("services").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id").or_else(|| row.get("service_id"))?;
            let amount = row
                .get("price")
                .and_then(|price| price.get("total_price").or_else(|| price.get("base_price")))
                .and_then(Value::as_f64)?;
            Some(json!({
                "id": format!("packlink-{id}"),
                "label": row.get("name").and_then(Value::as_str).unwrap_or("Packlink"),
                "serviceName": row.get("name").and_then(Value::as_str).unwrap_or("Packlink"),
                "carrier": row.get("carrier_name").and_then(Value::as_str).unwrap_or(""),
                "amountCents": (amount * 100.0).round() as i64,
                "currency": "EUR",
                "tracked": true,
                "packageTier": null,
                "source": "packlink",
            }))
        })
        .collect())
}

// ---------------------------------------------------------------------------
// /api/marketplace-checkout-quote
// ---------------------------------------------------------------------------

pub async fn marketplace_checkout_quote(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let items = body
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        return Err(ApiError::bad_request("Cart items required."));
    }

    let address_id = text_field(&body, &["shippingAddressId"], 80);
    let to_country;
    if !address_id.is_empty() {
        let firestore = state.firestore()?;
        let path = firestore.nested_path((store::USERS, &claims.uid), ADDRESSES_COLLECTION, &address_id);
        let Some(row) = firestore.get_document(&path).await? else {
            return Err(ApiError::not_found("Shipping address not found."));
        };
        to_country = crate::domain::country::normalize_country(
            row.get("countryCode").and_then(Value::as_str).unwrap_or_default(),
        );
        if to_country.is_empty() {
            return Err(ApiError::bad_request("Address countryCode invalid."));
        }
        // Decrypt only to confirm the payload exists for the owner.
        let encrypted: Value = row.get("encryptedPayload").cloned().unwrap_or(json!({}));
        if let Ok(envelope) = serde_json::from_value::<EncryptedPayload>(encrypted) {
            let _ = decrypt_address_payload(
                &envelope,
                state.config().address_encryption_key.as_deref(),
            )?;
        }
    } else {
        to_country = crate::domain::country::normalize_country(&text_field(
            &body,
            &["toCountry"],
            8,
        ));
        if to_country.is_empty() {
            return Err(
                ApiError::bad_request("shippingAddressId or toCountry required.")
                    .with_code("address_required"),
            );
        }
    }

    let mut seller_ids: Vec<String> = Vec::new();
    for row in &items {
        if let Some(seller) = row.get("sellerUid").and_then(Value::as_str) {
            let seller = seller.trim().to_string();
            if !seller.is_empty() && !seller_ids.contains(&seller) {
                seller_ids.push(seller);
            }
        }
    }

    let mut seller_origins: HashMap<String, String> = HashMap::new();
    for seller_id in &seller_ids {
        let seller = store::read_user(state.firestore()?, seller_id).await?;
        let profile_country = crate::domain::country::normalize_country(
            seller
                .get("shipFromCountry")
                .or_else(|| seller.get("ship_from_country"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if !profile_country.is_empty() {
            seller_origins.insert(seller_id.clone(), profile_country);
            continue;
        }
        let listing_country = items
            .iter()
            .find(|row| row.get("sellerUid").and_then(Value::as_str) == Some(seller_id))
            .and_then(|row| {
                ["shipFromCountry", "sellerCountry"]
                    .iter()
                    .find_map(|key| row.get(*key).and_then(Value::as_str))
            })
            .map(crate::domain::country::normalize_country)
            .unwrap_or_default();
        if listing_country.is_empty() {
            return Err(ApiError::conflict(format!(
                "Seller {seller_id} has no shipFromCountry."
            ))
            .with_code("missing_ship_from"));
        }
        seller_origins.insert(seller_id.clone(), listing_country);
    }

    let tracked = body.get("tracked").and_then(Value::as_bool) != Some(false)
        && body.get("shippingTracked").and_then(Value::as_bool) != Some(false)
        && !body
            .get("shippingService")
            .and_then(Value::as_str)
            .map(|value| value.eq_ignore_ascii_case("untracked"))
            .unwrap_or(false);
    let insurance = body.get("insurance").and_then(Value::as_bool) == Some(true);

    let catalog = RateCatalog::default_catalog();
    let quote = shipping::quote_checkout(&items, &seller_origins, &to_country, tracked, catalog)?;
    let quote = shipping::guard_checkout_quote(quote, tracked, insurance)?;

    Ok(private_json(json!({
        "shipments": quote.shipments.iter().map(|shipment| json!({
            "sellerId": shipment.seller_id,
            "sellerName": shipment.seller_name,
            "rateId": shipment.rate_id,
            "fromCountry": shipment.from_country,
            "toCountry": shipment.to_country,
            "cardCount": shipment.card_count,
            "packageTier": shipment.package_tier,
            "tracked": shipment.tracked,
            "estimatedWeightGrams": shipment.estimated_weight_grams,
            "carrier": shipment.carrier,
            "serviceName": shipment.service_name,
            "amountCents": shipment.amount_cents,
            "currency": shipment.currency,
            "itemsSubtotalCents": shipment.items_subtotal_cents,
            "itemCount": shipment.item_count,
        })).collect::<Vec<_>>(),
        "itemsSubtotalCents": quote.items_subtotal_cents,
        "shippingTotalCents": quote.shipping_total_cents,
        "grandTotalCents": quote.grand_total_cents,
        "currency": quote.currency,
        "tracked": quote.tracked,
        "insuranceCents": quote.insurance_cents,
        "sellerOrigins": seller_origins,
        "shippingAddressId": if address_id.is_empty() { Value::Null } else { json!(address_id) },
        "toCountry": to_country,
        "preview": address_id.is_empty(),
        "quotedAt": state.now_iso(),
    })))
}

/// OPTIONS / guard helpers.
pub fn preflight() -> Response {
    StatusCode::NO_CONTENT.into_response()
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::shipping::RateCatalog;

    #[test]
    fn iso_country_rejects_eu_and_junk() {
        assert_eq!(iso_country(Some(&"it".to_string())), "IT");
        assert_eq!(iso_country(Some(&"EU".to_string())), "");
        assert_eq!(iso_country(Some(&"ITA".to_string())), "");
        assert_eq!(iso_country(None), "");
    }

    #[test]
    fn vendored_lane_quotes_a_letter_for_italy_to_denmark() {
        let catalog = RateCatalog::default_catalog();
        let options = shipping::seed_letter_options("IT", "DK", 3, catalog).unwrap();
        assert!(!options.is_empty());
        assert_eq!(options[0]["packageTier"], json!("SMALL"));
    }
}

pub async fn account_addresses_method_not_allowed() -> Response {
    let mut response = (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"error": "Method not allowed."}))).into_response();
    response.headers_mut().insert("allow", axum::http::HeaderValue::from_static("GET, POST, PUT, DELETE"));
    response
}
