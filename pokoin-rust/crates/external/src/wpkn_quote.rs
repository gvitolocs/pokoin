//! `/api/wpkn-pkn-quote` — wPKN/PKN market quote. Native port of
//! `_wpkn_pkn_market_quote.js` + the route. GeckoTerminal HTTP, no Node.

use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

pub const DEFAULT_PKN_USD: f64 = 0.005;
pub const DEFAULT_SPREAD_BPS: i64 = 100;
pub const QUOTE_TTL_MS: i64 = 30_000;
pub const BPS_DENOMINATOR: f64 = 10_000.0;
pub const GECKO_API_BASE: &str = "https://api.geckoterminal.com/api/v2";
pub const DEFAULT_WPKN_BSC: &str = "0x91A17E2bddfF839078BD395482B38e4AC15276f4";
pub const DEFAULT_GECKO_NETWORK: &str = "bsc";

fn int_env(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.trunc() as i64)
        .unwrap_or(fallback)
}

fn number_env(name: &str, fallback: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

pub fn normalize_direction(direction: &str) -> ApiResult<String> {
    let value = direction.trim().to_lowercase();
    if value == "pkn_to_wpkn" || value == "wpkn_to_pkn" {
        Ok(value)
    } else {
        Err(ApiError::bad_request("Choose PKN -> wPKN or wPKN -> PKN."))
    }
}

pub fn normalize_amount(value: f64) -> ApiResult<i64> {
    if !value.is_finite() || value.fract() != 0.0 || value <= 0.0 {
        return Err(ApiError::bad_request("Enter a whole PKN/wPKN amount."));
    }
    let amount = value as i64;
    let min = int_env("WPKN_MARKET_QUOTE_MIN_AMOUNT", 1);
    let max = int_env("WPKN_MARKET_QUOTE_MAX_AMOUNT", 100_000_000);
    if amount < min {
        return Err(ApiError::bad_request(format!("Amount too low, the minimum is {min}")));
    }
    if amount > max {
        return Err(ApiError::bad_request(format!("Enter an amount up to {max}.")));
    }
    Ok(amount)
}

pub fn pkn_usd_price() -> f64 {
    number_env("WPKN_EXCHANGE_PKN_USD_PRICE", number_env("CRYPTO_PKN_USDT_PRICE", DEFAULT_PKN_USD))
}

pub fn wpkn_contract_address() -> String {
    std::env::var("WPKN_CONTRACT_ADDRESS")
        .unwrap_or_else(|_| DEFAULT_WPKN_BSC.to_string())
        .trim()
        .to_lowercase()
}

pub fn gecko_network() -> String {
    std::env::var("GECKOTERMINAL_NETWORK")
        .unwrap_or_else(|_| DEFAULT_GECKO_NETWORK.to_string())
        .trim()
        .to_lowercase()
}

pub fn reference_price_from_usd(wpkn_usd: f64, pkn_usd: f64) -> f64 {
    (wpkn_usd / pkn_usd).max(0.000_001)
}

/// `geckoTerminalWpknUsd` — override env, else GeckoTerminal token price.
pub async fn gecko_terminal_wpkn_usd(http: &reqwest::Client) -> ApiResult<f64> {
    let override_price = number_env("WPKN_USD_PRICE_OVERRIDE", 0.0);
    if override_price > 0.0 {
        return Ok(override_price);
    }
    let token = wpkn_contract_address();
    let url = format!("{GECKO_API_BASE}/simple/networks/{}/token_price/{token}", gecko_network());
    let response = http
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| ApiError::unavailable("GeckoTerminal wPKN price is unavailable."))?;
    if !response.status().is_success() {
        return Err(ApiError::unavailable("GeckoTerminal wPKN price is unavailable."));
    }
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let price = payload
        .pointer(&format!("/data/attributes/token_prices/{token}"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if !price.is_finite() || price <= 0.0 {
        return Err(ApiError::unavailable("GeckoTerminal returned an invalid wPKN price."));
    }
    Ok(price)
}

/// `calculateWpknPknMarketQuote`.
pub async fn calculate_quote(
    http: &reqwest::Client,
    direction: &str,
    amount_in: f64,
    wpkn_usd: Option<f64>,
    pkn_usd: Option<f64>,
    now_ms: i64,
) -> ApiResult<Value> {
    let normalized_direction = normalize_direction(direction)?;
    let amount = normalize_amount(amount_in)?;
    let spread_bps = int_env("WPKN_EXCHANGE_SPREAD_BPS", DEFAULT_SPREAD_BPS);
    let resolved_wpkn_usd = match wpkn_usd {
        Some(value) if value > 0.0 => value,
        _ => gecko_terminal_wpkn_usd(http).await?,
    };
    let resolved_pkn_usd = match pkn_usd {
        Some(value) if value > 0.0 => value,
        _ => pkn_usd_price(),
    };
    let market_price = reference_price_from_usd(resolved_wpkn_usd, resolved_pkn_usd);
    let gross_out = if normalized_direction == "pkn_to_wpkn" {
        amount as f64 / market_price
    } else {
        amount as f64 * market_price
    };
    let net_out = gross_out * (BPS_DENOMINATOR - spread_bps as f64) / BPS_DENOMINATOR;
    let amount_out = net_out.round().max(0.0) as i64;
    let fee_amount = (gross_out.round().max(0.0) as i64 - amount_out).max(0);
    Ok(json!({
        "direction": normalized_direction,
        "fromAsset": if normalized_direction == "pkn_to_wpkn" { "PKN" } else { "wPKN" },
        "toAsset": if normalized_direction == "pkn_to_wpkn" { "wPKN" } else { "PKN" },
        "amountIn": amount,
        "amountOut": amount_out,
        "feeAmount": fee_amount,
        "feeBps": spread_bps,
        "marketPrice": market_price,
        "wpknUsd": resolved_wpkn_usd,
        "pknUsd": resolved_pkn_usd,
        "priceSource": "geckoterminal",
        "poolId": "WPKN-PKN-market",
        "reserveIn": format!("${:.6} wPKN", resolved_wpkn_usd),
        "reserveOut": format!("${:.6} PKN", resolved_pkn_usd),
        "quoteExpiresAt": crate::time_util::iso_from_ms(now_ms + int_env("WPKN_MARKET_QUOTE_TTL_MS", QUOTE_TTL_MS)),
    }))
}

/// Route body: quote + route metadata.
pub async fn handle(
    http: &reqwest::Client,
    direction: &str,
    amount_in: f64,
) -> ApiResult<Value> {
    let now_ms = crate::time_util::now_ms();
    let quote = calculate_quote(http, direction, amount_in, None, None, now_ms).await?;
    Ok(json!({
        "direction": quote["direction"],
        "fromAsset": quote["fromAsset"],
        "toAsset": quote["toAsset"],
        "amountIn": quote["amountIn"],
        "amountOut": quote["amountOut"],
        "feeAmount": quote["feeAmount"],
        "feeBps": quote["feeBps"],
        "marketPrice": quote["marketPrice"],
        "wpknUsd": quote["wpknUsd"],
        "pknUsd": quote["pknUsd"],
        "priceSource": quote["priceSource"],
        "poolId": quote["poolId"],
        "reserveIn": quote["reserveIn"],
        "reserveOut": quote["reserveOut"],
        "quoteExpiresAt": quote["quoteExpiresAt"],
        "source": "wpkn_market",
        "assetIn": quote["fromAsset"],
        "assetOut": quote["toAsset"],
        "quotedAt": crate::time_util::iso_from_ms(now_ms),
        "priceFetchedAt": crate::time_util::iso_from_ms(now_ms),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_and_amount_validation() {
        assert_eq!(normalize_direction("PKN_TO_WPKN").unwrap(), "pkn_to_wpkn");
        assert!(normalize_direction("swap").is_err());
        assert_eq!(normalize_amount(5.0).unwrap(), 5);
        assert!(normalize_amount(0.0).is_err());
        assert!(normalize_amount(1.5).is_err());
        assert!(normalize_amount(-3.0).is_err());
    }

    #[test]
    fn reference_price_floor() {
        assert_eq!(reference_price_from_usd(0.01, 0.005), 2.0);
        assert!(reference_price_from_usd(0.0, 0.005) >= 0.000001);
    }

    #[test]
    fn quote_math_matches_reference() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let http = reqwest::Client::new();
        // 100 PKN -> wPKN at wpkn=0.01, pkn=0.005 → marketPrice 2, gross 50, 1% spread → 50 (round)
        let quote = runtime
            .block_on(calculate_quote(&http, "pkn_to_wpkn", 100.0, Some(0.01), Some(0.005), 0))
            .unwrap();
        assert_eq!(quote["marketPrice"], 2.0);
        assert_eq!(quote["amountOut"], 50);
        assert_eq!(quote["feeAmount"], 0);
        assert_eq!(quote["feeBps"], 100);
        // wPKN -> PKN
        let quote = runtime
            .block_on(calculate_quote(&http, "wpkn_to_pkn", 10.0, Some(0.01), Some(0.005), 0))
            .unwrap();
        assert_eq!(quote["amountOut"], 20);
    }
}
