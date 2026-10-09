//! wPKN ⇄ PKN exchange quote math, ported from `_wpkn_exchange.js` and
//! `_wpkn_pkn_market_quote.js`.
//!
//! Inventory and size impact are the risk controls: both are BPS surcharges on
//! top of the spread, and every output is rounded down so the house never pays
//! more than quoted.

use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

pub const WPKN_DECIMALS: i64 = 18;
pub const DEFAULT_QUOTE_TTL_MS: i64 = 60 * 1000;
pub const DEFAULT_PKN_USD_PRICE: f64 = 0.005;
pub const DEFAULT_SPREAD_BPS: i64 = 100;
pub const DEFAULT_IMPACT_BPS: i64 = 75;
pub const DEFAULT_MAX_ORDER_PKN: i64 = 100_000;
pub const DEFAULT_MIN_ORDER_PKN: i64 = 1000;
pub const DEFAULT_AVAILABLE_LIQUIDITY_PKN: f64 = 2_000_000.0;
pub const DEFAULT_WPKN_RESERVE_PKN: f64 = 2_000_000.0;
pub const DEFAULT_PKN_LOCKED_TARGET: f64 = 2_000_000.0;
pub const MAX_INVENTORY_BPS: i64 = 300;
pub const MAX_SIZE_IMPACT_BPS: i64 = 500;
pub const BPS_DENOMINATOR: f64 = 10_000.0;
pub const DEFAULT_WPKN_BSC: &str = "0x91A17E2bddfF839078BD395482B38e4AC15276f4";
pub const GECKO_API_BASE: &str = "https://api.geckoterminal.com/api/v2";
pub const DEFAULT_GECKO_NETWORK: &str = "bsc";
pub const MARKET_QUOTE_MIN_AMOUNT: i64 = 1;
pub const MARKET_QUOTE_MAX_AMOUNT: i64 = 100_000_000;
pub const DEFAULT_MARKET_QUOTE_TTL_MS: i64 = 30 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    PknToWpkn,
    WpknToPkn,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PknToWpkn => "pkn_to_wpkn",
            Self::WpknToPkn => "wpkn_to_pkn",
        }
    }
    pub fn from_asset(self) -> &'static str {
        match self {
            Self::PknToWpkn => "PKN",
            Self::WpknToPkn => "wPKN",
        }
    }
    pub fn to_asset(self) -> &'static str {
        match self {
            Self::PknToWpkn => "wPKN",
            Self::WpknToPkn => "PKN",
        }
    }
}

pub fn normalize_direction(direction: &str) -> ApiResult<Direction> {
    match direction.trim().to_ascii_lowercase().as_str() {
        "pkn_to_wpkn" => Ok(Direction::PknToWpkn),
        "wpkn_to_pkn" => Ok(Direction::WpknToPkn),
        _ => Err(ApiError::bad_request("Choose PKN -> wPKN or wPKN -> PKN.")),
    }
}

/// `normalizeAmount` for the exchange: whole units inside [min, max].
pub fn normalize_amount(value: f64, min: i64, max: i64) -> ApiResult<i64> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(ApiError::bad_request("Enter a whole PKN/wPKN amount."));
    }
    let amount = value as i64;
    if amount < min {
        return Err(ApiError::bad_request(format!(
            "Amount too low, the minimum is {min}"
        )));
    }
    if amount > max {
        return Err(ApiError::bad_request(format!("Enter an amount up to {max}.")));
    }
    Ok(amount)
}

/// `normalizeAmount` for the public market quote: whole units inside [min, max].
pub fn normalize_market_amount(value: f64, min: i64, max: i64) -> ApiResult<i64> {
    if !value.is_finite() || value.fract() != 0.0 || value <= 0.0 {
        return Err(ApiError::bad_request(
            "Enter a whole PKN/wPKN amount.",
        ));
    }
    let amount = value as i64;
    if amount < min {
        return Err(ApiError::bad_request(format!(
            "Amount too low, the minimum is {min}"
        )));
    }
    if amount > max {
        return Err(ApiError::bad_request(format!("Enter an amount up to {max}.")));
    }
    Ok(amount)
}

pub fn round_positive(value: f64) -> i64 {
    if !value.is_finite() || value < 0.0 {
        0
    } else {
        value.floor() as i64
    }
}

pub fn round_market_output(value: f64) -> i64 {
    if !value.is_finite() || value < 0.0 {
        0
    } else {
        (value).round() as i64
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Reserves {
    pub available_liquidity_pkn: Option<f64>,
    pub settlement_wpkn_pkn: Option<f64>,
    pub locked_pkn: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ExchangeParams {
    pub spread_bps: i64,
    pub impact_coefficient_bps: i64,
    pub available_liquidity_pkn: f64,
    pub wpkn_reserve_pkn: f64,
    pub pkn_locked_target: f64,
    pub default_market_price: f64,
    pub quote_ttl_ms: i64,
    pub settlement_mode: String,
}

impl Default for ExchangeParams {
    fn default() -> Self {
        Self {
            spread_bps: DEFAULT_SPREAD_BPS,
            impact_coefficient_bps: DEFAULT_IMPACT_BPS,
            available_liquidity_pkn: DEFAULT_AVAILABLE_LIQUIDITY_PKN,
            wpkn_reserve_pkn: DEFAULT_WPKN_RESERVE_PKN,
            pkn_locked_target: DEFAULT_PKN_LOCKED_TARGET,
            default_market_price: 1.0,
            quote_ttl_ms: DEFAULT_QUOTE_TTL_MS,
            settlement_mode: "manual_pending".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExchangeQuote {
    pub direction: Direction,
    pub amount_in: i64,
    pub amount_out: i64,
    pub fee_amount: i64,
    pub market_price: f64,
    pub spread_bps: i64,
    pub inventory_bps: i64,
    pub size_impact_bps: i64,
    pub total_cost_bps: i64,
    pub quote_expires_at: String,
    pub settlement_mode: String,
}

fn iso(now_ms: i64, ttl_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms + ttl_ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn positive_or(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(value) if value.is_finite() && value != 0.0 => value,
        _ => fallback,
    }
}

/// `calculateQuote` — the authenticated exchange quote.
pub fn calculate_quote(
    direction: Direction,
    amount_in: f64,
    reserves: Reserves,
    market_price: Option<f64>,
    params: &ExchangeParams,
    now_ms: i64,
) -> ApiResult<ExchangeQuote> {
    let amount = normalize_amount(amount_in, DEFAULT_MIN_ORDER_PKN, DEFAULT_MAX_ORDER_PKN)?;
    let available_liquidity = positive_or(
        reserves.available_liquidity_pkn,
        params.available_liquidity_pkn,
    )
    .max(1.0);
    let settlement_wpkn_pkn =
        positive_or(reserves.settlement_wpkn_pkn, params.wpkn_reserve_pkn).max(0.0);
    let locked_pkn = reserves.locked_pkn.unwrap_or(0.0).max(0.0);
    let pkn_target = params.pkn_locked_target.max(1.0);

    let reference_price = market_price
        .filter(|price| price.is_finite() && *price != 0.0)
        .unwrap_or(params.default_market_price);

    let wpkn_reserve_ratio = settlement_wpkn_pkn / DEFAULT_WPKN_RESERVE_PKN;
    let locked_ratio = locked_pkn / pkn_target;
    let inventory_bps = match direction {
        Direction::PknToWpkn => round_positive((1.0 - wpkn_reserve_ratio) * MAX_INVENTORY_BPS as f64),
        Direction::WpknToPkn => round_positive(locked_ratio * MAX_INVENTORY_BPS as f64),
    };
    let size_impact_bps = round_positive(
        (amount as f64 / available_liquidity) * params.impact_coefficient_bps as f64,
    )
    .min(MAX_SIZE_IMPACT_BPS);
    let total_cost_bps = (params.spread_bps + inventory_bps + size_impact_bps).max(0);
    let gross_out = match direction {
        Direction::PknToWpkn => amount as f64 / reference_price,
        Direction::WpknToPkn => amount as f64 * reference_price,
    };
    let amount_out = round_positive(
        gross_out * (BPS_DENOMINATOR - total_cost_bps as f64) / BPS_DENOMINATOR,
    );
    let fee_amount = (round_positive(gross_out) - amount_out).max(0);

    Ok(ExchangeQuote {
        direction,
        amount_in: amount,
        amount_out,
        fee_amount,
        market_price: reference_price,
        spread_bps: params.spread_bps,
        inventory_bps,
        size_impact_bps,
        total_cost_bps,
        quote_expires_at: iso(now_ms, params.quote_ttl_ms),
        settlement_mode: params.settlement_mode.clone(),
    })
}

/// Response body of `publicQuote`.
pub fn public_quote(quote_id: &str, quote: &ExchangeQuote) -> Value {
    json!({
        "quoteId": quote_id,
        "direction": quote.direction.as_str(),
        "fromAsset": quote.direction.from_asset(),
        "toAsset": quote.direction.to_asset(),
        "amountIn": quote.amount_in,
        "amountOut": quote.amount_out,
        "feeAmount": quote.fee_amount,
        "marketPrice": quote.market_price,
        "spreadBps": quote.spread_bps,
        "inventoryBps": quote.inventory_bps,
        "sizeImpactBps": quote.size_impact_bps,
        "totalCostBps": quote.total_cost_bps,
        "quoteExpiresAt": quote.quote_expires_at,
        "settlementMode": quote.settlement_mode,
    })
}

/// Orient a Pancake pair's reserves around wPKN (`token0()` is the pair's own
/// ordering, so wPKN can be either slot).
pub fn orient_pair_reserves(token0_is_wpkn: bool, reserve0: f64, reserve1: f64) -> (f64, f64) {
    if token0_is_wpkn {
        (reserve0, reserve1)
    } else {
        (reserve1, reserve0)
    }
}

/// `pancakeSpotPrice`: wPKN priced in PKN from the live pool reserves.
pub fn spot_price_from_reserves(
    reserve_wpkn: f64,
    reserve_bnb: f64,
    bnb_usd: f64,
    pkn_usd: f64,
) -> Option<f64> {
    if !reserve_wpkn.is_finite() || reserve_wpkn <= 0.0 {
        return None;
    }
    if !reserve_bnb.is_finite() || reserve_bnb <= 0.0 {
        return None;
    }
    if !bnb_usd.is_finite() || bnb_usd <= 0.0 || !pkn_usd.is_finite() || pkn_usd <= 0.0 {
        return None;
    }
    Some(((reserve_bnb / reserve_wpkn) * (bnb_usd / pkn_usd)).max(0.000001))
}

pub fn reference_price_from_usd(wpkn_usd: f64, pkn_usd: f64) -> f64 {
    (wpkn_usd / pkn_usd).max(0.000001)
}

#[derive(Debug, Clone)]
pub struct MarketQuote {
    pub direction: Direction,
    pub amount_in: i64,
    pub amount_out: i64,
    pub fee_amount: i64,
    pub fee_bps: i64,
    pub market_price: f64,
    pub wpkn_usd: f64,
    pub pkn_usd: f64,
    pub reserve_in: String,
    pub reserve_out: String,
    pub quote_expires_at: String,
}

/// `calculateWpknPknMarketQuote` — the public `/api/wpkn-pkn-quote` body.
#[allow(clippy::too_many_arguments)]
pub fn calculate_wpkn_pkn_market_quote(
    direction: Direction,
    amount_in: f64,
    wpkn_usd: f64,
    pkn_usd: f64,
    spread_bps: i64,
    min_amount: i64,
    max_amount: i64,
    ttl_ms: i64,
    now_ms: i64,
) -> ApiResult<MarketQuote> {
    let amount = normalize_market_amount(amount_in, min_amount, max_amount)?;
    let resolved_wpkn_usd = if wpkn_usd > 0.0 { wpkn_usd } else { 0.0 };
    let resolved_pkn_usd = if pkn_usd > 0.0 { pkn_usd } else { DEFAULT_PKN_USD_PRICE };
    let market_price = reference_price_from_usd(resolved_wpkn_usd, resolved_pkn_usd);
    let gross_out = match direction {
        Direction::PknToWpkn => amount as f64 / market_price,
        Direction::WpknToPkn => amount as f64 * market_price,
    };
    let net_out = gross_out * (BPS_DENOMINATOR - spread_bps as f64) / BPS_DENOMINATOR;
    let amount_out = round_market_output(net_out);
    let fee_amount = (round_market_output(gross_out) - amount_out).max(0);

    Ok(MarketQuote {
        direction,
        amount_in: amount,
        amount_out,
        fee_amount,
        fee_bps: spread_bps,
        market_price,
        wpkn_usd: resolved_wpkn_usd,
        pkn_usd: resolved_pkn_usd,
        reserve_in: format!("${:.6} wPKN", resolved_wpkn_usd),
        reserve_out: format!("${:.6} PKN", resolved_pkn_usd),
        quote_expires_at: iso(now_ms, ttl_ms),
    })
}

impl MarketQuote {
    /// The handler spreads the quote and then adds the source/timestamp fields.
    pub fn to_json(&self, quoted_at: &str) -> Value {
        json!({
            "direction": self.direction.as_str(),
            "fromAsset": self.direction.from_asset(),
            "toAsset": self.direction.to_asset(),
            "amountIn": self.amount_in,
            "amountOut": self.amount_out,
            "feeAmount": self.fee_amount,
            "feeBps": self.fee_bps,
            "marketPrice": self.market_price,
            "wpknUsd": self.wpkn_usd,
            "pknUsd": self.pkn_usd,
            "priceSource": "geckoterminal",
            "poolId": "WPKN-PKN-market",
            "reserveIn": self.reserve_in,
            "reserveOut": self.reserve_out,
            "quoteExpiresAt": self.quote_expires_at,
            "source": "wpkn_market",
            "assetIn": self.direction.from_asset(),
            "assetOut": self.direction.to_asset(),
            "quotedAt": quoted_at,
            "priceFetchedAt": quoted_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pancake_reserves_orient_around_wpkn() {
        assert_eq!(orient_pair_reserves(true, 10.0, 2.0), (10.0, 2.0));
        assert_eq!(orient_pair_reserves(false, 10.0, 2.0), (2.0, 10.0));
    }

    #[test]
    fn spot_price_from_reserves_matches_the_node_formula() {
        let price = spot_price_from_reserves(10.0, 2.0, 600.0, 1.0).unwrap();
        assert!((price - 120.0).abs() < 1e-9);
        let tiny = spot_price_from_reserves(1_000_000.0, 0.0000001, 0.0000001, 1.0).unwrap();
        assert!(tiny >= 0.000001);
        assert!(spot_price_from_reserves(0.0, 2.0, 600.0, 1.0).is_none());
        assert!(spot_price_from_reserves(10.0, 0.0, 600.0, 1.0).is_none());
        assert!(spot_price_from_reserves(10.0, 2.0, 0.0, 1.0).is_none());
        assert!(spot_price_from_reserves(10.0, 2.0, 600.0, 0.0).is_none());
        assert!(spot_price_from_reserves(f64::NAN, 2.0, 600.0, 1.0).is_none());
    }

    #[test]
    fn direction_parsing_matches_node() {
        assert_eq!(normalize_direction("PKN_TO_WPKN").unwrap(), Direction::PknToWpkn);
        assert_eq!(normalize_direction(" wpkn_to_pkn ").unwrap(), Direction::WpknToPkn);
        let error = normalize_direction("sideways").unwrap_err();
        assert_eq!(error.status.as_u16(), 400);
    }

    #[test]
    fn amount_bounds_are_enforced() {
        assert_eq!(normalize_amount(1000.0, 1000, 100000).unwrap(), 1000);
        assert_eq!(normalize_amount(100000.0, 1000, 100000).unwrap(), 100000);
        assert!(normalize_amount(999.0, 1000, 100000).is_err());
        assert!(normalize_amount(100001.0, 1000, 100000).is_err());
        assert!(normalize_amount(1000.5, 1000, 100000).is_err());
    }

    #[test]
    fn quote_applies_spread_plus_size_impact() {
        let params = ExchangeParams::default();
        let quote = calculate_quote(
            Direction::PknToWpkn,
            1000.0,
            Reserves {
                available_liquidity_pkn: Some(2_000_000.0),
                settlement_wpkn_pkn: Some(DEFAULT_WPKN_RESERVE_PKN),
                locked_pkn: Some(0.0),
            },
            Some(1.0),
            &params,
            0,
        )
        .unwrap();
        // 1000/1 = 1000 gross; impact = 1000/2e6*75 = 0.0375 → 0 bps.
        assert_eq!(quote.size_impact_bps, 0);
        assert_eq!(quote.inventory_bps, 0);
        assert_eq!(quote.total_cost_bps, 100);
        assert_eq!(quote.amount_out, 990);
        assert_eq!(quote.fee_amount, 10);
    }

    #[test]
    fn thin_wpkn_reserves_charge_inventory() {
        let params = ExchangeParams::default();
        let quote = calculate_quote(
            Direction::PknToWpkn,
            10_000.0,
            Reserves {
                settlement_wpkn_pkn: Some(1_000_000.0),
                ..Default::default()
            },
            Some(1.0),
            &params,
            0,
        )
        .unwrap();
        // (1 - 0.5) * 300 = 150 bps inventory; impact = 10000/2e6*75 = 0.375 → 0.
        assert_eq!(quote.inventory_bps, 150);
        assert_eq!(quote.total_cost_bps, 250);
        assert_eq!(quote.amount_out, 9750);
    }

    #[test]
    fn locked_pkn_inventory_applies_to_the_reverse_direction() {
        let params = ExchangeParams::default();
        let quote = calculate_quote(
            Direction::WpknToPkn,
            10_000.0,
            Reserves {
                locked_pkn: Some(1_000_000.0),
                ..Default::default()
            },
            Some(2.0),
            &params,
            0,
        )
        .unwrap();
        assert_eq!(quote.inventory_bps, 150);
        // 10000 * 2 = 20000 gross; 250 bps cost → 19500.
        assert_eq!(quote.amount_out, 19500);
        assert_eq!(quote.fee_amount, 500);
    }

    #[test]
    fn size_impact_is_capped_at_500_bps() {
        let params = ExchangeParams::default();
        let quote = calculate_quote(
            Direction::PknToWpkn,
            100_000.0,
            Reserves {
                available_liquidity_pkn: Some(1000.0),
                ..Default::default()
            },
            Some(1.0),
            &params,
            0,
        )
        .unwrap();
        assert_eq!(quote.size_impact_bps, MAX_SIZE_IMPACT_BPS);
    }

    #[test]
    fn public_quote_keeps_the_camel_case_contract() {
        let params = ExchangeParams::default();
        let quote = calculate_quote(
            Direction::WpknToPkn,
            5000.0,
            Reserves::default(),
            Some(2.0),
            &params,
            1_700_000_000_000,
        )
        .unwrap();
        let public = public_quote("q1", &quote);
        assert_eq!(public["direction"], json!("wpkn_to_pkn"));
        assert_eq!(public["fromAsset"], json!("wPKN"));
        assert_eq!(public["toAsset"], json!("PKN"));
        assert_eq!(public["quoteId"], json!("q1"));
        let parsed = chrono::DateTime::parse_from_rfc3339(&quote.quote_expires_at).unwrap();
        assert_eq!(parsed.timestamp_millis(), 1_700_000_000_000 + DEFAULT_QUOTE_TTL_MS);
    }

    #[test]
    fn market_quote_matches_the_reference_formula() {
        // 1 wPKN = $0.006, 1 PKN = $0.005 → price 1.2 PKN per wPKN.
        let quote = calculate_wpkn_pkn_market_quote(
            Direction::WpknToPkn,
            1000.0,
            0.006,
            0.005,
            100,
            1,
            100_000_000,
            DEFAULT_MARKET_QUOTE_TTL_MS,
            0,
        )
        .unwrap();
        assert!((quote.market_price - 1.2).abs() < 1e-9);
        assert_eq!(quote.amount_out, 1188);
        assert_eq!(quote.fee_amount, 12);
        assert_eq!(quote.reserve_in, "$0.006000 wPKN");
        assert_eq!(quote.reserve_out, "$0.005000 PKN");
    }

    #[test]
    fn market_quote_rejects_bad_amounts() {
        assert!(calculate_wpkn_pkn_market_quote(
            Direction::PknToWpkn, 0.0, 0.006, 0.005, 100, 1, 100_000_000, 1000, 0
        )
        .is_err());
        assert!(calculate_wpkn_pkn_market_quote(
            Direction::PknToWpkn, 1.5, 0.006, 0.005, 100, 1, 100_000_000, 1000, 0
        )
        .is_err());
        assert!(calculate_wpkn_pkn_market_quote(
            Direction::PknToWpkn, 100_000_001.0, 0.006, 0.005, 100, 1, 100_000_000, 1000, 0
        )
        .is_err());
    }

    #[test]
    fn reference_price_never_goes_to_zero() {
        assert_eq!(reference_price_from_usd(0.0, 0.005), 0.000001);
        assert!((reference_price_from_usd(1.0, 0.005) - 200.0).abs() < 1e-9);
    }
}
