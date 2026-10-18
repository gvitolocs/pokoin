//! Buyer markup and allocation of the ONE actual processor fee on a cart.
//! Integer minor units only; no assumed country-specific Stripe tariff.
use crate::error::ApiError;
use serde_json::{Value, json};

pub const MODEL: &str = "buyer_markup_processor_costs_v1";
pub const BUYER_MARKUP_BPS: i64 = 300;

pub fn buyer_markup(subtotal: i64) -> i64 {
    ((subtotal.max(0) as i128 * BUYER_MARKUP_BPS as i128 + 5000) / 10000) as i64
}

fn invalid(message: &str) -> ApiError {
    ApiError::conflict(message).with_code("settlement_costs_unavailable")
}

pub fn reserve_operation(order: &Value, token: &str, kind: &str, request: Value) -> Result<Value, ApiError> {
    if !order["settlementOperation"].is_null() {
        return Err(ApiError::conflict("A financial operation is pending. Reconcile its Stripe outcome before retrying.")
            .with_code("settlement_operation_busy"));
    }
    let status=order["paymentStatus"].as_str().unwrap_or("");
    if order["settlementModel"] != MODEL || token.is_empty()
        || !matches!(kind,"payout" | "refund")
        || !matches!(status,"paid" | "escrow" | "partially_refunded" | "released")
        || (kind == "payout" && (status == "released" || order["transfersReleased"] == true)) {
        return Err(invalid("Order is not eligible for this financial operation."));
    }
    Ok(json!({"token":token,"kind":kind,"request":request,
        "status":"reserved","createdAt":crate::store::now_iso(),
        "recovery":"verify Stripe using recorded idempotency keys; never expire or steal this reservation"}))
}

pub fn require_operation(order: &Value, token: &str) -> Result<(), ApiError> {
    if order["settlementOperation"]["token"].as_str() != Some(token) {
        return Err(invalid("Financial operation reservation no longer belongs to this request."));
    }
    Ok(())
}

/// Cumulative actual costs left uncovered by a refund larger than seller net.
/// This records a liability; it does not claim a seller was automatically debited.
pub fn stamp_processing_liability(shipment: &mut Value, refunded: i64, snapshot: &Value) -> Result<(), ApiError> {
    let gross=required_nonnegative(shipment,"sellerGrossCents")?;
    let fee=required_nonnegative(shipment,"stripeProcessingFeeCents")?;
    if refunded < 0 { return Err(invalid("Refunded amount is invalid.")); }
    let amount=refunded.saturating_add(fee).saturating_sub(gross).max(0).min(fee);
    shipment["sellerProcessingCostLiabilityCents"]=json!(amount);
    shipment["sellerProcessingCostLiability"]=if amount > 0 {
        json!({"status":"outstanding","currency":"EUR","amountCents":amount,
            "sellerGrossCents":gross,"processingFeeCents":fee,"refundedCents":refunded,
            "stripeChargeId":snapshot["stripeChargeId"],"balanceTransactionId":snapshot["balanceTransactionId"],
            "basis":"actual frozen processor cost after refunds",
            "reconciliation":"manual verified recovery required; not automatically collected"})
    } else { Value::Null };
    Ok(())
}

fn required_nonnegative(value: &Value, key: &str) -> Result<i64, ApiError> {
    value[key]
        .as_i64()
        .filter(|amount| *amount >= 0)
        .ok_or_else(|| invalid("Order settlement amounts are incomplete or invalid."))
}

fn checked_add(left: i64, right: i64) -> Result<i64, ApiError> {
    left.checked_add(right)
        .ok_or_else(|| invalid("Order settlement amounts overflow."))
}

fn charge_object_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.get("id").and_then(Value::as_str))
}

/// Validate the immutable buyer/seller arithmetic written by checkout. This is
/// deliberately repeated at settlement time so a malformed stored order can
/// never turn into a transfer.
fn order_weights(order: &Value) -> Result<Vec<(String, i64)>, ApiError> {
    let shipments = order["shipments"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .ok_or_else(|| invalid("Order shipments unavailable."))?;
    let mut weights = Vec::with_capacity(shipments.len());
    let mut item_total = 0i64;
    let mut shipping_total = 0i64;
    let mut seller_ids = std::collections::BTreeSet::new();
    for shipment in shipments {
        let seller_id = shipment["sellerId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("Seller payment allocation is ambiguous."))?
            .to_string();
        if !seller_ids.insert(seller_id.clone()) {
            return Err(invalid("Seller payment allocation is ambiguous."));
        }
        let items = required_nonnegative(shipment, "itemsSubtotalCents")?;
        let shipping = required_nonnegative(shipment, "shippingAmountEURCents")?;
        let gross = checked_add(items, shipping)?;
        item_total = checked_add(item_total, items)?;
        shipping_total = checked_add(shipping_total, shipping)?;
        weights.push((seller_id, gross));
    }

    let stored_markup = required_nonnegative(order, "buyerMarkupCents")?;
    let stored_shipping = required_nonnegative(order, "shippingEURCents")?;
    let insurance = required_nonnegative(order, "insuranceEURCents")?;
    let total = required_nonnegative(order, "totalEURCents")?;
    let expected_markup = buyer_markup(item_total);
    let expected_total = checked_add(
        checked_add(checked_add(item_total, shipping_total)?, expected_markup)?,
        insurance,
    )?;
    if stored_markup != expected_markup
        || stored_shipping != shipping_total
        || total != expected_total
        || total <= 0
    {
        return Err(invalid(
            "Stored checkout totals do not match seller proceeds.",
        ));
    }
    Ok(weights)
}

/// The exact amount Stripe was instructed to charge for a versioned EUR
/// order. PKN credit reduces the charge only; it never changes seller weights.
pub fn expected_charge_cents(order: &Value) -> Result<i64, ApiError> {
    let _ = order_weights(order)?;
    let total = required_nonnegative(order, "totalEURCents")?;
    let discount = match order.get("pknDiscount") {
        None | Some(Value::Null) => 0,
        Some(value) => required_nonnegative(value, "eurCents")?,
    };
    total
        .checked_sub(discount)
        .filter(|amount| *amount > 0)
        .ok_or_else(|| invalid("The stored Stripe charge amount is invalid."))
}

/// Largest remainder, with seller id as a stable tie breaker. A fixed fee is
/// part of `total` ONCE, never once per seller. Output follows input order.
pub fn allocate(total: i64, weights: &[(String, i64)]) -> Result<Vec<i64>, ApiError> {
    if total < 0 || weights.iter().any(|(_, n)| *n < 0) {
        return Err(invalid("Invalid payment cost allocation."));
    }
    let sum: i128 = weights.iter().map(|(_, n)| *n as i128).sum();
    if sum == 0 {
        return if total == 0 {
            Ok(vec![0; weights.len()])
        } else {
            Err(invalid("Payment costs have no seller basis."))
        };
    }
    let mut result: Vec<i64> = weights
        .iter()
        .map(|(_, n)| (total as i128 * *n as i128 / sum) as i64)
        .collect();
    let mut ranking: Vec<usize> = (0..weights.len()).filter(|i| weights[*i].1 > 0).collect();
    ranking.sort_by(|a, b| {
        let ra = total as i128 * weights[*a].1 as i128 % sum;
        let rb = total as i128 * weights[*b].1 as i128 % sum;
        rb.cmp(&ra).then_with(|| weights[*a].0.cmp(&weights[*b].0))
    });
    let remaining = total - result.iter().sum::<i64>();
    for index in ranking.into_iter().take(remaining as usize) {
        result[index] += 1;
    }
    Ok(result)
}

/// Expanded Charge.balance_transaction is authoritative. Stripe may provide it
/// asynchronously; missing data is pending, never a fabricated zero-cost fee.
pub fn fee_snapshot(order: &Value, charge: &Value) -> Result<Value, ApiError> {
    let expected = expected_charge_cents(order)?;
    let intent = order["stripePaymentIntentId"].as_str().unwrap_or("");
    let charge_id = charge["id"].as_str().unwrap_or("");
    let charge_intent = charge_object_id(&charge["payment_intent"]);
    if !charge_id.starts_with("ch_")
        || charge["paid"] != true
        || charge["status"] != "succeeded"
        || charge["currency"] != "eur"
        || charge["amount"].as_i64() != Some(expected)
        || charge_intent != Some(intent)
        || !intent.starts_with("pi_")
    {
        return Err(invalid("Stripe charge does not match this order."));
    }
    let balance = &charge["balance_transaction"];
    let fee = balance["fee"].as_i64().filter(|n| *n >= 0).ok_or_else(|| {
        invalid("Actual Stripe fees are not available yet. Retry settlement later.")
    })?;
    let balance_amount = balance["amount"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| invalid("Stripe balance transaction amount is unavailable."))?;
    let balance_currency = balance["currency"]
        .as_str()
        .filter(|currency| {
            currency.len() == 3
                && currency
                    .as_bytes()
                    .iter()
                    .all(|byte| byte.is_ascii_lowercase())
        })
        .ok_or_else(|| invalid("Stripe fee currency is unavailable."))?;
    let id = balance["id"]
        .as_str()
        .filter(|s| s.starts_with("txn_"))
        .ok_or_else(|| invalid("Stripe balance transaction reference is unavailable."))?;
    if charge_object_id(&balance["source"]) != Some(charge_id)
        || balance["type"] != "charge"
        || !balance["fee_details"].is_array()
    {
        return Err(invalid(
            "Stripe balance transaction does not match this charge.",
        ));
    }
    // Stripe balance currency can differ from the EUR charge. Use that exact
    // transaction's ratio, preserving the original fee/amount/currency for audit.
    let eur_fee = if balance_currency == "eur" {
        if balance_amount != expected {
            return Err(invalid("Stripe balance amount mismatch."));
        }
        fee
    } else {
        let converted =
            (fee as i128 * expected as i128 + balance_amount as i128 / 2) / balance_amount as i128;
        i64::try_from(converted)
            .map_err(|_| invalid("Converted Stripe fee is outside the supported range."))?
    };
    Ok(
        json!({ "status":"final", "currency":"EUR", "processingFeeCents":eur_fee,
            "stripeChargeId":charge_id, "stripePaymentIntentId":intent,
            "chargedAmountCents":expected, "chargeCurrency":"eur",
            "balanceTransactionId":id,
            "originalFee":fee, "originalAmount":balance_amount, "originalCurrency":balance_currency,
            "originalFeeDetails":balance["fee_details"],
            "allocationBasis":"seller item subtotal plus shipping; largest remainder, seller-id tie break",
        }),
    )
}

pub fn apply_fees(order: &Value, snapshot: &Value) -> Result<Value, ApiError> {
    let mut shipments = order["shipments"]
        .as_array()
        .cloned()
        .ok_or_else(|| invalid("Order shipments unavailable."))?;
    let weights = order_weights(order)?;
    if snapshot["status"] != "final"
        || snapshot["currency"] != "EUR"
        || !snapshot["stripeChargeId"]
            .as_str()
            .is_some_and(|id| id.starts_with("ch_"))
        || !snapshot["balanceTransactionId"]
            .as_str()
            .is_some_and(|id| id.starts_with("txn_"))
    {
        return Err(invalid("Actual fee snapshot is invalid."));
    }
    let total = snapshot["processingFeeCents"]
        .as_i64()
        .ok_or_else(|| invalid("Actual fee missing."))?;
    let fees = allocate(total, &weights)?;
    for (i, shipment) in shipments.iter_mut().enumerate() {
        if fees[i] > weights[i].1 {
            return Err(invalid(
                "Payment costs exceed seller proceeds; manual review required.",
            ));
        }
        shipment["sellerGrossCents"] = json!(weights[i].1);
        shipment["stripeProcessingFeeCents"] = json!(fees[i]);
        shipment["sellerTransferCents"] = json!(weights[i].1 - fees[i]);
        let refunded=shipment["refundedCents"].as_i64().unwrap_or(0);
        stamp_processing_liability(shipment,refunded,snapshot)?;
    }
    Ok(
        json!({ "shipments":shipments, "settlementFees":snapshot, "stripeChargeId":snapshot["stripeChargeId"] }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn financial_reservation_excludes_both_directions_and_never_expires() {
        let mut o=json!({"settlementModel":MODEL,"paymentStatus":"paid"});
        for first in ["payout","refund"] {
            o["settlementOperation"]=Value::Null;
            o["settlementOperation"]=reserve_operation(&o,"first",first,json!({})).unwrap();
            o["settlementOperation"]["createdAt"]=json!("2000-01-01T00:00:00Z");
            for second in ["payout","refund"] {
                assert!(reserve_operation(&o,"second",second,json!({})).is_err());
            }
            assert!(require_operation(&o,"second").is_err());
            assert!(require_operation(&o,"first").is_ok());
        }
    }
    #[test]
    fn full_refund_cost_liability_is_exact_and_not_added_twice() {
        let mut shipment=json!({"sellerGrossCents":10000,"stripeProcessingFeeCents":185});
        let snapshot=json!({"stripeChargeId":"ch_1","balanceTransactionId":"txn_1"});
        stamp_processing_liability(&mut shipment,1000,&snapshot).unwrap();
        assert_eq!(shipment["sellerProcessingCostLiabilityCents"],0);
        stamp_processing_liability(&mut shipment,10000,&snapshot).unwrap();
        assert_eq!(shipment["sellerProcessingCostLiabilityCents"],185);
        stamp_processing_liability(&mut shipment,10000,&snapshot).unwrap();
        assert_eq!(shipment["sellerProcessingCostLiabilityCents"],185);
        assert_eq!(shipment["sellerProcessingCostLiability"]["status"],"outstanding");
    }
    #[test]
    fn markup_is_buyer_side_and_rounded_once() {
        assert_eq!(buyer_markup(10000), 300);
        assert_eq!(buyer_markup(17), 1);
        assert_eq!(buyer_markup(16), 0);
    }
    #[test]
    fn one_fixed_fee_is_shared_exactly_including_pennies() {
        let rows = vec![("b".into(), 100), ("a".into(), 100), ("c".into(), 100)];
        assert_eq!(allocate(32, &rows).unwrap(), vec![11, 11, 10]);
        for fee in 0..1000 {
            assert_eq!(allocate(fee, &rows).unwrap().iter().sum::<i64>(), fee);
        }
        assert_eq!(
            allocate(101, &[("a".into(), 300), ("b".into(), 100)]).unwrap(),
            vec![76, 25]
        );
    }
    fn order() -> Value {
        json!({"totalEURCents":10300,"buyerMarkupCents":300,"shippingEURCents":0,
        "insuranceEURCents":0,"stripePaymentIntentId":"pi_x","shipments":[
        {"sellerId":"a","itemsSubtotalCents":7500,"shippingAmountEURCents":0},
        {"sellerId":"b","itemsSubtotalCents":2500,"shippingAmountEURCents":0}]})
    }
    fn charge() -> Value {
        json!({"id":"ch_x","paid":true,"status":"succeeded","currency":"eur","amount":10300,"payment_intent":"pi_x",
        "balance_transaction":{"id":"txn_x","type":"charge","source":"ch_x","amount":10300,
        "currency":"eur","fee":185,"fee_details":[]}})
    }
    #[test]
    fn seller_gets_full_item_value_minus_real_processor_cost_not_markup() {
        let snapshot = fee_snapshot(&order(), &charge()).unwrap();
        let result = apply_fees(&order(), &snapshot).unwrap();
        assert_eq!(result["shipments"][0]["sellerTransferCents"], 7361);
        assert_eq!(result["shipments"][1]["sellerTransferCents"], 2454);
        assert_eq!(7361 + 2454 + 185 + 300, 10300);
    }
    #[test]
    fn pending_mismatched_and_cross_currency_fees() {
        let mut c = charge();
        c["balance_transaction"] = Value::Null;
        assert!(fee_snapshot(&order(), &c).is_err());
        c = charge();
        c["payment_intent"] = json!("pi_other");
        assert!(fee_snapshot(&order(), &c).is_err());
        c = charge();
        c["balance_transaction"] = json!({"id":"txn_fx","type":"charge","source":"ch_x","amount":76838,
            "currency":"dkk","fee":1380,"fee_details":[]});
        assert_eq!(
            fee_snapshot(&order(), &c).unwrap()["processingFeeCents"],
            185
        );
        c["balance_transaction"]["fee"] = json!(0);
        assert_eq!(fee_snapshot(&order(), &c).unwrap()["processingFeeCents"], 0);
        c["balance_transaction"]["currency"] = json!("not-a-currency");
        assert!(fee_snapshot(&order(), &c).is_err());
    }
    #[test]
    fn pkn_discount_is_platform_funded_and_cannot_reduce_seller_gross() {
        let mut o = order();
        o["pknDiscount"] = json!({"eurCents":1000});
        let mut c = charge();
        c["amount"] = json!(9300);
        c["balance_transaction"]["amount"] = json!(9300);
        let result = apply_fees(&o, &fee_snapshot(&o, &c).unwrap()).unwrap();
        assert_eq!(result["shipments"][0]["sellerGrossCents"], 7500);
    }

    #[test]
    fn stored_markup_shipping_and_charge_identity_fail_closed() {
        let mut malformed = order();
        malformed["buyerMarkupCents"] = json!(299);
        assert!(fee_snapshot(&malformed, &charge()).is_err());

        malformed = order();
        malformed["shippingEURCents"] = json!(1);
        assert!(fee_snapshot(&malformed, &charge()).is_err());

        let mut wrong_source = charge();
        wrong_source["balance_transaction"]["source"] = json!("ch_other");
        assert!(fee_snapshot(&order(), &wrong_source).is_err());

        let mut missing_details = charge();
        missing_details["balance_transaction"]
            .as_object_mut()
            .unwrap()
            .remove("fee_details");
        assert!(fee_snapshot(&order(), &missing_details).is_err());
    }

    #[test]
    fn discount_changes_the_charge_not_seller_economics() {
        let mut discounted = order();
        discounted["pknDiscount"] = json!({"pkn":2000,"eurCents":1000,"state":"consumed"});
        assert_eq!(expected_charge_cents(&discounted).unwrap(), 9300);
        let mut discounted_charge = charge();
        discounted_charge["amount"] = json!(9300);
        discounted_charge["balance_transaction"]["amount"] = json!(9300);
        let applied = apply_fees(
            &discounted,
            &fee_snapshot(&discounted, &discounted_charge).unwrap(),
        )
        .unwrap();
        assert_eq!(applied["shipments"][0]["sellerGrossCents"], 7500);
        assert_eq!(applied["shipments"][1]["sellerGrossCents"], 2500);
    }
}
