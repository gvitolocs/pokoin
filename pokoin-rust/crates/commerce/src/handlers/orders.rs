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
        return Err(ApiError::bad_request(
            "Item quantity must be between 1 and 99.",
        ));
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
        return Err(ApiError::bad_request(
            "Every order item needs a unitPricePkn.",
        ));
    }
    Ok(OrderItem {
        listing_id,
        quantity,
        seller_uid,
        unit_price_pkn,
        card_id: row
            .pointer("/card/id")
            .and_then(Value::as_str)
            .map(|s| s.trim().chars().take(120).collect())
            .unwrap_or_else(|| text_field(row, &["cardId"], 120)),
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
    source_listing_id: String,
    source: String,
    remaining_quantity: i64,
}

const TAKE_SQL: &str = r#"
    update public.marketplace_user_listings
    set
      quantity_available = quantity_available - $2,
      status = case when quantity_available - $2 <= 0 then 'sold_out' else status end,
      updated_at = now()
    where id = $1
      and seller_uid = $3
      and status = 'active'
      and quantity_available >= $2
    returning card_id, source_listing_id, source, seller_uid, quantity_available, price_pkn
"#;

/// Insert this order's hold first; the unique (order_id, listing_id) key
/// makes a concurrent or repeated take wait for, then see, the first one.
const HOLD_SQL: &str = "insert into public.marketplace_checkout_holds (order_id, listing_id, quantity) \
     values ($1, $2, $3) on conflict (order_id, listing_id) do nothing returning listing_id";

const HELD_ROW_SQL: &str = "select card_id, source_listing_id, source, seller_uid, quantity_available, price_pkn \
     from public.marketplace_user_listings where id = $1";

/// Take one line. With a hold order the hold row and the decrement commit
/// together, and a line this order already holds is not taken again: a
/// re-take after a crash or a failed Firestore write used to decrement a
/// second time (specs/tla/eur-fulfilment bugs/double-retake.cfg).
async fn take_line(
    state: &DomainState,
    item: &OrderItem,
    uuid: uuid::Uuid,
    hold_order_id: Option<&str>,
) -> Result<Option<sqlx::postgres::PgRow>, ApiError> {
    let Some(order_id) = hold_order_id else {
        return Ok(sqlx::query(TAKE_SQL)
            .bind(uuid)
            .bind(item.quantity as i32)
            .bind(&item.seller_uid)
            .fetch_optional(state.write_db())
            .await?);
    };
    let mut tx = state.write_db().begin().await?;
    let inserted = sqlx::query(HOLD_SQL)
        .bind(order_id)
        .bind(uuid)
        .bind(item.quantity as i32)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    let row = if inserted {
        sqlx::query(TAKE_SQL)
            .bind(uuid)
            .bind(item.quantity as i32)
            .bind(&item.seller_uid)
            .fetch_optional(&mut *tx)
            .await?
    } else {
        sqlx::query(HELD_ROW_SQL).bind(uuid).fetch_optional(&mut *tx).await?
    };
    if row.is_some() {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(row)
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
        let row = match take_line(state, item, uuid, hold_order_id).await {
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
                return Err(error);
            }
        };
        let stored_price: f64 = row.try_get("price_pkn").unwrap_or(0.0);
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
            source_listing_id: row
                .try_get::<Option<String>, _>("source_listing_id")
                .ok()
                .flatten()
                .unwrap_or_default(),
            source: row
                .try_get::<Option<String>, _>("source")
                .ok()
                .flatten()
                .unwrap_or_default(),
            remaining_quantity: row
                .try_get::<i32, _>("quantity_available")
                .map(i64::from)
                .unwrap_or(0),
        });
        if (stored_price - item.unit_price_pkn as f64).abs() > 0.0001 {
            rollback_decrements(state, &decremented, hold_order_id).await;
            return Err(ApiError::conflict(
                "Listing price changed. Refresh your cart.",
            ));
        }
    }
    Ok(decremented)
}

/// Give back what this call took. With a hold order, only deleting the hold
/// row restores its quantity (one statement, like release_order_stock).
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
                r#"
                with released as (
                  delete from public.marketplace_checkout_holds
                  where order_id = $1 and listing_id = $2
                  returning listing_id, quantity
                )
                update public.marketplace_user_listings as listing
                set quantity_available = listing.quantity_available + released.quantity,
                    status = case when listing.status = 'sold_out' then 'active' else listing.status end,
                    updated_at = now()
                from released
                where listing.id = released.listing_id
                "#,
            )
            .bind(order_id)
            .bind(uuid)
            .execute(state.write_db())
            .await;
            continue;
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
    // Only the worker deleting a hold restores its stock. Both operations are atomic.
    let result = sqlx::query(
        r#"
        with released as (
          delete from public.marketplace_checkout_holds
          where order_id = $1
          returning listing_id, quantity
        )
        update public.marketplace_user_listings as listing
        set quantity_available = listing.quantity_available + released.quantity,
            status = case when listing.status = 'sold_out' then 'active' else listing.status end,
            updated_at = now()
        from released
        where listing.id = released.listing_id
        returning listing.card_id
    "#,
    )
    .bind(order_id)
    .fetch_all(state.write_db())
    .await?;
    for row in &result {
        if let Ok(Some(card_id)) = row.try_get::<Option<String>, _>("card_id") {
            let _ = sqlx::query("select public.refresh_marketplace_blueprint_price_summary($1)")
                .bind(card_id)
                .execute(state.write_db())
                .await;
        }
    }
    Ok(result.len() as u64)
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
            store::apply(state.firestore()?, &op)
                .await
                .map_err(|error| ApiError::from(error))?;
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
        crate::sales_index::note_sale(data.get("cardId").and_then(Value::as_str).unwrap_or_default());
        let _ = firestore
            .set_document(
                &firestore.document_path(store::SALES_COLLECTION, &row.id),
                &data,
            )
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
        .set_document(
            &firestore.document_path(store::ORDERS, &order_id),
            &order_document,
        )
        .await;

    if let Some(key) = &idem {
        let _ =
            store::claim_idempotency(state.firestore()?, key, Some(&claims.uid), &payload).await;
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
            items
                .iter()
                .any(|item| item.get("sellerUid").and_then(Value::as_str) == Some(uid))
        })
        .unwrap_or(false);
    let in_shipments = order
        .get("shipments")
        .and_then(Value::as_array)
        .map(|shipments| {
            shipments
                .iter()
                .any(|shipment| shipment.get("sellerId").and_then(Value::as_str) == Some(uid))
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
    Ok(private_json(
        json!({ "order": updated, "transfers": releases }),
    ))
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
        return Err(ApiError::bad_request(
            "Add a reason for the problem report.",
        ));
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
    let mut claimed = None;
    for attempt in 0..5 {
        let transaction = firestore.begin_transaction().await?;
        let current = match firestore
            .get_document_in_transaction(&path, &transaction)
            .await
        {
            Ok(Some(current)) => current,
            Ok(None) => {
                firestore.rollback(&transaction).await;
                return Ok(json!({"orderId":order_id,"outcome":"missing","lines":0}));
            }
            Err(error) => {
                firestore.rollback(&transaction).await;
                return Err(error.into());
            }
        };
        let status = current
            .get("paymentStatus")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !RELEASABLE_STATUSES.contains(&status) && !extra_releasable.contains(&status) {
            firestore.rollback(&transaction).await;
            return Ok(json!({"orderId":order_id,"outcome":"not_releasable","lines":0}));
        }
        let (patch, restore, held_pkn, buyer_uid, lines) =
            release_plan(&current, reason, payment_status, &state.now_iso());
        let mask = patch
            .as_object()
            .map(|fields| fields.keys().cloned().collect())
            .unwrap_or_default();
        let write = crate::firestore::FirestoreWrite::Update {
            path: path.clone(),
            value: patch,
            update_mask: Some(mask),
        };
        match firestore.commit(Some(&transaction), &[write]).await {
            Ok(_) => {
                claimed = Some((restore, held_pkn, buyer_uid, lines));
                break;
            }
            Err(error) => {
                firestore.rollback(&transaction).await;
                if attempt == 4 {
                    return Err(error.into());
                }
            }
        }
    }
    let (restore, held_pkn, buyer_uid, line_count) =
        claimed.ok_or_else(|| ApiError::internal("Could not release the order reservation."))?;
    if held_pkn > 0 && !buyer_uid.is_empty() {
        let op = LedgerOp::unlock(&buyer_uid, held_pkn, "order_discount_released", true)
            .with_ref(order_id)
            .with_idempotency(format!("order_discount_release:{order_id}"))
            .with_meta(json!({"orderId":order_id,"reason":reason}));
        if let Err(error) = store::apply(firestore, &op).await {
            firestore.update_document(&path, &json!({"pknDiscount":{"restoreError":error.to_string()},"updatedAt":state.now_iso()}),
                Some(&["pknDiscount.restoreError","updatedAt"])).await?;
        }
    }
    if restore {
        if let Err(error) = release_order_stock(state, order_id).await {
            let _=firestore.update_document(&path,&json!({"inventory":{"restoreError":error.message.chars().take(500).collect::<String>()},"updatedAt":state.now_iso()}),
                Some(&["inventory.restoreError","updatedAt"])).await;
            return Err(ApiError::internal(format!(
                "Could not restore the released listings: {}",
                error.message
            ))
            .with_code("order_stock_restore_failed"));
        }
    }
    Ok(
        json!({"orderId":order_id,"outcome":if restore{"released"}else{"closed"},"lines":line_count}),
    )
}

/// Recompute values from every fresh transaction snapshot.
fn release_plan(
    order: &Value,
    reason: &str,
    payment_status: &str,
    at: &str,
) -> (Value, bool, i64, String, usize) {
    let mut patch = json!({"paymentStatus":payment_status,"status":"cancelled","fulfillmentStatus":"cancelled",
        "cancelReason":reason.trim().chars().take(80).collect::<String>(),"cancelledAt":at,"updatedAt":at});
    let mut inventory = order
        .get("inventory")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or(json!({}));
    let was_reserved = inventory["state"] == "reserved";
    let retry_restore = inventory["state"] == "released" && inventory.get("restoreError").is_some();
    let line_count = if was_reserved {
        inventory
            .get("lines")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    } else {
        0
    };
    if was_reserved {
        inventory["state"] = json!("released");
        inventory["releasedAt"] = json!(at);
        inventory["releaseReason"] = json!(reason);
        patch["inventory"] = inventory;
    }
    let discount = order.get("pknDiscount").cloned().unwrap_or(json!({}));
    let held = if discount["state"] == "held" {
        discount
            .get("pkn")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0)
    } else {
        0
    };
    if held > 0 {
        patch["pknDiscount"] = discount;
        patch["pknDiscount"]["state"] = json!("released");
        patch["pknDiscount"]["releasedAt"] = json!(at);
    }
    let buyer = order
        .get("buyerUid")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    (
        patch,
        was_reserved || retry_restore,
        held,
        buyer,
        line_count,
    )
}

/// What `cancel-eur` may do with an order in this payment state.
#[derive(Debug, PartialEq, Eq)]
pub enum CancelPlan {
    AlreadyPaid,
    AlreadyClosed,
    /// Expire the Checkout session first, then release.
    ExpireThenRelease,
}

pub fn cancel_plan(payment_status: &str) -> CancelPlan {
    match payment_status {
        "paid" | "escrow" | "released" | "partially_refunded" => CancelPlan::AlreadyPaid,
        "pending_stripe" => CancelPlan::ExpireThenRelease,
        _ => CancelPlan::AlreadyClosed,
    }
}

/// Stripe refused to expire the session: paid => recover it as paid; an
/// already expired session may be released; anything else is an error.
#[derive(Debug, PartialEq, Eq)]
pub enum ExpireRefused {
    Paid,
    AlreadyExpired,
    Unknown,
}

pub fn expire_refused(session: &Value) -> ExpireRefused {
    if session["status"] == "complete" && session["payment_status"] != "unpaid" {
        ExpireRefused::Paid
    } else if session["status"] == "expired" {
        ExpireRefused::AlreadyExpired
    } else {
        ExpireRefused::Unknown
    }
}

/// `cancel-eur` / `cancel` (Node `cancelPendingEurOrder`): only an unpaid
/// `pending_stripe` order is cancelled, and its Checkout session is expired
/// before the stock is released, so the buyer can no longer pay for stock
/// that went back on sale (specs/tla/eur-fulfilment bugs/cancel-then-paid.cfg).
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
    match cancel_plan(payment_status_of(&order)) {
        CancelPlan::AlreadyPaid => {
            return Err(ApiError::conflict("This order is already paid.").with_code("already_paid"))
        }
        CancelPlan::AlreadyClosed => {
            return Ok(private_json(json!({
                "order": order,
                "release": {"orderId": order_id, "outcome": "already_closed"},
            })))
        }
        CancelPlan::ExpireThenRelease => {}
    }
    let session_id = order
        .get("stripeCheckoutSessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    if !session_id.is_empty() {
        let stripe = state.stripe()?;
        if let Err(error) = stripe.expire_checkout_session(&session_id).await {
            let session = stripe.retrieve_checkout_session(&session_id).await?;
            match expire_refused(&session) {
                ExpireRefused::Paid => {
                    super::stripe::handle_marketplace_order_paid(state, &order_id, &session).await?;
                    return Err(ApiError::conflict("Stripe already took this payment — the order is paid.")
                        .with_code("already_paid"));
                }
                ExpireRefused::AlreadyExpired => {}
                ExpireRefused::Unknown => return Err(error),
            }
        }
    }
    // `releaseEurReservation` owns the cancel contract: status cancelled, the
    // inventory released, the held discount returned once and the stock restored.
    let result = release_eur_reservation(state, &order_id, "cancelled_by_buyer", "cancelled", &[]).await?;
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
pub async fn fulfil_paid_eur_order(state: &DomainState, order_id: &str) -> Result<Value, ApiError> {
    let firestore = state.firestore()?;
    let path = firestore.document_path(store::ORDERS, order_id);
    let mut claimed = None;
    // Lease is claimed using a real transaction read, shared with webhook workers.
    for attempt in 0..5 {
        let transaction = firestore.begin_transaction().await?;
        let current = match firestore
            .get_document_in_transaction(&path, &transaction)
            .await
        {
            Ok(Some(order)) => order,
            Ok(None) => {
                firestore.rollback(&transaction).await;
                return Ok(json!({"orderId":order_id,"skipped":"missing"}));
            }
            Err(error) => {
                firestore.rollback(&transaction).await;
                return Err(error.into());
            }
        };
        if let Some(skip) = fulfilment_skip(&current, state.now_ms()) {
            firestore.rollback(&transaction).await;
            return Ok(json!({"orderId":order_id,"skipped":skip}));
        }
        let mut fulfillment = current
            .get("fulfillment")
            .cloned()
            .filter(Value::is_object)
            .unwrap_or(json!({}));
        fulfillment["state"] = json!("running");
        fulfillment["startedAt"] = json!(state.now_iso());
        let patch = json!({"fulfillment":fulfillment,"updatedAt":state.now_iso()});
        let write = crate::firestore::FirestoreWrite::Update {
            path: path.clone(),
            value: patch,
            update_mask: Some(vec!["fulfillment".into(), "updatedAt".into()]),
        };
        match firestore.commit(Some(&transaction), &[write]).await {
            Ok(_) => {
                claimed = Some((current, fulfillment));
                break;
            }
            Err(error) => {
                firestore.rollback(&transaction).await;
                if attempt == 4 {
                    return Err(error.into());
                }
            }
        }
    }
    let (mut order, mut fulfillment) =
        claimed.ok_or_else(|| ApiError::internal("Could not claim EUR fulfilment."))?;
    let mut inventory = order
        .get("inventory")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or(json!({}));
    if inventory["state"] != "committed" {
        if inventory["state"] != "reserved" {
            match retake_eur_inventory(state, order_id, &order).await {
                Ok(lines) => {
                    inventory["lines"] = json!(lines);
                    inventory["retakenAt"] = json!(state.now_iso());
                }
                Err(error) => {
                    inventory["state"] = json!("conflict");
                    inventory["conflictError"] =
                        json!(error.message.chars().take(500).collect::<String>());
                    fulfillment["state"] = json!("conflict");
                    fulfillment["finishedAt"] = json!(state.now_iso());
                    firestore.set_document(&path,&json!({"inventory":inventory,"fulfillment":fulfillment,"fulfillmentStatus":"needs_refund","updatedAt":state.now_iso()})).await?;
                    return Ok(json!({"orderId":order_id,"conflict":true}));
                }
            }
        }
        inventory["state"] = json!("committed");
        inventory["committedAt"] = json!(state.now_iso());
        firestore
            .set_document(
                &path,
                &json!({"inventory":inventory,"updatedAt":state.now_iso()}),
            )
            .await?;
    }
    order["inventory"] = inventory.clone();
    let lines = inventory
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            order
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .into_iter()
        .filter(|l| l["external"] != true)
        .collect::<Vec<_>>();
    let mut steps = fulfillment
        .get("steps")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut ownership_done = string_set(fulfillment.get("ownershipDone"));
    let mut ct_done = string_set(fulfillment.get("cardTraderDone"));
    let mut ct_progress = fulfillment
        .get("cardtrader")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let legacy_progress = ct_progress.clone();
    // A retry rebuilds failures from this attempt, rather than retaining fixed failures forever.
    let mut failures = Vec::<String>::new();
    let mut holds_dropped = 0u64;
    for line in &lines {
        let listing_id = line.get("listingId").and_then(Value::as_str).unwrap_or("");
        let source_id = line
            .get("sourceListingId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !source_id.starts_with("ct:") {
            holds_dropped += drop_eur_hold(state, order_id, listing_id).await;
        }
        if !ownership_done.contains(listing_id) {
            let owned = OwnershipLine {
                listing_id: listing_id.into(),
                seller_uid: line
                    .get("sellerUid")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                quantity: line.get("quantity").and_then(Value::as_i64).unwrap_or(0),
                source_listing_id: source_id.into(),
                sale_key: format!("{order_id}:{listing_id}"),
            };
            match decrement_seller_ownership_for_sale(state, &owned).await {
                Ok(result) if result["ok"] != false => {
                    ownership_done.insert(listing_id.into());
                }
                _ => failures.push(format!("ownership:{listing_id}")),
            }
            fulfillment["ownershipDone"] = json!(ownership_done);
            firestore
                .set_document(
                    &path,
                    &json!({"fulfillment":fulfillment,"updatedAt":state.now_iso()}),
                )
                .await?;
        }
        if !ct_done.contains(listing_id) {
            let seller = line.get("sellerUid").and_then(Value::as_str).unwrap_or("");
            let key = format!("sync:{listing_id}");
            let legacy_key = format!("sync:{seller}");
            if ct_result_complete(ct_progress.get(&key))
                || ct_result_complete(legacy_progress.get(&legacy_key))
            {
                ct_done.insert(listing_id.into());
            } else {
                let request = crate::cardtrader::CardTraderSaleSync {
                    order_id: order_id.into(),
                    seller_uid: seller.into(),
                    items: vec![line.clone()],
                };
                match state.cardtrader().sync_after_sale(&request).await {
                    Ok(outcome) => {
                        let result = outcome.to_json();
                        ct_progress.insert(key, result.clone());
                        // Retain old telemetry key without using a failed value to skip retries.
                        ct_progress.insert(legacy_key, result);
                        if outcome.is_complete() {
                            ct_done.insert(listing_id.into());
                            let decremented = match &outcome {
                                crate::cardtrader::CardTraderOutcome::Applied { detail } => detail
                                    .get("items")
                                    .and_then(Value::as_array)
                                    .is_some_and(|rows| {
                                        rows.iter().any(|r| {
                                            r["ok"] == true && r["listingId"] == listing_id
                                        })
                                    }),
                                _ => false,
                            };
                            if decremented {
                                holds_dropped += drop_eur_hold(state, order_id, listing_id).await;
                            }
                        } else {
                            failures.push(format!("cardtrader_sync:{listing_id}"));
                        }
                    }
                    Err(error) => {
                        ct_progress.insert(key, json!({"status":"error","error":error.message}));
                        failures.push(format!("cardtrader_sync:{listing_id}"));
                    }
                }
            }
            fulfillment["cardTraderDone"] = json!(ct_done);
            fulfillment["cardtrader"] = json!(ct_progress);
            firestore
                .set_document(
                    &path,
                    &json!({"fulfillment":fulfillment,"updatedAt":state.now_iso()}),
                )
                .await?;
        }
    }
    if !failures.iter().any(|f| f.starts_with("ownership:")) {
        steps.insert("seller_ownership".into(), json!("done"));
    }
    if !failures.iter().any(|f| f.starts_with("cardtrader_sync:")) {
        steps.insert("cardtrader_sync".into(), json!("done"));
    }
    if steps
        .get("cardTraderBuy")
        .or_else(|| steps.get("cardtrader_buy"))
        .and_then(Value::as_str)
        != Some("done")
    {
        let mut complete = true;
        for request in crate::cardtrader::buy_through_requests(order_id, &order) {
            let key = format!("buy:{}", request.listing_id);
            if ct_result_complete(ct_progress.get(&key)) {
                continue;
            }
            match state.cardtrader().buy_through(&request).await {
                Ok(outcome) => {
                    if !outcome.is_complete() {
                        complete = false;
                    }
                    ct_progress.insert(key, outcome.to_json());
                }
                Err(error) => {
                    complete = false;
                    ct_progress.insert(key, json!({"status":"error","error":error.message}));
                }
            }
            fulfillment["cardtrader"] = json!(ct_progress);
            firestore
                .set_document(
                    &path,
                    &json!({"fulfillment":fulfillment,"updatedAt":state.now_iso()}),
                )
                .await?;
        }
        if complete {
            steps.insert("cardTraderBuy".into(), json!("done"));
            steps.insert("cardtrader_buy".into(), json!("done"));
        } else {
            failures.push("cardtrader_buy".into());
        }
    }
    if steps.get("notifications").and_then(Value::as_str) != Some("done") {
        match send_seller_sale_notifications_for_paid_order(state, order_id).await {
            Ok(result)
                if result["ok"] != false
                    && !result
                        .get("results")
                        .and_then(Value::as_array)
                        .is_some_and(|rows| rows.iter().any(|r| r["ok"] == false)) =>
            {
                steps.insert("notifications".into(), json!("done"));
            }
            _ => failures.push("notifications".into()),
        }
    }
    if steps.get("sales").and_then(Value::as_str) != Some("done") {
        let mut failed = false;
        for row in crate::domain::order_refund::sale_docs_from_order(order_id, &order) {
            let mut data = row.data.clone();
            data["soldAt"] = json!(state.now_iso());
            data["updatedAt"] = json!(state.now_iso());
            crate::sales_index::note_sale(data.get("cardId").and_then(Value::as_str).unwrap_or_default());
            let sale_path = firestore.document_path(store::SALES_COLLECTION, &row.id);
            if firestore.set_document(&sale_path, &data).await.is_err() {
                failed = true;
            }
        }
        if failed {
            failures.push("sales".into());
        } else {
            steps.insert("sales".into(), json!("done"));
        }
    }
    let pending = if failures.iter().any(|f| f.starts_with("cardtrader_sync:")) {
        vec!["cardtrader_sync"]
    } else {
        vec![]
    };
    let mut pending = pending.into_iter().map(str::to_string).collect::<Vec<_>>();
    if failures.iter().any(|f| f == "cardtrader_buy") {
        pending.push("cardtrader_buy".into());
    }
    let done = failures.is_empty();
    fulfillment["state"] = json!(if done { "done" } else { "partial" });
    fulfillment["steps"] = json!(steps);
    fulfillment["ownershipDone"] = json!(ownership_done);
    fulfillment["cardTraderDone"] = json!(ct_done);
    fulfillment["cardtrader"] = json!(ct_progress);
    fulfillment["failures"] = json!(failures);
    fulfillment["pendingWorkerSteps"] = json!(pending);
    fulfillment["finishedAt"] = json!(state.now_iso());
    let mut patch =
        json!({"inventory":inventory,"fulfillment":fulfillment,"updatedAt":state.now_iso()});
    // A paid, fulfilled order is never left "cancelled" by a release that
    // ran before the payment landed (specs/tla/eur-fulfilment
    // NotReleasedAndFulfilled).
    if order
        .get("fulfillmentStatus")
        .and_then(Value::as_str)
        .is_none_or(|s| s.is_empty() || s == "pending" || s == "cancelled")
    {
        patch["fulfillmentStatus"] = json!("awaiting_shipment");
        if order.get("status").and_then(Value::as_str) == Some("cancelled") {
            patch["status"] = json!("paid");
        }
    }
    firestore.set_document(&path, &patch).await?;
    Ok(
        json!({"orderId":order_id,"done":done,"failures":failures,"pendingWorkerSteps":pending,"holdsDropped":holds_dropped}),
    )
}
fn string_set(value: Option<&Value>) -> std::collections::BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}
fn ct_result_complete(value: Option<&Value>) -> bool {
    value
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|s| matches!(s, "applied" | "skipped"))
}
fn fulfilment_skip(order: &Value, now: i64) -> Option<&'static str> {
    if !matches!(
        payment_status_of(order),
        "paid" | "escrow" | "released" | "partially_refunded"
    ) {
        return Some("not_paid");
    }
    let state = order
        .pointer("/fulfillment/state")
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(state, "done" | "conflict") {
        return Some("done");
    }
    let start = order
        .pointer("/fulfillment/startedAt")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .or_else(|| {
            order
                .pointer("/fulfillment/startedAt/seconds")
                .and_then(Value::as_i64)
                .map(|s| s * 1000)
        })
        .unwrap_or(0);
    if state == "running" && now - start < 10 * 60 * 1000 {
        return Some("running");
    }
    None
}
async fn drop_eur_hold(state: &DomainState, order_id: &str, listing_id: &str) -> u64 {
    let Ok(id) = uuid::Uuid::parse_str(listing_id) else {
        return 0;
    };
    sqlx::query(
        "delete from public.marketplace_checkout_holds where order_id = $1 and listing_id = $2",
    )
    .bind(order_id)
    .bind(id)
    .execute(state.write_db())
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0)
}
async fn retake_eur_inventory(
    state: &DomainState,
    order_id: &str,
    order: &Value,
) -> Result<Vec<Value>, ApiError> {
    let raw = order
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::bad_request("Every cart row needs a listing, seller, quantity and price.")
        })?;
    if raw.is_empty() {
        return Err(ApiError::bad_request(
            "Every cart row needs a listing, seller, quantity and price.",
        ));
    }
    let mut native = Vec::new();
    let mut external = Vec::new();
    for row in raw {
        let item = normalize_item(row).map_err(|_| {
            ApiError::bad_request("Every cart row needs a listing, seller, quantity and price.")
        })?;
        let source = row.get("source").and_then(Value::as_str).unwrap_or("");
        let source_id = row
            .get("sourceListingId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if source.eq_ignore_ascii_case("cardtrader_live")
            || source_id.to_lowercase().starts_with("cardtrader:live:")
        {
            let product = row
                .pointer("/sourceMetadata/cardtraderProductId")
                .or_else(|| row.pointer("/sourceMetadata/externalProductId"))
                .or_else(|| row.pointer("/sourceMetadata/externalListingId"))
                .map(|v| {
                    if v.is_string() {
                        v.as_str().unwrap_or("").to_string()
                    } else {
                        v.to_string()
                    }
                })
                .unwrap_or_else(|| {
                    source_id
                        .get("cardtrader:live:".len()..)
                        .unwrap_or("")
                        .into()
                });
            let blueprint = row
                .pointer("/sourceMetadata/cardtraderBlueprintId")
                .or_else(|| row.pointer("/card/id"))
                .map(|v| {
                    if v.is_string() {
                        v.as_str().unwrap_or("").to_string()
                    } else {
                        v.to_string()
                    }
                })
                .unwrap_or_default();
            if product.is_empty() || blueprint.is_empty() {
                return Err(ApiError::conflict(
                    "CardTrader listing metadata is incomplete.",
                ));
            }
            let request = pokoin_external::cardtrader_live::LiveRequest {
                blueprint_id: blueprint.clone(),
                card_id: String::new(),
                requested_id: blueprint,
                requested_param: "blueprintId",
                language: String::new(),
                limit: None,
            };
            let db = pokoin_external::db::DbPools::lazy(
                state.read_db().clone(),
                state.write_db().clone(),
            );
            let payload = pokoin_external::cardtrader_live::read_live_listings(
                &db,
                &pokoin_external::cardtrader::client::CardTraderClient::new(),
                None,
                &request,
                "pokemon",
            )
            .await
            .map_err(|e| ApiError::conflict(e.message))?;
            let live = payload
                .get("listings")
                .and_then(Value::as_array)
                .and_then(|rows| {
                    rows.iter().find(|r| {
                        let id = r
                            .get("cardtraderProductId")
                            .or_else(|| r.get("externalProductId"))
                            .or_else(|| r.get("externalListingId"));
                        id.map(|v| {
                            if v.is_string() {
                                v.as_str().unwrap_or("").to_string()
                            } else {
                                v.to_string()
                            }
                        })
                        .unwrap_or_default()
                            == product
                    })
                })
                .ok_or_else(|| {
                    ApiError::conflict(format!(
                        "CardTrader listing {product} is no longer available."
                    ))
                })?;
            let quantity = live.get("quantity").and_then(Value::as_i64).unwrap_or(0);
            if quantity < item.quantity {
                return Err(ApiError::conflict(format!(
                    "CardTrader listing {product} is no longer available."
                )));
            }
            let price = live.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
            if (price - item.unit_price_pkn as f64).abs() > 0.0001 {
                return Err(ApiError::conflict(
                    "Listing price changed. Refresh your cart.",
                ));
            }
            external.push(json!({"listingId":item.listing_id,"quantity":item.quantity,"cardId":item.card_id,"unitPricePkn":item.unit_price_pkn,"external":true}));
        } else {
            native.push(item);
        }
    }
    let taken = verify_and_decrement_listings(state, &native, Some(order_id)).await?;
    let mut lines=taken.iter().map(|line|json!({"listingId":line.listing_id,"quantity":line.quantity,"cardId":line.card_id,"sellerUid":line.seller_uid,
        "sourceListingId":line.source_listing_id,"source":line.source,"remainingQuantity":line.remaining_quantity,"unitPricePkn":line.unit_price_pkn,"external":false})).collect::<Vec<_>>();
    lines.extend(external);
    for line in &taken {
        let _ = sqlx::query("select public.refresh_marketplace_blueprint_price_summary($1)")
            .bind(&line.card_id)
            .execute(state.write_db())
            .await;
    }
    Ok(lines)
}

/// One sold order line for the ownership sync.
#[derive(Debug, Clone, Default)]
pub struct OwnershipLine {
    pub listing_id: String,
    pub seller_uid: String,
    pub quantity: i64,
    pub source_listing_id: String,
    /// `<order>:<listing>`: when set, the decrement is applied at most once
    /// (kept in the row's `saleKeys`, checked in the same transaction).
    pub sale_key: String,
}

/// Keys of the sales a row already lost units to (the most recent ones).
pub const SALE_KEYS_KEPT: usize = 50;

/// The row's sale keys after applying `key` (None: already applied).
pub fn ownership_sale_keys(row: &Value, key: &str) -> Option<Vec<Value>> {
    let mut keys = row.get("saleKeys").and_then(Value::as_array).cloned().unwrap_or_default();
    if keys.iter().any(|k| k.as_str() == Some(key)) {
        return None;
    }
    keys.push(json!(key));
    let excess = keys.len().saturating_sub(SALE_KEYS_KEPT);
    Some(keys.split_off(excess))
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
    if !line.sale_key.is_empty() {
        return decrement_ownership_once(state, line, &doc_id).await;
    }
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

/// The decrement and its sale key in one Firestore transaction: a fulfilment
/// that died between the decrement and `ownershipDone`, or two fulfilments
/// of one order, used to take the units twice (specs/tla/eur-fulfilment
/// bugs/ownership-twice.cfg).
async fn decrement_ownership_once(state: &DomainState, line: &OwnershipLine, doc_id: &str) -> Result<Value, ApiError> {
    use crate::domain::order_refund as refunds;
    let firestore = state.firestore()?;
    let path = firestore.document_path(store::USER_CARD_COLLECTIONS, doc_id);
    for attempt in 0..5 {
        let transaction = firestore.begin_transaction().await?;
        let row = match firestore.get_document_in_transaction(&path, &transaction).await {
            Ok(row) => row,
            Err(error) => {
                firestore.rollback(&transaction).await;
                return Err(error.into());
            }
        };
        let Some(row) = row.filter(|row| refunds::ownership_row_is_decrementable(row, &line.seller_uid)) else {
            firestore.rollback(&transaction).await;
            return Ok(json!({ "ok": true, "skipped": true, "reason": "no_linked_ownership" }));
        };
        let Some(keys) = ownership_sale_keys(&row, &line.sale_key) else {
            firestore.rollback(&transaction).await;
            return Ok(json!({ "ok": true, "skipped": true, "reason": "already_decremented", "docId": doc_id }));
        };
        let current = row.get("quantity").and_then(Value::as_i64).unwrap_or(0);
        let next = refunds::ownership_quantity_after_sale(current, line.quantity);
        let write = if next <= 0 {
            crate::firestore::FirestoreWrite::Delete { path: path.clone() }
        } else {
            crate::firestore::FirestoreWrite::Update {
                path: path.clone(),
                value: json!({ "quantity": next, "saleKeys": keys, "updatedAt": store::now_iso() }),
                update_mask: Some(vec!["quantity".into(), "saleKeys".into(), "updatedAt".into()]),
            }
        };
        match firestore.commit(Some(&transaction), &[write]).await {
            Ok(_) => {
                return Ok(json!({
                    "ok": true, "deleted": next <= 0, "docId": doc_id, "before": current, "after": next.max(0),
                }))
            }
            Err(error) => {
                firestore.rollback(&transaction).await;
                if attempt == 4 {
                    return Err(error.into());
                }
            }
        }
    }
    Err(ApiError::internal("Could not decrement the seller's collection."))
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
        let profile = store::read_user(firestore, &seller_uid)
            .await
            .unwrap_or(json!({}));
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
            let body = notify::notification_marker_body(order_id, group, &email, &store::now_iso());
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
    Ok(private_json(
        json!({ "request": first, "requests": requests }),
    ))
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
            return Err(
                ApiError::conflict("This EUR order has no Stripe payment to refund.")
                    .with_code("no_payment_intent"),
            );
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
            let total = transfer
                .get("amount")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
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
                        if row.get("sellerId").and_then(Value::as_str) == Some(claims.uid.as_str())
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
    // Most cards never sold natively: the in-memory index answers those
    // without a Firestore round trip.
    let sales = match crate::sales_index::has_sales(&state, &card_id) {
        Some(false) => {
            pokoin_api_common::stages::source("index");
            Vec::new()
        }
        _ => read_card_sales(&state, &card_id, limit).await?,
    };
    let mut response = public_json(json!({ "cardId": card_id, "sales": sales }), 60);
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("public, max-age=60, s-maxage=60, stale-while-revalidate=600"),
    );
    Ok(response)
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
    let stored_envelope: crate::domain::address::EncryptedPayload = serde_json::from_value(
        address_doc
            .get("encryptedPayload")
            .cloned()
            .unwrap_or(json!({})),
    )
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
    Ok((
        to_country,
        serde_json::to_value(envelope).unwrap_or(json!({})),
    ))
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
        return Err(
            ApiError::bad_request("shippingAddressId required.").with_code("address_required")
        );
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
    let mut held_discount_pkn = 0i64;
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
            let op = LedgerOp::lock(&claims.uid, plan.discount_pkn, "order_discount_held")
                .with_ref(&order_id)
                .with_meta(json!({ "orderId": order_id }));
            store::apply(state.firestore()?, &op).await?;
            discount_eur_cents = plan.discount_eur_cents;
            held_discount_pkn = plan.discount_pkn;
        }
    }

    let charge_cents = quote.grand_total_cents - discount_eur_cents;
    if charge_cents < 50 {
        rollback_decrements(&state, &decremented, Some(&order_id)).await;
        return Err(ApiError::bad_request(
            "The card charge must be at least 50 cents.",
        ));
    }

    let site = state
        .config()
        .public_site_url
        .trim_end_matches('/')
        .to_string();
    let form: Vec<(String, String)> = vec![
        ("mode".into(), "payment".into()),
        (
            "expires_at".into(),
            (state.now_ms() / 1000 + 31 * 60).to_string(),
        ),
        (
            "success_url".into(),
            format!("{site}/orders/{order_id}?status=success"),
        ),
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
        (
            "metadata[discountPkn]".into(),
            held_discount_pkn.to_string(),
        ),
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
        "totalEURCents": quote.grand_total_cents,
        "shippingEURCents": quote.shipping_total_cents,
        "pknDiscount": {
            "pkn": held_discount_pkn,
            "eurCents": discount_eur_cents,
            "state": if held_discount_pkn > 0 { "held" } else { "none" },
        },
        "inventory": {
            "state": "reserved",
            "reservedAt": state.now_iso(),
            "expiresAt": chrono::DateTime::from_timestamp_millis(state.now_ms() + 31*60*1000).map(|d|d.to_rfc3339()),
            "lines": decremented.iter().map(|line|json!({
                "listingId":line.listing_id,"quantity":line.quantity,"cardId":line.card_id,"sellerUid":line.seller_uid,
                "sourceListingId":line.source_listing_id,"source":line.source,"remainingQuantity":line.remaining_quantity,
                "unitPricePkn":line.unit_price_pkn,"external":false
            })).collect::<Vec<_>>()
        },
        "fulfillment": { "state": "pending", "steps": {} },
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
    state
        .firestore()?
        .set_document(
            &state.firestore()?.document_path(store::ORDERS, &order_id),
            &order_document,
        )
        .await?;

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

    #[test]
    fn eur_release_plan_does_not_repeat_discount_and_preserves_inventory() {
        let order = json!({"buyerUid":"u","inventory":{"state":"reserved","lines":[{"listingId":"l"}],"expiresAt":"at"},
            "pknDiscount":{"state":"held","pkn":20,"eurCents":10}});
        let (patch, restore, held, uid, count) = release_plan(&order, "expired", "expired", "now");
        assert!(restore);
        assert_eq!(held, 20);
        assert_eq!(uid, "u");
        assert_eq!(count, 1);
        assert_eq!(patch["inventory"]["expiresAt"], "at");
        assert_eq!(patch["pknDiscount"]["eurCents"], 10);
        let mut next = order;
        for (k, v) in patch.as_object().unwrap() {
            next[k] = v.clone();
        }
        let (_, restore, held, _, _) = release_plan(&next, "expired", "expired", "later");
        assert!(!restore);
        assert_eq!(held, 0);
    }
    #[test]
    fn eur_lease_and_failed_cardtrader_results_do_not_claim_completion() {
        assert_eq!(
            fulfilment_skip(
                &json!({"paymentStatus":"paid","fulfillment":{"state":"running","startedAt":{"seconds":10}}}),
                20_000
            ),
            Some("running")
        );
        assert_eq!(
            fulfilment_skip(
                &json!({"paymentStatus":"paid","fulfillment":{"state":"running","startedAt":{"seconds":10}}}),
                610_000
            ),
            None
        );
        assert_eq!(
            fulfilment_skip(
                &json!({"paymentStatus":"paid","fulfillment":{"state":"done"}}),
                0
            ),
            Some("done")
        );
        assert!(!ct_result_complete(Some(&json!({"status":"error"}))));
        assert!(!ct_result_complete(Some(
            &json!({"status":"not_configured"})
        )));
        assert!(ct_result_complete(Some(&json!({"status":"applied"}))));
        assert_eq!(
            string_set(Some(&json!(["l", "l"]))),
            std::collections::BTreeSet::from(["l".to_string()])
        );
    }

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
    fn cancel_expires_the_session_and_never_releases_a_payable_order() {
        // specs/tla/eur-fulfilment bugs/cancel-then-paid.cfg: Node's
        // cancelPendingEurOrder contract.
        assert_eq!(cancel_plan("paid"), CancelPlan::AlreadyPaid);
        assert_eq!(cancel_plan("escrow"), CancelPlan::AlreadyPaid);
        assert_eq!(cancel_plan("pending_stripe"), CancelPlan::ExpireThenRelease);
        // An async payment in flight is not cancelled from Pokoin.
        assert_eq!(cancel_plan("processing"), CancelPlan::AlreadyClosed);
        assert_eq!(cancel_plan("expired"), CancelPlan::AlreadyClosed);
        assert_eq!(expire_refused(&json!({"status":"complete","payment_status":"paid"})), ExpireRefused::Paid);
        assert_eq!(expire_refused(&json!({"status":"complete","payment_status":"unpaid"})), ExpireRefused::Unknown);
        assert_eq!(expire_refused(&json!({"status":"expired"})), ExpireRefused::AlreadyExpired);
        assert_eq!(expire_refused(&json!({"status":"open"})), ExpireRefused::Unknown);
    }
    #[test]
    fn ownership_sale_keys_apply_once_and_stay_bounded() {
        assert_eq!(ownership_sale_keys(&json!({}), "o:l"), Some(vec![json!("o:l")]));
        assert_eq!(ownership_sale_keys(&json!({"saleKeys": ["o:l"]}), "o:l"), None);
        let full: Vec<Value> = (0..SALE_KEYS_KEPT).map(|i| json!(format!("o{i}:l"))).collect();
        let next = ownership_sale_keys(&json!({"saleKeys": full}), "new:l").unwrap();
        assert_eq!(next.len(), SALE_KEYS_KEPT);
        assert_eq!(next.last(), Some(&json!("new:l")));
        assert_eq!(next[0], json!("o1:l"));
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
