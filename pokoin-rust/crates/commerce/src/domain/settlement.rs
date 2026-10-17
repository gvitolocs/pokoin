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
    let expected = order["totalEURCents"].as_i64().unwrap_or(0)
        - order["pknDiscount"]["eurCents"].as_i64().unwrap_or(0);
    let intent = order["stripePaymentIntentId"].as_str().unwrap_or("");
    if !charge["id"].as_str().unwrap_or("").starts_with("ch_")
        || charge["paid"] != true
        || charge["currency"] != "eur"
        || charge["amount"].as_i64() != Some(expected)
        || expected <= 0
        || charge["payment_intent"].as_str() != Some(intent)
        || intent.is_empty()
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
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("Stripe fee currency is unavailable."))?;
    let id = balance["id"]
        .as_str()
        .filter(|s| s.starts_with("txn_"))
        .ok_or_else(|| invalid("Stripe balance transaction reference is unavailable."))?;
    // Stripe balance currency can differ from the EUR charge. Use that exact
    // transaction's ratio, preserving the original fee/amount/currency for audit.
    let eur_fee = if balance_currency == "eur" {
        if balance_amount != expected {
            return Err(invalid("Stripe balance amount mismatch."));
        }
        fee
    } else {
        ((fee as i128 * expected as i128 + balance_amount as i128 / 2) / balance_amount as i128)
            as i64
    };
    Ok(
        json!({ "status":"final", "currency":"EUR", "processingFeeCents":eur_fee,
            "stripeChargeId":charge["id"], "balanceTransactionId":id,
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
    let weights: Vec<(String, i64)> = shipments
        .iter()
        .map(|s| {
            (
                s["sellerId"].as_str().unwrap_or("").to_string(),
                s["itemsSubtotalCents"].as_i64().unwrap_or(0)
                    + s["shippingAmountEURCents"].as_i64().unwrap_or(0),
            )
        })
        .collect();
    let ids: std::collections::BTreeSet<_> = weights.iter().map(|(id, _)| id).collect();
    if weights.iter().any(|(id, _)| id.is_empty()) || ids.len() != weights.len() {
        return Err(invalid("Seller payment allocation is ambiguous."));
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
    }
    Ok(
        json!({ "shipments":shipments, "settlementFees":snapshot, "stripeChargeId":snapshot["stripeChargeId"] }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
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
        json!({"totalEURCents":10300,"stripePaymentIntentId":"pi_x","shipments":[
        {"sellerId":"a","itemsSubtotalCents":7500,"shippingAmountEURCents":0},
        {"sellerId":"b","itemsSubtotalCents":2500,"shippingAmountEURCents":0}]})
    }
    fn charge() -> Value {
        json!({"id":"ch_x","paid":true,"currency":"eur","amount":10300,"payment_intent":"pi_x",
        "balance_transaction":{"id":"txn_x","amount":10300,"currency":"eur","fee":185,"fee_details":[]}})
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
        c["balance_transaction"] =
            json!({"id":"txn_fx","amount":76838,"currency":"dkk","fee":1380});
        assert_eq!(
            fee_snapshot(&order(), &c).unwrap()["processingFeeCents"],
            185
        );
        c["balance_transaction"]["fee"] = json!(0);
        assert_eq!(fee_snapshot(&order(), &c).unwrap()["processingFeeCents"], 0);
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
}
