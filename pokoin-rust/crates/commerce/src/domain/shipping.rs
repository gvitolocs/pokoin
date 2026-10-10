//! Shipping rates, package tiers and checkout quoting, ported from
//! `_checkout_core.js` and the seed half of `marketplace-shipping-options.js`.
//!
//! The rate catalog is `assets/shipping-rates.json`, written by
//! `scripts/sync-shipping-rates.py` with the SPA copy, so quoting fails closed
//! on exactly the routes the retired Node quote service did.

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{json, Value};

use super::country::{assert_ship_from_country, normalize_country};
use super::money::{items_subtotal_cents, QuoteItem};
use crate::error::{ApiError, ApiResult};

pub const DEFAULT_RATES_JSON: &str = include_str!("../../assets/shipping-rates.json");

/// Untracked letters stop at €20.
pub const UNTRACKED_MAX_EUR_CENTS: i64 = 2000;
/// Insurance is 5% of the card subtotal.
pub const INSURANCE_RATE: f64 = 0.05;

#[derive(Debug, Clone, Deserialize)]
pub struct PackageTier {
    pub id: String,
    #[serde(rename = "maxCards")]
    pub max_cards: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ShippingRate {
    pub id: String,
    #[serde(rename = "fromCountry")]
    pub from_country: String,
    #[serde(rename = "toCountry")]
    pub to_country: String,
    #[serde(rename = "packageTier")]
    pub package_tier: String,
    #[serde(rename = "maxCards", default)]
    pub max_cards: i64,
    #[serde(rename = "priceEURCents", default)]
    pub price_eur_cents: f64,
    #[serde(default)]
    pub carrier: String,
    #[serde(rename = "serviceName", default)]
    pub service_name: String,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub tracked: Option<bool>,
    #[serde(rename = "rateSource", default)]
    pub rate_source: String,
}

impl ShippingRate {
    pub fn is_active(&self) -> bool {
        self.active != Some(false)
    }
    pub fn is_tracked(&self) -> bool {
        self.tracked != Some(false)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateCatalog {
    #[serde(default)]
    pub tiers: Vec<PackageTier>,
    #[serde(default)]
    pub rates: Vec<ShippingRate>,
}

impl RateCatalog {
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn default_catalog() -> &'static RateCatalog {
        static CATALOG: OnceLock<RateCatalog> = OnceLock::new();
        CATALOG.get_or_init(|| {
            RateCatalog::from_json(DEFAULT_RATES_JSON)
                .expect("vendored shipping-rates.json must parse")
        })
    }
}

fn http_error(status: u16, message: impl Into<String>, code: &str) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::BAD_REQUEST),
        message,
    )
    .with_code(code)
}

/// `cardCount`: sum of positive integer quantities.
pub fn card_count(items: &[Value]) -> i64 {
    items
        .iter()
        .map(|row| {
            let qty: f64 = [row.get("quantity"), row.get("qty")]
                .into_iter()
                .flatten()
                .find_map(|value| crate::domain::js_number(Some(value)))
                .unwrap_or(0.0);
            if qty.is_finite() && qty > 0.0 {
                qty.trunc() as i64
            } else {
                0
            }
        })
        .sum()
}

/// `packageTierForCount`. Tiers are sorted by `maxCards` before matching.
pub fn package_tier_for_count(count: i64, catalog: &RateCatalog) -> ApiResult<String> {
    let n = count.max(0);
    if n < 1 {
        return Err(http_error(
            400,
            "Shipment needs at least one card.",
            "empty_shipment",
        ));
    }
    let mut tiers: Vec<&PackageTier> = catalog.tiers.iter().collect();
    tiers.sort_by_key(|tier| tier.max_cards);
    tiers
        .iter()
        .find(|tier| n <= tier.max_cards)
        .map(|tier| tier.id.clone())
        .ok_or_else(|| {
            http_error(
                400,
                "No package tier covers this card count.",
                "package_tier_missing",
            )
        })
}

pub fn package_tier_for_count_default(count: i64) -> ApiResult<String> {
    package_tier_for_count(count, RateCatalog::default_catalog())
}

#[derive(Debug, Clone)]
pub struct SellerGroup {
    pub seller_id: String,
    pub seller_name: String,
    pub items: Vec<Value>,
    pub card_count: i64,
}

/// `groupCartBySeller` — every row needs a sellerUid.
pub fn group_cart_by_seller(items: &[Value]) -> ApiResult<Vec<SellerGroup>> {
    let mut groups: Vec<SellerGroup> = Vec::new();
    for row in items {
        let seller_id = ["sellerUid", "sellerId", "seller_uid"]
            .iter()
            .find_map(|key| row.get(*key).and_then(Value::as_str))
            .unwrap_or_default()
            .trim()
            .to_string();
        if seller_id.is_empty() {
            return Err(http_error(400, "Every cart row needs a sellerUid.", "missing_seller"));
        }
        match groups.iter_mut().find(|group| group.seller_id == seller_id) {
            Some(group) => group.items.push(row.clone()),
            None => {
                let seller_name = ["sellerName", "seller"]
                    .iter()
                    .find_map(|key| row.get(*key).and_then(Value::as_str))
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                groups.push(SellerGroup {
                    seller_id,
                    seller_name,
                    items: vec![row.clone()],
                    card_count: 0,
                });
            }
        }
    }
    for group in &mut groups {
        group.card_count = card_count(&group.items);
    }
    Ok(groups)
}

/// `findRate`: exact tracked match, else any tracked, else the first match.
pub fn find_rate<'a>(
    from_country: &str,
    to_country: &str,
    package_tier: &str,
    tracked: bool,
    catalog: &'a RateCatalog,
) -> ApiResult<&'a ShippingRate> {
    let from = assert_ship_from_country(from_country)?;
    let to = assert_ship_from_country(to_country)?;
    let tier = package_tier.trim().to_ascii_uppercase();
    let matches: Vec<&ShippingRate> = catalog
        .rates
        .iter()
        .filter(|rate| {
            rate.is_active()
                && rate.from_country.eq_ignore_ascii_case(&from)
                && rate.to_country.eq_ignore_ascii_case(&to)
                && rate.package_tier.eq_ignore_ascii_case(&tier)
        })
        .collect();
    let row = matches
        .iter()
        .find(|rate| rate.is_tracked() == tracked)
        .or_else(|| if tracked { matches.first() } else { None })
        .or_else(|| matches.first())
        .copied();
    row.ok_or_else(|| {
        http_error(
            409,
            "Shipping is not currently available for this route.",
            "shipping_rate_missing",
        )
        .with_meta(json!({
            "fromCountry": from,
            "toCountry": to,
            "packageTier": tier,
            "tracked": tracked,
        }))
    })
}

#[derive(Debug, Clone)]
pub struct ShipmentQuote {
    pub seller_id: String,
    pub seller_name: String,
    pub rate_id: String,
    pub from_country: String,
    pub to_country: String,
    pub card_count: i64,
    pub package_tier: String,
    pub tracked: bool,
    pub estimated_weight_grams: i64,
    pub carrier: String,
    pub service_name: String,
    pub amount_cents: i64,
    pub currency: String,
    pub items_subtotal_cents: i64,
    pub item_count: i64,
}

pub fn quote_shipment(
    _seller_id: &str,
    from_country: &str,
    to_country: &str,
    items: &[Value],
    tracked: bool,
    catalog: &RateCatalog,
) -> ApiResult<(ShippingRate, i64, String)> {
    let count = card_count(items);
    let tier = package_tier_for_count(count, catalog)?;
    let rate = find_rate(from_country, to_country, &tier, tracked, catalog)?.clone();
    Ok((rate, count, tier))
}

#[derive(Debug, Clone)]
pub struct CheckoutQuote {
    pub shipments: Vec<ShipmentQuote>,
    pub items_subtotal_cents: i64,
    pub shipping_total_cents: i64,
    pub grand_total_cents: i64,
    pub currency: String,
    pub tracked: bool,
    pub insurance_cents: i64,
}

fn json_items(items: &[Value]) -> Vec<QuoteItem> {
    items
        .iter()
        .map(|row| QuoteItem {
            seller_uid: row
                .get("sellerUid")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            quantity: crate::domain::js_number(row.get("quantity").or_else(|| row.get("qty")))
                .map(|qty| qty.trunc() as i64)
                .unwrap_or(0),
            unit_price_pkn: ["unitPricePkn", "pricePkn"]
                .iter()
                .find_map(|key| crate::domain::js_number(row.get(*key)))
                .unwrap_or(0.0),
            unit_price_eur_cents: ["unitPriceEURCents", "unitPriceEurCents"]
                .iter()
                .find_map(|key| row.get(*key).and_then(Value::as_i64)),
            total_price_eur_cents: ["totalPriceEURCents", "totalPriceEurCents"]
                .iter()
                .find_map(|key| row.get(*key).and_then(Value::as_i64)),
        })
        .collect()
}

/// `quoteCheckout`: server-resolved seller origins and seeded rate tables.
pub fn quote_checkout(
    items: &[Value],
    seller_origins: &std::collections::HashMap<String, String>,
    to_country: &str,
    tracked: bool,
    catalog: &RateCatalog,
) -> ApiResult<CheckoutQuote> {
    let groups = group_cart_by_seller(items)?;
    let mut shipments = Vec::new();
    for group in groups {
        let from_country = seller_origins
            .get(&group.seller_id)
            .cloned()
            .or_else(|| {
                group.items.first().and_then(|row| {
                    ["shipFromCountry", "sellerCountry"]
                        .iter()
                        .find_map(|key| row.get(*key).and_then(Value::as_str))
                        .map(|value| value.to_string())
                })
            })
            .unwrap_or_default();
        let (rate, count, tier) = quote_shipment(
            &group.seller_id,
            &from_country,
            to_country,
            &group.items,
            tracked,
            catalog,
        )?;
        shipments.push(ShipmentQuote {
            seller_id: group.seller_id.clone(),
            seller_name: group.seller_name.clone(),
            rate_id: rate.id.clone(),
            from_country: rate.from_country.to_ascii_uppercase(),
            to_country: rate.to_country.to_ascii_uppercase(),
            card_count: count,
            package_tier: tier,
            tracked: rate.is_tracked(),
            estimated_weight_grams: count * 2,
            carrier: rate.carrier.clone(),
            service_name: if rate.service_name.is_empty() {
                "Standard".to_string()
            } else {
                rate.service_name.clone()
            },
            amount_cents: if rate.price_eur_cents.is_finite() {
                rate.price_eur_cents as i64
            } else {
                0
            },
            currency: "EUR".to_string(),
            items_subtotal_cents: items_subtotal_cents(&json_items(&group.items)),
            item_count: group.card_count,
        });
    }
    let items_subtotal = shipments.iter().map(|row| row.items_subtotal_cents).sum();
    let shipping_total = shipments.iter().map(|row| row.amount_cents).sum();
    Ok(CheckoutQuote {
        shipments,
        items_subtotal_cents: items_subtotal,
        shipping_total_cents: shipping_total,
        grand_total_cents: items_subtotal + shipping_total,
        currency: "EUR".to_string(),
        tracked,
        insurance_cents: 0,
    })
}

/// `guardCheckoutQuote`: untracked letters are capped, insurance is 5%.
pub fn guard_checkout_quote(
    quote: CheckoutQuote,
    tracked: bool,
    insurance: bool,
) -> ApiResult<CheckoutQuote> {
    let over_limit = quote.items_subtotal_cents > UNTRACKED_MAX_EUR_CENTS;
    if !tracked && over_limit {
        return Err(http_error(
            400,
            "Untracked shipping is only available for orders up to €20.",
            "untracked_not_allowed",
        ));
    }
    if !insurance || !over_limit {
        return Ok(quote);
    }
    let insurance_cents = (quote.items_subtotal_cents as f64 * INSURANCE_RATE).round() as i64;
    Ok(CheckoutQuote {
        insurance_cents,
        grand_total_cents: quote.grand_total_cents + insurance_cents,
        ..quote
    })
}

/// One bookable letter option for a lane, matching `seedLetterOptions`.
pub fn seed_letter_options(
    from_country: &str,
    to_country: &str,
    card_count: i64,
    catalog: &RateCatalog,
) -> ApiResult<Vec<Value>> {
    let from = normalize_country(from_country);
    let to = normalize_country(to_country);
    let n = card_count.max(0);
    let tier = package_tier_for_count(n, catalog)?;
    if from.is_empty() || to.is_empty() || n < 1 {
        return Ok(Vec::new());
    }
    let matches: Vec<&ShippingRate> = catalog
        .rates
        .iter()
        .filter(|rate| {
            rate.is_active()
                && rate.from_country.eq_ignore_ascii_case(&from)
                && rate.to_country.eq_ignore_ascii_case(&to)
                && rate.package_tier.eq_ignore_ascii_case(&tier)
        })
        .collect();

    let mut options = Vec::new();
    for want_tracked in [false, true] {
        let row = matches
            .iter()
            .find(|rate| rate.is_tracked() == want_tracked)
            .or_else(|| {
                if want_tracked {
                    matches.iter().find(|rate| rate.is_tracked())
                } else {
                    None
                }
            });
        let Some(row) = row else { continue };
        let id = if row.is_tracked() { "tracked" } else { "untracked" };
        if options
            .iter()
            .any(|option: &Value| option.get("id").and_then(Value::as_str) == Some(id))
        {
            continue;
        }
        let service_name = if row.service_name.is_empty() {
            if row.is_tracked() {
                "Tracked letter".to_string()
            } else {
                "Untracked letter".to_string()
            }
        } else {
            row.service_name.clone()
        };
        options.push(json!({
            "id": id,
            "label": service_name,
            "serviceName": service_name,
            "carrier": row.carrier,
            "amountCents": if row.price_eur_cents.is_finite() { row.price_eur_cents as i64 } else { 0 },
            "currency": "EUR",
            "tracked": row.is_tracked(),
            "packageTier": tier,
            "source": if row.rate_source.is_empty() { "seed".to_string() } else { row.rate_source.clone() },
        }));
    }
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> RateCatalog {
        RateCatalog::from_json(
            r#"{
              "tiers": [
                {"id":"SMALL","maxCards":4},
                {"id":"MEDIUM","maxCards":20},
                {"id":"LARGE","maxCards":200},
                {"id":"EXTRA_LARGE","maxCards":9999}
              ],
              "rates": [
                {"id":"it-dk-small-untracked","fromCountry":"IT","toCountry":"DK","packageTier":"SMALL","maxCards":4,"priceEURCents":435,"carrier":"Poste Italiane","serviceName":"Untracked letter","active":true,"tracked":false,"rateSource":"seed"},
                {"id":"it-dk-small-tracked","fromCountry":"IT","toCountry":"DK","packageTier":"SMALL","maxCards":4,"priceEURCents":1684,"carrier":"Poste Italiane","serviceName":"Tracked letter","active":true,"tracked":true,"rateSource":"seed"},
                {"id":"it-dk-medium-untracked","fromCountry":"IT","toCountry":"DK","packageTier":"MEDIUM","maxCards":20,"priceEURCents":435,"carrier":"Poste Italiane","serviceName":"Untracked letter","active":true,"tracked":false,"rateSource":"seed"},
                {"id":"it-dk-medium-tracked","fromCountry":"IT","toCountry":"DK","packageTier":"MEDIUM","maxCards":20,"priceEURCents":1684,"carrier":"Poste Italiane","serviceName":"Tracked letter","active":true,"tracked":true,"rateSource":"seed"}
              ]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn tiers_match_the_js_ordering() {
        let catalog = catalog();
        assert_eq!(package_tier_for_count(1, &catalog).unwrap(), "SMALL");
        assert_eq!(package_tier_for_count(4, &catalog).unwrap(), "SMALL");
        assert_eq!(package_tier_for_count(5, &catalog).unwrap(), "MEDIUM");
        assert_eq!(package_tier_for_count(20, &catalog).unwrap(), "MEDIUM");
        assert_eq!(package_tier_for_count(21, &catalog).unwrap(), "LARGE");
        assert!(package_tier_for_count(0, &catalog).is_err());
    }

    #[test]
    fn tracked_selection_prefers_the_matching_flag() {
        let catalog = catalog();
        let tracked = find_rate("IT", "DK", "MEDIUM", true, &catalog).unwrap();
        assert_eq!(tracked.price_eur_cents as i64, 1684);
        let untracked = find_rate("IT", "DK", "MEDIUM", false, &catalog).unwrap();
        assert_eq!(untracked.price_eur_cents as i64, 435);
    }

    #[test]
    fn missing_routes_fail_closed_with_metadata() {
        let catalog = catalog();
        let error = find_rate("IT", "JP", "MEDIUM", true, &catalog).unwrap_err();
        assert_eq!(error.status.as_u16(), 409);
        assert_eq!(error.code.as_deref(), Some("shipping_rate_missing"));
        assert_eq!(error.meta.unwrap()["toCountry"], json!("JP"));
    }

    #[test]
    fn groups_require_a_seller() {
        assert!(group_cart_by_seller(&[json!({ "quantity": 1 })]).is_err());
        let groups = group_cart_by_seller(&[
            json!({ "sellerUid": "a", "quantity": 2, "unitPricePkn": 10, "sellerName": "A" }),
            json!({ "sellerUid": "b", "quantity": 1, "unitPricePkn": 5 }),
            json!({ "sellerUid": "a", "quantity": 1, "unitPricePkn": 10 }),
        ])
        .unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].card_count, 3);
        assert_eq!(groups[0].seller_name, "A");
    }

    #[test]
    fn checkout_quote_totals_match_the_reference_example() {
        let catalog = catalog();
        let mut origins = std::collections::HashMap::new();
        origins.insert("a".to_string(), "IT".to_string());
        let items = vec![json!({
            "sellerUid": "a", "quantity": 2, "unitPricePkn": 200,
        })];
        let quote = quote_checkout(&items, &origins, "DK", true, &catalog).unwrap();
        // 2 * 200 PKN = 400 PKN = 200 cents + 1684 tracked = 1884.
        assert_eq!(quote.items_subtotal_cents, 200);
        assert_eq!(quote.shipping_total_cents, 1684);
        assert_eq!(quote.grand_total_cents, 1884);
        assert_eq!(quote.shipments[0].estimated_weight_grams, 4);
    }

    #[test]
    fn untracked_is_capped_and_insurance_is_five_percent() {
        let catalog = catalog();
        let mut origins = std::collections::HashMap::new();
        origins.insert("a".to_string(), "IT".to_string());
        let items = vec![json!({
            "sellerUid": "a", "quantity": 1, "unitPriceEURCents": 2500,
        })];
        let quote = quote_checkout(&items, &origins, "DK", false, &catalog).unwrap();
        assert!(guard_checkout_quote(quote.clone(), false, false).is_err());

        let quote = quote_checkout(&items, &origins, "DK", true, &catalog).unwrap();
        let guarded = guard_checkout_quote(quote, true, true).unwrap();
        assert_eq!(guarded.insurance_cents, 125);
        assert_eq!(guarded.grand_total_cents, 2500 + 1684 + 125);
    }

    #[test]
    fn seed_options_include_tracked_and_untracked_letters() {
        let catalog = catalog();
        let options = seed_letter_options("IT", "DK", 3, &catalog).unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["id"], json!("untracked"));
        assert_eq!(options[0]["amountCents"], json!(435));
        assert_eq!(options[1]["id"], json!("tracked"));
        assert_eq!(options[1]["packageTier"], json!("SMALL"));
    }

    #[test]
    fn vendored_catalog_parses_and_covers_the_italy_denmark_lane() {
        let catalog = RateCatalog::default_catalog();
        assert!(catalog.tiers.len() >= 4);
        assert!(catalog.rates.len() > 100);
        // The documented default: IT -> DK untracked letter for <=20 cards.
        let rate = find_rate("IT", "DK", "MEDIUM", false, catalog).unwrap();
        assert!(rate.price_eur_cents > 0.0);
    }
}
