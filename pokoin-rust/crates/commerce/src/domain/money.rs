//! PKN ⇄ EUR money math, ported 1:1 from `_pkn_checkout_pricing.js` and the
//! money helpers in `_checkout_core.js` / `_stock_csv.js`.
//!
//! 1 PKN = €0.005, so one euro-cent is 2 PKN. Every function here is pure so
//! rounding behaviour can be asserted directly.

/// 1 EUR = 200 PKN (same ratio as the CardTrader inventory sync tests).
pub const EUR_TO_PKN: f64 = 200.0;
/// One euro-cent is 2 PKN at the reference price.
pub const PKN_PER_EUR_CENT: i64 = 2;
/// `PKN_USDT_REFERENCE_PRICE` used by every payment helper.
pub const PKN_USD_REFERENCE_PRICE: f64 = 0.005;

/// `pknCheckoutReferencePrice()`. A non-positive or NaN configuration is an
/// error, exactly like the Node helper.
pub fn pkn_checkout_reference_price(configured: Option<f64>) -> Result<f64, String> {
    let value = configured.unwrap_or(PKN_USD_REFERENCE_PRICE);
    if !value.is_finite() || value <= 0.0 {
        return Err("PKN checkout price is not configured.".into());
    }
    Ok(value)
}

/// `pknAmountForFiatCents`: whole PKN for a fiat charge.
pub fn pkn_amount_for_fiat_cents(fiat_cents: i64, reference_price: f64) -> i64 {
    let fiat_amount = fiat_cents as f64 / 100.0;
    (fiat_amount / reference_price).round() as i64
}

/// `eurCentsFromPkn`. Non-positive input is zero, matching the Node guard.
pub fn eur_cents_from_pkn(pkn: f64) -> i64 {
    if !pkn.is_finite() || pkn <= 0.0 {
        return 0;
    }
    (pkn * 0.005 * 100.0).round() as i64
}

/// One cart line in the checkout-quote sense.
#[derive(Debug, Clone, Default)]
pub struct QuoteItem {
    pub seller_uid: String,
    pub quantity: i64,
    pub unit_price_pkn: f64,
    pub unit_price_eur_cents: Option<i64>,
    pub total_price_eur_cents: Option<i64>,
}

/// `itemsSubtotalCents`: prefers an explicit EUR price, else converts PKN.
pub fn items_subtotal_cents(items: &[QuoteItem]) -> i64 {
    items
        .iter()
        .map(|row| {
            let quantity = row.quantity.max(0);
            if row.unit_price_eur_cents.is_some() || row.total_price_eur_cents.is_some() {
                let line = row
                    .total_price_eur_cents
                    .map(|total| total as f64)
                    .unwrap_or_else(|| row.unit_price_eur_cents.unwrap_or(0) as f64 * quantity as f64);
                if line.is_finite() {
                    return line.round() as i64;
                }
                return 0;
            }
            eur_cents_from_pkn(row.unit_price_pkn * quantity as f64)
        })
        .sum()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PknBalanceDiscount {
    pub discount_pkn: i64,
    pub discount_eur_cents: i64,
    pub eligible_pkn: i64,
}

/// PowerTools-style "pay with your balance as a discount" for an EUR (Stripe)
/// checkout. Lines from PKN-refusing sellers are card-only. The card charge
/// never drops below 50 cents (Stripe minimum).
pub fn pkn_balance_discount(
    available_pkn: i64,
    items: &[QuoteItem],
    refused_seller_uids: &[String],
    grand_total_cents: i64,
) -> PknBalanceDiscount {
    let balance = available_pkn.max(0);
    let mut eligible_pkn = 0i64;
    for row in items {
        let seller = row.seller_uid.trim();
        if !seller.is_empty() && refused_seller_uids.iter().any(|uid| uid == seller) {
            continue;
        }
        let quantity = row.quantity.max(1);
        eligible_pkn += quantity * row.unit_price_pkn.max(0.0) as i64;
    }
    let mut discount_pkn = balance.min(eligible_pkn);
    if discount_pkn < 1 {
        return PknBalanceDiscount {
            discount_pkn: 0,
            discount_eur_cents: 0,
            eligible_pkn,
        };
    }
    let mut discount_eur_cents = discount_pkn / PKN_PER_EUR_CENT;
    let card_floor = (grand_total_cents - 50).max(0);
    if discount_eur_cents > card_floor {
        discount_eur_cents = card_floor;
    }
    discount_pkn = discount_eur_cents * PKN_PER_EUR_CENT;
    if discount_pkn < 1 || discount_eur_cents < 1 {
        return PknBalanceDiscount {
            discount_pkn: 0,
            discount_eur_cents: 0,
            eligible_pkn,
        };
    }
    PknBalanceDiscount {
        discount_pkn,
        discount_eur_cents,
        eligible_pkn,
    }
}

/// The buyer opted into the balance discount: `usePknDiscount: true`, or the
/// legacy numeric `pknDiscount` > 0. A client amount is never used; the server
/// prices the discount from the buyer's own balance.
pub fn wants_pkn_discount(body: &serde_json::Value) -> bool {
    if body.get("usePknDiscount").and_then(serde_json::Value::as_bool) == Some(true) {
        return true;
    }
    body.get("pknDiscount")
        .and_then(serde_json::Value::as_f64)
        .map(|value| value.is_finite() && value > 0.0)
        .unwrap_or(false)
}

/// Sellers whose profile says `acceptsPkn: false` (missing means they accept).
pub fn pkn_refused_sellers<'a>(
    sellers: impl IntoIterator<Item = (&'a str, &'a serde_json::Value)>,
) -> Vec<String> {
    let mut refused: Vec<String> = Vec::new();
    for (uid, user) in sellers {
        let uid = uid.trim();
        let accepts = user
            .get("acceptsPkn")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        if !accepts && !uid.is_empty() && !refused.iter().any(|seen| seen == uid) {
            refused.push(uid.to_string());
        }
    }
    refused
}

/// What the buyer could take off the card charge (`voucher`) and what is
/// taken (`applied`: the voucher when they opted in, else nothing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckoutPknDiscount {
    pub voucher: PknBalanceDiscount,
    pub applied: PknBalanceDiscount,
    pub available_pkn: i64,
    pub opted_in: bool,
}

impl CheckoutPknDiscount {
    /// The card charge after the discount.
    pub fn charge_cents(&self, grand_total_cents: i64) -> i64 {
        grand_total_cents - self.applied.discount_eur_cents
    }

    /// The quote/session JSON: `pknVoucher`, `pknDiscount`.
    pub fn voucher_json(&self) -> serde_json::Value {
        serde_json::json!({
            "pkn": self.voucher.discount_pkn,
            "eurCents": self.voucher.discount_eur_cents,
            "eligiblePkn": self.voucher.eligible_pkn,
            "availablePkn": self.available_pkn,
        })
    }

    pub fn applied_json(&self) -> serde_json::Value {
        serde_json::json!({
            "pkn": self.applied.discount_pkn,
            "eurCents": self.applied.discount_eur_cents,
            "applied": self.applied.discount_pkn > 0,
        })
    }
}

/// One rule for the quote and the Stripe session.
pub fn checkout_pkn_discount(
    available_pkn: i64,
    items: &[QuoteItem],
    refused_seller_uids: &[String],
    grand_total_cents: i64,
    opted_in: bool,
) -> CheckoutPknDiscount {
    let voucher =
        pkn_balance_discount(available_pkn, items, refused_seller_uids, grand_total_cents);
    let applied = if opted_in {
        voucher
    } else {
        PknBalanceDiscount {
            discount_pkn: 0,
            discount_eur_cents: 0,
            eligible_pkn: voucher.eligible_pkn,
        }
    };
    CheckoutPknDiscount {
        voucher,
        applied,
        available_pkn: available_pkn.max(0),
        opted_in,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_packages_match_the_stripe_lookup_keys() {
        let price = pkn_checkout_reference_price(None).unwrap();
        assert_eq!(pkn_amount_for_fiat_cents(500, price), 1000);
        assert_eq!(pkn_amount_for_fiat_cents(2500, price), 5000);
        assert_eq!(pkn_amount_for_fiat_cents(10000, price), 20000);
    }

    #[test]
    fn checkout_price_configuration_fails_closed() {
        assert!(pkn_checkout_reference_price(Some(0.0)).is_err());
        assert!(pkn_checkout_reference_price(Some(f64::NAN)).is_err());
        assert_eq!(
            pkn_checkout_reference_price(Some(0.01)).unwrap(),
            0.01
        );
    }

    #[test]
    fn eur_cents_from_pkn_uses_two_pkn_per_cent() {
        assert_eq!(eur_cents_from_pkn(2.0), 1);
        assert_eq!(eur_cents_from_pkn(200.0), 100);
        assert_eq!(eur_cents_from_pkn(0.0), 0);
        assert_eq!(eur_cents_from_pkn(-5.0), 0);
    }

    #[test]
    fn subtotal_prefers_eur_prices() {
        let items = vec![
            QuoteItem {
                quantity: 2,
                unit_price_pkn: 200.0,
                ..Default::default()
            },
            QuoteItem {
                quantity: 3,
                unit_price_eur_cents: Some(150),
                ..Default::default()
            },
        ];
        // 2 * 200 PKN = 400 PKN = 200 cents; 3 * 150 = 450 cents.
        assert_eq!(items_subtotal_cents(&items), 650);
    }

    #[test]
    fn balance_discount_skips_pkn_refusing_sellers_and_keeps_stripe_minimum() {
        let items = vec![
            QuoteItem {
                seller_uid: "a".into(),
                quantity: 1,
                unit_price_pkn: 400.0,
                ..Default::default()
            },
            QuoteItem {
                seller_uid: "b".into(),
                quantity: 1,
                unit_price_pkn: 1000.0,
                ..Default::default()
            },
        ];
        let refused = vec!["b".to_string()];
        let discount = pkn_balance_discount(1000, &items, &refused, 500);
        // Only seller a is eligible: 400 PKN → 200 cents, but the card floor is 450.
        assert_eq!(discount.eligible_pkn, 400);
        assert_eq!(discount.discount_eur_cents, 200);
        assert_eq!(discount.discount_pkn, 400);
    }

    #[test]
    fn balance_discount_never_charges_less_than_fifty_cents() {
        let items = vec![QuoteItem {
            seller_uid: "a".into(),
            quantity: 1,
            unit_price_pkn: 400.0,
            ..Default::default()
        }];
        let discount = pkn_balance_discount(400, &items, &[], 120);
        assert_eq!(discount.discount_eur_cents, 70);
        assert_eq!(discount.discount_pkn, 140);
    }

    #[test]
    fn balance_discount_rounds_down_to_even_pkn() {
        let items = vec![QuoteItem {
            seller_uid: "a".into(),
            quantity: 1,
            unit_price_pkn: 401.0,
            ..Default::default()
        }];
        let discount = pkn_balance_discount(401, &items, &[], 10_000);
        // 200 cents of the 201 available; the odd PKN stays on the balance.
        assert_eq!(discount.discount_eur_cents, 200);
        assert_eq!(discount.discount_pkn, 400);
        assert_eq!(discount.eligible_pkn, 401);
    }

    #[test]
    fn the_discount_opt_in_is_a_flag_never_an_amount() {
        use serde_json::json;
        assert!(wants_pkn_discount(&json!({ "usePknDiscount": true })));
        assert!(!wants_pkn_discount(&json!({ "usePknDiscount": false })));
        assert!(!wants_pkn_discount(&json!({})));
        assert!(!wants_pkn_discount(&json!({ "usePknDiscount": "true" })));
        // The legacy numeric field is an opt-in; its amount is ignored.
        assert!(wants_pkn_discount(&json!({ "pknDiscount": 500 })));
        assert!(!wants_pkn_discount(&json!({ "pknDiscount": 0 })));
        assert!(!wants_pkn_discount(&json!({ "pknDiscount": "500" })));
    }

    #[test]
    fn refused_sellers_are_the_ones_that_said_no() {
        use serde_json::json;
        let red = json!({ "acceptsPkn": false });
        let givi = json!({ "acceptsPkn": true });
        let blank = json!({});
        let refused = pkn_refused_sellers([
            ("red", &red),
            ("givi", &givi),
            ("new", &blank),
            ("red", &red),
        ]);
        assert_eq!(refused, vec!["red".to_string()]);
    }

    #[test]
    fn the_checkout_discount_skips_refused_sellers_and_keeps_the_card_floor() {
        let items = vec![
            QuoteItem {
                seller_uid: "red".into(),
                quantity: 1,
                unit_price_pkn: 200.0,
                ..Default::default()
            },
            QuoteItem {
                seller_uid: "givi".into(),
                quantity: 2,
                unit_price_pkn: 400.0,
                ..Default::default()
            },
        ];
        let refused = vec!["red".to_string()];
        // givi's 800 PKN are eligible: 400 cents off a 1830-cent order.
        let off = checkout_pkn_discount(10_000, &items, &refused, 1830, false);
        assert_eq!(off.voucher.discount_eur_cents, 400);
        assert_eq!(off.voucher.eligible_pkn, 800);
        assert_eq!(off.applied.discount_pkn, 0);
        assert_eq!(off.charge_cents(1830), 1830);
        let on = checkout_pkn_discount(10_000, &items, &refused, 1830, true);
        assert_eq!(on.applied, on.voucher);
        assert_eq!(on.applied.discount_pkn, 800);
        assert_eq!(on.charge_cents(1830), 1430);
        assert_eq!(on.applied_json()["applied"], serde_json::json!(true));
        // A small order keeps a 50-cent card charge.
        let floor = checkout_pkn_discount(10_000, &items, &[], 300, true);
        assert_eq!(floor.charge_cents(300), 50);
        assert_eq!(floor.applied.discount_pkn, 500);
        // An empty balance offers nothing.
        let broke = checkout_pkn_discount(0, &items, &[], 1830, true);
        assert_eq!(broke.voucher.discount_pkn, 0);
        assert_eq!(broke.charge_cents(1830), 1830);
    }
}
