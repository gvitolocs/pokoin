//! Commerce configuration: every value comes from the environment, exactly like
//! the Node runtime. Secrets are never logged.

fn env_first(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn env_f64(name: &str, fallback: f64) -> f64 {
    env_first(&[name])
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn env_i64(name: &str, fallback: i64) -> i64 {
    env_first(&[name])
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn env_bool(name: &str, fallback: bool) -> bool {
    match env_first(&[name]) {
        None => fallback,
        Some(value) => matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
    }
}

#[derive(Debug, Clone)]
pub struct CommerceConfig {
    // --- addresses ---------------------------------------------------------
    pub address_encryption_key: Option<String>,
    // --- Stripe ------------------------------------------------------------
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub stripe_api_version: Option<String>,
    pub public_site_url: String,
    // --- PKN checkout ------------------------------------------------------
    pub pkn_checkout_usdt_price: Option<f64>,
    pub pkn_checkout_currency: String,
    // --- native PKN chain --------------------------------------------------
    pub pokoin_rpc_url: String,
    pub pokoin_bank_address: String,
    pub pokoin_reserve_address: String,
    pub pokoin_bank_private_key: Option<String>,
    pub pokoin_reserve_private_key: Option<String>,
    // --- EVM / wPKN --------------------------------------------------------
    pub ethereum_rpc_url: String,
    pub bnb_rpc_url: String,
    pub wpkn_contract_address: String,
    pub wpkn_settlement_address: Option<String>,
    pub bnb_settlement_private_key: Option<String>,
    pub pancake_wpkn_bnb_pair_address: Option<String>,
    pub usdt_bnb_contract_address: Option<String>,
    pub usdc_bnb_contract_address: Option<String>,
    pub dai_bnb_contract_address: Option<String>,
    pub eurc_eth_contract_address: Option<String>,
    pub link_eth_contract_address: Option<String>,
    pub uni_eth_contract_address: Option<String>,
    pub cake_bnb_contract_address: Option<String>,
    pub crypto_pkn_settlement_address: Option<String>,
    // --- crypto pricing ----------------------------------------------------
    pub coingecko_api_base: String,
    pub geckoterminal_api_base: String,
    pub geckoterminal_network: String,
    pub wpkn_usd_price_override: Option<f64>,
    pub wpkn_exchange_pkn_usd_price: Option<f64>,
    pub crypto_pkn_usdt_price: Option<f64>,
    pub crypto_pkn_fee_bps: Option<i64>,
    pub crypto_pkn_sell_fee_bps: Option<i64>,
    pub crypto_pkn_max_input_amount: f64,
    pub crypto_pkn_max_sell_pkn: f64,
    pub crypto_pkn_quote_ttl_ms: i64,
    pub crypto_pkn_sell_enabled: bool,
    pub crypto_pkn_auto_payout_enabled: bool,
    pub wpkn_exchange_spread_bps: i64,
    pub wpkn_exchange_impact_coefficient_bps: i64,
    pub wpkn_exchange_min_order_pkn: i64,
    pub wpkn_exchange_max_order_pkn: i64,
    pub wpkn_exchange_available_liquidity_pkn: f64,
    pub wpkn_exchange_wpkn_reserve_pkn: f64,
    pub wpkn_exchange_pkn_locked_target: f64,
    pub wpkn_exchange_market_price: Option<f64>,
    pub wpkn_exchange_quote_ttl_ms: i64,
    pub wpkn_market_quote_min_amount: i64,
    pub wpkn_market_quote_max_amount: i64,
    pub wpkn_market_quote_ttl_ms: i64,
    // --- Bitcoin -----------------------------------------------------------
    pub bitcoin_explorer_api_url: String,
    pub bitcoin_settlement_address: Option<String>,
    pub bitcoin_min_confirmations: i64,
    // --- shipping ----------------------------------------------------------
    pub packlink_api_key: Option<String>,
    // --- misc --------------------------------------------------------------
    pub silver_price_pkn: i64,
    pub pokoin_treasury_username: String,
    pub earn_pkn_inbox: String,
}

impl CommerceConfig {
    pub fn from_env() -> Self {
        Self {
            address_encryption_key: env_first(&["ADDRESS_ENCRYPTION_KEY"]),
            stripe_secret_key: env_first(&["STRIPE_SECRET_KEY"]),
            stripe_webhook_secret: env_first(&["STRIPE_WEBHOOK_SECRET"]),
            stripe_api_version: env_first(&["STRIPE_API_VERSION"]),
            public_site_url: env_first(&["PUBLIC_SITE_URL"])
                .unwrap_or_else(|| "https://pokoin.com".into()),
            pkn_checkout_usdt_price: env_first(&["PKN_CHECKOUT_USDT_PRICE"])
                .and_then(|value| value.parse::<f64>().ok()),
            pkn_checkout_currency: env_first(&["PKN_CHECKOUT_CURRENCY"])
                .unwrap_or_else(|| "eur".into()),
            pokoin_rpc_url: env_first(&["POKOIN_RPC_URL"])
                .unwrap_or_else(|| "https://rpc.pokoin.com/rpc".into()),
            pokoin_bank_address: env_first(&["POKOIN_BANK_ADDRESS"])
                .unwrap_or_else(|| "0xb4029f68e360280aa4ad21d8ae5ad8896b8768b2".into()),
            pokoin_reserve_address: env_first(&["POKOIN_RESERVE_ADDRESS"])
                .unwrap_or_else(|| "0x74466c3a204429b22ce8558f3f18f3c59f67fcb3".into()),
            pokoin_bank_private_key: env_first(&["POKOIN_BANK_PRIVATE_KEY"]),
            pokoin_reserve_private_key: env_first(&["POKOIN_RESERVE_PRIVATE_KEY"]),
            ethereum_rpc_url: env_first(&["ETHEREUM_RPC_URL"])
                .unwrap_or_else(|| "https://ethereum.publicnode.com".into()),
            bnb_rpc_url: env_first(&["BNB_RPC_URL"])
                .unwrap_or_else(|| "https://bsc-dataseed.binance.org".into()),
            wpkn_contract_address: env_first(&["WPKN_CONTRACT_ADDRESS"])
                .unwrap_or_else(|| crate::domain::wpkn::DEFAULT_WPKN_BSC.into()),
            wpkn_settlement_address: env_first(&["WPKN_SETTLEMENT_ADDRESS"]),
            bnb_settlement_private_key: env_first(&["BNB_SETTLEMENT_PRIVATE_KEY"]),
            pancake_wpkn_bnb_pair_address: env_first(&["PANCAKE_WPKN_BNB_PAIR_ADDRESS"]),
            usdt_bnb_contract_address: env_first(&["USDT_BNB_CONTRACT_ADDRESS"]),
            usdc_bnb_contract_address: env_first(&["USDC_BNB_CONTRACT_ADDRESS"]),
            dai_bnb_contract_address: env_first(&["DAI_BNB_CONTRACT_ADDRESS"]),
            eurc_eth_contract_address: env_first(&["EURC_ETH_CONTRACT_ADDRESS"]),
            link_eth_contract_address: env_first(&["LINK_ETH_CONTRACT_ADDRESS"]),
            uni_eth_contract_address: env_first(&["UNI_ETH_CONTRACT_ADDRESS"]),
            cake_bnb_contract_address: env_first(&["CAKE_BNB_CONTRACT_ADDRESS"]),
            crypto_pkn_settlement_address: env_first(&[
                "CRYPTO_PKN_SETTLEMENT_ADDRESS",
                "WPKN_SETTLEMENT_ADDRESS",
            ]),
            coingecko_api_base: env_first(&["COINGECKO_API_BASE"])
                .unwrap_or_else(|| "https://api.coingecko.com/api/v3".into()),
            geckoterminal_api_base: env_first(&["GECKOTERMINAL_API_BASE"])
                .unwrap_or_else(|| crate::domain::wpkn::GECKO_API_BASE.into()),
            geckoterminal_network: env_first(&["GECKOTERMINAL_NETWORK"])
                .unwrap_or_else(|| crate::domain::wpkn::DEFAULT_GECKO_NETWORK.into()),
            wpkn_usd_price_override: env_first(&["WPKN_USD_PRICE_OVERRIDE"])
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| *value > 0.0),
            wpkn_exchange_pkn_usd_price: env_first(&["WPKN_EXCHANGE_PKN_USD_PRICE"])
                .and_then(|value| value.parse::<f64>().ok()),
            crypto_pkn_usdt_price: env_first(&["CRYPTO_PKN_USDT_PRICE"])
                .and_then(|value| value.parse::<f64>().ok()),
            crypto_pkn_fee_bps: env_first(&["CRYPTO_PKN_FEE_BPS"])
                .and_then(|value| value.parse::<i64>().ok()),
            crypto_pkn_sell_fee_bps: env_first(&["CRYPTO_PKN_SELL_FEE_BPS"])
                .and_then(|value| value.parse::<i64>().ok()),
            crypto_pkn_max_input_amount: env_f64(
                "CRYPTO_PKN_MAX_INPUT_AMOUNT",
                crate::domain::crypto::DEFAULT_CRYPTO_PKN_MAX_INPUT_AMOUNT,
            ),
            crypto_pkn_max_sell_pkn: env_f64(
                "CRYPTO_PKN_MAX_SELL_PKN",
                crate::domain::crypto::DEFAULT_CRYPTO_PKN_MAX_SELL_PKN,
            ),
            crypto_pkn_quote_ttl_ms: env_i64(
                "CRYPTO_PKN_QUOTE_TTL_MS",
                crate::domain::crypto::QUOTE_TTL_MS,
            ),
            crypto_pkn_sell_enabled: env_bool("CRYPTO_PKN_SELL_ENABLED", true),
            crypto_pkn_auto_payout_enabled: env_bool("CRYPTO_PKN_AUTO_PAYOUT_ENABLED", true),
            wpkn_exchange_spread_bps: env_i64(
                "WPKN_EXCHANGE_SPREAD_BPS",
                crate::domain::wpkn::DEFAULT_SPREAD_BPS,
            ),
            wpkn_exchange_impact_coefficient_bps: env_i64(
                "WPKN_EXCHANGE_IMPACT_COEFFICIENT_BPS",
                crate::domain::wpkn::DEFAULT_IMPACT_BPS,
            ),
            wpkn_exchange_min_order_pkn: env_i64(
                "WPKN_EXCHANGE_MIN_ORDER_PKN",
                crate::domain::wpkn::DEFAULT_MIN_ORDER_PKN,
            ),
            wpkn_exchange_max_order_pkn: env_i64(
                "WPKN_EXCHANGE_MAX_ORDER_PKN",
                crate::domain::wpkn::DEFAULT_MAX_ORDER_PKN,
            ),
            wpkn_exchange_available_liquidity_pkn: env_f64(
                "WPKN_EXCHANGE_AVAILABLE_LIQUIDITY_PKN",
                crate::domain::wpkn::DEFAULT_AVAILABLE_LIQUIDITY_PKN,
            ),
            wpkn_exchange_wpkn_reserve_pkn: env_f64(
                "WPKN_EXCHANGE_WPKN_RESERVE_PKN",
                crate::domain::wpkn::DEFAULT_WPKN_RESERVE_PKN,
            ),
            wpkn_exchange_pkn_locked_target: env_f64(
                "WPKN_EXCHANGE_PKN_LOCKED_TARGET",
                crate::domain::wpkn::DEFAULT_PKN_LOCKED_TARGET,
            ),
            wpkn_exchange_market_price: env_first(&["WPKN_EXCHANGE_MARKET_PRICE"])
                .and_then(|value| value.parse::<f64>().ok()),
            wpkn_exchange_quote_ttl_ms: env_i64(
                "WPKN_EXCHANGE_QUOTE_TTL_MS",
                crate::domain::wpkn::DEFAULT_QUOTE_TTL_MS,
            ),
            wpkn_market_quote_min_amount: env_i64(
                "WPKN_MARKET_QUOTE_MIN_AMOUNT",
                crate::domain::wpkn::MARKET_QUOTE_MIN_AMOUNT,
            ),
            wpkn_market_quote_max_amount: env_i64(
                "WPKN_MARKET_QUOTE_MAX_AMOUNT",
                crate::domain::wpkn::MARKET_QUOTE_MAX_AMOUNT,
            ),
            wpkn_market_quote_ttl_ms: env_i64(
                "WPKN_MARKET_QUOTE_TTL_MS",
                crate::domain::wpkn::DEFAULT_MARKET_QUOTE_TTL_MS,
            ),
            bitcoin_explorer_api_url: env_first(&["BITCOIN_EXPLORER_API_URL"])
                .unwrap_or_else(|| "https://blockstream.info/api".into()),
            bitcoin_settlement_address: env_first(&["BITCOIN_SETTLEMENT_ADDRESS"]),
            bitcoin_min_confirmations: env_i64("BITCOIN_MIN_CONFIRMATIONS", 1),
            packlink_api_key: env_first(&["PACKLINK_API_KEY"]),
            silver_price_pkn: env_i64("SILVER_PRICE_PKN", SILVER_PRICE_PKN),
            pokoin_treasury_username: env_first(&["POKOIN_TREASURY_USERNAME"])
                .unwrap_or_else(|| "pokoin".into()),
            earn_pkn_inbox: env_first(&["EARN_PKN_INBOX"])
                .unwrap_or_else(|| "support@pokoin.com".into()),
                }
    }

    /// `pknCheckoutReferencePrice()` from `_pkn_checkout_pricing.js`.
    pub fn pkn_checkout_reference_price(&self) -> Result<f64, String> {
        crate::domain::money::pkn_checkout_reference_price(self.pkn_checkout_usdt_price)
    }

    pub fn pkn_usd_price(&self) -> f64 {
        self.crypto_pkn_usdt_price
            .or(self.wpkn_exchange_pkn_usd_price)
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(crate::domain::money::PKN_USD_REFERENCE_PRICE)
    }
}

/// Silver membership price in site PKN (one year). `market/src/silver.js`
/// shows the same price; keep them equal.
pub const SILVER_PRICE_PKN: i64 = 100;

impl Default for CommerceConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silver_price_matches_the_spa() {
        let spa = include_str!("../../../../market/src/silver.js");
        assert!(spa.contains(&format!("SILVER_PRICE_PKN = {SILVER_PRICE_PKN};")));
    }
}
