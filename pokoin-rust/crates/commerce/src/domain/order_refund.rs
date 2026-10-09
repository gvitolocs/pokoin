//! Seller share / refund arithmetic, ported from `_native_sales.js` and
//! `_order_refund.js`. Pure: no Firestore, no Stripe. Every rule the money
//! paths depend on (what is still refundable, what a refund may not exceed)
//! lives here so it can be asserted directly.

use serde_json::{json, Value};

use crate::error::ApiError;

/// `SOLD_PAYMENT_STATUSES`.
pub const SOLD_PAYMENT_STATUSES: [&str; 4] = ["paid", "escrow", "released", "partially_refunded"];

fn clean_text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn number_value(value: Option<&Value>, fallback: f64) -> f64 {
    match value.and_then(|value| crate::domain::js_number(Some(value))) {
        Some(number) if number.is_finite() => number,
        _ => fallback,
    }
}

/// `isEurOrder`: EUR currency or a Stripe payment method.
pub fn is_eur_order(order: &Value) -> bool {
    let currency = clean_text(order.get("currency"), 40);
    let method = clean_text(order.get("paymentMethod"), 40);
    currency == "EUR" || method == "stripe"
}

/// `orderIsSold`.
pub fn order_is_sold(order: &Value) -> bool {
    let status = clean_text(order.get("paymentStatus"), 40);
    SOLD_PAYMENT_STATUSES.contains(&status.as_str())
}

pub fn item_quantity(item: &Value) -> i64 {
    let quantity = number_value(item.get("quantity").or_else(|| item.get("qty")), 0.0);
    if quantity.fract() == 0.0 && quantity > 0.0 {
        quantity as i64
    } else {
        0
    }
}

fn seller_uid_of(value: Option<&Value>) -> String {
    clean_text(value, 160)
}

/// `sellerItems`: the order's lines belonging to one seller.
pub fn seller_items<'a>(order: &'a Value, seller_uid: &str) -> Vec<&'a Value> {
    order
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| seller_uid_of(item.get("sellerUid")) == seller_uid)
                .collect()
        })
        .unwrap_or_default()
}

/// `sellerShipment`.
pub fn seller_shipment<'a>(order: &'a Value, seller_uid: &str) -> Option<&'a Value> {
    order
        .get("shipments")
        .and_then(Value::as_array)
        .and_then(|shipments| {
            shipments
                .iter()
                .find(|row| seller_uid_of(row.get("sellerId")) == seller_uid)
        })
}

/// `refundsForSeller`: failed refunds do not count.
pub fn refunds_for_seller<'a>(order: &'a Value, seller_uid: &str) -> Vec<&'a Value> {
    order
        .get("refunds")
        .and_then(Value::as_array)
        .map(|refunds| {
            refunds
                .iter()
                .filter(|row| {
                    seller_uid_of(row.get("sellerUid")) == seller_uid
                        && clean_text(row.get("status"), 40) != "failed"
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
pub struct SellerShare {
    pub seller_uid: String,
    pub currency: &'static str,
    pub unit: &'static str,
    pub gross: i64,
    pub refunded: i64,
    pub refundable: i64,
}

/// `sellerShare`: what the seller can still hand back on this order.
/// EUR is their parcel (items + shipping) in cents; PKN is their item total.
pub fn seller_share(order: &Value, seller_uid: &str) -> SellerShare {
    let uid = seller_uid_of(Some(&Value::String(seller_uid.to_string())));
    let eur = is_eur_order(order);
    let items = seller_items(order, &uid);
    let refunded: i64 = refunds_for_seller(order, &uid)
        .iter()
        .map(|row| number_value(row.get("amount"), 0.0) as i64)
        .sum();

    let gross = if eur {
        match seller_shipment(order, &uid) {
            Some(shipment) => {
                (number_value(shipment.get("itemsSubtotalCents"), 0.0).round() as i64)
                    + (number_value(shipment.get("shippingAmountEURCents"), 0.0).round() as i64)
            }
            None => items
                .iter()
                .map(|item| {
                    (number_value(item.get("unitPriceEURCents"), 0.0)
                        * item_quantity(item) as f64)
                        .round() as i64
                })
                .sum(),
        }
    } else {
        items
            .iter()
            .map(|item| {
                let explicit = number_value(item.get("totalPricePkn"), f64::NAN);
                if explicit.is_finite() && explicit > 0.0 {
                    explicit as i64
                } else {
                    (number_value(item.get("unitPricePkn"), 0.0) * item_quantity(item) as f64) as i64
                }
            })
            .sum()
    };

    SellerShare {
        seller_uid: uid,
        currency: if eur { "EUR" } else { "PKN" },
        unit: if eur { "cents" } else { "pkn" },
        gross,
        refunded,
        refundable: (gross - refunded).max(0),
    }
}

/// `assertRefundable`: the seller's remaining share is the hard ceiling.
pub fn assert_refundable(
    order: &Value,
    seller_uid: &str,
    raw_amount: Option<f64>,
) -> Result<(i64, SellerShare), ApiError> {
    if !order_is_sold(order) {
        return Err(ApiError::conflict("Only paid orders can be refunded.")
            .with_code("order_not_paid"));
    }
    if seller_items(order, seller_uid).is_empty() {
        return Err(ApiError::forbidden("You did not sell anything on this order.")
            .with_code("not_seller"));
    }
    let share = seller_share(order, seller_uid);
    let Some(amount) = raw_amount else {
        return Err(invalid_amount(&share));
    };
    if !amount.is_finite() || amount.fract() != 0.0 || amount < 1.0 {
        return Err(invalid_amount(&share));
    }
    let amount = amount as i64;
    if amount > share.refundable {
        return Err(ApiError::conflict(
            "Refund is larger than what is left of your share of this order.",
        )
        .with_code("refund_too_large"));
    }
    Ok((amount, share))
}

fn invalid_amount(share: &SellerShare) -> ApiError {
    let message = if share.currency == "EUR" {
        "Refund amount must be at least 1 cent."
    } else {
        "Refund amount must be a whole PKN amount."
    };
    ApiError::bad_request(message).with_code("invalid_amount")
}


// ---------------------------------------------------------------------------
// Native sold rows (`marketplace_sales`)
// ---------------------------------------------------------------------------

/// `saleDocId(orderId, listingId)`: `/` cannot appear in a Firestore doc id.
pub fn sale_doc_id(order_id: &str, listing_id: &str) -> String {
    let raw = format!(
        "{}__{}",
        clean_text(Some(&Value::String(order_id.to_string())), 160),
        clean_text(Some(&Value::String(listing_id.to_string())), 160)
    );
    raw.replace('/', "_")
}

/// `itemCardId`: the item's public card id, falling back to `card.id`.
pub fn item_card_id(item: &Value) -> String {
    let direct = clean_text(item.get("cardId"), 120);
    if !direct.is_empty() {
        return direct;
    }
    clean_text(item.get("card").and_then(|card| card.get("id")), 120)
}

/// One Sold-on-Pokoin row, exactly as `saleDocsFromOrder` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct SaleDoc {
    pub id: String,
    pub data: Value,
}

/// `saleDocsFromOrder`: one row per order line with a listing, card and qty.
pub fn sale_docs_from_order(order_id: &str, order: &Value) -> Vec<SaleDoc> {
    let eur = is_eur_order(order);
    let mut rows = Vec::new();
    let Some(items) = order.get("items").and_then(Value::as_array) else {
        return rows;
    };
    for item in items {
        let listing_id = clean_text(item.get("listingId"), 160);
        let card_id = item_card_id(item);
        let quantity = item_quantity(item);
        if listing_id.is_empty() || card_id.is_empty() || quantity < 1 {
            continue;
        }
        let card = item.get("card").filter(|card| card.is_object());
        let card_name = card
            .and_then(|card| clean_text(card.get("name"), 240).into())
            .filter(|name: &String| !name.is_empty())
            .unwrap_or_else(|| clean_text(item.get("cardName"), 240));
        let fulfillment_mode = {
            let mode = clean_text(item.get("fulfillmentMode"), 40);
            if !mode.is_empty() {
                mode
            } else {
                let fallback = clean_text(order.get("fulfillmentMode"), 40);
                if fallback.is_empty() {
                    "physical".to_string()
                } else {
                    fallback
                }
            }
        };
        let mut data = json!({
            "orderId": clean_text(Some(&Value::String(order_id.to_string())), 160),
            "listingId": listing_id,
            "cardId": card_id,
            "cardName": card_name,
            "sellerUid": clean_text(item.get("sellerUid"), 160),
            "sellerName": clean_text(item.get("sellerName"), 120),
            "condition": clean_text(item.get("condition"), 40),
            "language": clean_text(item.get("language"), 20),
            "quantity": quantity,
            "unitPricePkn": number_value(item.get("unitPricePkn"), 0.0),
            "currency": if eur { "EUR" } else { "PKN" },
            "source": "pokoin",
            "fulfillmentMode": fulfillment_mode,
            "voided": false,
        });
        if eur {
            if let Some(object) = data.as_object_mut() {
                object.insert(
                    "unitPriceEURCents".into(),
                    json!(number_value(item.get("unitPriceEURCents"), 0.0).round() as i64),
                );
            }
        }
        rows.push(SaleDoc {
            id: sale_doc_id(order_id, item.get("listingId").and_then(Value::as_str).unwrap_or_default()),
            data,
        });
    }
    rows
}

// ---------------------------------------------------------------------------
// Seller ownership records (`user_card_collections`)
// ---------------------------------------------------------------------------

/// `decrementSellerOwnershipForSale` row eligibility: the row must belong to the
/// seller and must not be an NFT (those are never decremented by a sale).
pub fn ownership_row_is_decrementable(row: &Value, seller_uid: &str) -> bool {
    if clean_text(row.get("uid"), 160) != seller_uid {
        return false;
    }
    let is_nft = clean_text(row.get("ownershipType"), 40) == "nft"
        || clean_text(row.get("fulfillmentMode"), 40) == "nft_only"
        || clean_text(row.get("nftStatus"), 40) == "owned";
    !is_nft
}

/// The scan-owned document id for a `scan:` source listing id, if any.
pub fn scan_ownership_doc_id(source_listing_id: &str) -> Option<&str> {
    let source = source_listing_id.trim();
    source.strip_prefix("scan:").filter(|value| !value.is_empty())
}

/// `current - sold`, floored at zero (zero means delete the row).
pub fn ownership_quantity_after_sale(current: i64, sold: i64) -> i64 {
    (current - sold).max(0)
}

// ---------------------------------------------------------------------------
// Seller Transfers (Stripe Separate Charges and Transfers)
// ---------------------------------------------------------------------------

/// One seller payout candidate from `releaseSellerTransfers`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferPlanItem {
    pub seller_id: String,
    /// `sellerTransferCents - refundedCents`, floored at 0.
    pub amount_cents: i64,
    /// The Connect account recorded on the shipment, when present.
    pub account: Option<String>,
}

/// `releaseSellerTransfers` amount planning: partial refunds made before payout
/// shrink that seller's Transfer, and anything below 1 cent is skipped.
pub fn plan_transfer_amounts(order: &Value) -> Vec<TransferPlanItem> {
    let Some(shipments) = order.get("shipments").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut plan = Vec::new();
    for shipment in shipments {
        let amount = (number_value(shipment.get("sellerTransferCents"), 0.0) as i64
            - number_value(shipment.get("refundedCents"), 0.0) as i64)
            .max(0);
        if amount < 1 {
            continue;
        }
        let seller_id = clean_text(shipment.get("sellerId"), 160);
        let account = clean_text(shipment.get("stripeConnectAccountId"), 200);
        plan.push(TransferPlanItem {
            seller_id,
            amount_cents: amount,
            account: if account.is_empty() { None } else { Some(account) },
        });
    }
    plan
}

/// The Stripe `transfers.create` form for one plan item.
pub fn transfer_form(order_id: &str, item: &TransferPlanItem, account: &str, source_transaction: &str) -> Value {
    let mut form = json!({
        "amount": item.amount_cents,
        "currency": "eur",
        "destination": account,
        "transfer_group": order_id,
        "metadata[pokoinOrderId]": order_id,
        "metadata[sellerId]": item.seller_id,
    });
    if !source_transaction.is_empty() {
        if let Some(object) = form.as_object_mut() {
            object.insert(
                "source_transaction".into(),
                json!(source_transaction),
            );
        }
    }
    form
}

/// A seller may connect Stripe after the buyer paid, so a READY profile at
/// payout time supplies the missing account.
pub fn resolve_transfer_account(
    item: &TransferPlanItem,
    profile: Option<&Value>,
) -> Option<String> {
    if let Some(account) = &item.account {
        return Some(account.clone());
    }
    let profile = profile?;
    let status = clean_text(profile.get("stripeConnectStatus"), 40);
    let account = clean_text(profile.get("stripeConnectAccountId"), 200);
    if status == "READY" && !account.is_empty() {
        Some(account)
    } else {
        None
    }
}

/// Seller-facing sold history row for one order (`sellerHistoryRow`).
pub fn seller_history_row(order_id: &str, order: &Value, seller_uid: &str) -> Value {
    let share = seller_share(order, seller_uid);
    let shipment = seller_shipment(order, seller_uid);
    let refunds: Vec<Value> = refunds_for_seller(order, seller_uid)
        .into_iter()
        .cloned()
        .collect();
    json!({
        "orderId": order_id,
        "currency": share.currency,
        "unit": share.unit,
        "gross": share.gross,
        "refunded": share.refunded,
        "refundable": share.refundable,
        "refunds": refunds,
        "paymentStatus": clean_text(order.get("paymentStatus"), 40),
        "fulfillmentStatus": clean_text(order.get("fulfillmentStatus"), 40),
        "trackingCode": clean_text(order.get("trackingCode"), 80),
        "shippedAt": order.get("shippedAt").cloned().unwrap_or(Value::Null),
        "createdAt": order.get("createdAt").cloned().unwrap_or(Value::Null),
        "shipment": shipment.cloned().unwrap_or(Value::Null),
        "items": seller_items(order, seller_uid),
    })
}

/// `cleanClientToken`: a refund must be idempotent.
pub fn clean_client_token(value: Option<&Value>) -> String {
    clean_text(value, 80)
}

/// The `refunds` array with one entry patched.
pub fn patch_refund(refunds: &[Value], refund_id: &str, patch: Value) -> Vec<Value> {
    refunds
        .iter()
        .map(|row| {
            if row.get("id").and_then(Value::as_str) == Some(refund_id) {
                let mut merged = row.clone();
                if let (Some(target), Some(extra)) = (merged.as_object_mut(), patch.as_object()) {
                    for (key, value) in extra {
                        target.insert(key.clone(), value.clone());
                    }
                }
                merged
            } else {
                row.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pkn_order() -> Value {
        json!({
            "buyerUid": "buyer",
            "paymentStatus": "escrow",
            "items": [
                { "sellerUid": "s1", "quantity": 2, "unitPricePkn": 100 },
                { "sellerUid": "s2", "quantity": 1, "unitPricePkn": 500 },
            ],
            "refunds": [
                { "id": "rf_a", "sellerUid": "s1", "amount": 50, "status": "succeeded" },
                { "id": "rf_b", "sellerUid": "s1", "amount": 999, "status": "failed" },
            ],
        })
    }

    fn eur_order() -> Value {
        json!({
            "currency": "EUR",
            "paymentStatus": "paid",
            "buyerUid": "buyer",
            "items": [
                { "sellerUid": "s1", "quantity": 2, "unitPriceEURCents": 150 },
            ],
            "shipments": [
                { "sellerId": "s1", "itemsSubtotalCents": 300, "shippingAmountEURCents": 1684 },
                { "sellerId": "s2", "itemsSubtotalCents": 500, "shippingAmountEURCents": 900 },
            ],
        })
    }

    #[test]
    fn eur_detection_matches_the_reference() {
        assert!(is_eur_order(&json!({ "currency": "EUR" })));
        assert!(is_eur_order(&json!({ "paymentMethod": "stripe" })));
        assert!(!is_eur_order(&json!({ "currency": "PKN" })));
        assert!(!is_eur_order(&json!({})));
    }

    #[test]
    fn sold_statuses_match_the_reference_set() {
        for status in ["paid", "escrow", "released", "partially_refunded"] {
            assert!(order_is_sold(&json!({ "paymentStatus": status })), "{status}");
        }
        for status in ["pending", "pending_stripe", "expired", "failed", "cancelled"] {
            assert!(!order_is_sold(&json!({ "paymentStatus": status })), "{status}");
        }
    }

    #[test]
    fn seller_items_and_shipment_are_scoped() {
        let order = pkn_order();
        assert_eq!(seller_items(&order, "s1").len(), 1);
        assert!(seller_items(&order, "nobody").is_empty());
        assert!(seller_shipment(&eur_order(), "s1").is_some());
        assert!(seller_shipment(&eur_order(), "nobody").is_none());
    }

    #[test]
    fn pkn_share_uses_the_item_total_and_ignores_failed_refunds() {
        let share = seller_share(&pkn_order(), "s1");
        assert_eq!(share.currency, "PKN");
        assert_eq!(share.gross, 200);
        assert_eq!(share.refunded, 50);
        assert_eq!(share.refundable, 150);
    }

    #[test]
    fn eur_share_uses_the_shipment_parcel() {
        let share = seller_share(&eur_order(), "s1");
        assert_eq!(share.currency, "EUR");
        assert_eq!(share.gross, 300 + 1684);
        assert_eq!(share.refundable, 1984);
    }

    #[test]
    fn eur_share_falls_back_to_unit_prices_without_a_shipment() {
        let order = json!({
            "currency": "EUR",
            "paymentStatus": "paid",
            "items": [{ "sellerUid": "s1", "quantity": 3, "unitPriceEURCents": 125 }],
        });
        assert_eq!(seller_share(&order, "s1").gross, 375);
    }

    #[test]
    fn explicit_pkn_line_totals_win() {
        let order = json!({
            "paymentStatus": "paid",
            "items": [
                { "sellerUid": "s1", "quantity": 2, "unitPricePkn": 100, "totalPricePkn": 333 },
            ],
        });
        assert_eq!(seller_share(&order, "s1").gross, 333);
    }

    #[test]
    fn refundable_guards_match_the_reference() {
        let order = pkn_order();
        let (amount, share) = assert_refundable(&order, "s1", Some(150.0)).unwrap();
        assert_eq!(amount, 150);
        assert_eq!(share.refundable, 150);

        assert_eq!(
            assert_refundable(&order, "s1", Some(151.0))
                .unwrap_err()
                .code
                .as_deref(),
            Some("refund_too_large")
        );
        assert_eq!(
            assert_refundable(&order, "s1", Some(0.0))
                .unwrap_err()
                .code
                .as_deref(),
            Some("invalid_amount")
        );
        assert_eq!(
            assert_refundable(&order, "s1", Some(10.5))
                .unwrap_err()
                .code
                .as_deref(),
            Some("invalid_amount")
        );
        assert_eq!(
            assert_refundable(&order, "nobody", Some(10.0))
                .unwrap_err()
                .code
                .as_deref(),
            Some("not_seller")
        );
        let unpaid = json!({ "paymentStatus": "pending", "items": [{ "sellerUid": "s1" }] });
        assert_eq!(
            assert_refundable(&unpaid, "s1", Some(10.0))
                .unwrap_err()
                .code
                .as_deref(),
            Some("order_not_paid")
        );
    }

    #[test]
    fn eur_currency_wording_for_invalid_amounts() {
        let order = eur_order();
        assert!(assert_refundable(&order, "s1", Some(0.0))
            .unwrap_err()
            .message
            .contains("1 cent"));
    }

    #[test]
    fn refund_patching_replaces_only_the_target() {
        let refunds = vec![
            json!({ "id": "a", "status": "pending" }),
            json!({ "id": "b", "status": "pending" }),
        ];
        let patched = patch_refund(&refunds, "a", json!({ "status": "succeeded", "stripeRefundId": "re_1" }));
        assert_eq!(patched[0]["status"], json!("succeeded"));
        assert_eq!(patched[0]["stripeRefundId"], json!("re_1"));
        assert_eq!(patched[1]["status"], json!("pending"));
    }


    #[test]
    fn sale_doc_ids_match_the_node_scheme() {
        assert_eq!(sale_doc_id("order-1", "listing-9"), "order-1__listing-9");
        assert_eq!(sale_doc_id("a/b", "c/d"), "a_b__c_d");
    }

    #[test]
    fn sale_docs_are_one_row_per_usable_line() {
        let order = json!({
            "paymentStatus": "paid",
            "items": [
                { "listingId": "l1", "cardId": "693360", "sellerUid": "s1",
                  "quantity": 2, "unitPricePkn": 100, "condition": "NM", "language": "EN" },
                { "listingId": "", "cardId": "1", "quantity": 1 },
                { "listingId": "l3", "cardId": "", "quantity": 1 },
                { "listingId": "l4", "cardId": "5", "quantity": 0 },
            ],
        });
        let rows = sale_docs_from_order("order-1", &order);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "order-1__l1");
        assert_eq!(rows[0].data["quantity"], json!(2));
        assert_eq!(rows[0].data["currency"], json!("PKN"));
        assert_eq!(rows[0].data["source"], json!("pokoin"));
        assert_eq!(rows[0].data["voided"], json!(false));
        assert_eq!(rows[0].data["unitPricePkn"], json!(100.0));
    }

    #[test]
    fn eur_sale_docs_carry_cents_and_eur_currency() {
        let order = json!({
            "currency": "EUR",
            "items": [{ "listingId": "l1", "cardId": "7", "sellerUid": "s1",
                        "quantity": 1, "unitPriceEURCents": 149.4 }],
        });
        let rows = sale_docs_from_order("o2", &order);
        assert_eq!(rows[0].data["currency"], json!("EUR"));
        assert_eq!(rows[0].data["unitPriceEURCents"], json!(149));
    }

    #[test]
    fn sale_docs_prefer_the_nested_card_name() {
        let order = json!({
            "items": [{ "listingId": "l1", "cardId": "1", "quantity": 1,
                        "cardName": "outer", "card": { "name": "inner" } }],
        });
        let rows = sale_docs_from_order("o3", &order);
        assert_eq!(rows[0].data["cardName"], json!("inner"));
    }

    #[test]
    fn seller_history_row_exposes_the_share_and_tracking() {
        let order = json!({
            "paymentStatus": "paid",
            "fulfillmentStatus": "shipped",
            "trackingCode": "RR123",
            "items": [{ "sellerUid": "s1", "quantity": 2, "unitPricePkn": 100 }],
        });
        let row = seller_history_row("o4", &order, "s1");
        assert_eq!(row["orderId"], json!("o4"));
        assert_eq!(row["gross"], json!(200));
        assert_eq!(row["refundable"], json!(200));
        assert_eq!(row["trackingCode"], json!("RR123"));
        assert_eq!(row["currency"], json!("PKN"));
    }


    #[test]
    fn transfer_amounts_subtract_prior_refunds_and_skip_dust() {
        let order = json!({
            "shipments": [
                { "sellerId": "s1", "sellerTransferCents": 2000, "refundedCents": 500,
                  "stripeConnectAccountId": "acct_1" },
                { "sellerId": "s2", "sellerTransferCents": 1000 },
                { "sellerId": "s3", "sellerTransferCents": 700, "refundedCents": 700 },
                { "sellerId": "s4", "sellerTransferCents": 500, "refundedCents": 900 },
            ],
        });
        let plan = plan_transfer_amounts(&order);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].seller_id, "s1");
        assert_eq!(plan[0].amount_cents, 1500);
        assert_eq!(plan[0].account.as_deref(), Some("acct_1"));
        assert_eq!(plan[1].seller_id, "s2");
        assert_eq!(plan[1].amount_cents, 1000);
        assert!(plan[1].account.is_none());
        // Fully refunded and over-refunded sellers are skipped, never negative.
        assert!(plan.iter().all(|item| item.amount_cents >= 1));
        assert!(plan_transfer_amounts(&json!({})).is_empty());
    }

    #[test]
    fn transfer_forms_carry_the_stripe_grouping_and_source_charge() {
        let item = TransferPlanItem {
            seller_id: "s1".into(),
            amount_cents: 1500,
            account: Some("acct_1".into()),
        };
        let form = transfer_form("order-1", &item, "acct_1", "ch_1");
        assert_eq!(form["amount"], json!(1500));
        assert_eq!(form["currency"], json!("eur"));
        assert_eq!(form["destination"], json!("acct_1"));
        assert_eq!(form["transfer_group"], json!("order-1"));
        assert_eq!(form["source_transaction"], json!("ch_1"));
        assert_eq!(form["metadata[pokoinOrderId]"], json!("order-1"));
        assert_eq!(form["metadata[sellerId]"], json!("s1"));
        // Without a source charge the key is absent.
        let form = transfer_form("order-1", &item, "acct_1", "");
        assert!(form.get("source_transaction").is_none());
    }

    #[test]
    fn transfer_accounts_resolve_from_a_ready_profile_only() {
        let item = TransferPlanItem {
            seller_id: "s1".into(),
            amount_cents: 100,
            account: None,
        };
        let ready = json!({ "stripeConnectStatus": "READY", "stripeConnectAccountId": "acct_2" });
        assert_eq!(resolve_transfer_account(&item, Some(&ready)).as_deref(), Some("acct_2"));
        let pending = json!({ "stripeConnectStatus": "pending", "stripeConnectAccountId": "acct_2" });
        assert!(resolve_transfer_account(&item, Some(&pending)).is_none());
        let absent = json!({ "stripeConnectStatus": "READY" });
        assert!(resolve_transfer_account(&item, Some(&absent)).is_none());
        assert!(resolve_transfer_account(&item, None).is_none());
        // A shipment account always wins.
        let with_account = TransferPlanItem {
            account: Some("acct_shipment".into()),
            ..item
        };
        assert_eq!(
            resolve_transfer_account(&with_account, Some(&pending)).as_deref(),
            Some("acct_shipment")
        );
    }

    #[test]
    fn ownership_rows_are_decrementable_only_for_the_seller_and_not_nfts() {
        let row = json!({ "uid": "s1", "listingId": "l1", "quantity": 3 });
        assert!(ownership_row_is_decrementable(&row, "s1"));
        assert!(!ownership_row_is_decrementable(&row, "s2"));
        for nft in [
            json!({ "uid": "s1", "ownershipType": "nft" }),
            json!({ "uid": "s1", "fulfillmentMode": "nft_only" }),
            json!({ "uid": "s1", "nftStatus": "owned" }),
        ] {
            assert!(!ownership_row_is_decrementable(&nft, "s1"));
        }
    }

    #[test]
    fn scan_ownership_ids_and_quantity_math() {
        assert_eq!(scan_ownership_doc_id("scan:abc123"), Some("abc123"));
        assert_eq!(scan_ownership_doc_id(" scan:abc123 "), Some("abc123"));
        assert_eq!(scan_ownership_doc_id("scan:"), None);
        assert_eq!(scan_ownership_doc_id("pt:123"), None);
        assert_eq!(ownership_quantity_after_sale(3, 1), 2);
        assert_eq!(ownership_quantity_after_sale(3, 3), 0);
        assert_eq!(ownership_quantity_after_sale(1, 5), 0);
    }

    #[test]
    fn transfer_plan_items_are_publicly_constructible() {
        let item = TransferPlanItem {
            seller_id: "x".into(),
            amount_cents: 1,
            account: None,
        };
        assert_eq!(item.amount_cents, 1);
    }

    #[test]
    fn client_tokens_are_trimmed_and_bounded() {
        assert_eq!(
            clean_client_token(Some(&json!("  tok-1  "))),
            "tok-1"
        );
        assert_eq!(clean_client_token(None), "");
    }
}
