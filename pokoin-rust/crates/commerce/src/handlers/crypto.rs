//! Crypto ⇄ PKN purchases/sales and the wPKN ⇄ PKN exchange.
//!
//! Every quote, request, deposit and payout document lives in the Firestore
//! collections the Node writers used (`crypto_pkn_purchase_quotes`,
//! `crypto_pkn_purchase_requests`, `crypto_pkn_purchase_deposits`,
//! `crypto_pkn_sale_quotes/_requests/_payouts`, `wpkn_exchange_quotes/_requests/
//! _deposits`, `wpkn_exchange_config/reserves`). Balances and the ledger go
//! through [`crate::store`]; nothing is migrated to SQL.

use axum::extract::{Query, State};
use axum::response::Response;
use serde_json::{json, Value};

use super::{private_json, public_json};
use crate::auth::Claims;
use crate::domain::crypto;
use crate::domain::wpkn::{self, Direction, ExchangeParams, Reserves};
use crate::error::{ApiError, StoreError};
use crate::firestore::FirestoreClient;
use crate::state::{AuthedUser, DomainState};
use crate::store::{self, LedgerOp};

type QueryMap = std::collections::HashMap<String, String>;

fn action_of(query: &QueryMap, body: &Value) -> String {
    body.get("action")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .or_else(|| query.get("action").cloned())
        .unwrap_or_default()
}

fn text_of(body: &Value, key: &str, max: usize) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn num_of(body: &Value, key: &str) -> f64 {
    crate::domain::js_number(body.get(key)).unwrap_or(0.0)
}

fn doc_id() -> String {
    store::auto_id()
}

async fn read_doc(
    fs: &FirestoreClient,
    collection: &str,
    id: &str,
) -> Result<Option<Value>, ApiError> {
    Ok(fs.get_document(&fs.document_path(collection, id)).await?)
}

async fn write_doc(
    fs: &FirestoreClient,
    collection: &str,
    id: &str,
    value: &Value,
) -> Result<(), ApiError> {
    fs.set_document(&fs.document_path(collection, id), value)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// /api/crypto-pkn-purchase/:action
// ---------------------------------------------------------------------------

pub async fn crypto_pkn_purchase(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<QueryMap>,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    let parsed = super::parse_json_body(&body)?;
    let action = action_of(&query, &parsed);
    match action.as_str() {
        "quote" => crypto_purchase_quote(&state, &claims, &parsed).await,
        "request" => crypto_purchase_request(&state, &claims, &parsed).await,
        "status" => crypto_purchase_status(&state, &claims.uid, &query).await,
        _ => Err(ApiError::not_found("Purchase action was not found.")),
    }
}

async fn crypto_purchase_quote(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let asset_input = text_of(body, "asset", 16);
    let amount_in = num_of(body, "amountIn");
    let market_price = state.prices().usd_price(&asset_input).await?;
    let quote = crypto::calculate_crypto_pkn_quote(
        &asset_input,
        amount_in,
        market_price,
        state.config().pkn_usd_price(),
        state.config().crypto_pkn_fee_bps,
        state.config().crypto_pkn_max_input_amount,
        Some(state.chain().crypto_settlement_address()?),
        crypto::chain_config(&asset_input.to_ascii_uppercase())
            .and_then(|config| config.default_token_address)
            .map(|value| value.to_string()),
        state.now_ms(),
        state.config().crypto_pkn_quote_ttl_ms,
    )?;
    let expires_ms = state.now_ms() + state.config().crypto_pkn_quote_ttl_ms;
    let firestore = state.firestore()?;
    let quote_id = doc_id();
    let mut document = crypto::public_crypto_pkn_quote(&quote_id, &quote);
    if let Some(object) = document.as_object_mut() {
        object.insert("uid".into(), json!(claims.uid));
        object.insert("status".into(), json!("quoted"));
        object.insert("createdAt".into(), json!(state.now_iso()));
        object.insert("updatedAt".into(), json!(state.now_iso()));
        object.insert("quoteExpiresAtMs".into(), json!(expires_ms));
    }
    write_doc(firestore, store::CRYPTO_PURCHASE_QUOTES, &quote_id, &document).await?;
    Ok(private_json(crypto::public_crypto_pkn_quote(&quote_id, &quote)))
}

async fn crypto_purchase_request(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let quote_id = text_of(body, "quoteId", 80);
    let tx_hash = text_of(body, "depositTxHash", 80).to_ascii_lowercase();
    if quote_id.is_empty() {
        return Err(ApiError::bad_request("Quote id is required."));
    }
    if tx_hash.is_empty() {
        return Err(ApiError::bad_request(
            "Deposit transaction hash is required.",
        ));
    }
    let firestore = state.firestore()?;
    let quote = read_doc(firestore, store::CRYPTO_PURCHASE_QUOTES, &quote_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Purchase quote was not found."))?;
    if quote.get("uid").and_then(Value::as_str) != Some(claims.uid.as_str()) {
        return Err(ApiError::forbidden("This quote belongs to another user."));
    }
    if quote.get("status").and_then(Value::as_str) != Some("quoted") {
        return Err(ApiError::conflict("This quote has already been used."));
    }
    let expires_ms = quote
        .get("quoteExpiresAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if state.now_ms() > expires_ms {
        let _ = firestore
            .update_document(
                &firestore.document_path(store::CRYPTO_PURCHASE_QUOTES, &quote_id),
                &json!({ "status": "expired", "updatedAt": state.now_iso() }),
                Some(&["status", "updatedAt"]),
            )
            .await;
        return Err(ApiError::gone("Quote expired. Request a new quote."));
    }
    if read_doc(firestore, store::CRYPTO_PURCHASE_DEPOSITS, &tx_hash)
        .await?
        .is_some()
    {
        return Err(ApiError::conflict(
            "This deposit transaction was already used.",
        ));
    }

    let asset = quote
        .get("fromAsset")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let amount_in = quote.get("amountIn").and_then(Value::as_f64).unwrap_or(0.0);
    let amount_out = quote
        .get("amountOut")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let config = crypto::normalize_asset(&asset)?;
    let linked_wallet = if config.bitcoin {
        String::new()
    } else {
        store::read_user(firestore, &claims.uid)
            .await?
            .get("walletAddress")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    if !config.bitcoin && linked_wallet.trim().is_empty() {
        return Err(ApiError::bad_request(
            "Link the wallet that sent this crypto deposit before requesting PKN credit.",
        ));
    }

    let deposit = state
        .chain()
        .verify_crypto_deposit(&asset, &tx_hash, linked_zip(&linked_wallet), amount_in)
        .await?;

    let request_id = doc_id();
    let credit = amount_out.trunc() as i64;
    let request_document = json!({
        "uid": claims.uid,
        "email": claims.email,
        "quoteId": quote_id,
        "fromAsset": asset,
        "toAsset": "PKN",
        "amountIn": amount_in,
        "amountOut": amount_out,
        "feeAmount": quote.get("feeAmount").and_then(Value::as_f64).unwrap_or(0.0),
        "marketPrice": quote.get("marketPrice").and_then(Value::as_f64).unwrap_or(0.0),
        "pknUsd": quote.get("pknUsd").and_then(Value::as_f64).unwrap_or(0.0),
        "chainId": quote.get("chainId").cloned().unwrap_or(Value::Null),
        "chainName": quote.get("chainName").cloned().unwrap_or(Value::Null),
        "depositTxHash": deposit.tx_hash,
        "fromAddress": deposit.from_address,
        "status": "credited",
        "createdAt": state.now_iso(),
        "updatedAt": state.now_iso(),
    });
    write_doc(
        firestore,
        store::CRYPTO_PURCHASE_REQUESTS,
        &request_id,
        &request_document,
    )
    .await?;

    // Claim the funding hash before crediting so it can never be reused.
    let deposit_document = json!({
        "uid": claims.uid,
        "requestId": request_id,
        "txHash": deposit.tx_hash,
        "fromAddress": deposit.from_address,
        "fromAsset": asset,
        "amountIn": amount_in,
        "amountOutPkn": amount_out,
        "chainId": quote.get("chainId").cloned().unwrap_or(Value::Null),
        "blockNumber": deposit.block_number,
        "createdAt": state.now_iso(),
    });
    match firestore
        .create_document(
            store::CRYPTO_PURCHASE_DEPOSITS,
            &deposit.tx_hash,
            &deposit_document,
        )
        .await
    {
        Ok(_) => {}
        Err(StoreError::Conflict(_)) => {
            return Err(ApiError::conflict(
                "This deposit transaction was already used.",
            ))
        }
        Err(other) => return Err(other.into()),
    }

    let op = LedgerOp::mint(&claims.uid, credit, "crypto_pkn_purchase_credit")
        .with_idempotency(format!("crypto_purchase:{}", deposit.tx_hash))
        .with_ref(&request_id)
        .with_meta(json!({
            "cryptoPknPurchaseRequestId": request_id,
            "depositTxHash": deposit.tx_hash,
            "fromAddress": deposit.from_address,
            "fromAsset": asset,
            "amountIn": amount_in,
        }));
    store::apply(firestore, &op).await?;

    let _ = firestore
        .update_document(
            &firestore.document_path(store::CRYPTO_PURCHASE_QUOTES, &quote_id),
            &json!({
                "status": "credited",
                "requestId": request_id,
                "depositTxHash": deposit.tx_hash,
                "updatedAt": state.now_iso(),
            }),
            Some(&["status", "requestId", "depositTxHash", "updatedAt"]),
        )
        .await;

    Ok(private_json(json!({
        "ok": true,
        "requestId": request_id,
        "status": "credited",
        "amountPkn": credit,
        "depositTxHash": deposit.tx_hash,
    })))
}

fn linked_zip(value: &str) -> &str {
    if value.trim().is_empty() {
        "0x0000000000000000000000000000000000000000"
    } else {
        value
    }
}

/// `serialize()` from `crypto-pkn-purchase.js` / `crypto-pkn-sale.js`.
fn crypto_request_json(document: &Value, kind: &str) -> Value {
    json!({
        "requestId": document.get("id").cloned().unwrap_or(Value::Null),
        "quoteId": document.get("quoteId").cloned().unwrap_or(Value::Null),
        "fromAsset": document.get("fromAsset").cloned().unwrap_or(Value::Null),
        "toAsset": document.get("toAsset").cloned().unwrap_or(Value::Null),
        "amountIn": document.get("amountIn").and_then(Value::as_f64).unwrap_or(0.0),
        "amountOut": document.get("amountOut").and_then(Value::as_f64).unwrap_or(0.0),
        "feeAmount": document.get("feeAmount").and_then(Value::as_f64).unwrap_or(0.0),
        "depositTxHash": document.get("depositTxHash").cloned().unwrap_or(Value::Null),
        "fromAddress": document.get("fromAddress").cloned().unwrap_or(Value::Null),
        "payoutAddress": document.get("payoutAddress").cloned().unwrap_or(Value::Null),
        "payoutTxHash": document.get("payoutTxHash").cloned().unwrap_or(Value::Null),
        "status": document.get("status").cloned().unwrap_or(Value::Null),
        "settlementMode": document
            .get("settlementMode")
            .cloned()
            .unwrap_or(Value::Null),
        "chainId": document.get("chainId").cloned().unwrap_or(Value::Null),
        "chainName": document.get("chainName").cloned().unwrap_or(Value::Null),
        "createdAt": document.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": document.get("updatedAt").cloned().unwrap_or(Value::Null),
        "kind": kind,
    })
}

async fn crypto_request_status(
    state: &DomainState,
    uid: &str,
    query: &QueryMap,
    collection: &str,
    kind: &str,
) -> Result<Response, ApiError> {
    let firestore = state.firestore()?;
    if let Some(request_id) = query.get("requestId") {
        let id = request_id.trim();
        let document = read_doc(firestore, collection, id)
            .await?
            .ok_or_else(|| ApiError::not_found("Request was not found."))?;
        if document.get("uid").and_then(Value::as_str) != Some(uid) {
            return Err(ApiError::not_found("Request was not found."));
        }
        return Ok(private_json(
            json!({ "request": crypto_request_json(&document, kind) }),
        ));
    }
    let rows = firestore
        .run_query(
            &store::StructuredQuery::collection(collection)
                .where_eq("uid", json!(uid))
                .limit(50),
        )
        .await?;
    let mut requests: Vec<Value> = rows.iter().map(|row| crypto_request_json(row, kind)).collect();
    requests.sort_by(|a, b| {
        let left = a.get("createdAt").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("createdAt").and_then(Value::as_str).unwrap_or_default();
        right.cmp(left)
    });
    requests.truncate(12);
    Ok(private_json(json!({ "requests": requests })))
}

async fn crypto_purchase_status(
    state: &DomainState,
    uid: &str,
    query: &QueryMap,
) -> Result<Response, ApiError> {
    crypto_request_status(
        state,
        uid,
        query,
        store::CRYPTO_PURCHASE_REQUESTS,
        "purchase",
    )
    .await
}

async fn crypto_sale_status(
    state: &DomainState,
    uid: &str,
    query: &QueryMap,
) -> Result<Response, ApiError> {
    crypto_request_status(state, uid, query, store::CRYPTO_SALE_REQUESTS, "sale").await
}

// ---------------------------------------------------------------------------
// /api/crypto-pkn-sale/:action
// ---------------------------------------------------------------------------

pub async fn crypto_pkn_sale(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<QueryMap>,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    if !state.config().crypto_pkn_sell_enabled {
        return Err(ApiError::forbidden(
            "PKN to crypto sales are not enabled yet.",
        ));
    }
    let parsed = super::parse_json_body(&body)?;
    let action = action_of(&query, &parsed);
    match action.as_str() {
        "quote" => crypto_sale_quote(&state, &claims, &parsed).await,
        "request" => crypto_sale_request(&state, &claims, &parsed).await,
        "status" => crypto_sale_status(&state, &claims.uid, &query).await,
        _ => Err(ApiError::not_found("Sale action was not found.")),
    }
}

async fn crypto_sale_quote(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let asset = text_of(body, "asset", 16);
    let amount_in = num_of(body, "amountIn");
    let market_price = state.prices().usd_price(&asset).await?;
    let quote = crypto::calculate_pkn_crypto_sale_quote(
        &asset,
        amount_in,
        market_price,
        state.config().pkn_usd_price(),
        state.config().crypto_pkn_sell_fee_bps,
        state.config().crypto_pkn_max_sell_pkn,
        state.now_ms(),
        state.config().crypto_pkn_quote_ttl_ms,
    )?;
    // Payout liquidity must be provably available before a sale is quoted.
    let liquidity_available = payout_liquidity(state, &quote.to_asset).await?;
    if let Some(available) = liquidity_available {
        if available < quote.amount_out {
            return Err(ApiError::conflict(format!(
                "{} payout liquidity is too low. Available: {} {}.",
                quote.to_asset, available, quote.to_asset
            ))
            .with_code("payout_liquidity_low")
            .with_meta(json!({ "available": available, "required": quote.amount_out })));
        }
    }
    let firestore = state.firestore()?;
    let quote_id = doc_id();
    let mut document = crypto::public_pkn_crypto_sale_quote(&quote_id, &quote);
    if let Some(object) = document.as_object_mut() {
        object.insert("uid".into(), json!(claims.uid));
        object.insert("status".into(), json!("quoted"));
        object.insert("createdAt".into(), json!(state.now_iso()));
        object.insert("updatedAt".into(), json!(state.now_iso()));
        object.insert(
            "quoteExpiresAtMs".into(),
            json!(state.now_ms() + state.config().crypto_pkn_quote_ttl_ms),
        );
        object.insert("payoutLiquidityAvailable".into(), json!(liquidity_available));
    }
    write_doc(firestore, store::CRYPTO_SALE_QUOTES, &quote_id, &document).await?;
    let mut payload = crypto::public_pkn_crypto_sale_quote(&quote_id, &quote);
    if let Some(object) = payload.as_object_mut() {
        object.insert("payoutLiquidityAvailable".into(), json!(liquidity_available));
    }
    Ok(private_json(payload))
}

/// Native payout liquidity for the sale path.
///
/// Bitcoin reads the payout wallet's confirmed UTXOs (`bitcoinPayoutLiquidity`);
/// EVM assets read the payout wallet's native balance or ERC-20 `balanceOf`.
/// A missing key is a 503 before any quote is issued.
async fn payout_liquidity(state: &DomainState, asset: &str) -> Result<Option<f64>, ApiError> {
    let config = crypto::normalize_asset(asset)?;
    if config.bitcoin {
        return match state.chain().bitcoin_payout_liquidity().await {
            Ok(Some(sats)) => Ok(Some(sats as f64 / 100_000_000.0)),
            Ok(None) => Err(ApiError::unavailable(
                "BTC payout wallet is not configured.",
            )),
            Err(error) => Err(error),
        };
    }
    match state.chain().evm_payout_liquidity(config.asset).await {
        Ok(Some(available)) => Ok(Some(available)),
        Ok(None) => Err(ApiError::unavailable(format!(
            "{} payout wallet is not configured.",
            config.asset
        ))),
        Err(error) => Err(error),
    }
}

async fn crypto_sale_request(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let quote_id = text_of(body, "quoteId", 80);
    if quote_id.is_empty() {
        return Err(ApiError::bad_request("Quote id is required."));
    }
    let deposit_tx_hash = text_of(body, "depositTxHash", 80).to_ascii_lowercase();
    if deposit_tx_hash.is_empty() {
        return Err(ApiError::bad_request(
            "Missing PKN funding transaction hash.",
        ));
    }
    let firestore = state.firestore()?;
    let quote = read_doc(firestore, store::CRYPTO_SALE_QUOTES, &quote_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Sale quote was not found."))?;
    if quote.get("uid").and_then(Value::as_str) != Some(claims.uid.as_str()) {
        return Err(ApiError::forbidden("This quote belongs to another user."));
    }
    if quote.get("status").and_then(Value::as_str) != Some("quoted") {
        return Err(ApiError::conflict("This quote has already been used."));
    }
    let expires_ms = quote
        .get("quoteExpiresAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if state.now_ms() > expires_ms {
        let _ = firestore
            .update_document(
                &firestore.document_path(store::CRYPTO_SALE_QUOTES, &quote_id),
                &json!({ "status": "expired", "updatedAt": state.now_iso() }),
                Some(&["status", "updatedAt"]),
            )
            .await;
        return Err(ApiError::gone("Quote expired. Request a new quote."));
    }

    let asset = quote
        .get("toAsset")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let amount_pkn = quote
        .get("amountIn")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .trunc() as i64;
    let amount_out = quote
        .get("amountOut")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let payout_address =
        crypto::normalize_payout_address(&asset, &text_of(body, "payoutAddress", 120))?;
    let wallet = store::read_user(firestore, &claims.uid)
        .await?
        .get("walletAddress")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if wallet.trim().is_empty() {
        return Err(ApiError::bad_request(
            "Link the wallet that sends this PKN before requesting crypto payout.",
        ));
    }
    let deposit = state
        .chain()
        .verify_pokoin_deposit(&deposit_tx_hash, &wallet, amount_pkn as f64)
        .await?;

    let auto_payout = state.config().crypto_pkn_auto_payout_enabled;
    let request_id = doc_id();
    let request_document = json!({
        "uid": claims.uid,
        "email": claims.email,
        "quoteId": quote_id,
        "fromAsset": "PKN",
        "toAsset": asset,
        "amountIn": amount_pkn,
        "amountOut": amount_out,
        "feeAmount": quote.get("feeAmount").and_then(Value::as_f64).unwrap_or(0.0),
        "feeBps": quote.get("feeBps").cloned().unwrap_or(Value::Null),
        "marketPrice": quote.get("marketPrice").cloned().unwrap_or(Value::Null),
        "pknUsd": quote.get("pknUsd").cloned().unwrap_or(Value::Null),
        "chainId": quote.get("chainId").cloned().unwrap_or(Value::Null),
        "chainName": quote.get("chainName").cloned().unwrap_or(Value::Null),
        "depositTxHash": deposit.tx_hash,
        "fromAddress": deposit.from_address,
        "payoutAddress": payout_address,
        "payoutTxHash": Value::Null,
        "status": if auto_payout { "payout_pending" } else { "pending_liquidity" },
        "settlementMode": if auto_payout { "automatic_pending" } else { "manual_settlement" },
        "createdAt": state.now_iso(),
        "updatedAt": state.now_iso(),
    });
    write_doc(
        firestore,
        store::CRYPTO_SALE_REQUESTS,
        &request_id,
        &request_document,
    )
    .await?;

    // Claim the funding hash, then record the PKN leaving the site.
    let claim = json!({
        "uid": claims.uid,
        "requestId": request_id,
        "txHash": deposit.tx_hash,
        "fromAddress": deposit.from_address,
        "amountPkn": amount_pkn,
        "purpose": "crypto_pkn_sale",
        "createdAt": state.now_iso(),
    });
    match firestore
        .create_document(store::NATIVE_DEPOSITS, &deposit.tx_hash, &claim)
        .await
    {
        Ok(_) => {}
        Err(StoreError::Conflict(_)) => {
            return Err(ApiError::conflict(
                "This PKN funding transaction was already used.",
            ))
        }
        Err(other) => return Err(other.into()),
    }
    let record = LedgerOp::record(&claims.uid, -amount_pkn, "crypto_pkn_sale_deposit")
        .with_ref(&request_id)
        .with_meta(json!({ "depositTxHash": deposit.tx_hash, "toAsset": asset }));
    store::apply(firestore, &record).await?;

    let _ = firestore
        .set_document(
            &firestore.document_path(store::CRYPTO_SALE_PAYOUTS, &request_id),
            &json!({
                "uid": claims.uid,
                "requestId": request_id,
                "asset": asset,
                "amountOut": amount_out,
                "toAddress": payout_address,
                "status": "pending",
                "createdAt": state.now_iso(),
            }),
        )
        .await;

    let payout = state
        .chain()
        .payout(&asset, &payout_address, amount_out)
        .await
        .unwrap_or_else(|_| ("manual_pending".into(), None));
    let (status, tx_hash) = match payout {
        (mode, Some(tx_hash)) => {
            let _ = firestore
                .set_document(
                    &firestore.document_path(store::CRYPTO_SALE_REQUESTS, &request_id),
                    &json!({
                        "status": "payout_sent",
                        "payoutTxHash": tx_hash,
                        "settlementMode": mode,
                        "updatedAt": state.now_iso(),
                    }),
                )
                .await;
            ("payout_sent", Some(tx_hash))
        }
        (mode, None) => {
            let _ = firestore
                .set_document(
                    &firestore.document_path(store::CRYPTO_SALE_REQUESTS, &request_id),
                    &json!({ "settlementMode": mode, "updatedAt": state.now_iso() }),
                )
                .await;
            ("payout_pending", None)
        }
    };

    Ok(private_json(json!({
        "ok": true,
        "requestId": request_id,
        "status": status,
        "amountOut": amount_out,
        "payoutAddress": payout_address,
        "payoutTxHash": tx_hash,
    })))
}

// ---------------------------------------------------------------------------
// /api/wpkn-exchange/:action
// ---------------------------------------------------------------------------

pub async fn wpkn_exchange(
    State(state): State<DomainState>,
    super::PublicAuthedUser(claims): super::PublicAuthedUser,
    Query(query): Query<QueryMap>,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    let parsed = super::parse_json_body(&body)?;
    let action = action_of(&query, &parsed);
    match action.as_str() {
        "quote" => wpkn_exchange_quote(&state, &claims, &parsed).await,
        "request" => wpkn_exchange_request(&state, &claims, &parsed).await,
        "status" => wpkn_exchange_status(&state, &claims.uid, &query).await,
        _ => Err(ApiError::not_found("Exchange action was not found.")),
    }
}

fn exchange_params(state: &DomainState) -> ExchangeParams {
    let config = state.config();
    ExchangeParams {
        spread_bps: config.wpkn_exchange_spread_bps,
        impact_coefficient_bps: config.wpkn_exchange_impact_coefficient_bps,
        available_liquidity_pkn: config.wpkn_exchange_available_liquidity_pkn,
        wpkn_reserve_pkn: config.wpkn_exchange_wpkn_reserve_pkn,
        pkn_locked_target: config.wpkn_exchange_pkn_locked_target,
        default_market_price: config.wpkn_exchange_market_price.unwrap_or(1.0),
        quote_ttl_ms: config.wpkn_exchange_quote_ttl_ms,
        settlement_mode: if state.chain().has_wpkn_settlement() {
            "automatic_available".into()
        } else {
            "manual_pending".into()
        },
    }
}

/// `reserveSnapshot`: `wpkn_exchange_config/reserves`.
async fn reserve_snapshot(state: &DomainState) -> Result<Reserves, ApiError> {
    let firestore = state.firestore()?;
    let document = read_doc(firestore, store::WPKN_EXCHANGE_CONFIG, "reserves").await?;
    Ok(document
        .map(|row| Reserves {
            available_liquidity_pkn: row
                .get("availableLiquidityPkn")
                .and_then(Value::as_f64)
                .filter(|value| *value > 0.0),
            settlement_wpkn_pkn: row
                .get("settlementWpknPkn")
                .and_then(Value::as_f64)
                .filter(|value| *value > 0.0),
            locked_pkn: Some(row.get("lockedPkn").and_then(Value::as_f64).unwrap_or(0.0)),
        })
        .unwrap_or_default())
}

async fn wpkn_exchange_quote(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let direction = wpkn::normalize_direction(&text_of(body, "direction", 40))?;
    let amount_in = num_of(body, "amountIn");
    let reserves = reserve_snapshot(state).await?;
    // Node's order: GeckoTerminal, then the live Pancake pool through direct
    // RPC, then the configured override.
    let market_price = match state.prices().wpkn_market_reference().await {
        Some(price) => price,
        None => match state.chain().pancake_spot_price().await {
            Some(price) if price > 0.0 => price,
            _ => state.prices().configured_wpkn_price(),
        },
    };
    let params = exchange_params(state);
    let quote = wpkn::calculate_quote(
        direction,
        amount_in,
        reserves,
        Some(market_price),
        &params,
        state.now_ms(),
    )?;
    let firestore = state.firestore()?;
    let quote_id = doc_id();
    let mut document = wpkn::public_quote(&quote_id, &quote);
    if let Some(object) = document.as_object_mut() {
        object.insert("uid".into(), json!(claims.uid));
        object.insert("status".into(), json!("quoted"));
        object.insert("createdAt".into(), json!(state.now_iso()));
        object.insert("updatedAt".into(), json!(state.now_iso()));
        object.insert(
            "quoteExpiresAtMs".into(),
            json!(state.now_ms() + params.quote_ttl_ms),
        );
    }
    write_doc(firestore, store::WPKN_EXCHANGE_QUOTES, &quote_id, &document).await?;
    Ok(private_json(wpkn::public_quote(&quote_id, &quote)))
}

async fn wpkn_exchange_request(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let quote_id = text_of(body, "quoteId", 80);
    if quote_id.is_empty() {
        return Err(ApiError::bad_request("Quote id is required."));
    }
    let direction = wpkn::normalize_direction(&text_of(body, "direction", 40))?;
    let payout_address = crypto::normalize_address(
        &text_of(body, "toAddress", 120),
        if direction == Direction::PknToWpkn {
            "Enter a valid BSC payout address."
        } else {
            "Enter a valid PKN payout address."
        },
    )?;
    let firestore = state.firestore()?;
    let quote = read_doc(firestore, store::WPKN_EXCHANGE_QUOTES, &quote_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Exchange quote was not found."))?;
    if quote.get("uid").and_then(Value::as_str) != Some(claims.uid.as_str()) {
        return Err(ApiError::forbidden("This quote belongs to another user."));
    }
    if quote.get("status").and_then(Value::as_str) != Some("quoted") {
        return Err(ApiError::conflict("This quote has already been used."));
    }
    if quote.get("direction").and_then(Value::as_str) != Some(direction.as_str()) {
        return Err(ApiError::bad_request(
            "Quote direction does not match request.",
        ));
    }
    let expires_ms = quote
        .get("quoteExpiresAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if state.now_ms() > expires_ms {
        let _ = firestore
            .update_document(
                &firestore.document_path(store::WPKN_EXCHANGE_QUOTES, &quote_id),
                &json!({ "status": "expired", "updatedAt": state.now_iso() }),
                Some(&["status", "updatedAt"]),
            )
            .await;
        return Err(ApiError::gone("Exchange quote expired. Request a new quote."));
    }

    let amount_in = quote.get("amountIn").and_then(Value::as_i64).unwrap_or(0);
    let amount_out = quote.get("amountOut").and_then(Value::as_i64).unwrap_or(0);
    let fee_amount = quote.get("feeAmount").and_then(Value::as_i64).unwrap_or(0);
    let params = exchange_params(state);
    let username = store::read_user(firestore, &claims.uid)
        .await?
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let request_id = doc_id();
    let mut deposit_tx_hash: Option<String> = None;

    if direction == Direction::PknToWpkn {
        let lock = LedgerOp::lock(&claims.uid, amount_in, "wpkn_exchange_pkn_locked")
            .with_ref(&request_id)
            .with_meta(json!({ "toAddress": payout_address }));
        store::apply(firestore, &lock).await?;
    } else {
        let wallet = store::read_user(firestore, &claims.uid)
            .await?
            .get("walletAddress")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if wallet.trim().is_empty() {
            return Err(ApiError::bad_request(
                "Link the BSC wallet that sent the wPKN deposit before requesting payout.",
            ));
        }
        let used_rows = firestore
            .run_query(
                &store::StructuredQuery::collection(store::WPKN_EXCHANGE_DEPOSITS)
                    .where_eq("fromAddress", json!(wallet.to_ascii_lowercase()))
                    .limit(50),
            )
            .await
            .unwrap_or_default();
        let used: Vec<String> = used_rows
            .iter()
            .filter_map(|row| row.get("id").and_then(Value::as_str).map(|v| v.to_string()))
            .collect();
        let deposit = state
            .chain()
            .find_wpkn_deposit(&wallet, amount_in as f64, &used)
            .await?;
        if deposit.amount_in < amount_in as f64 {
            return Err(ApiError::bad_request(
                "Deposit amount is lower than the quoted wPKN amount.",
            ));
        }
        // Claim the deposit in the same step that records it.
        match firestore
            .create_document(
                store::WPKN_EXCHANGE_DEPOSITS,
                &deposit.tx_hash,
                &json!({
                    "uid": claims.uid,
                    "requestId": request_id,
                    "txHash": deposit.tx_hash,
                    "fromAddress": deposit.from_address,
                    "amountWpkn": deposit.amount_in,
                    "createdAt": state.now_iso(),
                }),
            )
            .await
        {
            Ok(_) => {}
            Err(StoreError::Conflict(_)) => {
                return Err(ApiError::conflict("This wPKN deposit tx was already used."))
            }
            Err(other) => return Err(other.into()),
        }
        deposit_tx_hash = Some(deposit.tx_hash.clone());
    }

    let initial_status = if direction == Direction::PknToWpkn {
        "locked"
    } else {
        "pending_payout"
    };
    let request_document = json!({
        "uid": claims.uid,
        "email": claims.email,
        "username": username,
        "quoteId": quote_id,
        "direction": direction.as_str(),
        "amountIn": amount_in,
        "amountOutQuoted": amount_out,
        "feePknOrWpkn": fee_amount,
        "fromAsset": direction.from_asset(),
        "toAsset": direction.to_asset(),
        "toAddress": payout_address,
        "depositTxHash": deposit_tx_hash,
        "payoutTxHash": Value::Null,
        "status": initial_status,
        "settlementMode": params.settlement_mode,
        "createdAt": state.now_iso(),
        "updatedAt": state.now_iso(),
    });
    write_doc(
        firestore,
        store::WPKN_EXCHANGE_REQUESTS,
        &request_id,
        &request_document,
    )
    .await?;
    let _ = firestore
        .update_document(
            &firestore.document_path(store::WPKN_EXCHANGE_QUOTES, &quote_id),
            &json!({
                "status": initial_status,
                "requestId": request_id,
                "updatedAt": state.now_iso(),
            }),
            Some(&["status", "requestId", "updatedAt"]),
        )
        .await;

    // Settlement: only automatic when the reserve wallet is configured.
    let (status, payout_tx_hash) = if direction == Direction::WpknToPkn {
        match state
            .chain()
            .send_reserve_pkn(&payout_address, amount_out as f64)
            .await
        {
            Ok((mode, Some(tx_hash))) => {
                let _ = firestore
                    .set_document(
                        &firestore.document_path(store::WPKN_EXCHANGE_REQUESTS, &request_id),
                        &json!({
                            "status": "completed",
                            "payoutTxHash": tx_hash,
                            "settlementMode": mode,
                            "completedAt": state.now_iso(),
                            "updatedAt": state.now_iso(),
                        }),
                    )
                    .await;
                ("completed", Some(tx_hash))
            }
            Ok(_) | Err(_) => {
                let _ = firestore
                    .set_document(
                        &firestore.document_path(store::WPKN_EXCHANGE_REQUESTS, &request_id),
                        &json!({
                            "settlementMode": "manual_pending",
                            "updatedAt": state.now_iso(),
                        }),
                    )
                    .await;
                ("pending_payout", None)
            }
        }
    } else {
        // PKN -> wPKN: the locked PKN settles by sending wPKN from the
        // settlement wallet, or stays locked for manual settlement.
        match state
            .chain()
            .send_wpkn(&payout_address, amount_out as f64)
            .await
        {
            Ok((mode, Some(tx_hash))) => {
                let _ = firestore
                    .set_document(
                        &firestore.document_path(store::WPKN_EXCHANGE_REQUESTS, &request_id),
                        &json!({
                            "status": "processing",
                            "payoutTxHash": tx_hash,
                            "settlementMode": mode,
                            "updatedAt": state.now_iso(),
                        }),
                    )
                    .await;
                ("processing", Some(tx_hash))
            }
            Ok(_) | Err(_) => ("locked", None),
        }
    };

    Ok(private_json(json!({
        "ok": true,
        "requestId": request_id,
        "status": status,
        "settlementMode": params.settlement_mode,
        "payoutTxHash": payout_tx_hash,
        "quote": wpkn::public_quote(&quote_id, &wpkn::ExchangeQuote {
            direction,
            amount_in,
            amount_out,
            fee_amount,
            market_price: 1.0,
            spread_bps: 0,
            inventory_bps: 0,
            size_impact_bps: 0,
            total_cost_bps: 0,
            quote_expires_at: state.now_iso(),
            settlement_mode: params.settlement_mode,
        }),
    })))
}

fn wpkn_request_json(document: &Value) -> Value {
    json!({
        "requestId": document.get("id").cloned().unwrap_or(Value::Null),
        "direction": document.get("direction").cloned().unwrap_or(Value::Null),
        "amountIn": document.get("amountIn").and_then(Value::as_i64).unwrap_or(0),
        "amountOutQuoted": document
            .get("amountOutQuoted")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        "feePknOrWpkn": document
            .get("feePknOrWpkn")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        "fromAsset": document.get("fromAsset").cloned().unwrap_or(Value::Null),
        "toAsset": document.get("toAsset").cloned().unwrap_or(Value::Null),
        "toAddress": document.get("toAddress").cloned().unwrap_or(Value::Null),
        "depositTxHash": document.get("depositTxHash").cloned().unwrap_or(Value::Null),
        "payoutTxHash": document.get("payoutTxHash").cloned().unwrap_or(Value::Null),
        "status": document.get("status").cloned().unwrap_or(Value::Null),
        "settlementMode": document
            .get("settlementMode")
            .cloned()
            .unwrap_or(Value::Null),
        "createdAt": document.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": document.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

async fn wpkn_exchange_status(
    state: &DomainState,
    uid: &str,
    query: &QueryMap,
) -> Result<Response, ApiError> {
    let firestore = state.firestore()?;
    if let Some(request_id) = query.get("requestId") {
        let id = request_id.trim();
        let document = read_doc(firestore, store::WPKN_EXCHANGE_REQUESTS, id)
            .await?
            .ok_or_else(|| ApiError::not_found("Exchange request was not found."))?;
        if document.get("uid").and_then(Value::as_str) != Some(uid) {
            return Err(ApiError::not_found("Exchange request was not found."));
        }
        return Ok(private_json(
            json!({ "request": wpkn_request_json(&document) }),
        ));
    }
    let rows = firestore
        .run_query(
            &store::StructuredQuery::collection(store::WPKN_EXCHANGE_REQUESTS)
                .where_eq("uid", json!(uid))
                .limit(50),
        )
        .await?;
    let mut requests: Vec<Value> = rows.iter().map(wpkn_request_json).collect();
    requests.sort_by(|a, b| {
        let left = a.get("createdAt").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("createdAt").and_then(Value::as_str).unwrap_or_default();
        right.cmp(left)
    });
    requests.truncate(12);
    Ok(private_json(json!({ "requests": requests })))
}

// ---------------------------------------------------------------------------
// /api/wpkn-pkn-quote (public)
// ---------------------------------------------------------------------------

pub async fn wpkn_pkn_quote(
    State(state): State<DomainState>,
    Query(query): Query<QueryMap>,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    let parsed = super::parse_json_body(&body)?;
    let direction_input = parsed
        .get("direction")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .or_else(|| query.get("direction").cloned())
        .unwrap_or_default();
    let amount_input = parsed
        .get("amountIn")
        .and_then(Value::as_f64)
        .or_else(|| query.get("amountIn").and_then(|value| value.parse::<f64>().ok()))
        .unwrap_or(0.0);

    // Node fetches the market price before validating the request, so a
    // missing GeckoTerminal price answers 503 even for an empty query.
    let wpkn_usd = state.prices().wpkn_usd().await?;
    let pkn_usd = state.config().pkn_usd_price();
    let direction = wpkn::normalize_direction(&direction_input)?;
    let quote = wpkn::calculate_wpkn_pkn_market_quote(
        direction,
        amount_input,
        wpkn_usd,
        pkn_usd,
        state.config().wpkn_exchange_spread_bps,
        state.config().wpkn_market_quote_min_amount,
        state.config().wpkn_market_quote_max_amount,
        state.config().wpkn_market_quote_ttl_ms,
        state.now_ms(),
    )?;
    let quoted_at = state.now_iso();
    let response = quote.to_json(&quoted_at);
    let mut res = public_json(response, 0);
    res.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store, max-age=0"),
    );
    res.headers_mut().insert(
        axum::http::header::PRAGMA,
        axum::http::HeaderValue::from_static("no-cache"),
    );
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_resolution_prefers_the_body() {
        let mut query = QueryMap::new();
        query.insert("action".to_string(), "status".to_string());
        assert_eq!(action_of(&query, &json!({ "action": "quote" })), "quote");
        assert_eq!(action_of(&query, &json!({})), "status");
    }

    #[test]
    fn zero_wallet_is_zipped_to_the_zero_address() {
        assert_eq!(linked_zip(""), "0x0000000000000000000000000000000000000000");
        assert_eq!(linked_zip("0xabc"), "0xabc");
    }

    #[test]
    fn crypto_request_serialization_matches_the_node_shape() {
        let document = json!({
            "id": "req1",
            "quoteId": "q1",
            "fromAsset": "USDT",
            "toAsset": "PKN",
            "amountIn": 100.0,
            "amountOut": 19940.0,
            "feeAmount": 60.0,
            "depositTxHash": "0xabc",
            "fromAddress": "0xdef",
            "status": "credited",
            "createdAt": "2026-10-08T10:00:00.000Z",
        });
        let row = crypto_request_json(&document, "purchase");
        assert_eq!(row["requestId"], json!("req1"));
        assert_eq!(row["quoteId"], json!("q1"));
        assert_eq!(row["amountOut"], json!(19940.0));
        assert_eq!(row["status"], json!("credited"));
        assert_eq!(row["kind"], json!("purchase"));
        assert_eq!(row["payoutTxHash"], json!(null));
    }

    #[test]
    fn wpkn_request_serialization_matches_the_node_shape() {
        let document = json!({
            "id": "req2",
            "direction": "pkn_to_wpkn",
            "amountIn": 5000,
            "amountOutQuoted": 4950,
            "feePknOrWpkn": 50,
            "fromAsset": "PKN",
            "toAsset": "wPKN",
            "toAddress": "0xabc",
            "status": "locked",
            "settlementMode": "manual_pending",
        });
        let row = wpkn_request_json(&document);
        assert_eq!(row["requestId"], json!("req2"));
        assert_eq!(row["direction"], json!("pkn_to_wpkn"));
        assert_eq!(row["amountOutQuoted"], json!(4950));
        assert_eq!(row["status"], json!("locked"));
        assert_eq!(row["depositTxHash"], json!(null));
    }

    #[test]
    fn text_and_number_helpers_trim_and_bound() {
        assert_eq!(
            text_of(&json!({ "quoteId": "  abcdef  " }), "quoteId", 3),
            "abc"
        );
        assert_eq!(text_of(&json!({}), "quoteId", 10), "");
        assert_eq!(num_of(&json!({ "amountIn": "12.5" }), "amountIn"), 12.5);
        assert_eq!(num_of(&json!({}), "amountIn"), 0.0);
    }
}
