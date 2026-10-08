//! External service clients: Stripe (REST), EVM/Bitcoin RPC and price oracles.
//!
//! Everything here is direct HTTPS or JSON-RPC — no Node, no shell. Read paths
//! (deposit verification, quotes, price lookups) are complete; key-signing
//! payout paths report themselves unconfigured rather than pretending success,
//! and the commerce coverage file records that.


use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::config::CommerceConfig;
use crate::error::{ApiError, ApiResult};

type HmacSha256 = Hmac<Sha256>;

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> i64;
    fn now_iso(&self) -> String {
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(self.now_ms())
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

pub struct FixedClock(pub i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Price oracle
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct PriceOracle {
    http: reqwest::Client,
    config: Arc<CommerceConfig>,
}

impl PriceOracle {
    pub fn new(http: reqwest::Client, config: Arc<CommerceConfig>) -> Self {
        Self { http, config }
    }

    /// `marketUsdPrice` for one chain asset.
    pub async fn usd_price(&self, asset: &str) -> ApiResult<f64> {
        let config = crate::domain::crypto::normalize_asset(asset)?;
        if config.stablecoin {
            return Ok(1.0);
        }
        let override_key = format!("CRYPTO_PKN_{}_USD_PRICE", config.asset);
        let configured = std::env::var(&override_key)
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0);
        let upstream = match (configured, config.coingecko_id) {
            (Some(price), _) => Some(price),
            (None, Some(id)) => self.coingecko_usd(id).await.ok(),
            (None, None) => None,
        };
        crate::domain::crypto::resolve_market_price(config, configured, upstream)
    }

    pub async fn coingecko_usd(&self, id: &str) -> ApiResult<f64> {
        let url = format!("{}/simple/price", self.config.coingecko_api_base.trim_end_matches('/'));
        let response = self
            .http
            .get(&url)
            .query(&[("ids", id), ("vs_currencies", "usd")])
            .header("accept", "application/json")
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .map_err(|_| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Market price is unavailable."))?;
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Market price is unavailable."))?;
        payload
            .get(id)
            .and_then(|row| row.get("usd"))
            .and_then(Value::as_f64)
            .filter(|price| price.is_finite() && *price > 0.0)
            .ok_or_else(|| {
                ApiError::new(
                    axum::http::StatusCode::BAD_GATEWAY,
                    format!("Market price for {id} is unavailable."),
                )
            })
    }

    /// `geckoTerminalWpknUsd`.
    pub async fn wpkn_usd(&self) -> ApiResult<f64> {
        if let Some(override_price) = self.config.wpkn_usd_price_override {
            return Ok(override_price);
        }
        let token = self.config.wpkn_contract_address.to_ascii_lowercase();
        let url = format!(
            "{}/simple/networks/{}/token_price/{}",
            self.config.geckoterminal_api_base.trim_end_matches('/'),
            self.config.geckoterminal_network.to_ascii_lowercase(),
            token
        );
        let response = self
            .http
            .get(&url)
            .header("accept", "application/json")
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .map_err(|_| ApiError::unavailable("GeckoTerminal wPKN price is unavailable."))?;
        if !response.status().is_success() {
            return Err(ApiError::unavailable("GeckoTerminal wPKN price is unavailable."));
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("GeckoTerminal wPKN price is unavailable."))?;
        payload
            .get("data")
            .and_then(|data| data.get("attributes"))
            .and_then(|attributes| attributes.get("token_prices"))
            .and_then(|prices| prices.get(&token))
            .and_then(Value::as_f64)
            .filter(|price| price.is_finite() && *price > 0.0)
            .ok_or_else(|| ApiError::unavailable("GeckoTerminal returned an invalid wPKN price."))
    }

    /// `marketSpotPrice`: GeckoTerminal with the Pancake fallback.
    /// The GeckoTerminal reference price, when the oracle answers.
    pub async fn wpkn_market_reference(&self) -> Option<f64> {
        let wpkn_usd = self.wpkn_usd().await.ok().filter(|value| *value > 0.0)?;
        Some(crate::domain::wpkn::reference_price_from_usd(
            wpkn_usd,
            self.config.pkn_usd_price(),
        ))
    }

    /// `WPKN_EXCHANGE_MARKET_PRICE`, defaulting to 1 like the Node fallback.
    pub fn configured_wpkn_price(&self) -> f64 {
        self.config
            .wpkn_exchange_market_price
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0)
    }

    /// Market price resolution without the pool probe (GeckoTerminal, then the
    /// configured override). Callers that can reach BSC use
    /// [`ChainClient::pancake_spot_price`] in between, matching Node.
    pub async fn wpkn_pkn_market_price(&self) -> f64 {
        match self.wpkn_market_reference().await {
            Some(price) => price,
            None => self.configured_wpkn_price(),
        }
    }
}

// ---------------------------------------------------------------------------
// Chain RPC
// ---------------------------------------------------------------------------

/// One EVM transfer log the verification paths need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Erc20Transfer {
    pub from: String,
    pub to: String,
    pub value: u128,
    pub tx_hash: String,
}

#[derive(Debug, Clone)]
pub struct EvmTx {
    pub from: String,
    pub to: String,
    pub value: u128,
    pub chain_id: Option<i64>,
    pub tx_hash: String,
}

#[derive(Debug, Clone)]
pub struct EvmReceipt {
    pub status: i64,
    pub block_number: i64,
    pub logs: Vec<Erc20Transfer>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedDeposit {
    pub tx_hash: String,
    pub from_address: String,
    pub amount_in: f64,
    pub block_number: Option<i64>,
}

/// keccak256("Transfer(address,address,uint256)").
pub const ERC20_TRANSFER_TOPIC: &str =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

pub fn parse_hex_u128(value: &str) -> Option<u128> {
    let trimmed = value.trim();
    let digits = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    if digits.is_empty() {
        return Some(0);
    }
    u128::from_str_radix(digits, 16).ok()
}

/// `Number(ethers.formatUnits(value, decimals))`.
pub fn format_units(value: u128, decimals: u32) -> f64 {
    if decimals == 0 {
        return value as f64;
    }
    let divisor = 10f64.powi(decimals.min(38) as i32);
    value as f64 / divisor
}

/// `ethers.parseUnits(amount, decimals)` as an integer, saturating.
pub fn parse_units(amount: f64, decimals: u32) -> u128 {
    if !amount.is_finite() || amount <= 0.0 {
        return 0;
    }
    let scaled = amount * 10f64.powi(decimals.min(38) as i32);
    if scaled >= u128::MAX as f64 {
        u128::MAX
    } else {
        scaled.floor() as u128
    }
}

fn topic_to_address(topic: &str) -> String {
    let digits = topic.trim().strip_prefix("0x").unwrap_or(topic.trim());
    if digits.len() >= 40 {
        format!("0x{}", &digits[digits.len() - 40..].to_ascii_lowercase())
    } else {
        String::new()
    }
}

#[derive(Clone)]
pub struct ChainClient {
    http: reqwest::Client,
    config: Arc<CommerceConfig>,
}

impl ChainClient {
    pub fn new(http: reqwest::Client, config: Arc<CommerceConfig>) -> Self {
        Self { http, config }
    }

    pub async fn rpc(&self, url: &str, method: &str, params: Value) -> ApiResult<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let response = self
            .http
            .post(url)
            .json(&body)
            .timeout(Duration::from_secs(6))
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Chain RPC is unavailable."))?;
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Chain RPC returned an invalid response."))?;
        if let Some(error) = payload.get("error") {
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                format!("Chain RPC error: {error}"),
            ));
        }
        Ok(payload.get("result").cloned().unwrap_or(Value::Null))
    }

    fn rpc_for(&self, asset: &str) -> String {
        match asset {
            "ETH" | "EURC" | "LINK" | "UNI" => self.config.ethereum_rpc_url.clone(),
            _ => self.config.bnb_rpc_url.clone(),
        }
    }

    fn token_address(&self, asset: &str) -> Option<String> {
        let configured = match asset {
            "USDT" => self.config.usdt_bnb_contract_address.clone(),
            "USDC" => self.config.usdc_bnb_contract_address.clone(),
            "DAI" => self.config.dai_bnb_contract_address.clone(),
            "EURC" => self.config.eurc_eth_contract_address.clone(),
            "LINK" => self.config.link_eth_contract_address.clone(),
            "UNI" => self.config.uni_eth_contract_address.clone(),
            "CAKE" => self.config.cake_bnb_contract_address.clone(),
            _ => None,
        };
        configured
            .or_else(|| {
                crate::domain::crypto::chain_config(asset)
                    .and_then(|config| config.default_token_address)
                    .map(|value| value.to_string())
            })
            .map(|value| value.to_ascii_lowercase())
    }

    /// `settlementAddress()` for the crypto purchase flow.
    pub fn crypto_settlement_address(&self) -> ApiResult<String> {
        crate::domain::crypto::normalize_address(
            self.config
                .crypto_pkn_settlement_address
                .as_deref()
                .unwrap_or(crate::domain::crypto::DEFAULT_SETTLEMENT_ADDRESS),
            "Crypto settlement address is not configured.",
        )
    }

    pub fn wpkn_settlement_address(&self) -> ApiResult<String> {
        crate::domain::crypto::normalize_address(
            self.config.wpkn_settlement_address.as_deref().unwrap_or_default(),
            "wPKN settlement address is not configured.",
        )
    }

    pub async fn get_transaction(&self, url: &str, tx_hash: &str) -> ApiResult<Option<EvmTx>> {
        let result = self
            .rpc(url, "eth_getTransactionByHash", json!([tx_hash]))
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        Ok(Some(EvmTx {
            from: result
                .get("from")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase(),
            to: result
                .get("to")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase(),
            value: result
                .get("value")
                .and_then(Value::as_str)
                .and_then(parse_hex_u128)
                .unwrap_or(0),
            chain_id: result.get("chainId").and_then(Value::as_str).and_then(|value| {
                let digits = value.strip_prefix("0x").unwrap_or(value);
                i64::from_str_radix(digits, 16).ok()
            }),
            tx_hash: tx_hash.to_ascii_lowercase(),
        }))
    }

    pub async fn get_receipt(&self, url: &str, tx_hash: &str) -> ApiResult<Option<EvmReceipt>> {
        let result = self
            .rpc(url, "eth_getTransactionReceipt", json!([tx_hash]))
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        let logs = result
            .get("logs")
            .and_then(Value::as_array)
            .map(|logs| {
                logs.iter()
                    .filter_map(|log| decode_transfer_log(log, tx_hash))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(Some(EvmReceipt {
            status: result
                .get("status")
                .and_then(Value::as_str)
                .map(|value| {
                    let digits = value.strip_prefix("0x").unwrap_or(value);
                    i64::from_str_radix(digits, 16).unwrap_or(0)
                })
                .unwrap_or(0),
            block_number: result
                .get("blockNumber")
                .and_then(Value::as_str)
                .map(|value| {
                    let digits = value.strip_prefix("0x").unwrap_or(value);
                    i64::from_str_radix(digits, 16).unwrap_or(0)
                })
                .unwrap_or(0),
            logs,
        }))
    }

    pub async fn token_decimals(&self, url: &str, token: &str) -> u32 {
        // decimals() selector 0x313ce567
        let result = self
            .rpc(
                url,
                "eth_call",
                json!([{ "to": token, "data": "0x313ce567" }, "latest"]),
            )
            .await
            .ok();
        result
            .as_ref()
            .and_then(Value::as_str)
            .and_then(parse_hex_u128)
            .filter(|value| *value > 0 && *value <= 36)
            .map(|value| value as u32)
            .unwrap_or(18)
    }

    /// `verifyNativeDeposit` for an EVM native coin.
    pub async fn verify_native_deposit(
        &self,
        asset: &str,
        tx_hash: &str,
        from_address: &str,
        expected_amount: f64,
    ) -> ApiResult<VerifiedDeposit> {
        let config = crate::domain::crypto::normalize_asset(asset)?;
        let url = self.rpc_for(config.asset);
        let normalized_tx = crate::domain::crypto::normalize_tx_hash(tx_hash)?;
        let normalized_from = crate::domain::crypto::normalize_address(
            from_address,
            "Deposit must be sent from your linked wallet.",
        )?;
        let expected_to = self.crypto_settlement_address()?;

        let (tx, receipt) = tokio::join!(
            self.get_transaction(&url, &normalized_tx),
            self.get_receipt(&url, &normalized_tx)
        );
        let (Some(tx), Some(receipt)) = (tx?, receipt?) else {
            return Err(ApiError::not_found("Deposit transaction was not found yet."));
        };
        if receipt.status != 1 {
            return Err(ApiError::bad_request("Deposit transaction failed."));
        }
        if let Some(chain_id) = config.chain_id {
            if tx.chain_id != Some(chain_id) {
                return Err(ApiError::bad_request(format!(
                    "Deposit must be on {}.",
                    config.chain_name
                )));
            }
        }
        if tx.from != normalized_from {
            return Err(ApiError::forbidden(
                "Deposit transaction must be sent from your linked wallet.",
            ));
        }
        if tx.to != expected_to {
            return Err(ApiError::bad_request(
                "Deposit transaction must be sent to the Pokoin settlement wallet.",
            ));
        }
        if tx.value < parse_units(expected_amount, 18) {
            return Err(ApiError::bad_request(
                "Deposit amount is lower than the quoted amount.",
            ));
        }
        Ok(VerifiedDeposit {
            tx_hash: normalized_tx,
            from_address: normalized_from,
            amount_in: format_units(tx.value, 18),
            block_number: Some(receipt.block_number),
        })
    }

    /// `verifyTokenDeposit` for an ERC-20.
    pub async fn verify_token_deposit(
        &self,
        asset: &str,
        tx_hash: &str,
        from_address: &str,
        expected_amount: f64,
    ) -> ApiResult<VerifiedDeposit> {
        let config = crate::domain::crypto::normalize_asset(asset)?;
        let url = self.rpc_for(config.asset);
        let normalized_tx = crate::domain::crypto::normalize_tx_hash(tx_hash)?;
        let normalized_from = crate::domain::crypto::normalize_address(
            from_address,
            "Deposit must be sent from your linked wallet.",
        )?;
        let expected_to = self.crypto_settlement_address()?;
        let token = self.token_address(config.asset).ok_or_else(|| {
            ApiError::internal(format!("{} token contract is not configured.", config.asset))
        })?;
        let Some(receipt) = self.get_receipt(&url, &normalized_tx).await? else {
            return Err(ApiError::not_found("Deposit transaction was not found yet."));
        };
        if receipt.status != 1 {
            return Err(ApiError::bad_request("Deposit transaction failed."));
        }
        let decimals = self.token_decimals(&url, &token).await;
        let required = parse_units(expected_amount, decimals);
        let deposited: u128 = receipt
            .logs
            .iter()
            .filter(|log| log.to == expected_to && log.from == normalized_from)
            .map(|log| log.value)
            .fold(0u128, |sum, value| sum.saturating_add(value));
        if deposited < required {
            return Err(ApiError::bad_request(
                "Deposit amount is lower than the quoted amount.",
            ));
        }
        Ok(VerifiedDeposit {
            tx_hash: normalized_tx,
            from_address: normalized_from,
            amount_in: format_units(deposited, decimals),
            block_number: Some(receipt.block_number),
        })
    }

    /// `verifyBitcoinDeposit` via the configured block explorer.
    pub async fn verify_bitcoin_deposit(
        &self,
        tx_hash: &str,
        expected_amount: f64,
    ) -> ApiResult<VerifiedDeposit> {
        let txid = crate::domain::crypto::normalize_bitcoin_txid(tx_hash)?;
        let expected_to = crate::domain::crypto::normalize_bitcoin_address(
            self.config.bitcoin_settlement_address.as_deref().unwrap_or_default(),
        )?;
        let base = self.config.bitcoin_explorer_api_url.trim_end_matches('/');
        let response = self
            .http
            .get(format!("{base}/tx/{txid}"))
            .header("accept", "application/json")
            .timeout(Duration::from_secs(6))
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Bitcoin explorer is unavailable."))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ApiError::not_found(
                "Bitcoin deposit transaction was not found yet.",
            ));
        }
        let tx: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Bitcoin deposit transaction is unavailable."))?;
        let confirmed = tx
            .get("status")
            .and_then(|status| status.get("confirmed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let block_height = tx
            .get("status")
            .and_then(|status| status.get("block_height"))
            .and_then(Value::as_i64);
        let mut confirmations = if confirmed { 1 } else { 0 };
        if confirmed {
            if let Some(height) = block_height {
                if let Ok(tip_response) = self
                    .http
                    .get(format!("{base}/blocks/tip/height"))
                    .timeout(Duration::from_secs(4))
                    .send()
                    .await
                {
                    if let Ok(text) = tip_response.text().await {
                        if let Ok(tip) = text.trim().parse::<i64>() {
                            if tip >= height {
                                confirmations = tip - height + 1;
                            }
                        }
                    }
                }
            }
        }
        if confirmations < self.config.bitcoin_min_confirmations {
            return Err(ApiError::conflict("Bitcoin deposit is not confirmed yet."));
        }
        let deposited_sats: i64 = tx
            .get("vout")
            .and_then(Value::as_array)
            .map(|outputs| {
                outputs
                    .iter()
                    .filter(|output| {
                        output.get("scriptpubkey_address").and_then(Value::as_str) == Some(&expected_to)
                    })
                    .map(|output| output.get("value").and_then(Value::as_i64).unwrap_or(0))
                    .sum()
            })
            .unwrap_or(0);
        let required_sats = (expected_amount * 100_000_000.0).ceil() as i64;
        if deposited_sats < required_sats {
            return Err(ApiError::bad_request(
                "Bitcoin deposit amount is lower than the quoted amount.",
            ));
        }
        Ok(VerifiedDeposit {
            tx_hash: txid,
            from_address: "bitcoin".into(),
            amount_in: deposited_sats as f64 / 100_000_000.0,
            block_number: block_height,
        })
    }

    /// `verifyCryptoDeposit` dispatch.
    pub async fn verify_crypto_deposit(
        &self,
        asset: &str,
        tx_hash: &str,
        from_address: &str,
        expected_amount: f64,
    ) -> ApiResult<VerifiedDeposit> {
        let config = crate::domain::crypto::normalize_asset(asset)?;
        if config.bitcoin {
            return self.verify_bitcoin_deposit(tx_hash, expected_amount).await;
        }
        if config.native {
            return self
                .verify_native_deposit(config.asset, tx_hash, from_address, expected_amount)
                .await;
        }
        self.verify_token_deposit(config.asset, tx_hash, from_address, expected_amount)
            .await
    }

    /// `verifyNativeDeposit` for the Pokoin PoS chain (top-up funding).
    pub async fn verify_pokoin_deposit(
        &self,
        tx_hash: &str,
        from_address: &str,
        expected_amount_pkn: f64,
    ) -> ApiResult<VerifiedDeposit> {
        let url = self.config.pokoin_rpc_url.clone();
        let treasury = self.config.pokoin_bank_address.to_ascii_lowercase();
        let normalized_tx = crate::domain::crypto::normalize_tx_hash(tx_hash)?;
        let normalized_from = crate::domain::crypto::normalize_address(
            from_address,
            "Link the wallet that funded this transfer before sending.",
        )?;
        let mut tx = None;
        let mut receipt = None;
        for _ in 0..6 {
            let (maybe_tx, maybe_receipt) = tokio::join!(
                self.get_transaction(&url, &normalized_tx),
                self.get_receipt(&url, &normalized_tx)
            );
            tx = maybe_tx?;
            receipt = maybe_receipt?;
            if tx.is_some() && receipt.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        let (Some(tx), Some(receipt)) = (tx, receipt) else {
            return Err(ApiError::not_found("Funding transaction was not found yet."));
        };
        if receipt.status != 1 {
            return Err(ApiError::bad_request(
                "Funding transaction failed on PokoinPoS.",
            ));
        }
        if tx.from != normalized_from {
            return Err(ApiError::forbidden(
                "Funding transaction must be sent from your linked wallet.",
            ));
        }
        if tx.to != treasury {
            return Err(ApiError::bad_request(
                "Funding transaction must be sent to the Pokoin treasury wallet.",
            ));
        }
        if tx.value < parse_units(expected_amount_pkn, 18) {
            return Err(ApiError::bad_request("Funding transaction amount is too low."));
        }
        Ok(VerifiedDeposit {
            tx_hash: normalized_tx,
            from_address: normalized_from,
            amount_in: format_units(tx.value, 18),
            block_number: Some(receipt.block_number),
        })
    }

    /// `addressTransactions` from the Pokoin explorer.
    pub async fn address_transactions(&self, address: &str, limit: usize) -> ApiResult<Vec<Value>> {
        let normalized = crate::domain::crypto::normalize_address(address, "Enter a valid 0x address.")?;
        let base = self
            .config
            .pokoin_rpc_url
            .trim()
            .trim_end_matches("/rpc")
            .trim_end_matches('/');
        let response = self
            .http
            .get(format!("{base}/explorer/address/{normalized}"))
            .timeout(Duration::from_secs(6))
            .send()
            .await
            .map_err(|_| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Could not load Pokoin bank activity."))?;
        if !response.status().is_success() {
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                "Could not load Pokoin bank activity.",
            ));
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Could not load Pokoin bank activity."))?;
        Ok(payload
            .get("transactions")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().take(limit).cloned().collect())
            .unwrap_or_default())
    }

    /// `findWpknDeposit`: scan recent Transfer logs to the settlement wallet.
    pub async fn find_wpkn_deposit(
        &self,
        from_address: &str,
        expected_amount_wpkn: f64,
        used_tx_hashes: &[String],
    ) -> ApiResult<VerifiedDeposit> {
        let settlement = self.wpkn_settlement_address()?;
        let normalized_from = crate::domain::crypto::normalize_address(
            from_address,
            "Link the BSC wallet that sent the wPKN deposit before requesting payout.",
        )?;
        let contract = crate::domain::crypto::normalize_address(
            &self.config.wpkn_contract_address,
            "wPKN contract is not configured.",
        )?;
        let url = self.config.bnb_rpc_url.clone();
        let latest = self
            .rpc(&url, "eth_blockNumber", json!([]))
            .await
            .ok()
            .and_then(|value| value.as_str().and_then(parse_hex_u128))
            .unwrap_or(0) as i64;
        let lookback: i64 = std::env::var("WPKN_EXCHANGE_DEPOSIT_LOOKBACK_BLOCKS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(120_000);
        let from_block = (latest - lookback).max(0);
        let logs = self
            .rpc(
                &url,
                "eth_getLogs",
                json!([{
                    "address": contract,
                    "fromBlock": format!("0x{from_block:x}"),
                    "toBlock": "latest",
                    "topics": [
                        ERC20_TRANSFER_TOPIC,
                        format!("0x{:0>64}", normalized_from.trim_start_matches("0x")),
                        format!("0x{:0>64}", settlement.trim_start_matches("0x")),
                    ],
                }]),
            )
            .await?;
        let decimals = self.token_decimals(&url, &contract).await;
        let required = parse_units(expected_amount_wpkn, decimals);
        let mut used: Vec<String> = used_tx_hashes.iter().map(|hash| hash.to_ascii_lowercase()).collect();
        let empty = Vec::new();
        let entries = logs.as_array().unwrap_or(&empty);
        for log in entries.iter().rev() {
            let tx_hash = log
                .get("transactionHash")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if tx_hash.is_empty() || used.contains(&tx_hash) {
                continue;
            }
            let Some(data) = log.get("data").and_then(Value::as_str) else {
                continue;
            };
            let Some(value) = parse_hex_u128(data) else {
                continue;
            };
            if value < required {
                continue;
            }
            if let Ok(Some(receipt)) = self.get_receipt(&url, &tx_hash).await {
                if receipt.status != 1 {
                    continue;
                }
            }
            used.push(tx_hash.clone());
            return Ok(VerifiedDeposit {
                tx_hash,
                from_address: normalized_from,
                amount_in: format_units(value, decimals),
                block_number: None,
            });
        }
        Err(ApiError::not_found(
            "No matching wPKN deposit was found yet. Send wPKN to the settlement wallet, wait for confirmation, then try again.",
        ))
    }

    // --- transaction building helpers -------------------------------------

    async fn rpc_u128(&self, url: &str, method: &str, params: Value) -> ApiResult<Option<u128>> {
        let result = self.rpc(url, method, params).await?;
        Ok(result.as_str().and_then(parse_hex_u128))
    }

    async fn chain_id(&self, url: &str) -> ApiResult<u128> {
        self.rpc_u128(url, "eth_chainId", json!([]))
            .await?
            .ok_or_else(|| ApiError::unavailable("Chain RPC did not return a chain id."))
    }

    async fn pending_nonce(&self, url: &str, address: &str) -> ApiResult<u128> {
        self.rpc_u128(url, "eth_getTransactionCount", json!([address, "pending"]))
            .await?
            .ok_or_else(|| ApiError::unavailable("Chain RPC did not return a nonce."))
    }

    async fn gas_price(&self, url: &str) -> u128 {
        self.rpc_u128(url, "eth_gasPrice", json!([]))
            .await
            .ok()
            .flatten()
            .unwrap_or(0)
    }

    async fn estimate_gas(
        &self,
        url: &str,
        from: &str,
        to: &str,
        value: u128,
        data: &[u8],
    ) -> Option<u128> {
        let call = if data.is_empty() {
            json!({ "from": from, "to": to, "value": format!("0x{:x}", value) })
        } else {
            json!({
                "from": from,
                "to": to,
                "value": format!("0x{:x}", value),
                "data": format!("0x{}", hex::encode(data)),
            })
        };
        self.rpc_u128(url, "eth_estimateGas", json!([call]))
            .await
            .ok()
            .flatten()
    }

    async fn send_raw_transaction(&self, url: &str, raw_hex: &str) -> ApiResult<String> {
        let result = self.rpc(url, "eth_sendRawTransaction", json!([raw_hex])).await?;
        result
            .as_str()
            .map(|value| value.to_string())
            .ok_or_else(|| ApiError::unavailable("Chain RPC rejected the payout transaction."))
    }

    fn payout_private_key(&self, config: &crate::domain::crypto::ChainConfig) -> Option<String> {
        if config.bitcoin {
            return None;
        }
        let per_asset = format!("CRYPTO_PKN_{}_PAYOUT_PRIVATE_KEY", config.asset);
        std::env::var(per_asset)
            .ok()
            .or_else(|| std::env::var(format!("{}_PAYOUT_PRIVATE_KEY", config.asset)).ok())
            .or_else(|| std::env::var("CRYPTO_PKN_EVM_PAYOUT_PRIVATE_KEY").ok())
            .or_else(|| std::env::var("BNB_SETTLEMENT_PRIVATE_KEY").ok())
            .filter(|value| !value.trim().is_empty())
    }

    /// Measured payout-wallet liquidity for an EVM asset.
    ///
    /// Native coins read `eth_getBalance`; ERC-20 tokens read `balanceOf`
    /// through `eth_call`. `None` means no payout key is configured (the caller
    /// reports 503), matching the Node `payoutLiquidityFor` contract.
    pub async fn evm_payout_liquidity(&self, asset: &str) -> ApiResult<Option<f64>> {
        let config = crate::domain::crypto::normalize_asset(asset)?;
        if config.bitcoin {
            return Ok(None);
        }
        let Some(key) = self.payout_private_key(config) else {
            return Ok(None);
        };
        let from = crate::evm::address_from_private_key(&key)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let url = self.rpc_for(config.asset);
        if config.native {
            let wei = self
                .rpc_u128(&url, "eth_getBalance", json!([from, "latest"]))
                .await?
                .unwrap_or(0);
            return Ok(Some(format_units(wei, 18)));
        }
        let token = self.token_address(config.asset).ok_or_else(|| {
            ApiError::internal(format!("{} token contract is not configured.", config.asset))
        })?;
        let decimals = self.token_decimals(&url, &token).await;
        let data = crate::evm::erc20_balance_of_data(&from)?;
        let result = self
            .rpc(
                &url,
                "eth_call",
                json!([{ "to": token, "data": format!("0x{}", hex::encode(data)) }, "latest"]),
            )
            .await?;
        let balance = result.as_str().and_then(parse_hex_u128).unwrap_or(0);
        Ok(Some(format_units(balance, decimals)))
    }

    /// Sign and submit an EVM payout (native coin or ERC-20 transfer).
    ///
    /// Without a configured key this returns `manual_pending`, exactly like the
    /// Node runtime. With a key it signs an EIP-155 legacy transaction and
    /// submits it; a malformed or rejected transaction is an error, never a
    /// fabricated success.
    pub async fn send_evm_payout(
        &self,
        asset: &str,
        to_address: &str,
        amount: f64,
    ) -> ApiResult<(String, Option<String>)> {
        let config = crate::domain::crypto::normalize_asset(asset)?;
        if config.bitcoin {
            // Bitcoin is signed through the P2WPKH path, not this EVM dispatcher.
            return Err(ApiError::internal(
                "Bitcoin payouts use the P2WPKH signer; this call only handles EVM assets.",
            )
            .with_code("payout_asset_mismatch"));
        }
        let Some(key) = self.payout_private_key(config) else {
            return Ok(("manual_pending".into(), None));
        };
        let url = self.rpc_for(config.asset);
        let to = crate::domain::crypto::normalize_address(
            to_address,
            &format!("Enter a valid {} payout address.", config.asset),
        )?;
        let from = crate::evm::address_from_private_key(&key)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let chain_id = self.chain_id(&url).await?;
        let nonce = self.pending_nonce(&url, &from).await?;
        let gas_price = self.gas_price(&url).await;

        let (target, value, data, default_gas) = if config.native {
            (to.clone(), parse_units(amount, 18), Vec::new(), 21_000u128)
        } else {
            let token = self.token_address(config.asset).ok_or_else(|| {
                ApiError::internal(format!("{} token contract is not configured.", config.asset))
            })?;
            let decimals = self.token_decimals(&url, &token).await;
            let data = crate::evm::erc20_transfer_data(&to, parse_units(amount, decimals))?;
            (token, 0u128, data, 65_000u128)
        };
        // `assertPayoutLiquidity`: never sign a payout the wallet cannot fund.
        if let Some(available) = self.evm_payout_liquidity(config.asset).await? {
            if available < amount {
                return Err(ApiError::conflict(format!(
                    "{} payout liquidity is too low. Available: {} {}.",
                    config.asset, available, config.asset
                ))
                .with_code("payout_liquidity_low")
                .with_meta(json!({ "available": available, "required": amount })));
            }
        }
        let gas_limit = self
            .estimate_gas(&url, &from, &target, value, &data)
            .await
            .unwrap_or(default_gas);

        let signed = crate::evm::sign_legacy_transaction(
            &key,
            chain_id,
            nonce,
            gas_price,
            gas_limit,
            &target,
            value,
            &data,
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
        let tx_hash = self.send_raw_transaction(&url, &signed.raw_hex).await?;
        Ok(("automatic_available".into(), Some(tx_hash)))
    }

    /// Payout dispatch used by the crypto sale path.
    pub async fn payout(
        &self,
        asset: &str,
        to_address: &str,
        amount: f64,
    ) -> ApiResult<(String, Option<String>)> {
        let config = crate::domain::crypto::normalize_asset(asset)?;
        if config.bitcoin {
            return self.bitcoin_payout(to_address, amount).await;
        }
        self.send_evm_payout(config.asset, to_address, amount).await
    }

    // --- Bitcoin (P2WPKH) -------------------------------------------------

    fn bitcoin_wif(&self) -> Option<String> {
        std::env::var("BITCOIN_PAYOUT_PRIVATE_KEY_WIF")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    pub fn bitcoin_network(&self) -> crate::bitcoin::Network {
        crate::bitcoin::Network::from_env_value(
            &std::env::var("BITCOIN_NETWORK").unwrap_or_default(),
        )
    }

    /// `fetchFeeRate`: env override, else the explorer's 3/6-block estimate.
    async fn bitcoin_fee_rate(&self, base: &str) -> u64 {
        if let Ok(raw) = std::env::var("BITCOIN_FEE_RATE_SATS_PER_VBYTE") {
            if let Ok(parsed) = raw.trim().parse::<f64>() {
                if parsed.is_finite() && parsed > 0.0 {
                    return parsed.ceil() as u64;
                }
            }
        }
        let payload: Value = match self
            .http
            .get(format!("{base}/fee-estimates"))
            .header("accept", "application/json")
            .timeout(Duration::from_secs(6))
            .send()
            .await
        {
            Ok(response) => response.json().await.unwrap_or(json!({})),
            Err(_) => json!({}),
        };
        let value = payload
            .get("3")
            .or_else(|| payload.get("6"))
            .and_then(Value::as_f64)
            .unwrap_or(crate::bitcoin::DEFAULT_FEE_RATE as f64);
        (value.ceil() as u64).max(1)
    }

    async fn bitcoin_utxos(&self, base: &str, address: &str) -> ApiResult<Vec<crate::bitcoin::Utxo>> {
        let response = self
            .http
            .get(format!("{base}/address/{address}/utxo"))
            .header("accept", "application/json")
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Bitcoin explorer request failed."))?;
        if !response.status().is_success() {
            return Err(ApiError::unavailable("Bitcoin explorer request failed."));
        }
        let rows: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Bitcoin explorer request failed."))?;
        let empty = Vec::new();
        Ok(rows
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter_map(|row| {
                let txid = row.get("txid").and_then(Value::as_str)?.to_string();
                let vout = row.get("vout").and_then(Value::as_u64).unwrap_or(0) as u32;
                let value = row.get("value").and_then(Value::as_u64).unwrap_or(0);
                let confirmed = row
                    .get("status")
                    .and_then(|status| status.get("confirmed"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Some(crate::bitcoin::Utxo {
                    txid,
                    vout,
                    value,
                    confirmed,
                })
            })
            .collect())
    }

    /// Confirmed Bitcoin payout liquidity in sats.
    pub async fn bitcoin_payout_liquidity(&self) -> ApiResult<Option<u64>> {
        let Some(wif) = self.bitcoin_wif() else {
            return Ok(None);
        };
        let key = crate::bitcoin::decode_wif(&wif)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let network = self.bitcoin_network();
        if key.network != network {
            return Err(ApiError::internal(
                "BITCOIN_PAYOUT_PRIVATE_KEY_WIF does not match BITCOIN_NETWORK.",
            ));
        }
        let pubkey = crate::bitcoin::compressed_pubkey(&key.secret)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let address = match std::env::var("BITCOIN_PAYOUT_ADDRESS") {
            Ok(configured) if !configured.trim().is_empty() => configured.trim().to_string(),
            _ => crate::bitcoin::p2wpkh_address(&pubkey, network)
                .map_err(|error| ApiError::internal(error.to_string()))?,
        };
        let base = self.config.bitcoin_explorer_api_url.trim_end_matches('/');
        let utxos = self.bitcoin_utxos(base, &address).await?;
        let fee_rate = self.bitcoin_fee_rate(base).await;
        Ok(Some(crate::bitcoin::payout_liquidity_sats(&utxos, fee_rate)))
    }

    /// `sendBitcoinPayout`: build, sign and broadcast a P2WPKH payout.
    pub async fn bitcoin_payout(
        &self,
        to_address: &str,
        amount_btc: f64,
    ) -> ApiResult<(String, Option<String>)> {
        let Some(wif) = self.bitcoin_wif() else {
            return Ok(("bitcoin_manual_pending".into(), None));
        };
        let key = crate::bitcoin::decode_wif(&wif)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let network = self.bitcoin_network();
        if key.network != network {
            return Err(ApiError::internal(
                "BITCOIN_PAYOUT_PRIVATE_KEY_WIF does not match BITCOIN_NETWORK.",
            ));
        }
        let pubkey = crate::bitcoin::compressed_pubkey(&key.secret)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let from_address = match std::env::var("BITCOIN_PAYOUT_ADDRESS") {
            Ok(configured) if !configured.trim().is_empty() => configured.trim().to_string(),
            _ => crate::bitcoin::p2wpkh_address(&pubkey, network)
                .map_err(|error| ApiError::internal(error.to_string()))?,
        };
        let recipient_script = crate::bitcoin::address_to_output_script(to_address, network)?;
        let change_script = crate::bitcoin::p2wpkh_script(&pubkey);
        let amount_sats = crate::bitcoin::sats_from_btc(amount_btc)?;

        let min_sats = env_f64("BITCOIN_MIN_PAYOUT_BTC", crate::bitcoin::DEFAULT_MIN_PAYOUT_BTC);
        let max_sats = env_f64("BITCOIN_MAX_PAYOUT_BTC", crate::bitcoin::DEFAULT_MAX_PAYOUT_BTC);
        let min_sats = crate::bitcoin::sats_from_btc(min_sats).unwrap_or(1_000);
        let max_sats = crate::bitcoin::sats_from_btc(max_sats).unwrap_or(1_000_000);
        if amount_sats < min_sats {
            return Err(ApiError::bad_request("BTC payout amount is below the minimum."));
        }
        if amount_sats > max_sats {
            return Err(ApiError::bad_request("BTC payout amount exceeds the maximum."));
        }

        let base = self.config.bitcoin_explorer_api_url.trim_end_matches('/');
        let utxos = self.bitcoin_utxos(base, &from_address).await?;
        let fee_rate = self.bitcoin_fee_rate(base).await;
        let built = crate::bitcoin::build_p2wpkh_payout(
            &key.secret,
            &utxos,
            amount_sats,
            fee_rate,
            &recipient_script,
            &change_script,
        )
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("insufficient") {
                ApiError::conflict("BTC payout wallet has insufficient confirmed liquidity.")
            } else {
                ApiError::internal(message)
            }
        })?;

        let response = self
            .http
            .post(format!("{base}/tx"))
            .header("content-type", "text/plain")
            .timeout(Duration::from_secs(10))
            .body(built.raw_hex.clone())
            .send()
            .await
            .map_err(|_| ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "Bitcoin payout broadcast failed."))?;
        let broadcast_ok = response.status().is_success();
        let body = response.text().await.unwrap_or_default();
        let txid = body.trim().to_ascii_lowercase();
        if !broadcast_ok || txid.len() != 64 || !txid.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                if txid.is_empty() { "Bitcoin payout broadcast failed.".to_string() } else { txid },
            ));
        }
        Ok(("automatic_bitcoin".into(), Some(txid)))
    }

    pub fn has_bank_key(&self) -> bool {
        self.config
            .pokoin_bank_private_key
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    }

    pub fn has_reserve_key(&self) -> bool {
        self.config
            .pokoin_reserve_private_key
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    }

    pub fn has_wpkn_settlement(&self) -> bool {
        self.config
            .bnb_settlement_private_key
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
            && self.config.wpkn_settlement_address.is_some()
    }

    /// Sign and submit a native PKN payout from one of the Pokoin wallets.
    async fn send_native_pkn(
        &self,
        key: Option<&str>,
        expected_address: &str,
        to_address: &str,
        amount_pkn: f64,
        signer_label: &str,
    ) -> ApiResult<(String, Option<String>)> {
        let Some(key) = key.filter(|value| !value.trim().is_empty()) else {
            return Ok(("manual_pending".into(), None));
        };
        let derived = crate::evm::address_from_private_key(key)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let expected = expected_address.trim().to_ascii_lowercase();
        if derived != expected {
            return Err(ApiError::internal(format!(
                "{signer_label} private key does not match the configured address."
            )));
        }
        let url = self.config.pokoin_rpc_url.clone();
        let to = crate::domain::crypto::normalize_address(
            to_address,
            "Recipient payout wallet is invalid.",
        )?;
        let chain_id = self.chain_id(&url).await?;
        let nonce = self.pending_nonce(&url, &derived).await?;
        let gas_price = self.gas_price(&url).await;
        let value = parse_units(amount_pkn, 18);
        let gas_limit = self
            .estimate_gas(&url, &derived, &to, value, &[])
            .await
            .unwrap_or(21_000);
        let signed = crate::evm::sign_legacy_transaction(
            key, chain_id, nonce, gas_price, gas_limit, &to, value, &[],
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
        let tx_hash = self.send_raw_transaction(&url, &signed.raw_hex).await?;
        Ok(("automatic_available".into(), Some(tx_hash)))
    }

    /// Pokoin bank (treasury) payout.
    pub async fn send_bank_pkn(
        &self,
        to_address: &str,
        amount_pkn: f64,
    ) -> ApiResult<(String, Option<String>)> {
        self.send_native_pkn(
            self.config.pokoin_bank_private_key.as_deref(),
            &self.config.pokoin_bank_address,
            to_address,
            amount_pkn,
            "POKOIN_BANK_PRIVATE_KEY",
        )
        .await
    }

    /// Pokoin reserve payout (wPKN -> PKN settlement).
    pub async fn send_reserve_pkn(
        &self,
        to_address: &str,
        amount_pkn: f64,
    ) -> ApiResult<(String, Option<String>)> {
        self.send_native_pkn(
            self.config.pokoin_reserve_private_key.as_deref(),
            &self.config.pokoin_reserve_address,
            to_address,
            amount_pkn,
            "POKOIN_RESERVE_PRIVATE_KEY",
        )
        .await
    }

    /// The configured wPKN ERC-20 contract on BSC.
    pub fn wpkn_token(&self) -> ApiResult<String> {
        crate::domain::crypto::normalize_address(
            &self.config.wpkn_contract_address,
            "wPKN contract is not configured.",
        )
    }

    /// Measured wPKN balance of the settlement wallet.
    pub async fn wpkn_payout_liquidity(&self) -> ApiResult<Option<f64>> {
        if !self.has_wpkn_settlement() {
            return Ok(None);
        }
        let key = self
            .config
            .bnb_settlement_private_key
            .clone()
            .unwrap_or_default();
        let from = crate::evm::address_from_private_key(&key)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let url = self.config.bnb_rpc_url.clone();
        let token = self.wpkn_token()?;
        let decimals = self.token_decimals(&url, &token).await;
        let data = crate::evm::erc20_balance_of_data(&from)?;
        let result = self
            .rpc(
                &url,
                "eth_call",
                json!([{ "to": token, "data": format!("0x{}", hex::encode(data)) }, "latest"]),
            )
            .await?;
        let balance = result.as_str().and_then(parse_hex_u128).unwrap_or(0);
        Ok(Some(format_units(balance, decimals)))
    }

    /// `bnbUsdPrice`: env override, else CoinGecko.
    pub async fn bnb_usd_price(&self) -> f64 {
        if let Ok(raw) = std::env::var("WPKN_EXCHANGE_BNB_USD_PRICE") {
            if let Ok(parsed) = raw.trim().parse::<f64>() {
                if parsed.is_finite() && parsed > 0.0 {
                    return parsed;
                }
            }
        }
        let payload: Value = match self
            .http
            .get("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd")
            .header("accept", "application/json")
            .timeout(Duration::from_secs(6))
            .send()
            .await
        {
            Ok(response) => response.json().await.unwrap_or(json!({})),
            Err(_) => json!({}),
        };
        payload
            .get("binancecoin")
            .and_then(|row| row.get("usd"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0)
    }

    /// Decode a fixed-width ABI word at `index` from an `eth_call` result.
    fn abi_word(result: &str, index: usize) -> Option<[u8; 32]> {
        let digits = result.trim().trim_start_matches("0x");
        let start = index * 64;
        if digits.len() < start + 64 {
            return None;
        }
        let bytes = hex::decode(&digits[start..start + 64]).ok()?;
        let mut word = [0u8; 32];
        word.copy_from_slice(&bytes);
        Some(word)
    }

    fn abi_address(result: &str, index: usize) -> Option<String> {
        let word = Self::abi_word(result, index)?;
        Some(format!("0x{}", hex::encode(&word[12..])))
    }

    /// `pancakeSpotPrice()`: wPKN in PKN from the live Pancake pair reserves,
    /// read through direct JSON-RPC calls (never a cached/stored value).
    pub async fn pancake_spot_price(&self) -> Option<f64> {
        let Some(pair) = self
            .config
            .pancake_wpkn_bnb_pair_address
            .clone()
            .filter(|value| !value.trim().is_empty())
        else {
            return None;
        };
        let wpkn = self.wpkn_token().ok()?;
        let url = self.config.bnb_rpc_url.clone();
        if url.trim().is_empty() {
            return None;
        }
        // token0()
        let token0_data = format!("0x{}", hex::encode(&crate::evm::keccak256(b"token0()")[..4]));
        let token0_result = self
            .rpc(&url, "eth_call", json!([{ "to": pair, "data": token0_data }, "latest"]))
            .await
            .ok()?;
        let token0 = Self::abi_address(token0_result.as_str()?, 0)?;
        // getReserves() -> (uint112, uint112, uint32)
        let reserves_data = format!("0x{}", hex::encode(&crate::evm::keccak256(b"getReserves()")[..4]));
        let reserves_result = self
            .rpc(&url, "eth_call", json!([{ "to": pair, "data": reserves_data }, "latest"]))
            .await
            .ok()?;
        let text = reserves_result.as_str()?;
        let reserve0 = Self::abi_word(text, 0)
            .map(|word| u128::from_be_bytes(word[16..].try_into().unwrap_or([0; 16])));
        let reserve1 = Self::abi_word(text, 1)
            .map(|word| u128::from_be_bytes(word[16..].try_into().unwrap_or([0; 16])));
        let (Some(reserve0), Some(reserve1)) = (reserve0, reserve1) else {
            return None;
        };
        let (reserve_wpkn, reserve_bnb) =
            crate::domain::wpkn::orient_pair_reserves(
                token0.eq_ignore_ascii_case(&wpkn),
                format_units(reserve0, 18),
                format_units(reserve1, 18),
            );
        crate::domain::wpkn::spot_price_from_reserves(
            reserve_wpkn,
            reserve_bnb,
            self.bnb_usd_price().await,
            self.config.pkn_usd_price(),
        )
    }

    /// Send wPKN from the settlement wallet (ERC-20 transfer on BSC).
    ///
    /// wPKN is the Pokoin-wrapped BEP-20 token, not one of the `CHAIN_CONFIG`
    /// assets, so it is signed directly against the configured contract.
    pub async fn send_wpkn(
        &self,
        to_address: &str,
        amount_wpkn: f64,
    ) -> ApiResult<(String, Option<String>)> {
        if !self.has_wpkn_settlement() {
            return Ok(("manual_pending".into(), None));
        }
        let key = self
            .config
            .bnb_settlement_private_key
            .clone()
            .unwrap_or_default();
        let url = self.config.bnb_rpc_url.clone();
        let token = self.wpkn_token()?;
        let derived = crate::evm::address_from_private_key(&key)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if let Some(expected) = self.config.wpkn_settlement_address.as_ref() {
            if derived != expected.trim().to_ascii_lowercase() {
                return Err(ApiError::internal(
                    "BNB_SETTLEMENT_PRIVATE_KEY does not match WPKN_SETTLEMENT_ADDRESS.",
                ));
            }
        }
        if let Some(available) = self.wpkn_payout_liquidity().await? {
            if available < amount_wpkn {
                return Err(ApiError::conflict(format!(
                    "wPKN payout liquidity is too low. Available: {available} wPKN."
                ))
                .with_code("payout_liquidity_low")
                .with_meta(json!({ "available": available, "required": amount_wpkn })));
            }
        }
        let to = crate::domain::crypto::normalize_address(
            to_address,
            "Enter a valid BSC payout address.",
        )?;
        let decimals = self.token_decimals(&url, &token).await;
        let data = crate::evm::erc20_transfer_data(&to, parse_units(amount_wpkn, decimals))?;
        let chain_id = self.chain_id(&url).await?;
        let nonce = self.pending_nonce(&url, &derived).await?;
        let gas_price = self.gas_price(&url).await;
        let gas_limit = self
            .estimate_gas(&url, &derived, &token, 0, &data)
            .await
            .unwrap_or(65_000);
        let signed = crate::evm::sign_legacy_transaction(
            &key, chain_id, nonce, gas_price, gas_limit, &token, 0, &data,
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
        let tx_hash = self.send_raw_transaction(&url, &signed.raw_hex).await?;
        Ok(("automatic_available".into(), Some(tx_hash)))
    }
}

/// `numberEnv` for the Bitcoin amount bounds.
fn env_f64(name: &str, fallback: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn decode_transfer_log(log: &Value, tx_hash: &str) -> Option<Erc20Transfer> {
    let topics = log.get("topics")?.as_array()?;
    if topics.len() < 3 {
        return None;
    }
    let topic0 = topics[0].as_str()?.to_ascii_lowercase();
    if topic0 != ERC20_TRANSFER_TOPIC {
        return None;
    }
    let from = topic_to_address(topics[1].as_str()?);
    let to = topic_to_address(topics[2].as_str()?);
    let value = parse_hex_u128(log.get("data").and_then(Value::as_str)?)?;
    Some(Erc20Transfer {
        from,
        to,
        value,
        tx_hash: tx_hash.to_ascii_lowercase(),
    })
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct StripeClient {
    http: reqwest::Client,
    secret: String,
    api_version: Option<String>,
}

impl StripeClient {
    pub fn from_config(config: &CommerceConfig) -> ApiResult<Self> {
        let secret = config
            .stripe_secret_key
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ApiError::internal("Stripe is not configured yet."))?;
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| ApiError::internal("Stripe client could not be created."))?,
            secret,
            api_version: config.stripe_api_version.clone(),
        })
    }

    async fn form(&self, method: reqwest::Method, path: &str, form: &[(String, String)]) -> ApiResult<Value> {
        let url = format!("https://api.stripe.com{path}");
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(&self.secret)
            .form(form);
        if let Some(version) = &self.api_version {
            request = request.header("Stripe-Version", version);
        }
        let response = request
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))?;
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Stripe request failed.");
            return Err(ApiError::new(
                axum::http::StatusCode::from_u16(if status == reqwest::StatusCode::BAD_REQUEST {
                    400
                } else {
                    502
                })
                .unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
                message,
            ));
        }
        Ok(payload)
    }

    pub async fn retrieve_checkout_session(&self, session_id: &str) -> ApiResult<Value> {
        let response = self
            .http
            .get(format!("https://api.stripe.com/v1/checkout/sessions/{session_id}"))
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))?;
        Ok(payload)
    }

    pub async fn create_checkout_session(&self, form: Vec<(String, String)>) -> ApiResult<Value> {
        self.form(reqwest::Method::POST, "/v1/checkout/sessions", &form).await
    }

    pub async fn create_account(&self, form: Vec<(String, String)>) -> ApiResult<Value> {
        self.form(reqwest::Method::POST, "/v1/accounts", &form).await
    }

    pub async fn retrieve_account(&self, account_id: &str) -> ApiResult<Value> {
        let response = self
            .http
            .get(format!("https://api.stripe.com/v1/accounts/{account_id}"))
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))
    }

    pub async fn create_account_link(&self, form: Vec<(String, String)>) -> ApiResult<Value> {
        self.form(reqwest::Method::POST, "/v1/account_links", &form).await
    }

    pub async fn list_prices(&self, lookup_key: &str, fiat_cents: i64) -> ApiResult<Option<String>> {
        let response = self
            .http
            .get("https://api.stripe.com/v1/prices")
            .bearer_auth(&self.secret)
            .query(&[
                ("lookup_keys[]", lookup_key.to_string()),
                ("active", "true".to_string()),
                ("limit", "1".to_string()),
            ])
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))?;
        let price = payload.get("data").and_then(Value::as_array).and_then(|rows| rows.first());
        let Some(price) = price else { return Ok(None) };
        let unit_amount = price.get("unit_amount").and_then(Value::as_i64);
        let currency = price.get("currency").and_then(Value::as_str);
        if unit_amount == Some(fiat_cents) && currency == Some("eur") {
            return Ok(price.get("id").and_then(Value::as_str).map(|v| v.to_string()));
        }
        Ok(None)
    }

    async fn get_json(&self, url: &str, query: &[(String, String)]) -> ApiResult<Value> {
        let mut request = self.http.get(url).bearer_auth(&self.secret);
        if !query.is_empty() {
            request = request.query(query);
        }
        let response = request
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))?;
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Stripe request failed.");
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                message,
            ));
        }
        Ok(payload)
    }

    /// `stripe.refunds.create` (Separate Charges and Transfers refunds).
    pub async fn create_refund(&self, form: Vec<(String, String)>, idempotency_key: &str) -> ApiResult<Value> {
        let url = "https://api.stripe.com/v1/refunds";
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.secret)
            .header("Idempotency-Key", idempotency_key)
            .form(&form)
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))?;
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Stripe refund failed.");
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                format!("Stripe refund failed: {message}"),
            )
            .with_code("stripe_refund_failed"));
        }
        Ok(payload)
    }

    pub async fn retrieve_transfer(&self, transfer_id: &str) -> ApiResult<Value> {
        self.get_json(
            &format!("https://api.stripe.com/v1/transfers/{transfer_id}"),
            &[],
        )
        .await
    }

    pub async fn list_transfers(&self, transfer_group: &str) -> ApiResult<Vec<Value>> {
        let payload = self
            .get_json(
                "https://api.stripe.com/v1/transfers",
                &[
                    ("transfer_group".to_string(), transfer_group.to_string()),
                    ("limit".to_string(), "100".to_string()),
                ],
            )
            .await?;
        Ok(payload
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `stripe.transfers.createReversal`.
    pub async fn create_transfer_reversal(
        &self,
        transfer_id: &str,
        form: Vec<(String, String)>,
        idempotency_key: &str,
    ) -> ApiResult<Value> {
        let url = format!("https://api.stripe.com/v1/transfers/{transfer_id}/reversals");
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.secret)
            .header("Idempotency-Key", idempotency_key)
            .form(&form)
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))?;
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Stripe transfer reversal failed.");
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                format!("Stripe transfer reversal failed: {message}"),
            ));
        }
        Ok(payload)
    }

    /// `stripe.transfers.create` (Separate Charges and Transfers payout).
    pub async fn create_transfer(
        &self,
        form: Vec<(String, String)>,
        idempotency_key: &str,
    ) -> ApiResult<Value> {
        let response = self
            .http
            .post("https://api.stripe.com/v1/transfers")
            .bearer_auth(&self.secret)
            .header("Idempotency-Key", idempotency_key)
            .form(&form)
            .send()
            .await
            .map_err(|_| ApiError::unavailable("Stripe is unavailable."))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ApiError::unavailable("Stripe returned an invalid response."))?;
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Stripe transfer failed.");
            return Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                format!("Stripe transfer failed: {message}"),
            )
            .with_code("stripe_transfer_failed"));
        }
        Ok(payload)
    }

    /// The Checkout charge id for a PaymentIntent (`latest_charge`).
    pub async fn retrieve_payment_intent_charge(&self, payment_intent_id: &str) -> ApiResult<String> {
        let payload = self
            .get_json(
                &format!("https://api.stripe.com/v1/payment_intents/{payment_intent_id}"),
                &[("expand[]".to_string(), "latest_charge".to_string())],
            )
            .await?;
        Ok(payload
            .get("latest_charge")
            .map(|charge| {
                charge
                    .as_str()
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| {
                        charge
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    })
            })
            .unwrap_or_default())
    }

    /// Stripe's `constructEvent` signature check:
    /// `v1 = HMAC_SHA256(secret, "{t}.{payload}")`.
    pub fn verify_webhook(&self, payload: &[u8], signature_header: Option<&str>, tolerance_seconds: i64) -> ApiResult<()> {
        let config = crate::config::CommerceConfig::from_env();
        let secret = config
            .stripe_webhook_secret
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ApiError::internal("Stripe webhook is not configured."))?;
        self.verify_webhook_with_secret(payload, signature_header, &secret, tolerance_seconds)
    }

    pub fn verify_webhook_with_secret(
        &self,
        payload: &[u8],
        signature_header: Option<&str>,
        secret: &str,
        tolerance_seconds: i64,
    ) -> ApiResult<()> {
        let header = signature_header.ok_or_else(|| {
            ApiError::bad_request("Webhook Error: No signatures found matching the expected signature for payload.")
        })?;
        let mut timestamp: Option<i64> = None;
        let mut signatures: Vec<String> = Vec::new();
        for part in header.split(',') {
            let mut kv = part.splitn(2, '=');
            let key = kv.next().unwrap_or_default().trim();
            let value = kv.next().unwrap_or_default().trim();
            match key {
                "t" => timestamp = value.parse::<i64>().ok(),
                "v1" => signatures.push(value.to_string()),
                _ => {}
            }
        }
        let timestamp = timestamp.ok_or_else(|| {
            ApiError::bad_request("Webhook Error: Unable to extract a timestamp from the signature header.")
        })?;
        let now = chrono::Utc::now().timestamp();
        if tolerance_seconds > 0 && (now - timestamp).abs() > tolerance_seconds {
            return Err(ApiError::bad_request(
                "Webhook Error: Timestamp outside the tolerance zone.",
            ));
        }
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .map_err(|_| ApiError::internal("Stripe webhook secret is invalid."))?;
        mac.update(format!("{timestamp}.").as_bytes());
        mac.update(payload);
        let expected = hex::encode(mac.finalize().into_bytes());
        if signatures.iter().any(|signature| {
            signature.len() == expected.len()
                && signature
                    .bytes()
                    .zip(expected.bytes())
                    .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                    == 0
        }) {
            Ok(())
        } else {
            Err(ApiError::bad_request(
                "Webhook Error: No signatures found matching the expected signature for payload.",
            ))
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_unit_helpers_match_ethers() {
        assert_eq!(parse_hex_u128("0x1"), Some(1));
        assert_eq!(parse_hex_u128(""), Some(0));
        assert_eq!(parse_hex_u128("zz"), None);
        assert!((format_units(1_500_000_000_000_000_000, 18) - 1.5).abs() < 1e-12);
        assert_eq!(parse_units(1.5, 18), 1_500_000_000_000_000_000);
        assert_eq!(parse_units(-1.0, 18), 0);
    }

    #[test]
    fn transfer_logs_decode_from_topics() {
        let log = json!({
            "topics": [
                ERC20_TRANSFER_TOPIC,
                "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ],
            "data": "0x0000000000000000000000000000000000000000000000000000000000000064",
        });
        let transfer = decode_transfer_log(&log, "0xABC").unwrap();
        assert_eq!(transfer.from, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(transfer.to, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        assert_eq!(transfer.value, 100);
        assert_eq!(transfer.tx_hash, "0xabc");
    }

    #[test]
    fn transfer_logs_ignore_other_events() {
        let log = json!({
            "topics": ["0xdeadbeef", "0x0", "0x0"],
            "data": "0x00",
        });
        assert!(decode_transfer_log(&log, "0x1").is_none());
        let short = json!({ "topics": [ERC20_TRANSFER_TOPIC], "data": "0x00" });
        assert!(decode_transfer_log(&short, "0x1").is_none());
    }

    fn stripe_stub() -> StripeClient {
        StripeClient {
            http: reqwest::Client::new(),
            secret: "sk_test".into(),
            api_version: None,
        }
    }

    fn signed_header(secret: &str, timestamp: i64, payload: &[u8]) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{timestamp}.").as_bytes());
        mac.update(payload);
        format!("t={timestamp},v1={}", hex::encode(mac.finalize().into_bytes()))
    }


    /// Env-mutating tests must not overlap (the process has one environment).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn chain_client() -> ChainClient {
        ChainClient::new(
            reqwest::Client::new(),
            Arc::new(crate::config::CommerceConfig::from_env()),
        )
    }

    #[tokio::test]
    async fn payouts_without_a_key_stay_manual_and_never_fake_a_hash() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        std::env::remove_var("POKOIN_BANK_PRIVATE_KEY");
        std::env::remove_var("POKOIN_RESERVE_PRIVATE_KEY");
        std::env::remove_var("CRYPTO_PKN_EVM_PAYOUT_PRIVATE_KEY");
        std::env::remove_var("BNB_SETTLEMENT_PRIVATE_KEY");
        let client = chain_client();
        for (mode, hash) in [
            client.send_bank_pkn("0x3535353535353535353535353535353535353535", 10.0).await.unwrap(),
            client.send_reserve_pkn("0x3535353535353535353535353535353535353535", 10.0).await.unwrap(),
            client.send_wpkn("0x3535353535353535353535353535353535353535", 10.0).await.unwrap(),
        ] {
            assert_eq!(mode, "manual_pending");
            assert!(hash.is_none(), "a manual payout must not report a tx hash");
        }
        // Bitcoin without a WIF keeps the Node mode string and no hash.
        let (mode, hash) = client
            .payout("BTC", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 0.001)
            .await
            .unwrap();
        assert_eq!(mode, "bitcoin_manual_pending");
        assert!(hash.is_none());
        assert!(client.bitcoin_payout_liquidity().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn evm_liquidity_without_a_key_is_unconfigured() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        for name in [
            "CRYPTO_PKN_USDT_PAYOUT_PRIVATE_KEY",
            "USDT_PAYOUT_PRIVATE_KEY",
            "CRYPTO_PKN_EVM_PAYOUT_PRIVATE_KEY",
            "BNB_SETTLEMENT_PRIVATE_KEY",
        ] {
            std::env::remove_var(name);
        }
        let client = chain_client();
        // No key, no network call: unconfigured rather than a fabricated zero.
        assert!(client.evm_payout_liquidity("USDT").await.unwrap().is_none());
        assert!(client.evm_payout_liquidity("ETH").await.unwrap().is_none());
        assert!(client.wpkn_payout_liquidity().await.unwrap().is_none());
        // The wPKN contract is configured by default (the BSC mainnet token).
        let token = client.wpkn_token().unwrap();
        assert_eq!(token.len(), 42);
        assert!(token.starts_with("0x"));
    }

    #[tokio::test]
    async fn a_bitcoin_wif_on_the_wrong_network_fails_before_any_request() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        std::env::remove_var("BITCOIN_NETWORK");
        // A testnet WIF while the configured network is mainnet.
        let secret = [0x01u8; 32];
        let testnet_wif = crate::bitcoin::encode_wif(
            &secret,
            crate::bitcoin::Network::Testnet,
            true,
        );
        std::env::set_var("BITCOIN_PAYOUT_PRIVATE_KEY_WIF", &testnet_wif);
        let client = chain_client();
        let error = client
            .bitcoin_payout("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 0.001)
            .await
            .unwrap_err();
        assert!(error.message.contains("does not match BITCOIN_NETWORK"));
        assert!(client.bitcoin_payout_liquidity().await.is_err());
        std::env::remove_var("BITCOIN_PAYOUT_PRIVATE_KEY_WIF");
    }

    #[tokio::test]
    async fn bitcoin_payouts_route_to_the_p2wpkh_signer_not_the_evm_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        std::env::set_var("CRYPTO_PKN_BTC_PAYOUT_PRIVATE_KEY", "0x01");
        let client = chain_client();
        // BTC is implemented, so the EVM dispatcher must not claim otherwise.
        let error = client
            .send_evm_payout("BTC", "bc1qexample", 0.001)
            .await
            .unwrap_err();
        assert_eq!(error.status.as_u16(), 500);
        assert_eq!(error.code.as_deref(), Some("payout_asset_mismatch"));
        assert!(!error.message.contains("not ported"));
        // Without a WIF the payout path reports the Node manual mode.
        std::env::remove_var("BITCOIN_PAYOUT_PRIVATE_KEY_WIF");
        let (mode, hash) = client
            .payout("BTC", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 0.001)
            .await
            .unwrap();
        assert_eq!(mode, "bitcoin_manual_pending");
        assert!(hash.is_none());
        std::env::remove_var("CRYPTO_PKN_BTC_PAYOUT_PRIVATE_KEY");
    }

    #[tokio::test]
    async fn derived_addresses_match_the_configured_wallets_when_keys_exist() {
        // When a bank key is configured the derived address must match the
        // configured bank address, mirroring the Node guard.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        std::env::set_var(
            "POKOIN_BANK_PRIVATE_KEY",
            "0x0101010101010101010101010101010101010101010101010101010101010101",
        );
        let client = chain_client();
        assert!(client.has_bank_key());
        let derived = crate::evm::address_from_private_key(
            "0x0101010101010101010101010101010101010101010101010101010101010101",
        )
        .unwrap();
        // Mismatch is detected before any RPC call is attempted.
        if derived != client.config.pokoin_bank_address.to_ascii_lowercase() {
            let error = client
                .send_bank_pkn("0x3535353535353535353535353535353535353535", 1.0)
                .await
                .unwrap_err();
            assert!(error.message.contains("does not match"), "{}", error.message);
        }
        std::env::remove_var("POKOIN_BANK_PRIVATE_KEY");
    }

    #[test]
    fn webhook_signature_verification_accepts_a_valid_signature() {
        let payload = br#"{"id":"evt_1","type":"checkout.session.completed"}"#;
        let now = chrono::Utc::now().timestamp();
        let header = signed_header("whsec_test", now, payload);
        assert!(stripe_stub()
            .verify_webhook_with_secret(payload, Some(&header), "whsec_test", 300)
            .is_ok());
    }

    #[test]
    fn webhook_signature_verification_rejects_tampering() {
        let payload = br#"{"id":"evt_1"}"#;
        let now = chrono::Utc::now().timestamp();
        let header = signed_header("whsec_test", now, payload);
        // Wrong secret.
        assert!(stripe_stub()
            .verify_webhook_with_secret(payload, Some(&header), "whsec_other", 300)
            .is_err());
        // Tampered payload.
        assert!(stripe_stub()
            .verify_webhook_with_secret(br#"{"id":"evt_2"}"#, Some(&header), "whsec_test", 300)
            .is_err());
        // Missing header.
        assert!(stripe_stub()
            .verify_webhook_with_secret(payload, None, "whsec_test", 300)
            .is_err());
    }

    #[test]
    fn webhook_signature_verification_rejects_stale_timestamps() {
        let payload = br#"{"id":"evt_1"}"#;
        let stale = chrono::Utc::now().timestamp() - 4000;
        let header = signed_header("whsec_test", stale, payload);
        assert!(stripe_stub()
            .verify_webhook_with_secret(payload, Some(&header), "whsec_test", 300)
            .is_err());
    }
}
