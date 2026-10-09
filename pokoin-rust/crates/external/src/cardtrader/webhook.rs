//! CardTrader webhook — native port of `_cardtrader_webhook_core.js` and
//! `cardtrader-webhook.js`. Raw-body HMAC-SHA256 verification, cause
//! filtering, Firestore idempotency claims, writer-pool decrements,
//! cancellation restore, and the 1-Day Ready channel.

use serde_json::{json, Value};

use crate::cardtrader::integration as ct_integration;
use crate::cardtrader::sync_core::{public_card_id_from_blueprint, sale_items_by_product};
use crate::db::DbPools;
use crate::error::{clean_text, clean_text_value, i64_field, ApiError, ApiResult};
use crate::firebase::FirestoreStore;

pub const EVENTS_COLLECTION: &str = "cardtrader_webhook_events";
pub const SALES_COLLECTION: &str = "marketplace_sales";

pub fn event_doc_id(uid: &str, order_id: &str, order_item_id: &str) -> String {
    format!("{}_{}_{}", clean_text(Some(uid), 80), clean_text(Some(order_id), 40), clean_text(Some(order_item_id), 40))
}

pub fn item_product_id(item: &Value) -> String {
    let product = item.get("product").filter(|v| v.is_object());
    clean_text(
        item.get("product_id")
            .or_else(|| item.get("productId"))
            .or_else(|| item.get("seller_product_id"))
            .or_else(|| item.get("sellerProductId"))
            .or_else(|| product.and_then(|p| p.get("id")))
            .or_else(|| product.and_then(|p| p.get("product_id")))
            .or_else(|| product.and_then(|p| p.get("productId")))
            .and_then(Value::as_str),
        80,
    )
}

pub fn item_user_data_field(item: &Value) -> String {
    let product = item.get("product").filter(|v| v.is_object());
    clean_text(
        item.get("user_data_field")
            .or_else(|| item.get("userDataField"))
            .or_else(|| product.and_then(|p| p.get("user_data_field")))
            .or_else(|| product.and_then(|p| p.get("userDataField")))
            .and_then(Value::as_str),
        160,
    )
}

pub fn order_item_id(item: &Value) -> String {
    let direct = clean_text(
        item.get("id")
            .or_else(|| item.get("order_item_id"))
            .or_else(|| item.get("orderItemId"))
            .and_then(crate::error::scalar_text).as_deref(),
        80,
    );
    if !direct.is_empty() {
        return direct;
    }
    item_product_id(item)
}

/// Direct sales decrement at paid; CardTrader Zero decrements at hub_pending.
pub fn should_decrement_stock(order: &Value, item: &Value) -> bool {
    let state = clean_text(order.get("state").and_then(Value::as_str), 40).to_lowercase();
    let via_zero = order.get("via_cardtrader_zero") == Some(&Value::Bool(true));
    if via_zero && state == "hub_pending" {
        let hub_order = item
            .get("hub_pending_order_id")
            .or_else(|| item.get("hubPendingOrderId"))
            .cloned()
            .unwrap_or(Value::Null);
        if hub_order.is_null() || hub_order == json!("") {
            return true;
        }
        return clean_text_value(&hub_order, 40) == clean_text_value(order.get("id").unwrap_or(&Value::Null), 40);
    }
    !via_zero && state == "paid"
}

pub fn is_cancelled_order(order: &Value) -> bool {
    let state = clean_text(order.get("state").and_then(Value::as_str), 40).to_lowercase();
    matches!(state.as_str(), "canceled" | "cancelled" | "request_for_cancel_accepted")
}

const FIND_LINKED_BY_ID_SQL: &str = r#"
  select id, card_id, quantity_available, status, source_listing_id, seller_uid
  from public.marketplace_user_listings
  where id = $1::uuid and seller_uid = $2
  limit 1
"#;

const FIND_LINKED_BY_SOURCE_SQL: &str = r#"
  select id, card_id, quantity_available, status, source_listing_id, seller_uid
  from public.marketplace_user_listings
  where seller_uid = $1
    and source_listing_id = $2
    and status in ('active', 'paused')
  order by updated_at desc
  limit 1
"#;

const FIND_LINKED_BY_PRODUCT_SQL: &str = r#"
  select l.id, l.card_id, l.quantity_available, l.status, l.source_listing_id, l.seller_uid
  from public.marketplace_cardtrader_product_links link
  join public.marketplace_user_listings l on l.id = link.listing_id
  where link.seller_uid = $1
    and link.ct_product_id = $2
    and l.status in ('active', 'paused')
  limit 1
"#;

/// `findLinkedListing` — pokoin: uuid in user_data_field, then ct: source id,
/// then the product-links table.
pub async fn find_linked_listing(db: &DbPools, seller_uid: &str, item: &Value) -> ApiResult<Option<Value>> {
    let listing_id = crate::cardtrader::sync_core::parse_pokoin_listing_id(&item_user_data_field(item));
    if !listing_id.is_empty() {
        let rows = db
            .query("pokemon", FIND_LINKED_BY_ID_SQL, &[json!(listing_id), json!(seller_uid)])
            .await?;
        if let Some(row) = rows.first() {
            return Ok(Some(row.clone()));
        }
    }
    let product_id = item_product_id(item);
    if product_id.is_empty() {
        return Ok(None);
    }
    let source_id = crate::cardtrader::sync_core::ct_source_listing_id(&product_id);
    let rows = db
        .query("pokemon", FIND_LINKED_BY_SOURCE_SQL, &[json!(seller_uid), json!(source_id)])
        .await?;
    if let Some(row) = rows.first() {
        return Ok(Some(row.clone()));
    }
    match db
        .query("pokemon", FIND_LINKED_BY_PRODUCT_SQL, &[json!(seller_uid), json!(product_id)])
        .await
    {
        Ok(rows) => Ok(rows.first().cloned()),
        // Optional table on non-pokemon game DBs.
        Err(error) if error.is_table_missing() => Ok(None),
        Err(error) => Err(error),
    }
}

const DECREMENT_SQL: &str = r#"
  update public.marketplace_user_listings
  set
    quantity_available = quantity_available - $2,
    status = case when quantity_available - $2 <= 0 then 'sold_out' else status end,
    updated_at = now()
  where id = $1::uuid
    and seller_uid = $3
    and status in ('active', 'paused')
    and quantity_available >= $2
  returning id, card_id, quantity_available, status, seller_uid
"#;

/// `decrementPokoinListing` — guarded writer-pool decrement.
pub async fn decrement_pokoin_listing(db: &DbPools, listing: &Value, quantity: i64) -> ApiResult<Option<Value>> {
    let qty = quantity.max(1);
    let rows = db
        .write(
            "pokemon",
            DECREMENT_SQL,
            &[
                json!(clean_text_value(listing.get("id").unwrap_or(&Value::Null), 80)),
                json!(qty),
                json!(clean_text_value(
                    listing.get("seller_uid").unwrap_or(&Value::Null),
                    160
                )),
            ],
        )
        .await?;
    Ok(rows.first().cloned())
}

/// `claimWebhookEvent` — Firestore create() = idempotency claim.
pub async fn claim_webhook_event(firestore: &dyn FirestoreStore, uid: &str, order_id: &str, order_item_id: &str, cause: &str) -> ApiResult<bool> {
    let id = event_doc_id(uid, order_id, order_item_id);
    let fields = json!({
        "uid": uid,
        "orderId": order_id,
        "orderItemId": order_item_id,
        "cause": clean_text(Some(cause), 40),
        "createdAt": crate::time_util::iso_from_ms(crate::time_util::now_ms()),
    });
    match firestore.create_doc(EVENTS_COLLECTION, &id, fields).await {
        Ok(()) => Ok(true),
        Err(error) if error.status == 409 => Ok(false),
        Err(error) => Err(error),
    }
}

pub async fn release_webhook_event(firestore: &dyn FirestoreStore, id: &str) {
    let _ = firestore.delete_doc(EVENTS_COLLECTION, id).await;
}

/// `recordCardTraderSale` — public-safe sold-history row.
pub async fn record_cardtrader_sale(
    firestore: &dyn FirestoreStore,
    seller_uid: &str,
    order: &Value,
    item: &Value,
    listing: &Value,
    channel: &str,
) -> ApiResult<()> {
    let listing_id = clean_text_value(listing.get("id").unwrap_or(&Value::Null), 160);
    let card_id = clean_text_value(listing.get("card_id").unwrap_or(&Value::Null), 120);
    let quantity = i64_field(item, &["quantity", "qty"]).unwrap_or(1).max(1);
    let seller_price = item.get("seller_price").cloned().unwrap_or(Value::Null);
    let cents = match &seller_price {
        Value::Object(map) => map.get("cents").and_then(Value::as_i64),
        Value::Number(number) => number.as_f64().map(|f| f.round() as i64),
        _ => None,
    };
    let currency = match &seller_price {
        Value::Object(map) => clean_text(map.get("currency").and_then(Value::as_str), 8).to_uppercase(),
        _ => "EUR".to_string(),
    };
    let doc_id = format!(
        "ct_{}__{}",
        clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
        order_item_id(item)
    )
    .replace('/', "_");
    let now = crate::time_util::iso_from_ms(crate::time_util::now_ms());
    firestore
        .merge_doc(
            SALES_COLLECTION,
            &doc_id,
            json!({
                "sellerUid": seller_uid,
                "orderId": clean_text_value(order.get("id").unwrap_or(&Value::Null), 160),
                "orderCode": clean_text_value(order.get("code").unwrap_or(&Value::Null), 80),
                "listingId": listing_id,
                "cardId": card_id,
                "cardName": clean_text(item.get("name").and_then(Value::as_str), 240),
                "quantity": quantity,
                "unitPriceCents": cents,
                "currency": if currency.is_empty() { "EUR".to_string() } else { currency },
                "source": "cardtrader",
                "channel": channel,
                "voided": false,
                "soldAt": now.clone(),
                "updatedAt": now,
            }),
        )
        .await
}

/// `restoreCancelledItem` — restock once per order item.
pub async fn restore_cancelled_item(
    firestore: &dyn FirestoreStore,
    db: &DbPools,
    uid: &str,
    order: &Value,
    item: &Value,
) -> ApiResult<Value> {
    let current_item_id = order_item_id(item);
    let doc_id = event_doc_id(
        uid,
        &clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
        &current_item_id,
    );
    // Transaction predicate: exists, not yet restored, has a listingId.
    fn predicate(data: &Value) -> bool {
        !data.get("restoredAt").is_some_and(|v| !v.is_null())
            && data.get("listingId").map(|v| !v.is_null()).unwrap_or(false)
    }
    let restored = firestore
        .merge_doc_if(
            EVENTS_COLLECTION,
            &doc_id,
            &predicate as &(dyn Fn(&Value) -> bool + Send + Sync),
            json!({
                "restoredAt": crate::time_util::iso_from_ms(crate::time_util::now_ms()),
                "cancelledState": clean_text(order.get("state").and_then(Value::as_str), 40),
            }),
        )
        .await?;
    if !restored {
        return Ok(json!({ "orderItemId": current_item_id, "skipped": true, "reason": "nothing_to_restore" }));
    }
    let doc = firestore.get_doc(EVENTS_COLLECTION, &doc_id).await?;
    let data = doc.data;
    let qty = i64_field(&data, &["quantity"])
        .or_else(|| i64_field(item, &["quantity"]))
        .unwrap_or(1)
        .max(1);
    let listing_id = clean_text_value(data.get("listingId").unwrap_or(&Value::Null), 80);
    db.write(
        "pokemon",
        r#"
      update public.marketplace_user_listings
      set
        quantity_available = quantity_available + $2,
        status = case when status = 'sold_out' then 'active' else status end,
        updated_at = now()
      where id = $1::uuid and seller_uid = $3
    "#,
        &[json!(listing_id), json!(qty), json!(uid)],
    )
    .await?;
    let sale_doc = format!("ct_{}__{}", clean_text_value(order.get("id").unwrap_or(&Value::Null), 40), current_item_id).replace('/', "_");
    let _ = firestore
        .merge_doc(
            SALES_COLLECTION,
            &sale_doc,
            json!({ "voided": true, "voidReason": "cardtrader_order_cancelled", "updatedAt": crate::time_util::iso_from_ms(crate::time_util::now_ms()) }),
        )
        .await;
    Ok(json!({ "orderItemId": current_item_id, "ok": true, "restored": qty, "listingId": listing_id }))
}

/// `handleOrderPayload` — the webhook body loop.
pub async fn handle_order_payload(
    firestore: &dyn FirestoreStore,
    db: &DbPools,
    uid: &str,
    cause: &str,
    order: &Value,
) -> ApiResult<Vec<Value>> {
    let items = order.get("order_items").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut results = Vec::new();

    if is_cancelled_order(order) {
        for item in &items {
            results.push(restore_cancelled_item(firestore, db, uid, order, item).await?);
        }
        return Ok(results);
    }

    for item in &items {
        let current_item_id = order_item_id(item);
        if !should_decrement_stock(order, item) {
            results.push(json!({ "orderItemId": current_item_id, "skipped": true, "reason": "not_sale_state" }));
            continue;
        }
        if current_item_id.is_empty() {
            results.push(json!({ "orderItemId": "", "skipped": true, "reason": "missing_order_item_id" }));
            continue;
        }
        let order_id = clean_text_value(order.get("id").unwrap_or(&Value::Null), 40);
        // Resolve before claiming: a not-yet-linked item must stay retryable.
        let listing = find_linked_listing(db, uid, item).await?;
        let Some(listing) = listing else {
            // 1-Day Ready stock is never a Pokoin listing — record the sale
            // tagged 1dr and leave Pokoin stock put.
            let integration = ct_integration::read_integration_doc(firestore, uid).await?;
            if ct_integration::is_one_day_ready_integration(&integration) {
                let claimed = claim_webhook_event(firestore, uid, &order_id, &current_item_id, cause).await?;
                if !claimed {
                    results.push(json!({ "orderItemId": current_item_id, "skipped": true, "reason": "already_processed" }));
                    continue;
                }
                let product_id = item_product_id(item);
                let card_id = item
                    .get("blueprint_id")
                    .or_else(|| item.get("blueprintId"))
                    .and_then(crate::error::scalar_text)
                    .and_then(|id| public_card_id_from_blueprint(&id))
                    .unwrap_or_default();
                let _ = firestore
                    .merge_doc(
                        EVENTS_COLLECTION,
                        &event_doc_id(uid, &order_id, &current_item_id),
                        json!({
                            "quantity": i64_field(item, &["quantity"]).unwrap_or(1).max(1),
                            "productId": product_id,
                            "channel": "1dr",
                        }),
                    )
                    .await;
                let _ = record_cardtrader_sale(
                    firestore,
                    uid,
                    order,
                    item,
                    &json!({ "id": if product_id.is_empty() { Value::Null } else { json!(format!("ct:{product_id}")) }, "card_id": card_id }),
                    "1dr",
                )
                .await;
                results.push(json!({ "orderItemId": current_item_id, "ok": true, "channel": "1dr", "productId": product_id }));
                continue;
            }
            results.push(json!({ "orderItemId": current_item_id, "skipped": true, "reason": "no_linked_listing" }));
            continue;
        };

        let claimed = claim_webhook_event(firestore, uid, &order_id, &current_item_id, cause).await?;
        if !claimed {
            results.push(json!({ "orderItemId": current_item_id, "skipped": true, "reason": "already_processed" }));
            continue;
        }
        let qty = i64_field(item, &["quantity"]).unwrap_or(1).max(1);
        let updated = decrement_pokoin_listing(db, &listing, qty).await?;
        let Some(updated) = updated else {
            let claim_id = event_doc_id(uid, &order_id, &current_item_id);
            release_webhook_event(firestore, &claim_id).await;
            results.push(json!({ "orderItemId": current_item_id, "ok": false, "reason": "decrement_failed", "listingId": listing["id"] }));
            continue;
        };
        let _ = firestore
            .merge_doc(
                EVENTS_COLLECTION,
                &event_doc_id(uid, &order_id, &current_item_id),
                json!({
                    "listingId": updated["id"],
                    "quantity": qty,
                    "productId": item_product_id(item),
                }),
            )
            .await;
        let _ = record_cardtrader_sale(firestore, uid, order, item, &updated, "").await;
        // refresh_marketplace_blueprint_price_summary is DELETE+INSERT, so it
        // must run on the writer pool; best-effort so CardTrader never
        // redelivers into a double decrement.
        let _ = db
            .write("pokemon", "select public.refresh_marketplace_blueprint_price_summary($1)", &[updated["card_id"].clone()])
            .await;
        results.push(json!({
            "orderItemId": current_item_id,
            "ok": true,
            "listingId": updated["id"],
            "quantity": qty,
            "remaining": updated["quantity_available"],
            "status": updated["status"],
        }));
    }
    Ok(results)
}

/// The HTTP-level webhook logic (route calls this after pulling the raw body).
pub async fn handle_webhook(
    firestore: &dyn FirestoreStore,
    db: &DbPools,
    uid: &str,
    raw_body: &[u8],
    signature_header: &str,
    body_json: Option<&Value>,
) -> ApiResult<Value> {
    let uid = clean_text(Some(uid), 160);
    if uid.is_empty() {
        return Err(ApiError::bad_request("Missing seller uid."));
    }
    let shared_secret = ct_integration::decrypt_integration_shared_secret(firestore, &uid).await?;
    if !crate::crypto::verify_webhook_signature(raw_body, signature_header, &shared_secret) {
        tracing::warn!(uid, body_bytes = raw_body.len(), "cardtrader-webhook rejected: invalid_signature");
        return Err(ApiError::new(401, "Invalid webhook signature."));
    }
    let payload: Value = match body_json {
        Some(value) if value.is_object() => value.clone(),
        _ => {
            if raw_body.is_empty() {
                json!({})
            } else {
                serde_json::from_slice(raw_body).unwrap_or(json!({}))
            }
        }
    };
    let cause = clean_text(payload.get("cause").and_then(Value::as_str), 40).to_lowercase();
    if !matches!(cause.as_str(), "order.create" | "order.update" | "order.destroy") {
        return Ok(json!({ "ok": true, "skipped": true, "reason": "ignored_cause" }));
    }
    let mut data = payload.get("data").cloned().unwrap_or(json!({}));
    if !data.is_object() {
        data = json!({});
    }
    // A destroyed order never completed: same as a cancellation (restock once).
    let order = if cause == "order.destroy" {
        let mut order = data;
        order["state"] = json!("canceled");
        order
    } else {
        data
    };
    if clean_text(order.get("order_as").and_then(Value::as_str), 20).to_lowercase() == "buyer" {
        return Ok(json!({ "ok": true, "skipped": true, "reason": "buyer_order" }));
    }
    let results = handle_order_payload(firestore, db, &uid, &cause, &order).await?;
    // Retryable misses trigger the complete-export fallback sync.
    if results.iter().any(|row| row.get("reason").and_then(Value::as_str) == Some("no_linked_listing")
        || row.get("reason").and_then(Value::as_str) == Some("decrement_failed"))
    {
        // Enqueue is best-effort; caller owns the job queue.
        return Ok(json!({ "ok": true, "results": results, "retrySync": true }));
    }
    Ok(json!({ "ok": true, "results": results }))
}

/// `saleItemsByProduct` re-export for the reconcile path.
pub fn sales_map(orders: &[Value]) -> std::collections::HashMap<String, Vec<(Value, Value)>> {
    sale_items_by_product(orders)
}

#[cfg(test)]
mod tests {
    /// Set the integration encryption key once for the whole test binary:
    /// tests run in parallel, so removing it mid-run races other cases.
    fn ensure_encryption_key() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            std::env::set_var(
                "CARDTRADER_TOKEN_ENCRYPTION_KEY",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            );
        });
    }

    use super::*;

    #[test]
    fn decrement_gate_by_order_state() {
        let paid_direct = json!({"state": "paid", "via_cardtrader_zero": false});
        let item = json!({"product_id": "1", "quantity": 1});
        assert!(should_decrement_stock(&paid_direct, &item));

        let pending_direct = json!({"state": "hub_pending", "via_cardtrader_zero": false});
        assert!(!should_decrement_stock(&pending_direct, &item));

        let zero_pending = json!({"state": "hub_pending", "via_cardtrader_zero": true, "id": "9"});
        assert!(should_decrement_stock(&zero_pending, &item));
        let other_hub = json!({"state": "hub_pending", "via_cardtrader_zero": true, "id": "9"});
        let item_with_foreign_hub = json!({"product_id": "1", "hub_pending_order_id": "8"});
        assert!(!should_decrement_stock(&other_hub, &item_with_foreign_hub));
        let item_with_own_hub = json!({"product_id": "1", "hub_pending_order_id": "9"});
        assert!(should_decrement_stock(&other_hub, &item_with_own_hub));

        let zero_paid = json!({"state": "paid", "via_cardtrader_zero": true});
        assert!(!should_decrement_stock(&zero_paid, &item));
    }

    #[test]
    fn cancellation_states() {
        for state in ["canceled", "cancelled", "request_for_cancel_accepted"] {
            assert!(is_cancelled_order(&json!({"state": state})));
        }
        assert!(!is_cancelled_order(&json!({"state": "paid"})));
    }

    #[test]
    fn ids_and_fields() {
        let item = json!({"id": "77", "product_id": "42", "user_data_field": "pokoin:9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d"});
        assert_eq!(order_item_id(&item), "77");
        assert_eq!(item_product_id(&item), "42");
        assert_eq!(item_user_data_field(&item), "pokoin:9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d");
        let nested = json!({"product": {"id": "9"}});
        assert_eq!(item_product_id(&nested), "9");
        let no_id = json!({"product_id": "5"});
        assert_eq!(order_item_id(&no_id), "5");
    }

    #[test]
    fn event_doc_id_shape() {
        assert_eq!(event_doc_id("u1", "55", "66"), "u1_55_66");
    }

    #[tokio::test]
    async fn webhook_signature_gate_fails_before_any_db_work() {
        use crate::firebase::MemoryFirestore;
        let fs = MemoryFirestore::new();
        ensure_encryption_key();
        crate::cardtrader::integration::store_connected_integration(
            &fs,
            "u1",
            "",
            "tok",
            &json!({"sharedSecret": "ssh"}),
        )
        .await
        .unwrap();
        // Disconnected pools: if the signature gate is skipped, the DB error
        // would surface instead of the 401.
        let err = handle_webhook(&fs, &DbPools::disconnected(), "u1", b"{}", "bad", None)
            .await
            .unwrap_err();
        assert_eq!(err.status, 401);
        assert_eq!(err.message, "Invalid webhook signature.");

        // An unknown seller fails closed at the secret lookup, before any DB work.
        let fs2 = MemoryFirestore::new();
        let err = handle_webhook(&fs2, &DbPools::disconnected(), "nobody", b"{}", "bad", None)
            .await
            .unwrap_err();
        assert_eq!(err.status, 404);
    }

    #[tokio::test]
    async fn webhook_ignores_non_order_causes() {
        use crate::firebase::MemoryFirestore;
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let fs = MemoryFirestore::new();
        ensure_encryption_key();
        let _ = crate::cardtrader::integration::store_connected_integration(
            &fs, "u1", "", "tok", &json!({"sharedSecret": "ssh"}),
        )
        .await;
        let body = br#"{"cause":"user.ping","data":{}}"#;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(b"ssh").unwrap();
        mac.update(body);
        let signature = B64.encode(mac.finalize().into_bytes());
        let payload: Value = serde_json::from_slice(body).unwrap();
        let out = handle_webhook(&fs, &DbPools::disconnected(), "u1", body, &signature, Some(&payload))
            .await
            .unwrap();
        assert_eq!(out["skipped"], true);
        assert_eq!(out["reason"], "ignored_cause");
        // Buyer orders are ignored too.
        let buyer_body = br#"{"cause":"order.create","data":{"id":1,"order_as":"buyer","order_items":[]}}"#;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(b"ssh").unwrap();
        mac.update(buyer_body);
        let signature = B64.encode(mac.finalize().into_bytes());
        let payload: Value = serde_json::from_slice(buyer_body).unwrap();
        let out = handle_webhook(&fs, &DbPools::disconnected(), "u1", buyer_body, &signature, Some(&payload))
            .await
            .unwrap();
        assert_eq!(out["reason"], "buyer_order");
    }
}
