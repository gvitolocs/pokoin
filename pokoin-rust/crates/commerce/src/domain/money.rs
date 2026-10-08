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
}
