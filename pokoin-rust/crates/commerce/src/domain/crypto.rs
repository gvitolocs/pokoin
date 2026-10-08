//! Crypto → PKN purchase/sale quote math and input normalization, ported from
//! `_crypto_pkn_purchase.js`. The on-chain verification itself is a port
//! (`crate::ports::ChainPort`); everything here is pure and tested directly.

use regex::Regex;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

pub const PKN_USDT_REFERENCE_PRICE: f64 = 0.005;
pub const QUOTE_TTL_MS: i64 = 60 * 1000;
pub const DEFAULT_FEE_BPS: i64 = 100;
pub const STABLECOIN_FEE_BPS: i64 = 30;
pub const DEFAULT_SELL_FEE_BPS: i64 = 100;
pub const DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT: f64 = 1_000_000.0;
pub const DEFAULT_CRYPTO_PKN_MAX_SELL_PKN: f64 = 1_000_000_000.0;
pub const DEFAULT_SETTLEMENT_ADDRESS: &str = "0x74466c3a204429B22CE8558F3F18f3C59F67fCB3";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainConfig {
    pub asset: &'static str,
    pub chain_name: &'static str,
    pub chain_id: Option<i64>,
    pub bitcoin: bool,
    pub native: bool,
    pub stablecoin: bool,
    pub coingecko_id: Option<&'static str>,
    pub rpc_env: Option<&'static str>,
    pub default_rpc_url: Option<&'static str>,
    pub token_address_env: Option<&'static str>,
    pub default_token_address: Option<&'static str>,
}

const fn evm(
    asset: &'static str,
    chain_name: &'static str,
    chain_id: i64,
    rpc_env: &'static str,
    default_rpc_url: &'static str,
) -> ChainConfig {
    ChainConfig {
        asset,
        chain_name,
        chain_id: Some(chain_id),
        bitcoin: false,
        native: true,
        stablecoin: false,
        coingecko_id: None,
        rpc_env: Some(rpc_env),
        default_rpc_url: Some(default_rpc_url),
        token_address_env: None,
        default_token_address: None,
    }
}

pub const CHAIN_CONFIG: &[ChainConfig] = &[
    ChainConfig {
        asset: "BTC",
        chain_name: "Bitcoin",
        chain_id: None,
        bitcoin: true,
        native: false,
        stablecoin: false,
        coingecko_id: Some("bitcoin"),
        rpc_env: None,
        default_rpc_url: None,
        token_address_env: None,
        default_token_address: None,
    },
    ChainConfig {
        asset: "ETH",
        chain_name: "Ethereum",
        chain_id: Some(1),
        bitcoin: false,
        native: true,
        stablecoin: false,
        coingecko_id: Some("ethereum"),
        rpc_env: Some("ETHEREUM_RPC_URL"),
        default_rpc_url: Some("https://ethereum.publicnode.com"),
        token_address_env: None,
        default_token_address: None,
    },
    ChainConfig {
        coingecko_id: Some("binancecoin"),
        ..evm("BNB", "BNB Chain", 56, "BNB_RPC_URL", "https://bsc-dataseed.binance.org")
    },
    ChainConfig {
        asset: "USDT",
        chain_name: "BNB Chain",
        chain_id: Some(56),
        bitcoin: false,
        native: false,
        stablecoin: true,
        coingecko_id: None,
        rpc_env: Some("BNB_RPC_URL"),
        default_rpc_url: Some("https://bsc-dataseed.binance.org"),
        token_address_env: Some("USDT_BNB_CONTRACT_ADDRESS"),
        default_token_address: Some("0x55d398326f99059fF775485246999027B3197955"),
    },
    ChainConfig {
        asset: "EURC",
        chain_name: "Ethereum",
        chain_id: Some(1),
        bitcoin: false,
        native: false,
        stablecoin: false,
        coingecko_id: Some("eurc"),
        rpc_env: Some("ETHEREUM_RPC_URL"),
        default_rpc_url: Some("https://ethereum.publicnode.com"),
        token_address_env: Some("EURC_ETH_CONTRACT_ADDRESS"),
        default_token_address: Some("0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c"),
    },
    ChainConfig {
        asset: "USDC",
        chain_name: "BNB Chain",
        chain_id: Some(56),
        bitcoin: false,
        native: false,
        stablecoin: true,
        coingecko_id: None,
        rpc_env: Some("BNB_RPC_URL"),
        default_rpc_url: Some("https://bsc-dataseed.binance.org"),
        token_address_env: Some("USDC_BNB_CONTRACT_ADDRESS"),
        default_token_address: Some("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"),
    },
    ChainConfig {
        asset: "DAI",
        chain_name: "BNB Chain",
        chain_id: Some(56),
        bitcoin: false,
        native: false,
        stablecoin: true,
        coingecko_id: None,
        rpc_env: Some("BNB_RPC_URL"),
        default_rpc_url: Some("https://bsc-dataseed.binance.org"),
        token_address_env: Some("DAI_BNB_CONTRACT_ADDRESS"),
        default_token_address: Some("0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3"),
    },
    ChainConfig {
        asset: "LINK",
        chain_name: "Ethereum",
        chain_id: Some(1),
        bitcoin: false,
        native: false,
        stablecoin: false,
        coingecko_id: Some("chainlink"),
        rpc_env: Some("ETHEREUM_RPC_URL"),
        default_rpc_url: Some("https://ethereum.publicnode.com"),
        token_address_env: Some("LINK_ETH_CONTRACT_ADDRESS"),
        default_token_address: Some("0x514910771af9ca656af840dff83e8264ecf986ca"),
    },
    ChainConfig {
        asset: "UNI",
        chain_name: "Ethereum",
        chain_id: Some(1),
        bitcoin: false,
        native: false,
        stablecoin: false,
        coingecko_id: Some("uniswap"),
        rpc_env: Some("ETHEREUM_RPC_URL"),
        default_rpc_url: Some("https://ethereum.publicnode.com"),
        token_address_env: Some("UNI_ETH_CONTRACT_ADDRESS"),
        default_token_address: Some("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
    },
    ChainConfig {
        asset: "CAKE",
        chain_name: "BNB Chain",
        chain_id: Some(56),
        bitcoin: false,
        native: false,
        stablecoin: false,
        coingecko_id: Some("pancakeswap-token"),
        rpc_env: Some("BNB_RPC_URL"),
        default_rpc_url: Some("https://bsc-dataseed.binance.org"),
        token_address_env: Some("CAKE_BNB_CONTRACT_ADDRESS"),
        default_token_address: Some("0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"),
    },
];

pub fn chain_config(asset: &str) -> Option<&'static ChainConfig> {
    let normalized = asset.trim().to_ascii_uppercase();
    CHAIN_CONFIG.iter().find(|config| config.asset == normalized)
}

pub fn normalize_asset(asset: &str) -> ApiResult<&'static ChainConfig> {
    let normalized = asset.trim().to_ascii_uppercase();
    chain_config(&normalized).ok_or_else(|| {
        ApiError::bad_request(format!(
            "Buying PKN with {} is not supported yet.",
            if normalized.is_empty() {
                "this asset".to_string()
            } else {
                normalized
            }
        ))
    })
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid regex")
}

/// `REGISTERED_ADDRESS = /^0x[a-f0-9]{40}$/` from `top-up-account-balance.js`.
pub fn is_registered_address(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && bytes[1] == b'x'
        && bytes[2..].iter().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn normalize_address(address: &str, message: &str) -> ApiResult<String> {
    let value = address.trim().to_ascii_lowercase();
    if re(r"^0x[a-f0-9]{40}$").is_match(&value) {
        Ok(value)
    } else {
        Err(ApiError::bad_request(message))
    }
}

pub fn normalize_bitcoin_address(address: &str) -> ApiResult<String> {
    let value = address.trim();
    if re(r"(?i)^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,87}$").is_match(value) {
        Ok(value.to_string())
    } else {
        Err(ApiError::internal(
            "Bitcoin settlement address is not configured.",
        ))
    }
}

pub fn normalize_tx_hash(tx_hash: &str) -> ApiResult<String> {
    let value = tx_hash.trim().to_ascii_lowercase();
    if re(r"^(0x)?[a-f0-9]{64}$").is_match(&value) {
        Ok(if value.starts_with("0x") {
            value
        } else {
            format!("0x{value}")
        })
    } else {
        Err(ApiError::bad_request("Enter a valid deposit transaction hash."))
    }
}

pub fn normalize_bitcoin_txid(tx_hash: &str) -> ApiResult<String> {
    let value = tx_hash.trim().to_ascii_lowercase();
    if re(r"^[a-f0-9]{64}$").is_match(&value) {
        Ok(value)
    } else {
        Err(ApiError::bad_request("Enter a valid Bitcoin transaction id."))
    }
}

pub fn normalize_amount(value: f64, max: f64) -> ApiResult<f64> {
    if !value.is_finite() || value <= 0.0 {
        return Err(ApiError::bad_request("Enter an amount greater than zero."));
    }
    if value > max {
        return Err(ApiError::bad_request(format!(
            "Enter an amount up to {}.",
            max
        )));
    }
    Ok(value)
}

pub fn normalize_pkn_amount(value: f64, max: f64) -> ApiResult<i64> {
    if !value.is_finite() || value.fract() != 0.0 || value <= 0.0 {
        return Err(ApiError::bad_request(
            "Enter a whole PKN amount greater than zero.",
        ));
    }
    if value > max {
        return Err(ApiError::bad_request(format!(
            "Enter a PKN amount up to {}.",
            max
        )));
    }
    Ok(value as i64)
}

pub fn normalize_payout_address(asset: &str, address: &str) -> ApiResult<String> {
    let config = normalize_asset(asset)?;
    if config.bitcoin {
        return normalize_bitcoin_address(address);
    }
    normalize_address(
        address,
        &format!("Enter a valid {} payout address.", config.asset),
    )
}

#[derive(Debug, Clone)]
pub struct CryptoQuote {
    pub asset: String,
    pub from_asset: String,
    pub to_asset: String,
    pub amount_in: f64,
    pub amount_out: f64,
    pub fee_amount: f64,
    pub fee_bps: i64,
    pub market_price: f64,
    pub pkn_usd: f64,
    pub chain_id: Option<i64>,
    pub chain_name: String,
    pub settlement_address: Option<String>,
    pub token_address: Option<String>,
    pub quote_expires_at: String,
}

fn iso(now_ms: i64, ttl_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms + ttl_ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `calculateCryptoPknQuote`.
#[allow(clippy::too_many_arguments)]
pub fn calculate_crypto_pkn_quote(
    asset: &str,
    amount_in: f64,
    market_price: f64,
    pkn_usd: f64,
    fee_bps: Option<i64>,
    max_input: f64,
    settlement_address: Option<String>,
    token_address: Option<String>,
    now_ms: i64,
    ttl_ms: i64,
) -> ApiResult<CryptoQuote> {
    let config = normalize_asset(asset)?;
    let amount = normalize_amount(amount_in, max_input)?;
    let fee_bps = fee_bps.unwrap_or(if config.stablecoin {
        STABLECOIN_FEE_BPS
    } else {
        DEFAULT_FEE_BPS
    });
    let gross_pkn = amount * market_price / pkn_usd;
    let amount_out = (gross_pkn * (10000.0 - fee_bps as f64) / 10000.0)
        .max(0.0)
        .floor();
    if amount_out <= 0.0 {
        return Err(ApiError::bad_request("Quote is too small for a PKN purchase."));
    }
    Ok(CryptoQuote {
        asset: config.asset.to_string(),
        from_asset: config.asset.to_string(),
        to_asset: "PKN".to_string(),
        amount_in: amount,
        amount_out,
        fee_amount: (gross_pkn.floor() - amount_out).max(0.0),
        fee_bps,
        market_price,
        pkn_usd,
        chain_id: config.chain_id,
        chain_name: config.chain_name.to_string(),
        settlement_address,
        token_address,
        quote_expires_at: iso(now_ms, ttl_ms),
    })
}

/// `calculatePknCryptoSaleQuote`.
#[allow(clippy::too_many_arguments)]
pub fn calculate_pkn_crypto_sale_quote(
    asset: &str,
    amount_in: f64,
    market_price: f64,
    pkn_usd: f64,
    fee_bps: Option<i64>,
    max_sell_pkn: f64,
    now_ms: i64,
    ttl_ms: i64,
) -> ApiResult<CryptoQuote> {
    let config = normalize_asset(asset)?;
    let amount = normalize_pkn_amount(amount_in, max_sell_pkn)?;
    let fee_bps = fee_bps.unwrap_or(DEFAULT_SELL_FEE_BPS);
    let gross_crypto = amount as f64 * pkn_usd / market_price;
    let amount_out = (gross_crypto * (10000.0 - fee_bps as f64) / 10000.0).max(0.0);
    if amount_out <= 0.0 {
        return Err(ApiError::bad_request("Quote is too small for a crypto sale."));
    }
    Ok(CryptoQuote {
        asset: config.asset.to_string(),
        from_asset: "PKN".to_string(),
        to_asset: config.asset.to_string(),
        amount_in: amount as f64,
        amount_out,
        fee_amount: (gross_crypto - amount_out).max(0.0),
        fee_bps,
        market_price,
        pkn_usd,
        chain_id: config.chain_id,
        chain_name: config.chain_name.to_string(),
        settlement_address: None,
        token_address: None,
        quote_expires_at: iso(now_ms, ttl_ms),
    })
}

pub fn public_crypto_pkn_quote(quote_id: &str, quote: &CryptoQuote) -> Value {
    json!({
        "quoteId": quote_id,
        "fromAsset": quote.from_asset,
        "toAsset": quote.to_asset,
        "amountIn": quote.amount_in,
        "amountOut": quote.amount_out,
        "feeAmount": quote.fee_amount,
        "feeBps": quote.fee_bps,
        "marketPrice": quote.market_price,
        "pknUsd": quote.pkn_usd,
        "chainId": quote.chain_id,
        "chainName": quote.chain_name,
        "settlementAddress": quote.settlement_address,
        "tokenAddress": quote.token_address,
        "quoteExpiresAt": quote.quote_expires_at,
    })
}

pub fn public_pkn_crypto_sale_quote(quote_id: &str, quote: &CryptoQuote) -> Value {
    json!({
        "quoteId": quote_id,
        "fromAsset": quote.from_asset,
        "toAsset": quote.to_asset,
        "amountIn": quote.amount_in,
        "amountOut": quote.amount_out,
        "feeAmount": quote.fee_amount,
        "feeBps": quote.fee_bps,
        "marketPrice": quote.market_price,
        "pknUsd": quote.pkn_usd,
        "chainId": quote.chain_id,
        "chainName": quote.chain_name,
        "quoteExpiresAt": quote.quote_expires_at,
    })
}

/// `marketUsdPrice` for a config: stablecoins are $1, otherwise the configured
/// or upstream price must be positive.
pub fn resolve_market_price(config: &ChainConfig, configured: Option<f64>, upstream: Option<f64>) -> ApiResult<f64> {
    if config.stablecoin {
        return Ok(1.0);
    }
    if let Some(price) = configured.filter(|price| *price > 0.0) {
        return Ok(price);
    }
    if config.coingecko_id.is_none() {
        return Err(ApiError::internal(format!(
            "Market price for {} is not configured.",
            config.asset
        )));
    }
    match upstream.filter(|price| price.is_finite() && *price > 0.0) {
        Some(price) => Ok(price),
        None => Err(ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("Market price for {} is unavailable.", config.asset),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_address_regex_matches_node() {
        // /^0x[a-f0-9]{40}$/
        assert!(is_registered_address("0x1111111111111111111111111111111111111111"));
        assert!(is_registered_address("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"));
        // Uppercase hex is not the canonical registry form.
        assert!(!is_registered_address("0x111111111111111111111111111111111111111A"));
        assert!(!is_registered_address("0x111111111111111111111111111111111111111")); // 39
        assert!(!is_registered_address("0x11111111111111111111111111111111111111111")); // 41
        assert!(!is_registered_address("1111111111111111111111111111111111111111"));
        assert!(!is_registered_address("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
        assert!(!is_registered_address(""));
        assert!(!is_registered_address("not-an-address"));
    }

    #[test]
    fn supported_assets_match_the_reference_table() {
        for asset in ["BTC", "ETH", "BNB", "USDT", "EURC", "USDC", "DAI", "LINK", "UNI", "CAKE"] {
            assert!(chain_config(asset).is_some(), "{asset}");
        }
        assert!(chain_config("DOGE").is_none());
        let error = normalize_asset("doge").unwrap_err();
        assert_eq!(error.status.as_u16(), 400);
        assert!(error.message.contains("DOGE"));
        assert_eq!(normalize_asset("btc").unwrap().chain_name, "Bitcoin");
    }

    #[test]
    fn address_and_hash_normalization_matches_node() {
        let address = normalize_address("0xABCdef0000000000000000000000000000000001", "bad").unwrap();
        assert_eq!(address, "0xabcdef0000000000000000000000000000000001");
        assert!(normalize_address("0x1234", "bad").is_err());

        assert_eq!(
            normalize_tx_hash(&"A".repeat(64)).unwrap(),
            format!("0x{}", "a".repeat(64))
        );
        assert_eq!(normalize_tx_hash(&format!("0x{}", "b".repeat(64))).unwrap(), format!("0x{}", "b".repeat(64)));
        assert!(normalize_tx_hash("0xdeadbeef").is_err());
        assert!(normalize_bitcoin_txid(&"c".repeat(64)).is_ok());
        assert!(normalize_bitcoin_txid("xyz").is_err());
    }

    #[test]
    fn purchase_quote_applies_asset_specific_fees() {
        // 1000 USDT at a $0.005 PKN: 200,000 PKN gross, 30 bps fee.
        let quote = calculate_crypto_pkn_quote(
            "USDT", 1000.0, 1.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT,
            Some(DEFAULT_SETTLEMENT_ADDRESS.into()), None, 1_700_000_000_000, QUOTE_TTL_MS,
        )
        .unwrap();
        assert_eq!(quote.amount_out, 199_400.0);
        assert_eq!(quote.fee_bps, 30);
        assert_eq!(quote.fee_amount, 600.0);

        // Non-stablecoin uses 100 bps.
        let quote = calculate_crypto_pkn_quote(
            "ETH", 1.0, 2500.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT,
            Some(DEFAULT_SETTLEMENT_ADDRESS.into()), None, 0, QUOTE_TTL_MS,
        )
        .unwrap();
        assert_eq!(quote.fee_bps, 100);
        assert_eq!(quote.amount_out, (500_000.0_f64 * 0.99).floor());
    }

    #[test]
    fn purchase_quote_rejects_dust_and_bad_amounts() {
        assert!(calculate_crypto_pkn_quote(
            "USDT", 0.0, 1.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT, None, None, 0, QUOTE_TTL_MS
        )
        .is_err());
        let dust = calculate_crypto_pkn_quote(
            "USDT", 0.0000001, 1.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT, None, None, 0, QUOTE_TTL_MS,
        );
        assert!(dust.is_err(), "dust quote must be refused");
        let too_big = calculate_crypto_pkn_quote(
            "USDT", 5_000_000.0, 1.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT, None, None, 0, QUOTE_TTL_MS,
        );
        assert!(too_big.is_err());
    }

    #[test]
    fn sale_quote_inverts_the_purchase_math() {
        let quote = calculate_pkn_crypto_sale_quote(
            "USDT", 200_000.0, 1.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_SELL_PKN, 0, QUOTE_TTL_MS,
        )
        .unwrap();
        assert_eq!(quote.from_asset, "PKN");
        assert_eq!(quote.to_asset, "USDT");
        // 200000 PKN * 0.005 / 1 = 1000 USDT gross, 100 bps fee.
        assert!((quote.amount_out - 990.0).abs() < 1e-9);
        assert!((quote.fee_amount - 10.0).abs() < 1e-9);
        assert!(calculate_pkn_crypto_sale_quote(
            "USDT", 1.5, 1.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_SELL_PKN, 0, QUOTE_TTL_MS
        )
        .is_err());
    }

    #[test]
    fn market_price_resolution_is_fail_closed() {
        let usdt = chain_config("USDT").unwrap();
        assert_eq!(resolve_market_price(usdt, None, None).unwrap(), 1.0);

        let eth = chain_config("ETH").unwrap();
        assert_eq!(resolve_market_price(eth, Some(2600.0), None).unwrap(), 2600.0);
        assert_eq!(resolve_market_price(eth, None, Some(2500.0)).unwrap(), 2500.0);
        assert!(resolve_market_price(eth, None, None).is_err());
        assert!(resolve_market_price(eth, Some(0.0), Some(-1.0)).is_err());

        let eurc = chain_config("EURC").unwrap();
        assert!(resolve_market_price(eurc, None, None).is_err());
        assert_eq!(resolve_market_price(eurc, None, Some(1.08)).unwrap(), 1.08);
    }

    #[test]
    fn public_quote_shape_keeps_camel_case() {
        let quote = calculate_crypto_pkn_quote(
            "BTC", 0.01, 60000.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT,
            None, None, 1_700_000_000_000, QUOTE_TTL_MS,
        )
        .unwrap();
        let public = public_crypto_pkn_quote("q1", &quote);
        assert_eq!(public["quoteId"], json!("q1"));
        assert_eq!(public["toAsset"], json!("PKN"));
        assert!(public.get("settlementAddress").is_some());
        assert_eq!(public["chainName"], json!("Bitcoin"));
    }

    #[test]
    fn quote_expiry_uses_the_ttl() {
        let quote = calculate_crypto_pkn_quote(
            "USDT", 100.0, 1.0, 0.005, None, DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT, None, None,
            1_700_000_000_000, QUOTE_TTL_MS,
        )
        .unwrap();
        let parsed = chrono::DateTime::parse_from_rfc3339(&quote.quote_expires_at).unwrap();
        assert_eq!(parsed.timestamp_millis(), 1_700_000_000_000 + QUOTE_TTL_MS);
    }
}
