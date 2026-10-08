//! Marketplace orders (native PKN checkout), public Sold-on-Pokoin rows and the
//! EUR Stripe checkout-session creation.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};
use sqlx::Row;

use super::{private_json, public_json, text_field};
use crate::auth::Claims;
use crate::domain::money;
use crate::error::ApiError;
use crate::state::{AuthedUser, DomainState};
use crate::store::{self, LedgerOp};

/// Pokoin checkout commission (3%).
pub const CHECKOUT_COMMISSION_RATE: f64 = 0.03;
/// Insurance is 5% of the card subtotal (paid by the buyer, optional).
pub const CHECKOUT_INSURANCE_RATE: f64 = 0.05;

/// Owner-scoped decrement used by PATCH-free inventory writes (`_listing_inventory.js`).
pub const DECREMENT_SQL: &str = r#"
with locked as (
  select id, seller_uid, quantity_available
  from public.marketplace_user_listings
  where id = $1
  for update
),
updated as (
  update public.marketplace_user_listings as listing
  set
    quantity_available = listing.quantity_available - $3,
    status = case
      when listing.quantity_available - $3 = 0 then 'sold_out'
      else listing.status
    end,
    updated_at = now()
  from locked
  where listing.id = locked.id
    and locked.seller_uid = $2
    and locked.quantity_available >= $3
  returning listing.*
)
select
  case
    when exists (select 1 from updated) then 'updated'
    when not exists (select 1 from locked) then 'missing'
    when exists (select 1 from locked where seller_uid is distinct from $2) then 'forbidden'
    else 'insufficient'
  end as outcome,
  (select row_to_json(updated) from updated) as listing
"#;

#[derive(Debug, Clone)]
pub struct OrderItem {
    pub listing_id: String,
    pub quantity: i64,
    pub seller_uid: String,
    pub unit_price_pkn: i64,
    pub card_id: String,
    pub condition: String,
    pub language: String,
    pub seller_name: String,
    pub card_name: String,
}

fn normalize_item(row: &Value) -> Result<OrderItem, ApiError> {
    let listing_id = text_field(row, &["listingId"], 80);
    if listing_id.is_empty() {
        return Err(ApiError::bad_request("Every order item needs a listingId."));
    }
    let quantity = row.get("quantity").and_then(Value::as_i64).unwrap_or(0);
    if !(1..=99).contains(&quantity) {
        return Err(ApiError::bad_request("Item quantity must be between 1 and 99."));
    }
    let seller_uid = text_field(row, &["sellerUid"], 160);
    if seller_uid.is_empty() {
        return Err(ApiError::bad_request("Every order item needs a sellerUid."));
    }
    let unit_price_pkn = row
        .get("unitPricePkn")
        .and_then(Value::as_f64)
        .map(|value| value.trunc() as i64)
        .unwrap_or(0);
    if unit_price_pkn <= 0 {
        return Err(ApiError::bad_request("Every order item needs a unitPricePkn."));
    }
    Ok(OrderItem {
        listing_id,
        quantity,
        seller_uid,
        unit_price_pkn,
        card_id: text_field(
            row.get("card").and_then(|card| card.get("id")).map(|_| row).unwrap_or(row),
            &["cardId"],
            120,
        ),
        condition: text_field(row, &["condition"], 20),
        language: text_field(row, &["language"], 10),
        seller_name: text_field(row, &["sellerName"], 120),
        card_name: text_field(row, &["cardName", "name"], 240),
    })
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct Decremented {
    listing_id: String,
    quantity: i64,
    unit_price_pkn: i64,
    card_id: String,
    seller_uid: String,
}

/// Atomic per-item decrement, rolled back together when any item fails.
async fn verify_and_decrement_listings(
    state: &DomainState,
    items: &[OrderItem],
    hold_order_id: Option<&str>,
) -> Result<Vec<Decremented>, ApiError> {
    let mut decremented: Vec<Decremented> = Vec::new();
    for item in items {
        let uuid = uuid::Uuid::parse_str(&item.listing_id)
            .map_err(|_| ApiError::bad_request("Listing id invalid."))?;
        let sql = if hold_order_id.is_some() {
            r#"
            with taken as (
              update public.marketplace_user_listings
              set
                quantity_available = quantity_available - $2,
                status = case when quantity_available - $2 <= 0 then 'sold_out' else status end,
                updated_at = now()
              where id = $1
                and seller_uid = $3
                and status = 'active'
                and quantity_available >= $2
              returning id, card_id, source_listing_id, source, seller_uid, quantity_available, price_pkn
            ),
            held as (
              insert into public.marketplace_checkout_holds (order_id, listing_id, quantity)
              select $4, id, $2 from taken
              on conflict (order_id, listing_id) do update set quantity = excluded.quantity
              returning listing_id
            )
            select card_id, source_listing_id, source, seller_uid, quantity_available, price_pkn
            from taken
            "#
        } else {
            r#"
            with taken as (
              update public.marketplace_user_listings
              set
                quantity_available = quantity_available - $2,
                status = case when quantity_available - $2 <= 0 then 'sold_out' else status end,
                updated_at = now()
              where id = $1
                and seller_uid = $3
                and status = 'active'
                and quantity_available >= $2
              returning id, card_id, source_listing_id, source, seller_uid, quantity_available, price_pkn
            )
            select card_id, source_listing_id, source, seller_uid, quantity_available, price_pkn
            from taken
            "#
        };
        let mut builder = sqlx::query(sql)
            .bind(uuid)
            .bind(item.quantity as i32)
            .bind(&item.seller_uid);
        if let Some(order_id) = hold_order_id {
            builder = builder.bind(order_id);
        }
        let row = builder.fetch_optional(state.write_db()).await;
        let row = match row {
            Ok(Some(row)) => row,
            Ok(None) => {
                rollback_decrements(state, &decremented, hold_order_id).await;
                return Err(ApiError::conflict(format!(
                    "Listing {} is no longer available.",
                    item.listing_id
                )));
            }
            Err(error) => {
                rollback_decrements(state, &decremented, hold_order_id).await;
                return Err(error.into());
            }
        };
        let stored_price: f64 = row.try_get("price_pkn").unwrap_or(0.0);
        if (stored_price - item.unit_price_pkn as f64).abs() > 0.0001 {
            rollback_decrements(state, &decremented, hold_order_id).await;
            return Err(ApiError::conflict("Listing price changed. Refresh your cart."));
        }
        decremented.push(Decremented {
            listing_id: item.listing_id.clone(),
            quantity: item.quantity,
            unit_price_pkn: stored_price as i64,
            card_id: row
                .try_get::<Option<String>, _>("card_id")
                .ok()
                .flatten()
                .unwrap_or_else(|| item.card_id.clone()),
            seller_uid: row
                .try_get::<Option<String>, _>("seller_uid")
                .ok()
                .flatten()
                .unwrap_or_else(|| item.seller_uid.clone()),
        });
    }
    Ok(decremented)
}

async fn rollback_decrements(
    state: &DomainState,
    decremented: &[Decremented],
    hold_order_id: Option<&str>,
) {
    for entry in decremented.iter().rev() {
        let Ok(uuid) = uuid::Uuid::parse_str(&entry.listing_id) else {
            continue;
        };
        if let Some(order_id) = hold_order_id {
            let _ = sqlx::query(
                "delete from public.marketplace_checkout_holds where order_id = $1 and listing_id = $2",
            )
            .bind(order_id)
            .bind(uuid)
            .execute(state.write_db())
            .await;
        }
        let _ = sqlx::query(
            "update public.marketplace_user_listings
                set quantity_available = quantity_available + $2,
                    status = case when status = 'sold_out' then 'active' else status end,
                    updated_at = now()
              where id = $1",
        )
        .bind(uuid)
        .bind(entry.quantity as i32)
        .execute(state.write_db())
        .await;
    }
}

/// Give held/reserved stock back (expired or failed EUR checkout).
pub async fn release_order_stock(state: &DomainState, order_id: &str) -> Result<u64, ApiError> {
    let holds = sqlx::query(
        "select listing_id, quantity from public.marketplace_checkout_holds where order_id = $1",
    )
    .bind(order_id)
    .fetch_all(state.write_db())
    .await
    .unwrap_or_default();
    let mut released = 0u64;
    for row in &holds {
        let listing_id: uuid::Uuid = row.try_get("listing_id").unwrap_or_default();
        let quantity: i32 = row.try_get("quantity").unwrap_or(0);
        let result = sqlx::query(
            "update public.marketplace_user_listings
                set quantity_available = quantity_available + $2,
                    status = case when status = 'sold_out' then 'active' else status end,
                    updated_at = now()
              where id = $1",
        )
        .bind(listing_id)
        .bind(quantity)
        .execute(state.write_db())
        .await?;
        released += result.rows_affected();
    }
    sqlx::query("delete from public.marketplace_checkout_holds where order_id = $1")
        .bind(order_id)
        .execute(state.write_db())
        .await?;
    Ok(released)
}

async fn treasury_uid(state: &DomainState, username: &str) -> Result<String, ApiError> {
    // Resolved through the Firestore username registry (`usernames/{name}` then
    // `users.usernameLower`), the same path every other username lookup uses.
    let firestore = state.firestore()?;
    store::uid_for_username(firestore, username)
        .await?
        .ok_or_else(|| ApiError::internal("Pokoin treasury account is not configured."))
}

fn seller_totals(items: &[OrderItem]) -> HashMap<String, i64> {
    let mut totals: HashMap<String, i64> = HashMap::new();
    for item in items {
        *totals.entry(item.seller_uid.clone()).or_insert(0) += item.quantity * item.unit_price_pkn;
    }
    totals
}

/// `POST /api/marketplace-orders` — native PKN checkout (action `create`).
pub async fn marketplace_orders_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let action = text_field(&body, &["action"], 40);
    let action = if action.is_empty() {
        query.get("action").cloned().unwrap_or_default()
    } else {
        action
    };
    match action.as_str() {
        "" | "create" | "checkout" => {}
        "confirm-delivery" => {
            return order_confirm_delivery(&state, &claims, &body).await;
        }
        "mark-shipped" => return order_mark_shipped(&state, &claims, &body).await,
        "reveal-shipping" => return order_reveal_shipping(&state, &claims, &body).await,
        "report-problem" => return order_report_problem(&state, &claims, &body).await,
        "cancel-eur" | "cancel" => return order_cancel(&state, &claims, &body).await,
        "sold-history" => return order_sold_history(&state, &claims, &query).await,
        "notify-sellers" => return order_notify_sellers(&state, &claims, &body).await,
        "nft-shipping-request" => return order_nft_shipping_request(&state, &claims, &body).await,
        "refund" => return order_refund(&state, &claims, &body).await,
        // Payment/email side effects that belong to their owning workers.
        other => {
            return Err(ApiError::new(
                StatusCode::NOT_IMPLEMENTED,
                format!("Order action '{other}' is not ported in the commerce crate yet."),
            )
            .with_code("ORDER_ACTION_NOT_PORTED"));
        }
    }

    let raw_items = body
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw_items.is_empty() {
        return Err(ApiError::bad_request("Cart items required."));
    }
    let mut items = Vec::new();
    for row in &raw_items {
        items.push(normalize_item(row)?);
    }

    let total_pkn: i64 = items
        .iter()
        .map(|item| item.quantity * item.unit_price_pkn)
        .sum();
    if total_pkn <= 0 {
        return Err(ApiError::bad_request("Order total must be positive."));
    }

    let idempotency_key = text_field(&body, &["clientOrderId", "idempotencyKey"], 120);
    let idem = if idempotency_key.is_empty() {
        None
    } else {
        Some(format!("order:{}:{}", claims.uid, idempotency_key))
    };
    if let Some(key) = &idem {
        if let Some(existing) = store::idempotency_result(state.firestore()?, key).await? {
            return Ok(private_json(existing));
        }
    }

    let order_id = uuid::Uuid::new_v4().to_string();
    let decremented = verify_and_decrement_listings(&state, &items, None).await?;
    drop(decremented);

    // Credit each seller their subtotal minus commission; commission → treasury.
    let totals = seller_totals(&items);
    let mut commission_pkn = 0i64;
    for (seller_uid, subtotal) in &totals {
        let commission = ((*subtotal as f64) * CHECKOUT_COMMISSION_RATE).round() as i64;
        commission_pkn += commission;
        let net = subtotal - commission;
        if net > 0 {
            let op = LedgerOp::transfer(&claims.uid, seller_uid, net, "marketplace_order_sale")
                .with_ref(&order_id)
                .with_meta(json!({ "orderId": order_id }));
            store::apply(state.firestore()?, &op).await.map_err(|error| {
                ApiError::from(error)
            })?;
        }
    }
    if commission_pkn > 0 {
        let treasury = treasury_uid(&state, &state.config().pokoin_treasury_username).await?;
        let op = LedgerOp::transfer(
            &claims.uid,
            &treasury,
            commission_pkn,
            "marketplace_order_commission",
        )
        .with_ref(&order_id);
        store::apply(state.firestore()?, &op).await?;
    }

    // Native sold rows for the desk (no buyer identity) in `marketplace_sales`,
    // using the Node doc-id scheme `{orderId}__{listingId}`.
    let firestore = state.firestore()?;
    let sale_rows = crate::domain::order_refund::sale_docs_from_order(
        &order_id,
        &json!({
            "fulfillmentMode": "physical",
            "items": items
                .iter()
                .map(|item| json!({
                    "listingId": item.listing_id,
                    "cardId": item.card_id,
                    "sellerUid": item.seller_uid,
                    "condition": item.condition,
                    "language": item.language,
                    "quantity": item.quantity,
                    "unitPricePkn": item.unit_price_pkn,
                }))
                .collect::<Vec<_>>(),
        }),
    );
    for row in &sale_rows {
        let mut data = row.data.clone();
        if let Some(object) = data.as_object_mut() {
            object.insert("soldAt".into(), json!(store::now_iso()));
            object.insert("updatedAt".into(), json!(store::now_iso()));
        }
        let _ = firestore
            .set_document(&firestore.document_path(store::SALES_COLLECTION, &row.id), &data)
            .await;
    }

    let payload = json!({
        "orderId": order_id,
        "id": order_id,
        "status": "paid",
        "paymentStatus": "paid",
        "channel": "pkn",
        "totalPkn": total_pkn,
        "commissionPkn": commission_pkn,
        "items": items.iter().map(|item| json!({
            "listingId": item.listing_id,
            "quantity": item.quantity,
            "sellerUid": item.seller_uid,
            "unitPricePkn": item.unit_price_pkn,
            "cardId": item.card_id,
        })).collect::<Vec<_>>(),
        "createdAt": state.now_iso(),
    });

    let order_document = json!({
        "buyerUid": claims.uid,
        "channel": "pkn",
        "paymentStatus": "paid",
        "status": "paid",
        "fulfillmentMode": "physical",
        "totalPkn": total_pkn,
        "commissionPkn": commission_pkn,
        "items": payload.get("items").cloned().unwrap_or(json!([])),
        "createdAt": store::now_iso(),
        "paidAt": store::now_iso(),
    });
    let _ = firestore
        .set_document(&firestore.document_path(store::ORDERS, &order_id), &order_document)
        .await;

    if let Some(key) = &idem {
        let _ = store::claim_idempotency(state.firestore()?, key, Some(&claims.uid), &payload).await;
    }
    Ok(private_json(payload))
}

/// Public Sold-on-Pokoin rows for one card desk from Firestore
/// (`marketplace_sales`), shaped like `_native_sales.js::publicSaleRow`.
pub async fn read_card_sales(
    state: &DomainState,
    card_id: &str,
    limit: i64,
) -> Result<Vec<Value>, ApiError> {
    let card_id = card_id.trim().to_string();
    if card_id.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 50);
    let firestore = state.firestore()?;
    let rows = firestore
        .run_query(
            &crate::store::StructuredQuery::collection(crate::store::SALES_COLLECTION)
                .where_eq("cardId", json!(card_id))
                .limit(200),
        )
        .await?;
    let mut sales: Vec<Value> = rows
        .iter()
        .filter(|row| row.get("voided").and_then(Value::as_bool) != Some(true))
        .filter(|row| row.get("source").and_then(Value::as_str) != Some("cardtrader"))
        .map(public_sale_row)
        .filter(|row| row.get("quantity").and_then(Value::as_i64).unwrap_or(0) > 0)
        .collect();
    sales.sort_by(|a, b| {
        let left = a.get("soldAt").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("soldAt").and_then(Value::as_str).unwrap_or_default();
        right.cmp(left)
    });
    sales.truncate(limit as usize);
    Ok(sales)
}

/// `publicSaleRow`: date, condition, language, quantity, price — never the
/// buyer or the order id.
pub fn public_sale_row(data: &Value) -> Value {
    json!({
        "soldAt": data.get("soldAt").cloned().unwrap_or(Value::Null),
        "condition": data.get("condition").cloned().unwrap_or(Value::Null),
        "language": data.get("language").cloned().unwrap_or(Value::Null),
        "quantity": data.get("quantity").and_then(Value::as_i64).unwrap_or(0),
        "pricePkn": data
            .get("pricePkn")
            .and_then(Value::as_i64)
            .or_else(|| data.get("pricePkn").and_then(Value::as_f64).map(|value| value as i64))
            .unwrap_or(0),
    })
}


// ---------------------------------------------------------------------------
// Order lifecycle actions (Firestore `orders/{orderId}` state machine)
// ---------------------------------------------------------------------------

fn order_id_of(body: &Value) -> Result<String, ApiError> {
    let order_id = text_field(body, &["orderId", "id"], 120);
    if order_id.is_empty() {
        return Err(ApiError::bad_request("Missing order id."));
    }
    Ok(order_id)
}

async fn load_order(state: &DomainState, order_id: &str) -> Result<Value, ApiError> {
    let firestore = state.firestore()?;
    firestore
        .get_document(&firestore.document_path(store::ORDERS, order_id))
        .await?
        .ok_or_else(|| ApiError::not_found("Order not found."))
}

/// Buyer on the order (the Node `buyerOwnsOrder`).
fn buyer_owns_order(order: &Value, uid: &str) -> bool {
    order.get("buyerUid").and_then(Value::as_str) == Some(uid)
}

/// Seller present on any of the order's items or shipments (`sellerOnOrder`).
fn seller_on_order(order: &Value, uid: &str) -> bool {
    let in_items = order
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.get("sellerUid").and_then(Value::as_str) == Some(uid)
            })
        })
        .unwrap_or(false);
    let in_shipments = order
        .get("shipments")
        .and_then(Value::as_array)
        .map(|shipments| {
            shipments.iter().any(|shipment| {
                shipment.get("sellerId").and_then(Value::as_str) == Some(uid)
            })
        })
        .unwrap_or(false);
    in_items || in_shipments
}

fn payment_status_of(order: &Value) -> &str {
    order
        .get("paymentStatus")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

async fn patch_order(state: &DomainState, order_id: &str, patch: Value) -> Result<Value, ApiError> {
    let firestore = state.firestore()?;
    let mut patch = patch;
    if let Some(object) = patch.as_object_mut() {
        object.insert("updatedAt".into(), json!(store::now_iso()));
    }
    firestore
        .set_document(&firestore.document_path(store::ORDERS, order_id), &patch)
        .await?;
    load_order(state, order_id).await
}

/// `confirm-delivery`: the buyer confirms receipt. Seller Transfers are the
/// fulfilment worker's job, so this records the delivered state and the pending
/// seller payouts instead of claiming money moved.
async fn order_confirm_delivery(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let order_id = order_id_of(body)?;
    let order = load_order(state, &order_id).await?;
    if !buyer_owns_order(&order, &claims.uid) {
        return Err(ApiError::forbidden("You cannot confirm this order."));
    }
    let status = payment_status_of(&order).to_string();
    if status != "paid" && status != "escrow" {
        return Err(ApiError::bad_request("This order is not paid yet."));
    }
    let pending_sellers: Vec<String> = order
        .get("shipments")
        .and_then(Value::as_array)
        .map(|shipments| {
            shipments
                .iter()
                .filter_map(|shipment| {
                    shipment
                        .get("sellerId")
                        .and_then(Value::as_str)
                        .map(|value| value.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    let is_eur = order.get("currency").and_then(Value::as_str) == Some("EUR")
        || order.get("paymentMethod").and_then(Value::as_str) == Some("stripe");
    let releases = if is_eur {
        // Separate Charges and Transfers: delivery releases each seller's share.
        release_seller_transfers(state, &order_id).await?
    } else {
        json!({ "complete": false, "pendingSellerIds": pending_sellers })
    };
    let updated = patch_order(
        state,
        &order_id,
        json!({
            "fulfillmentStatus": "delivered",
            "deliveredAt": store::now_iso(),
        }),
    )
    .await?;
    Ok(private_json(json!({ "order": updated, "transfers": releases })))
}

/// `mark-shipped`: a seller records the tracking code.
async fn order_mark_shipped(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let order_id = order_id_of(body)?;
    let order = load_order(state, &order_id).await?;
    if !seller_on_order(&order, &claims.uid) {
        return Err(ApiError::forbidden("You cannot mark this order shipped."));
    }
    let status = payment_status_of(&order).to_string();
    if status != "escrow" && status != "paid" {
        return Err(ApiError::bad_request("This order is not ready to ship."));
    }
    let tracking = text_field(body, &["trackingCode"], 80);
    if tracking.is_empty() {
        return Err(ApiError::bad_request(
            "Add the shipping tracking code before marking shipped.",
        ));
    }
    let updated = patch_order(
        state,
        &order_id,
        json!({
            "fulfillmentStatus": "shipped",
            "shippedAt": store::now_iso(),
            "trackingCode": tracking,
        }),
    )
    .await?;
    Ok(private_json(json!({ "order": updated })))
}

/// `reveal-shipping`: the seller sees the buyer's decrypted shipping snapshot.
async fn order_reveal_shipping(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let order_id = order_id_of(body)?;
    let order = load_order(state, &order_id).await?;
    if !seller_on_order(&order, &claims.uid) {
        return Err(ApiError::forbidden(
            "You cannot view this shipping address.",
        ));
    }
    let status = payment_status_of(&order);
    if !matches!(status, "paid" | "escrow" | "released") {
        return Err(ApiError::conflict("Order is not paid yet."));
    }
    let stored = order
        .get("shippingAddressSnapshotEncrypted")
        .cloned()
        .unwrap_or(Value::Null);
    if stored.is_null() {
        return Err(ApiError::not_found(
            "No encrypted shipping snapshot on this order.",
        ));
    }
    let plain = decrypt_shipping_snapshot(state, &stored)?;
    if plain.is_null() {
        return Err(ApiError::not_found(
            "No encrypted shipping snapshot on this order.",
        ));
    }
    let pick = |key: &str| {
        plain
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    // The shipment summary for THIS seller, like `decryptOrderShippingForSeller`.
    let shipment = order
        .get("shipments")
        .and_then(Value::as_array)
        .and_then(|shipments| {
            shipments.iter().find(|shipment| {
                shipment.get("sellerId").and_then(Value::as_str) == Some(claims.uid.as_str())
            })
        })
        .map(|shipment| {
            let text = |key: &str| {
                shipment
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            json!({
                "sellerId": text("sellerId"),
                "fromCountry": text("fromCountry"),
                "toCountry": text("toCountry"),
                "packageTier": text("packageTier"),
                "cardCount": shipment.get("cardCount").and_then(Value::as_i64).unwrap_or(0),
                "shippingAmountEURCents": shipment
                    .get("shippingAmountEURCents")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                "serviceName": text("serviceName"),
            })
        })
        .unwrap_or(Value::Null);
    let country_code = order
        .get("shippingAddressCountryCode")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            plain
                .get("countryCode")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        });
    Ok(private_json(json!({
        "orderId": order_id,
        "shippingAddress": {
            "countryCode": country_code,
            "fullName": pick("fullName"),
            "companyName": pick("companyName"),
            "addressLine1": pick("addressLine1"),
            "addressLine2": pick("addressLine2"),
            "postalCode": pick("postalCode"),
            "city": pick("city"),
            "stateProvinceRegion": pick("stateProvinceRegion"),
            "phoneNumber": pick("phoneNumber"),
            "deliveryInstructions": pick("deliveryInstructions"),
            "shipment": shipment,
        },
    })))
}

/// `report-problem`: either party flags the order.
async fn order_report_problem(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let order_id = order_id_of(body)?;
    let order = load_order(state, &order_id).await?;
    if !buyer_owns_order(&order, &claims.uid) && !seller_on_order(&order, &claims.uid) {
        return Err(ApiError::forbidden("You are not part of this order."));
    }
    let reason = text_field(body, &["reason"], 120);
    if reason.is_empty() {
        return Err(ApiError::bad_request("Add a reason for the problem report."));
    }
    let notes = text_field(body, &["notes"], 1000);
    let updated = patch_order(
        state,
        &order_id,
        json!({
            "problem": {
                "reason": reason,
                "notes": notes,
                "reportedBy": claims.uid,
                "reportedAt": store::now_iso(),
            },
            "fulfillmentStatus": "problem",
        }),
    )
    .await?;
    Ok(private_json(json!({ "order": updated })))
}

/// Statuses `releaseEurReservation` may release from.
pub const RELEASABLE_STATUSES: [&str; 4] = ["pending_stripe", "expired", "cancelled", "failed"];

/// `releaseEurReservation`: close an unpaid EUR order and give everything back.
///
/// Release is guarded by `paymentStatus`, marks the order cancelled (not merely
/// expired), transitions `inventory.reserved` → `released`, returns a held PKN
/// discount to the buyer's available balance exactly once (idempotency key
/// `order_discount_release:{orderId}`), and restores the listing quantities.
pub async fn release_eur_reservation(
    state: &DomainState,
    order_id: &str,
    reason: &str,
    payment_status: &str,
    extra_releasable: &[&str],
) -> Result<Value, ApiError> {
    let firestore = state.firestore()?;
    let path = firestore.document_path(store::ORDERS, order_id);
    let Some(order) = firestore.get_document(&path).await? else {
        return Ok(json!({ "orderId": order_id, "outcome": "missing" }));
    };
    let current_status = order
        .get("paymentStatus")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let releasable = RELEASABLE_STATUSES
        .iter()
        .any(|status| *status == current_status)
        || extra_releasable.iter().any(|status| *status == current_status);
    if !releasable {
        return Ok(json!({ "orderId": order_id, "outcome": "not_releasable" }));
    }

    let now = store::now_iso();
    let mut patch = json!({
        "paymentStatus": payment_status,
        "status": "cancelled",
        "fulfillmentStatus": "cancelled",
        "cancelReason": reason.chars().take(80).collect::<String>(),
        "cancelledAt": now,
        "updatedAt": now,
    });

    // `inventory.reserved` → `released`; only then are the listings restorable.
    let mut restore_lines = false;
    if order
        .get("inventory")
        .and_then(|inventory| inventory.get("state"))
        .and_then(Value::as_str)
        == Some("reserved")
    {
        restore_lines = true;
        let mut inventory = order.get("inventory").cloned().unwrap_or(json!({}));
        if let Some(object) = inventory.as_object_mut() {
            object.insert("state".into(), json!("released"));
            object.insert("releasedAt".into(), json!(now));
            object.insert("releaseReason".into(), json!(reason));
        }
        patch["inventory"] = inventory;
    }

    // A held discount goes back, but only while it is still held: releasing an
    // already-released discount would mint PKN out of the locked bucket.
    let mut held_pkn = 0i64;
    let mut buyer_uid = String::new();
    let discount = order.get("pknDiscount").cloned().unwrap_or(json!({}));
    let discount_state = discount
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let discount_pkn = discount.get("pkn").and_then(Value::as_i64).unwrap_or(0);
    if discount_state == "held" && discount_pkn > 0 {
        let mut next = discount.clone();
        if let Some(object) = next.as_object_mut() {
            object.insert("state".into(), json!("released"));
            object.insert("releasedAt".into(), json!(now));
        }
        patch["pknDiscount"] = next;
        held_pkn = discount_pkn;
        buyer_uid = order
            .get("buyerUid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
    }

    // The read/write pair is transactional, like the Node implementation, so a
    // concurrent release cannot double-apply.
    let claim_path = path.clone();
    let claim_patch = patch.clone();
    let extra: Vec<String> = extra_releasable.iter().map(|value| value.to_string()).collect();
    let applied = firestore
        .run_transaction(move |_transaction| {
            let firestore = firestore.clone();
            let path = claim_path.clone();
            let patch = claim_patch.clone();
            let extra = extra.clone();
            Box::pin(async move {
                let Some(current) = firestore.get_document(&path).await? else {
                    return Err(crate::error::StoreError::Invalid(
                        "order disappeared during release".into(),
                    ));
                };
                let live = current
                    .get("paymentStatus")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let still_releasable = RELEASABLE_STATUSES.iter().any(|item| *item == live)
                    || extra.iter().any(|item| *item == live);
                if !still_releasable {
                    return Err(crate::error::StoreError::Invalid(
                        "order is no longer releasable".into(),
                    ));
                }
                Ok(vec![crate::firestore::FirestoreWrite::Update {
                    path,
                    value: patch,
                    update_mask: None,
                }])
            })
        })
        .await;

    let outcome = match applied {
        Ok(_) => {
            if restore_lines {
                "released"
            } else {
                "closed"
            }
        }
        Err(error) => {
            let message = error.to_string();
            if message.contains("no longer releasable") {
                // Another writer already released it; do not move money again.
                return Ok(json!({ "orderId": order_id, "outcome": "not_releasable" }));
            }
            // A real store/transaction failure must not be reported as a clean
            // "not releasable": the order may still hold a reservation.
            return Err(ApiError::internal(format!(
                "Could not release the order reservation: {message}"
            ))
            .with_code("order_release_failed"));
        }
    };

    if held_pkn > 0 && !buyer_uid.is_empty() {
        // `release = true` returns locked PKN to the buyer's available balance.
        let op = LedgerOp::unlock(&buyer_uid, held_pkn, "order_discount_released", true)
            .with_ref(order_id)
            .with_idempotency(format!("order_discount_release:{order_id}"))
            .with_meta(json!({ "orderId": order_id, "reason": reason }));
        if let Err(error) = store::apply(firestore, &op).await {
            // The order already says released; ops can re-credit from
            // `pknDiscount.pkn`. Record why, like the Node writer.
            let _ = firestore
                .update_document(
                    &path,
                    &json!({
                        "pknDiscount": { "restoreError": error.to_string() },
                        "updatedAt": store::now_iso(),
                    }),
                    Some(&["pknDiscount", "updatedAt"]),
                )
                .await;
        }
    }

    let mut line_count = 0usize;
    if outcome == "released" {
        match release_order_stock(state, order_id).await {
            Ok(count) => line_count = count as usize,
            Err(error) => {
                // The order already says released. Record why the listings could
                // not be restored (Node writes `inventory.restoreError`) and
                // rethrow, so the failure is never silent.
                let _ = firestore
                    .update_document(
                        &path,
                        &json!({
                            "inventory": {
                                "restoreError": error
                                    .message
                                    .chars()
                                    .take(500)
                                    .collect::<String>(),
                            },
                            "updatedAt": store::now_iso(),
                        }),
                        Some(&["inventory", "updatedAt"]),
                    )
                    .await;
                return Err(ApiError::internal(format!(
                    "Could not restore the released listings: {}",
                    error.message
                ))
                .with_code("order_stock_restore_failed"));
            }
        }
    }

    Ok(json!({
        "orderId": order_id,
        "outcome": outcome,
        "lines": line_count,
    }))
}

/// `cancel-eur` / `cancel`: only unpaid orders may be cancelled; the stock hold
/// is released back to the listings.
async fn order_cancel(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let order_id = order_id_of(body)?;
    let order = load_order(state, &order_id).await?;
    if !buyer_owns_order(&order, &claims.uid) && !seller_on_order(&order, &claims.uid) {
        return Err(ApiError::forbidden("You are not part of this order."));
    }
    let status = payment_status_of(&order).to_string();
    if !matches!(
        status.as_str(),
        "pending_stripe" | "processing" | "expired" | "failed"
    ) {
        return Err(ApiError::bad_request("A paid order cannot be cancelled here."));
    }
    // `releaseEurReservation` owns the cancel contract: status cancelled, the
    // inventory released, the held discount returned once and the stock restored.
    let result = release_eur_reservation(
        state,
        &order_id,
        "cancelled_by_buyer",
        "cancelled",
        &["processing"],
    )
    .await?;
    if result["outcome"] == json!("not_releasable") {
        return Err(ApiError::conflict("This order can no longer be cancelled."));
    }
    let updated = load_order(state, &order_id).await?;
    Ok(private_json(json!({
        "order": updated,
        "release": result,
    })))
}

/// `sold-history`: the caller's Sold-on-Pokoin rows (`marketplace_sales`).
async fn order_sold_history(
    state: &DomainState,
    claims: &Claims,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| (value.trunc() as i64).clamp(1, 200))
        .unwrap_or(200);
    let firestore = state.firestore()?;
    let rows = firestore
        .run_query(
            &crate::store::StructuredQuery::collection(store::SALES_COLLECTION)
                .where_eq("sellerUid", json!(claims.uid))
                .limit(limit as u32),
        )
        .await?;
    let mut sales: Vec<Value> = rows
        .iter()
        .filter(|row| row.get("voided").and_then(Value::as_bool) != Some(true))
        .cloned()
        .collect();
    sales.sort_by(|a, b| {
        let left = a.get("soldAt").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("soldAt").and_then(Value::as_str).unwrap_or_default();
        right.cmp(left)
    });
    Ok(private_json(json!({ "sales": sales })))
}

/// `GET /api/marketplace-orders?action=sold-history` — the Node handler also
/// serves the seller's sold history over GET.
pub async fn marketplace_orders_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let action = query.get("action").cloned().unwrap_or_default();
    if action != "sold-history" {
        return Err(ApiError::method_not_allowed("GET, POST"));
    }
    order_sold_history(&state, &claims, &query).await
}



// ---------------------------------------------------------------------------
// EUR order fulfilment (`_eur_order_inventory.js::fulfillPaidEurOrder`)
// ---------------------------------------------------------------------------

/// Steps the CardTrader integration boundary owns. They are driven through
/// [`crate::cardtrader::CardTraderPort`]; a `not_configured` answer keeps them
/// pending instead of marking them done.
pub const CARDTRADER_STEPS: [&str; 2] = ["cardtrader_sync", "cardtrader_buy"];

/// Commit the paid EUR order: commit the stock hold, write the Sold-on-Pokoin
/// rows and queue the seller notifications. Ownership and CardTrader steps are
/// handed to their workers and reported as pending.
pub async fn fulfil_paid_eur_order(
    state: &DomainState,
    order_id: &str,
) -> Result<Value, ApiError> {
    let firestore = state.firestore()?;
    let path = firestore.document_path(store::ORDERS, order_id);
    let Some(order) = firestore.get_document(&path).await? else {
        return Ok(json!({ "orderId": order_id, "skipped": "missing" }));
    };
    let fulfillment = order.get("fulfillment").cloned().unwrap_or(json!({}));
    let fulfillment_state = fulfillment
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if fulfillment_state == "done" || fulfillment_state == "conflict" {
        return Ok(json!({ "orderId": order_id, "skipped": "done" }));
    }
    let paid_status = payment_status_of(&order);
    if !crate::domain::order_refund::SOLD_PAYMENT_STATUSES.contains(&paid_status) {
        return Ok(json!({ "orderId": order_id, "skipped": "not_paid" }));
    }

    let mut steps = fulfillment
        .get("steps")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut failures: Vec<String> = fulfillment
        .get("failures")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // 1. Commit the stock hold (the decrement already happened at checkout).
    let listing_ids: Vec<uuid::Uuid> = order
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("listingId").and_then(Value::as_str))
                .filter_map(|value| uuid::Uuid::parse_str(value).ok())
                .collect()
        })
        .unwrap_or_default();
    let mut holds_dropped = 0u64;
    for listing_id in &listing_ids {
        let deleted = sqlx::query(
            "delete from public.marketplace_checkout_holds where order_id = $1 and listing_id = $2",
        )
        .bind(order_id)
        .bind(listing_id)
        .execute(state.write_db())
        .await
        .map(|result| result.rows_affected())
        .unwrap_or(0);
        holds_dropped += deleted;
    }
    if let Some(object) = Some(&mut steps) {
        object.insert("holds_committed".into(), json!("done"));
    }

    // 2. Native Sold-on-Pokoin rows (idempotent by doc id).
    if steps.get("sales").and_then(Value::as_str) != Some("done") {
        let rows = crate::domain::order_refund::sale_docs_from_order(order_id, &order);
        let mut written = 0u64;
        for row in &rows {
            let mut data = row.data.clone();
            if let Some(object) = data.as_object_mut() {
                object.insert("soldAt".into(), json!(store::now_iso()));
                object.insert("updatedAt".into(), json!(store::now_iso()));
            }
            match firestore
                .set_document(&firestore.document_path(store::SALES_COLLECTION, &row.id), &data)
                .await
            {
                Ok(_) => written += 1,
                Err(error) => {
                    failures.push(format!("sales:{}", error));
                }
            }
        }
        if !failures.iter().any(|failure| failure.starts_with("sales:")) {
            if let Some(object) = Some(&mut steps) {
                object.insert("sales".into(), json!("done"));
            }
        }
        let _ = written;
    }

    // 3. Seller sale notifications: claimed on
    //    `order_seller_sale_notifications` and delivered through Resend. A
    //    delivery failure is recorded on the marker, never reported as sent.
    if steps.get("notifications").and_then(Value::as_str) != Some("done") {
        let outcome = send_seller_sale_notifications_for_paid_order(state, order_id).await?;
        let failed = outcome
            .get("results")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .any(|row| row.get("ok").and_then(Value::as_bool) == Some(false))
            })
            .unwrap_or(false);
        if failed {
            failures.push("notifications".to_string());
        } else {
            steps.insert("notifications".into(), json!("done"));
        }
    }

    // 4. Seller ownership records: the sold quantity leaves the seller's owned
    //    collection, per line so a retry never double-decrements.
    if steps.get("seller_ownership").and_then(Value::as_str) != Some("done") {
        let done_lines: Vec<String> = fulfillment
            .get("ownershipDone")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.as_str().map(|value| value.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let lines: Vec<OwnershipLine> = order
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let listing_id = item
                            .get("listingId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let seller_uid = item
                            .get("sellerUid")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let quantity = item.get("quantity").and_then(Value::as_i64).unwrap_or(0);
                        if listing_id.is_empty()
                            || seller_uid.is_empty()
                            || quantity < 1
                            || done_lines.contains(&listing_id)
                        {
                            return None;
                        }
                        Some(OwnershipLine {
                            listing_id,
                            seller_uid,
                            quantity,
                            source_listing_id: item
                                .get("sourceListingId")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let result = sync_seller_ownership_after_physical_sale(state, &lines).await?;
        let mut ownership_done = done_lines.clone();
        if let Some(items) = result.get("items").and_then(Value::as_array) {
            for item in items {
                let ok = item.get("ok").and_then(Value::as_bool).unwrap_or(false);
                let listing_id = item
                    .get("listingId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if ok {
                    if !ownership_done.contains(&listing_id) {
                        ownership_done.push(listing_id);
                    }
                } else {
                    failures.push(format!("ownership:{listing_id}"));
                }
            }
        }
        if !failures.iter().any(|failure| failure.starts_with("ownership:")) {
            steps.insert("seller_ownership".into(), json!("done"));
        }
        // Persist the per-line progress so a retry resumes.
        firestore
            .set_document(
                &path,
                &json!({ "fulfillment": { "ownershipDone": ownership_done } }),
            )
            .await?;
    }

    // 5. CardTrader steps go through the integration boundary. The
    //    integrations crate implements the port; until it is wired, the port
    //    answers `not_configured`, which stays open rather than claiming done.
    let mut ct_progress = fulfillment
        .get("cardtrader")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if steps.get("cardtrader_sync").and_then(Value::as_str) != Some("done") {
        let requests = crate::cardtrader::sale_sync_requests(order_id, &order);
        let mut all_complete = true;
        for request in &requests {
            let key = format!("sync:{}", request.seller_uid);
            if ct_progress.contains_key(&key) {
                continue;
            }
            match state.cardtrader().sync_after_sale(request).await {
                Ok(outcome) => {
                    if !outcome.is_complete() {
                        all_complete = false;
                    }
                    ct_progress.insert(key, outcome.to_json());
                }
                Err(error) => {
                    all_complete = false;
                    ct_progress.insert(
                        key,
                        json!({ "status": "error", "error": error.message }),
                    );
                }
            }
        }
        if all_complete {
            steps.insert("cardtrader_sync".into(), json!("done"));
        }
    }
    if steps.get("cardtrader_buy").and_then(Value::as_str) != Some("done") {
        let requests = crate::cardtrader::buy_through_requests(order_id, &order);
        let mut all_complete = true;
        for request in &requests {
            let key = format!("buy:{}", request.listing_id);
            if ct_progress.contains_key(&key) {
                continue;
            }
            match state.cardtrader().buy_through(request).await {
                Ok(outcome) => {
                    if !outcome.is_complete() {
                        all_complete = false;
                    }
                    ct_progress.insert(key, outcome.to_json());
                }
                Err(error) => {
                    all_complete = false;
                    ct_progress.insert(
                        key,
                        json!({ "status": "error", "error": error.message }),
                    );
                }
            }
        }
        if all_complete {
            steps.insert("cardtrader_buy".into(), json!("done"));
        }
    }
    let done = failures.is_empty();
    // Steps that did not complete. A step the integration never reached is
    // still pending (it is absent from `steps`, not silently satisfied).
    let mut pending_steps: Vec<String> = CARDTRADER_STEPS
        .iter()
        .filter(|step| steps.get(**step).and_then(Value::as_str) != Some("done"))
        .map(|step| step.to_string())
        .collect();
    for (key, value) in steps.iter() {
        if value.as_str() != Some("done") && !pending_steps.contains(key) {
            pending_steps.push(key.clone());
        }
    }
    // Everything (including the CardTrader boundary) finished: the fulfilment is
    // done, so a retry short-circuits instead of re-running the steps.
    let fulfilment_state = if pending_steps.is_empty() && failures.is_empty() {
        "done"
    } else {
        "partial"
    };
    let mut patch = json!({
        "inventory": { "state": "committed", "committedAt": store::now_iso() },
        "fulfillment": {
            "state": fulfilment_state,
            "steps": steps,
            "failures": failures,
            "pendingWorkerSteps": pending_steps,
            "finishedAt": store::now_iso(),
        },
    });
    patch["fulfillment"]["cardtrader"] = Value::Object(ct_progress);
    let status = order
        .get("fulfillmentStatus")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status.is_empty() || status == "pending" {
        patch["fulfillmentStatus"] = json!("awaiting_shipment");
    }
    firestore.set_document(&path, &patch).await?;

    Ok(json!({
        "orderId": order_id,
        "done": done,
        "holdsDropped": holds_dropped,
        "failures": failures,
        "pendingWorkerSteps": pending_steps,
    }))
}

/// One sold order line for the ownership sync.
#[derive(Debug, Clone)]
pub struct OwnershipLine {
    pub listing_id: String,
    pub seller_uid: String,
    pub quantity: i64,
    pub source_listing_id: String,
}

/// `decrementSellerOwnershipForSale`: the seller's owned collection row for a
/// sold line loses the sold quantity (and is deleted at zero).
pub async fn decrement_seller_ownership_for_sale(
    state: &DomainState,
    line: &OwnershipLine,
) -> Result<Value, ApiError> {
    use crate::domain::order_refund as refunds;
    let firestore = state.firestore()?;
    if line.seller_uid.is_empty() || line.quantity < 1 {
        return Ok(json!({ "ok": true, "skipped": true, "reason": "noop" }));
    }

    let mut found: Option<(String, Value)> = None;
    // A `scan:` source is looked up by its FULL id (`scan:{id}` is the doc id).
    if refunds::scan_ownership_doc_id(&line.source_listing_id).is_some() {
        let doc_key = line.source_listing_id.trim().to_string();
        let path = firestore.document_path(store::USER_CARD_COLLECTIONS, &doc_key);
        if let Some(row) = firestore.get_document(&path).await? {
            if refunds::ownership_row_is_decrementable(&row, &line.seller_uid) {
                found = Some((doc_key, row));
            }
        }
    }
    if found.is_none() && !line.listing_id.is_empty() {
        let rows = firestore
            .run_query(
                &store::StructuredQuery::collection(store::USER_CARD_COLLECTIONS)
                    .where_eq("uid", json!(line.seller_uid))
                    .where_eq("listingId", json!(line.listing_id))
                    .limit(8),
            )
            .await?;
        for row in rows {
            if refunds::ownership_row_is_decrementable(&row, &line.seller_uid) {
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                found = Some((id, row));
                break;
            }
        }
    }

    let Some((doc_id, row)) = found else {
        return Ok(json!({ "ok": true, "skipped": true, "reason": "no_linked_ownership" }));
    };
    let current = row.get("quantity").and_then(Value::as_i64).unwrap_or(0);
    let next = refunds::ownership_quantity_after_sale(current, line.quantity);
    let path = firestore.document_path(store::USER_CARD_COLLECTIONS, &doc_id);
    if next <= 0 {
        firestore.delete_document(&path).await?;
        return Ok(json!({
            "ok": true, "deleted": true, "docId": doc_id, "before": current, "after": 0,
        }));
    }
    firestore
        .update_document(
            &path,
            &json!({ "quantity": next, "updatedAt": store::now_iso() }),
            Some(&["quantity", "updatedAt"]),
        )
        .await?;
    Ok(json!({
        "ok": true, "deleted": false, "docId": doc_id, "before": current, "after": next,
    }))
}

/// `syncSellerOwnershipAfterPhysicalSale`: per-line, idempotent by listing id.
pub async fn sync_seller_ownership_after_physical_sale(
    state: &DomainState,
    lines: &[OwnershipLine],
) -> Result<Value, ApiError> {
    let mut items = Vec::new();
    let mut ok = true;
    for line in lines {
        match decrement_seller_ownership_for_sale(state, line).await {
            Ok(result) => {
                if result.get("ok").and_then(Value::as_bool) == Some(false) {
                    ok = false;
                }
                let mut row = result;
                if let Some(object) = row.as_object_mut() {
                    object.insert("listingId".into(), json!(line.listing_id));
                }
                items.push(row);
            }
            Err(error) => {
                ok = false;
                items.push(json!({
                    "listingId": line.listing_id, "ok": false, "error": error.message,
                }));
            }
        }
    }
    Ok(json!({ "ok": ok, "items": items }))
}

/// `sendSellerSaleNotificationsForPaidOrder`: email each seller their sold cards.
///
/// Idempotent through the Firestore `order_seller_sale_notifications` marker
/// (claimed inside a transaction with the Node doc id). Delivery goes through
/// Resend; without `RESEND_API_KEY` the marker records `skipped` with the Node
/// reason, and a delivery attempt is only marked `sent` when Resend accepted it.
pub async fn send_seller_sale_notifications_for_paid_order(
    state: &DomainState,
    order_id: &str,
) -> Result<Value, ApiError> {
    use crate::domain::notify;
    let firestore = state.firestore()?;
    let Some(order) = firestore
        .get_document(&firestore.document_path(store::ORDERS, order_id))
        .await?
    else {
        return Ok(json!({
            "ok": true, "skipped": true, "reason": "Order is not paid.",
        }));
    };
    if order_id.is_empty() || !notify::order_is_paid(&order) {
        return Ok(json!({
            "ok": true, "skipped": true, "reason": "Order is not paid.",
        }));
    }
    let items = order
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let groups = notify::group_order_items_by_seller(&items);
    let mut results = Vec::new();
    for group in &groups {
        let seller_uid = group.seller_uid.clone();
        let profile = store::read_user(firestore, &seller_uid).await.unwrap_or(json!({}));
        let email = profile
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let username = {
            let username = profile
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if username.is_empty() {
                profile
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            } else {
                username
            }
        };
        let marker_id = notify::notification_marker_id(order_id, &seller_uid);
        let marker_path = firestore.document_path(notify::NOTIFICATION_COLLECTION, &marker_id);

        // Claim the marker in a transaction so a retry cannot email twice.
        let claimed = {
            let firestore = firestore.clone();
            let marker_path = marker_path.clone();
            let body = notify::notification_marker_body(
                order_id,
                group,
                &email,
                &store::now_iso(),
            );
            let already = firestore.get_document(&marker_path).await?.is_some();
            if already {
                false
            } else {
                let path_for_write = marker_path.clone();
                firestore
                    .run_transaction(move |_transaction| {
                        let body = body.clone();
                        let path = path_for_write.clone();
                        Box::pin(async move {
                            Ok(vec![crate::firestore::FirestoreWrite::Create {
                                path,
                                value: body,
                            }])
                        })
                    })
                    .await
                    .is_ok()
            }
        };
        if !claimed {
            results.push(json!({
                "sellerUid": seller_uid, "ok": true, "skipped": true,
                "reason": "Notification already claimed.",
            }));
            continue;
        }
        if !crate::email::can_email_user(&email) {
            let reason = "Seller has no deliverable email.";
            let _ = firestore
                .update_document(
                    &marker_path,
                    &json!({
                        "status": "skipped",
                        "reason": reason,
                        "updatedAt": store::now_iso(),
                    }),
                    Some(&["status", "reason", "updatedAt"]),
                )
                .await;
            results.push(json!({
                "sellerUid": seller_uid, "ok": true, "skipped": true, "reason": reason,
            }));
            continue;
        }

        let message = notify::build_seller_sale_email(
            order_id,
            &notify::SellerGroup {
                seller_name: if group.seller_name.is_empty() {
                    username.clone()
                } else {
                    group.seller_name.clone()
                },
                ..group.clone()
            },
        );
        match crate::email::send_email(
            state.http(),
            crate::email::MARKETPLACE_FROM,
            &email,
            &message.subject,
            &message.text,
            &message.html,
        )
        .await
        {
            Ok(delivery) => {
                let status = if delivery.skipped { "skipped" } else { "sent" };
                let _ = firestore
                    .update_document(
                        &marker_path,
                        &json!({
                            "status": status,
                            "reason": delivery.reason,
                            "deliveryId": delivery.id,
                            "sentAt": if delivery.skipped { Value::Null } else { json!(store::now_iso()) },
                            "updatedAt": store::now_iso(),
                        }),
                        Some(&["status", "reason", "deliveryId", "sentAt", "updatedAt"]),
                    )
                    .await;
                results.push(json!({
                    "sellerUid": seller_uid,
                    "ok": true,
                    "skipped": delivery.skipped,
                    "reason": delivery.reason,
                    "deliveryId": delivery.id,
                }));
            }
            Err(error) => {
                let _ = firestore
                    .update_document(
                        &marker_path,
                        &json!({
                            "status": "failed",
                            "reason": error.message,
                            "updatedAt": store::now_iso(),
                        }),
                        Some(&["status", "reason", "updatedAt"]),
                    )
                    .await;
                results.push(json!({
                    "sellerUid": seller_uid, "ok": false, "error": error.message,
                }));
            }
        }
    }
    Ok(json!({ "ok": true, "results": results }))
}

/// `releaseSellerTransfers`: pay each seller their share of a paid EUR order.
///
/// Idempotent: a released order short-circuits, and every Transfer is created
/// with a stable `pokoin-transfer-{orderId}-{sellerId}` idempotency key. Sellers
/// without a READY Connect account are reported as pending (never silently
/// dropped) and the order stays in escrow.
pub async fn release_seller_transfers(
    state: &DomainState,
    order_id: &str,
) -> Result<Value, ApiError> {
    use crate::domain::order_refund as refunds;
    let firestore = state.firestore()?;
    let path = firestore.document_path(store::ORDERS, order_id);
    let order = firestore
        .get_document(&path)
        .await?
        .ok_or_else(|| ApiError::not_found("Order not found."))?;
    if order.get("transfersReleased").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({ "orderId": order_id, "duplicate": true }));
    }
    let status = payment_status_of(&order).to_string();
    if status != "paid" && status != "escrow" {
        return Err(ApiError::conflict("Order is not paid."));
    }

    let mut transfer_ids: Vec<String> = order
        .get("transferIds")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mut by_seller = order
        .get("transfersBySeller")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut pending_sellers: Vec<String> = Vec::new();

    // Tie each seller Transfer to the single Checkout charge.
    let mut source_transaction = order
        .get("stripeChargeId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if source_transaction.is_empty() {
        if let Some(intent) = order.get("stripePaymentIntentId").and_then(Value::as_str) {
            if !intent.is_empty() {
                if let Ok(stripe) = state.stripe() {
                    source_transaction = stripe
                        .retrieve_payment_intent_charge(intent)
                        .await
                        .unwrap_or_default();
                }
            }
        }
    }

    let plan = refunds::plan_transfer_amounts(&order);
    for item in &plan {
        let profile = if item.account.is_none() && !item.seller_id.is_empty() {
            store::read_user(firestore, &item.seller_id).await.ok()
        } else {
            None
        };
        let Some(account) = refunds::resolve_transfer_account(item, profile.as_ref()) else {
            pending_sellers.push(if item.seller_id.is_empty() {
                "unknown".to_string()
            } else {
                item.seller_id.clone()
            });
            continue;
        };
        let stripe = state.stripe()?;
        let form_value = refunds::transfer_form(order_id, item, &account, &source_transaction);
        let form: Vec<(String, String)> = form_value
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .map(|(key, value)| {
                        let text = match value {
                            Value::String(text) => text.clone(),
                            other => other.to_string(),
                        };
                        (key.clone(), text)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let transfer = stripe
            .create_transfer(
                form,
                &format!("pokoin-transfer-{order_id}-{}", item.seller_id),
            )
            .await?;
        let transfer_id = transfer
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !transfer_id.is_empty() && !transfer_ids.contains(&transfer_id) {
            transfer_ids.push(transfer_id.clone());
        }
        if !item.seller_id.is_empty() && !transfer_id.is_empty() {
            by_seller.insert(item.seller_id.clone(), json!(transfer_id));
        }
    }

    let complete = pending_sellers.is_empty();
    let mut patch = json!({
        "transfersReleased": complete,
        "transferIds": transfer_ids,
        "transfersBySeller": Value::Object(by_seller),
        "transfersPendingSellerIds": pending_sellers,
        "paymentStatus": if complete { "released" } else { "escrow" },
    });
    if complete {
        patch["escrowReleasedAt"] = json!(store::now_iso());
    }
    patch_order(state, order_id, patch).await?;

    Ok(json!({
        "orderId": order_id,
        "transferIds": transfer_ids,
        "pendingSellerIds": pending_sellers,
        "duplicate": false,
        "complete": complete,
    }))
}

/// `sendNotificationsForExistingOrder`: send the seller sale notifications.
///
/// Reuses the same idempotent path as fulfilment (the
/// `order_seller_sale_notifications` claim), so calling it twice never emails a
/// seller twice.
async fn order_notify_sellers(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let order_id = order_id_of(body)?;
    let order = load_order(state, &order_id).await?;
    let seller_uids: Vec<String> = order
        .get("sellerUids")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_else(|| {
            order
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    let mut uids: Vec<String> = Vec::new();
                    for item in items {
                        if let Some(uid) = item.get("sellerUid").and_then(Value::as_str) {
                            if !uids.contains(&uid.to_string()) {
                                uids.push(uid.to_string());
                            }
                        }
                    }
                    uids
                })
                .unwrap_or_default()
        });
    let can_access = order.get("uid").and_then(Value::as_str) == Some(claims.uid.as_str())
        || buyer_owns_order(&order, &claims.uid)
        || seller_uids.iter().any(|uid| uid == &claims.uid);
    if !can_access {
        return Err(ApiError::forbidden(
            "You cannot access this marketplace order.",
        ));
    }
    let notification = send_seller_sale_notifications_for_paid_order(state, &order_id).await?;
    Ok(private_json(json!({
        "order": order,
        "sellerNotification": notification,
    })))
}

/// `createNftShippingRequests`: queue physical shipping for owned NFTs.
async fn order_nft_shipping_request(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let raw_ids: Vec<String> = match body.get("collectionItemIds") {
        Some(Value::Array(rows)) => rows
            .iter()
            .filter_map(|row| row.as_str().map(|value| value.to_string()))
            .collect(),
        _ => body
            .get("collectionItemId")
            .and_then(Value::as_str)
            .map(|value| vec![value.to_string()])
            .unwrap_or_default(),
    };
    let mut collection_item_ids: Vec<String> = Vec::new();
    for id in raw_ids {
        let id = id.trim().chars().take(120).collect::<String>();
        if !id.is_empty() && !collection_item_ids.contains(&id) {
            collection_item_ids.push(id);
        }
    }
    if collection_item_ids.is_empty() {
        return Err(ApiError::bad_request(
            "Choose at least one NFT collection item to ship.",
        ));
    }
    if collection_item_ids.len() > 50 {
        return Err(ApiError::bad_request(
            "Request shipping for 50 NFTs or fewer at a time.",
        ));
    }
    let fields = crate::domain::address::validate_address_fields(
        body.get("shippingAddress").unwrap_or(&json!({})),
    )?;
    let shipping_address = fields.to_plaintext();

    let firestore = state.firestore()?;
    let notes = text_field(body, &["notes"], 500);
    let mut requests = Vec::new();
    for collection_item_id in &collection_item_ids {
        let item = firestore
            .get_document(
                &firestore.document_path(store::USER_CARD_COLLECTIONS, collection_item_id),
            )
            .await?;
        let item = item.ok_or_else(|| {
            ApiError::not_found(format!(
                "NFT collection item {collection_item_id} was not found."
            ))
        })?;
        if item.get("uid").and_then(Value::as_str) != Some(claims.uid.as_str()) {
            return Err(ApiError::not_found(format!(
                "NFT collection item {collection_item_id} was not found."
            )));
        }
        let owned = item.get("ownershipType").and_then(Value::as_str) == Some("nft")
            || item.get("fulfillmentMode").and_then(Value::as_str) == Some("nft_only")
            || item.get("nftStatus").and_then(Value::as_str) == Some("owned");
        if !owned {
            return Err(ApiError::bad_request(format!(
                "Collection item {collection_item_id} is not an owned NFT."
            )));
        }
        let shipping_status = item
            .get("physicalShippingStatus")
            .and_then(Value::as_str)
            .unwrap_or("not_requested");
        if shipping_status != "not_requested" {
            return Err(ApiError::conflict(format!(
                "Shipping is already requested for {collection_item_id}."
            )));
        }

        let request_id = store::auto_id();
        let request = json!({
            "uid": claims.uid,
            "collectionItemId": collection_item_id,
            "cardId": text_of_value(&item, "cardId")
                .or_else(|| text_of_value(&item, "blueprintId"))
                .unwrap_or_default(),
            "cardName": text_of_value(&item, "cardName").unwrap_or_default(),
            "sourceOrderId": text_of_value(&item, "sourceOrderId").unwrap_or_default(),
            "sourceListingId": text_of_value(&item, "sourceListingId").unwrap_or_default(),
            "quantity": item.get("quantity").and_then(Value::as_i64).unwrap_or(1).max(1),
            "shippingAddress": shipping_address,
            "notes": notes,
            "status": "pending_ops_review",
            "chargeStatus": "not_charged",
            "externalFulfillmentStatus": "not_sent",
            "createdAt": store::now_iso(),
            "updatedAt": store::now_iso(),
        });
        firestore
            .create_document(store::NFT_SHIPPING_REQUESTS, &request_id, &request)
            .await?;
        firestore
            .set_document(
                &firestore.document_path(store::USER_CARD_COLLECTIONS, collection_item_id),
                &json!({
                    "physicalShippingStatus": "requested",
                    "physicalShippingRequestId": request_id,
                    "physicalShippingRequestedAt": store::now_iso(),
                    "updatedAt": store::now_iso(),
                }),
            )
            .await?;
        let mut payload = request;
        if let Some(object) = payload.as_object_mut() {
            object.insert("id".into(), json!(request_id));
            object.insert("requestId".into(), json!(request_id));
        }
        requests.push(payload);
    }

    let first = requests.first().cloned().unwrap_or(Value::Null);
    Ok(private_json(json!({ "request": first, "requests": requests })))
}

fn text_of_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|text| text.trim().chars().take(240).collect::<String>())
        .filter(|text| !text.is_empty())
}

/// `refundSellerShare`: a seller hands back part (or all) of their share.
///
/// PKN refunds move money through the Firestore ledger inside the refund
/// transaction. EUR refunds call Stripe and then reverse the seller Transfer;
/// without a configured Stripe key the request fails loudly rather than
/// recording a refund that never happened.
async fn order_refund(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    use crate::domain::order_refund as refunds;
    let order_id = order_id_of(body)?;
    let order = load_order(state, &order_id).await?;
    if !seller_on_order(&order, &claims.uid) {
        return Err(ApiError::forbidden(
            "Only a seller on this order can refund it.",
        ));
    }
    let token = refunds::clean_client_token(body.get("clientToken"));
    if token.is_empty() {
        return Err(ApiError::bad_request("Refund needs a client token.")
            .with_code("client_token_required"));
    }
    let refund_id = format!("rf_{token}");
    let existing = order
        .get("refunds")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(refund_id.as_str()))
                .cloned()
        });
    if let Some(refund) = existing {
        return Ok(private_json(json!({
            "orderId": order_id,
            "duplicate": true,
            "refund": refund,
        })));
    }

    let amount_input = crate::domain::js_number(body.get("amount"));
    let (amount, share) = refunds::assert_refundable(&order, &claims.uid, amount_input)?;
    let eur = refunds::is_eur_order(&order);
    let buyer_uid = order
        .get("buyerUid")
        .or_else(|| order.get("uid"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let reason = text_field(body, &["reason"], 240);
    let mut refund = json!({
        "id": refund_id,
        "sellerUid": claims.uid,
        "amount": amount,
        "currency": share.currency,
        "reason": reason,
        "status": if eur { "pending" } else { "succeeded" },
        "clientToken": token,
        "createdAt": store::now_iso(),
    });

    if !eur {
        let escrow = payment_status_of(&order) == "escrow";
        let op = if escrow {
            // Funds are still in escrow: the buyer is credited from escrow.
            store::LedgerOp::mint(&buyer_uid, amount, "marketplace_order_refund")
        } else {
            // The seller was already paid: it comes out of their balance.
            let mut op = store::LedgerOp::transfer(
                &claims.uid,
                &buyer_uid,
                amount,
                "marketplace_sale_refund",
            );
            op.receive_reason = Some("marketplace_order_refund".into());
            op
        }
        .with_idempotency(format!("order_refund:{order_id}:{refund_id}"))
        .with_ref(&order_id)
        .with_meta(json!({
            "orderId": order_id,
            "buyerUid": buyer_uid,
            "sellerUid": claims.uid,
        }));
        match store::apply(state.firestore()?, &op).await {
            Ok(_) => {}
            Err(crate::error::StoreError::Insufficient) => {
                return Err(ApiError::conflict(
                    "Your PKN balance is too low to refund this amount.",
                )
                .with_code("seller_balance_low"))
            }
            Err(other) => return Err(other.into()),
        }
    } else {
        let stripe = state.stripe()?;
        let payment_intent = order
            .get("stripePaymentIntentId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if payment_intent.is_empty() {
            return Err(ApiError::conflict(
                "This EUR order has no Stripe payment to refund.",
            )
            .with_code("no_payment_intent"));
        }
        let stripe_refund = match stripe
            .create_refund(
                vec![
                    ("payment_intent".into(), payment_intent),
                    ("amount".into(), amount.to_string()),
                    ("reason".into(), "requested_by_customer".into()),
                    ("metadata[pokoinOrderId]".into(), order_id.clone()),
                    ("metadata[sellerId]".into(), claims.uid.clone()),
                    ("metadata[pokoinRefundId]".into(), refund_id.clone()),
                ],
                &format!("pokoin-refund-{order_id}-{refund_id}"),
            )
            .await
        {
            Ok(payload) => payload,
            Err(error) => {
                let patch = json!({
                    "refunds": refunds::patch_refund(
                        order.get("refunds").and_then(Value::as_array).cloned().unwrap_or_default().as_slice(),
                        &refund_id,
                        json!({ "status": "failed", "error": error.message }),
                    ),
                });
                let _ = patch_order(state, &order_id, patch).await;
                return Err(error);
            }
        };

        // Seller settlement follows the refund when a Transfer exists.
        let mut reversal_id: Option<String> = None;
        let mut reversal_error = String::new();
        let known_transfer = order
            .get("transfersBySeller")
            .and_then(|map| map.get(&claims.uid))
            .and_then(Value::as_str)
            .map(|value| value.to_string());
        let transfer = match known_transfer {
            Some(id) => stripe.retrieve_transfer(&id).await.ok(),
            None => stripe
                .list_transfers(&order_id)
                .await
                .ok()
                .and_then(|rows| {
                    rows.into_iter().find(|row| {
                        row.get("metadata")
                            .and_then(|meta| meta.get("sellerId"))
                            .and_then(Value::as_str)
                            == Some(claims.uid.as_str())
                    })
                }),
        };
        if let Some(transfer) = transfer {
            let transfer_id = transfer
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let total = transfer.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
            let reversed = transfer
                .get("amount_reversed")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let reversible = (total - reversed).max(0.0);
            let reverse_amount = (amount as f64).min(reversible) as i64;
            if reverse_amount > 0 && !transfer_id.is_empty() {
                match stripe
                    .create_transfer_reversal(
                        &transfer_id,
                        vec![
                            ("amount".into(), reverse_amount.to_string()),
                            ("metadata[pokoinOrderId]".into(), order_id.clone()),
                            ("metadata[pokoinRefundId]".into(), refund_id.clone()),
                        ],
                        &format!("pokoin-reversal-{order_id}-{refund_id}"),
                    )
                    .await
                {
                    Ok(reversal) => {
                        reversal_id = reversal
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|value| value.to_string());
                    }
                    Err(error) => reversal_error = error.message,
                }
            }
        }
        let mut patch = json!({
            "refunds": refunds::patch_refund(
                order.get("refunds").and_then(Value::as_array).cloned().unwrap_or_default().as_slice(),
                &refund_id,
                json!({
                    "status": "succeeded",
                    "stripeRefundId": stripe_refund.get("id").cloned().unwrap_or(Value::Null),
                }),
            ),
        });
        if let (Some(object), Some(reversal), Some(status)) = (
            patch.as_object_mut(),
            reversal_id.as_ref(),
            stripe_refund.get("id").cloned(),
        ) {
            let _ = status;
            object.insert("transferReversalId".into(), json!(reversal));
        }
        if !reversal_error.is_empty() {
            if let Some(object) = patch.as_object_mut() {
                object.insert("transferReversalError".into(), json!(reversal_error));
            }
        }
        patch_order(state, &order_id, patch).await?;
        refund["status"] = json!("succeeded");
        refund["stripeRefundId"] = stripe_refund.get("id").cloned().unwrap_or(Value::Null);
    }

    // Record the running refund totals for this seller.
    let current = load_order(state, &order_id).await?;
    let mut refunds_list = current
        .get("refunds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    refunds_list.push(refund.clone());
    let refunded_for_seller: i64 = refunds_list
        .iter()
        .filter(|row| {
            row.get("sellerUid").and_then(Value::as_str) == Some(claims.uid.as_str())
                && row.get("status").and_then(Value::as_str) != Some("failed")
        })
        .map(|row| row.get("amount").and_then(Value::as_i64).unwrap_or(0))
        .sum();
    let refunded_total: i64 = current
        .get("refundedTotal")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + amount;
    let mut patch = json!({
        "refunds": refunds_list,
        "refundsBySeller": { claims.uid.clone(): refunded_for_seller },
        "refundedTotal": refunded_total,
    });
    if eur {
        // Not transferred yet → the seller's later Transfer is smaller.
        if let Some(object) = patch.as_object_mut() {
            if current.get("transfersReleased").and_then(Value::as_bool) != Some(true) {
                let shipments: Vec<Value> = current
                    .get("shipments")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|mut row| {
                        if row.get("sellerId").and_then(Value::as_str)
                            == Some(claims.uid.as_str())
                        {
                            let already = row
                                .get("refundedCents")
                                .and_then(Value::as_i64)
                                .unwrap_or(0);
                            if let Some(map) = row.as_object_mut() {
                                map.insert("refundedCents".into(), json!(already + amount));
                            }
                        }
                        row
                    })
                    .collect();
                object.insert("shipments".into(), json!(shipments));
            }
        }
    }
    let updated = patch_order(state, &order_id, patch).await?;

    // Whole seller share handed back → those lines stop counting as sold.
    let after = refunds::seller_share(&updated, &claims.uid);
    if after.refundable <= 0 {
        let _ = void_native_sales(state, &order_id, &claims.uid).await;
    }

    Ok(private_json(json!({
        "orderId": order_id,
        "duplicate": false,
        "refund": refund,
        "refundable": after.refundable,
        "currency": after.currency,
    })))
}

/// `voidNativeSales`: mark this seller's Sold-on-Pokoin rows void.
async fn void_native_sales(
    state: &DomainState,
    order_id: &str,
    seller_uid: &str,
) -> Result<u64, ApiError> {
    let firestore = state.firestore()?;
    let rows = firestore
        .run_query(
            &crate::store::StructuredQuery::collection(store::SALES_COLLECTION)
                .where_eq("orderId", json!(order_id))
                .limit(200),
        )
        .await?;
    let mut voided = 0u64;
    for row in &rows {
        if row.get("sellerUid").and_then(Value::as_str) != Some(seller_uid) {
            continue;
        }
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        let _ = firestore
            .update_document(
                &firestore.document_path(store::SALES_COLLECTION, id),
                &json!({ "voided": true, "voidReason": "seller_refunded" }),
                Some(&["voided", "voidReason"]),
            )
            .await;
        voided += 1;
    }
    Ok(voided)
}

/// `GET /api/marketplace-native-sales`.
pub async fn marketplace_native_sales(
    State(state): State<DomainState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let card_id = query.get("cardId").cloned().unwrap_or_default();
    let card_id = card_id.trim().chars().take(120).collect::<String>();
    if card_id.is_empty()
        || !card_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ApiError::bad_request("cardId is required."));
    }
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| (value.trunc() as i64).clamp(1, 50))
        .unwrap_or(20);
    let sales = read_card_sales(&state, &card_id, limit).await?;
    Ok(public_json(json!({ "cardId": card_id, "sales": sales }), 60))
}

// ---------------------------------------------------------------------------
// /api/create-order-checkout-session (EUR, Stripe Checkout)
// ---------------------------------------------------------------------------

/// `shippingAddressId` → the saved address, decrypted and re-encrypted as the
/// order's shipping snapshot (`{...plain, countryCode, sourceAddressId}`).
///
/// Returns `(toCountry, encryptedSnapshot)`.
pub async fn shipping_address_snapshot(
    state: &DomainState,
    uid: &str,
    address_id: &str,
) -> Result<(String, Value), ApiError> {
    let firestore = state.firestore()?;
    let address_path = firestore.nested_path((store::USERS, uid), "shipping_addresses", address_id);
    let address_doc = firestore
        .get_document(&address_path)
        .await?
        .ok_or_else(|| ApiError::not_found("Shipping address not found."))?;
    let to_country = crate::domain::country::normalize_country(
        address_doc
            .get("countryCode")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let stored_envelope: crate::domain::address::EncryptedPayload =
        serde_json::from_value(address_doc.get("encryptedPayload").cloned().unwrap_or(json!({})))
            .map_err(|_| ApiError::internal("The saved shipping address is unreadable."))?;
    let address_key = state.config().address_encryption_key.clone();
    let plain_address =
        crate::domain::address::decrypt_address_value(&stored_envelope, address_key.as_deref())?;
    let mut snapshot = plain_address;
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("countryCode".into(), json!(to_country));
        object.insert("sourceAddressId".into(), json!(address_id));
    }
    let envelope =
        crate::domain::address::encrypt_address_value(&snapshot, address_key.as_deref())?;
    Ok((to_country, serde_json::to_value(envelope).unwrap_or(json!({}))))
}

/// Decrypt a stored order shipping snapshot for the seller.
pub fn decrypt_shipping_snapshot(state: &DomainState, stored: &Value) -> Result<Value, ApiError> {
    match serde_json::from_value::<crate::domain::address::EncryptedPayload>(stored.clone()) {
        Ok(envelope) => {
            let key = state.config().address_encryption_key.clone();
            crate::domain::address::decrypt_address_value(&envelope, key.as_deref())
        }
        // Nothing stored (an order predating the snapshot) reads as absent.
        Err(_) => Ok(Value::Null),
    }
}

pub async fn create_order_checkout_session(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let stripe = state.stripe()?;
    let raw_items = body
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw_items.is_empty() {
        return Err(ApiError::bad_request("Cart items required."));
    }
    let mut items = Vec::new();
    for row in &raw_items {
        items.push(normalize_item(row)?);
    }

    // The address is the saved one: `shippingAddressId` is required, and the
    // stored envelope is decrypted and re-encrypted as the order snapshot.
    let address_id = text_field(&body, &["shippingAddressId"], 160);
    if address_id.is_empty() {
        return Err(ApiError::bad_request("shippingAddressId required.")
            .with_code("address_required"));
    }
    let (to_country, shipping_address_snapshot) =
        shipping_address_snapshot(&state, &claims.uid, &address_id).await?;

    // Server-side shipping quote: seller origins come from the profile rows.
    let mut seller_origins: HashMap<String, String> = HashMap::new();
    for item in &items {
        if seller_origins.contains_key(&item.seller_uid) {
            continue;
        }
        let seller = store::read_user(state.firestore()?, &item.seller_uid).await?;
        let country = crate::domain::country::normalize_country(
            seller
                .get("shipFromCountry")
                .or_else(|| seller.get("ship_from_country"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if country.is_empty() {
            return Err(ApiError::conflict(format!(
                "Seller {} has no shipFromCountry.",
                item.seller_uid
            ))
            .with_code("missing_ship_from"));
        }
        seller_origins.insert(item.seller_uid.clone(), country);
    }
    let quote_items: Vec<Value> = items
        .iter()
        .map(|item| {
            json!({
                "sellerUid": item.seller_uid,
                "quantity": item.quantity,
                "unitPricePkn": item.unit_price_pkn,
            })
        })
        .collect();
    let catalog = crate::domain::shipping::RateCatalog::default_catalog();
    let quote = crate::domain::shipping::quote_checkout(
        &quote_items,
        &seller_origins,
        &to_country,
        true,
        catalog,
    )?;

    let order_id = uuid::Uuid::new_v4().to_string();
    let decremented = verify_and_decrement_listings(&state, &items, Some(&order_id)).await?;

    // Optional PKN balance discount: debit it once and hold the PKN.
    let discount_pkn = body
        .get("pknDiscount")
        .and_then(Value::as_f64)
        .map(|value| value.trunc() as i64)
        .unwrap_or(0);
    let mut discount_eur_cents = 0i64;
    if discount_pkn > 0 {
        let balance = store::balance(state.firestore()?, &claims.uid).await?;
        let eligible: Vec<String> = Vec::new();
        let quote_items: Vec<store::LedgerOp> = Vec::new();
        drop(quote_items);
        let plan = money::pkn_balance_discount(
            balance.available_pkn,
            &items
                .iter()
                .map(|item| money::QuoteItem {
                    seller_uid: item.seller_uid.clone(),
                    quantity: item.quantity,
                    unit_price_pkn: item.unit_price_pkn as f64,
                    ..Default::default()
                })
                .collect::<Vec<_>>(),
            &eligible,
            quote.grand_total_cents,
        );
        if plan.discount_pkn > 0 {
            let op = LedgerOp::lock(
                &claims.uid,
                plan.discount_pkn,
                "order_discount_held",
            )
            .with_ref(&order_id)
            .with_meta(json!({ "orderId": order_id }));
            store::apply(state.firestore()?, &op).await?;
            discount_eur_cents = plan.discount_eur_cents;
        }
    }

    let charge_cents = quote.grand_total_cents - discount_eur_cents;
    if charge_cents < 50 {
        rollback_decrements(&state, &decremented, Some(&order_id)).await;
        return Err(ApiError::bad_request(
            "The card charge must be at least 50 cents.",
        ));
    }

    let site = state.config().public_site_url.trim_end_matches('/').to_string();
    let form: Vec<(String, String)> = vec![
        ("mode".into(), "payment".into()),
        ("success_url".into(), format!("{site}/orders/{order_id}?status=success")),
        ("cancel_url".into(), format!("{site}/cart?status=cancelled")),
        ("line_items[0][quantity]".into(), "1".into()),
        ("line_items[0][price_data][currency]".into(), "eur".into()),
        (
            "line_items[0][price_data][unit_amount]".into(),
            charge_cents.to_string(),
        ),
        (
            "line_items[0][price_data][product_name]".into(),
            format!("Pokoin order {order_id}"),
        ),
        ("metadata[kind]".into(), "marketplace_order_eur".into()),
        ("metadata[pokoinOrderId]".into(), order_id.clone()),
        ("metadata[pokoinUid]".into(), claims.uid.clone()),
        ("metadata[discountPkn]".into(), discount_pkn.to_string()),
    ];

    let session = stripe.create_checkout_session(form).await?;
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let url = session
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let order_document = json!({
        "buyerUid": claims.uid,
        "channel": "eur",
        "paymentStatus": "pending_stripe",
        "status": "pending",
        "fulfillmentMode": "physical",
        "totalPkn": items.iter().map(|item| item.quantity * item.unit_price_pkn).sum::<i64>(),
        "totalEURCents": charge_cents,
        "shippingEURCents": quote.shipping_total_cents,
        "pknDiscount": {
            "pkn": discount_pkn,
            "eurCents": discount_eur_cents,
            "state": if discount_pkn > 0 { "held" } else { "none" },
        },
        "items": items
            .iter()
            .map(|item| {
                json!({
                    "listingId": item.listing_id,
                    "quantity": item.quantity,
                    "sellerUid": item.seller_uid,
                    "unitPricePkn": item.unit_price_pkn,
                    "cardId": item.card_id,
                })
            })
            .collect::<Vec<_>>(),
        "shipments": quote
            .shipments
            .iter()
            .map(|shipment| {
                json!({
                    "sellerId": shipment.seller_id,
                    "sellerTransferCents": shipment.amount_cents,
                    "amountCents": shipment.amount_cents,
                    "tracked": shipment.tracked,
                })
            })
            .collect::<Vec<_>>(),
        "shippingAddressId": address_id,
        "shippingAddressSnapshotEncrypted": shipping_address_snapshot,
        "shippingAddressCountryCode": to_country,
        "stripeCheckoutSessionId": session_id,
        "createdAt": store::now_iso(),
        "updatedAt": store::now_iso(),
    });
    let _ = state
        .firestore()?
        .set_document(
            &state.firestore()?.document_path(store::ORDERS, &order_id),
            &order_document,
        )
        .await;

    Ok(private_json(json!({
        "orderId": order_id,
        "id": session_id,
        "url": url,
        "totalEURCents": charge_cents,
        "shippingEURCents": quote.shipping_total_cents,
        "discountPkn": discount_pkn,
        "discountEurCents": discount_eur_cents,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order() -> Value {
        json!({
            "buyerUid": "buyer-1",
            "items": [
                { "sellerUid": "seller-a", "quantity": 1, "unitPricePkn": 100 },
                { "sellerUid": "seller-b", "quantity": 2, "unitPricePkn": 50 },
            ],
            "shipments": [
                { "sellerId": "seller-a", "sellerTransferCents": 200 },
            ],
        })
    }

    #[test]
    fn buyer_ownership_is_exact() {
        assert!(buyer_owns_order(&order(), "buyer-1"));
        assert!(!buyer_owns_order(&order(), "buyer-2"));
        assert!(!buyer_owns_order(&json!({}), "buyer-1"));
    }

    #[test]
    fn sellers_are_found_in_items_and_shipments() {
        assert!(seller_on_order(&order(), "seller-a"));
        assert!(seller_on_order(&order(), "seller-b"));
        assert!(!seller_on_order(&order(), "buyer-1"));
        assert!(!seller_on_order(&json!({}), "seller-a"));
    }

    #[test]
    fn public_sale_rows_never_leak_the_buyer() {
        let row = public_sale_row(&json!({
            "soldAt": "2026-10-08T10:00:00.000Z",
            "condition": "NM",
            "language": "EN",
            "quantity": 2,
            "pricePkn": 250.0,
            "buyerUid": "secret",
            "orderId": "should-not-appear",
        }));
        assert_eq!(row["quantity"], json!(2));
        assert_eq!(row["pricePkn"], json!(250));
        assert!(row.get("buyerUid").is_none());
        assert!(row.get("orderId").is_none());
    }
}
