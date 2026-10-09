//! PKN wallet flows: account top-up, transfers, withdrawals, Silver unlock,
//! money requests and the Earn-PKN inquiry.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::{private_json, text_field};
use crate::auth::Claims;
use crate::domain::money_request as mr;
use crate::error::ApiError;
use crate::firestore::StructuredQuery;
use crate::state::{AuthedUser, DomainState};
use crate::store::{self, LedgerOp};

const SILVER_DURATION_MS: i64 = 365 * 24 * 60 * 60 * 1000;

async fn username_for_uid(state: &DomainState, uid: &str) -> Result<String, ApiError> {
    let user = store::read_user(state.firestore()?, uid).await?;
    Ok(user
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

async fn uid_for_username(state: &DomainState, username: &str) -> Result<Option<String>, ApiError> {
    Ok(store::uid_for_username(state.firestore()?, username).await?)
}

/// Registered payout/source wallets: `wallet_addresses` documents whose
/// document id or `address` field is a 0x address for this uid.
async fn registered_wallets(state: &DomainState, uid: &str) -> Result<Vec<String>, ApiError> {
    let firestore = state.firestore()?;
    let rows = firestore
        .run_query(
            &StructuredQuery::collection(store::WALLET_ADDRESSES)
                .where_eq("uid", json!(uid))
                .limit(5),
        )
        .await
        .unwrap_or_default();
    let mut addresses: Vec<String> = Vec::new();
    for row in rows {
        for candidate in [row.get("id"), row.get("address")] {
            let Some(text) = candidate.and_then(Value::as_str) else {
                continue;
            };
            let text = text.trim().to_ascii_lowercase();
            // `REGISTERED_ADDRESS = /^0x[a-f0-9]{40}$/`
            if crate::domain::crypto::is_registered_address(&text) && !addresses.contains(&text) {
                addresses.push(text);
            }
        }
    }
    Ok(addresses)
}

// ---------------------------------------------------------------------------
// POST /api/top-up-account-balance
// ---------------------------------------------------------------------------

pub async fn top_up_account_balance(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let reconcile_recent = body.get("reconcileRecent").and_then(Value::as_bool) == Some(true);
    let amount = body
        .get("amountPkn")
        .and_then(Value::as_f64)
        .map(|value| value.trunc() as i64)
        .unwrap_or(0);
    let funding_hash = text_field(&body, &["fundingTxHash"], 80).to_ascii_lowercase();

    if !reconcile_recent && !(amount > 0) {
        return Err(ApiError::bad_request(
            "Enter a whole PKN amount greater than zero.",
        ));
    }
    if !reconcile_recent && funding_hash.is_empty() {
        return Err(ApiError::bad_request("Missing top-up transaction hash."));
    }

    let addresses = registered_wallets(&state, &claims.uid).await?;
    if addresses.is_empty() {
        return Err(ApiError::bad_request(
            "Link a wallet before topping up your account balance.",
        ));
    }

    if reconcile_recent {
        if !(amount > 0) {
            return Err(ApiError::bad_request(
                "Enter the whole PKN amount to reconcile.",
            ));
        }
        let bank = state.chain().crypto_settlement_address()?;
        let treasury = state.config().pokoin_bank_address.to_ascii_lowercase();
        let _ = bank;
        let transactions = state.chain().address_transactions(&treasury, 40).await?;
        let mut credited_count = 0i64;
        let mut credited_amount = 0i64;
        let mut credited_hashes: Vec<String> = Vec::new();
        for tx in &transactions {
            let tx_hash = tx
                .get("hash")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let from = tx
                .get("from")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let to = tx
                .get("to")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let tx_amount = tx
                .get("amount")
                .or_else(|| tx.get("value"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if tx_hash.len() != 66
                || !addresses.contains(&from)
                || to != treasury
                || (tx_amount - amount as f64).abs() > f64::EPSILON
            {
                continue;
            }
            if credit_verified_top_up(&state, &claims.uid, &tx_hash, &from, tx_amount, true).await? {
                credited_count += 1;
                credited_amount += tx_amount as i64;
                credited_hashes.push(tx_hash);
            }
        }
        return Ok(private_json(json!({
            "ok": true,
            "creditedCount": credited_count,
            "creditedAmountPkn": credited_amount,
            "creditedTxHashes": credited_hashes,
        })));
    }

    let mut verified = None;
    let mut mismatch = None;
    for address in &addresses {
        match state
            .chain()
            .verify_pokoin_deposit(&funding_hash, address, amount as f64)
            .await
        {
            Ok(deposit) => {
                verified = Some(deposit);
                break;
            }
            Err(error) if error.status == StatusCode::FORBIDDEN => mismatch = Some(error),
            Err(error) => return Err(error),
        }
    }
    let Some(deposit) = verified else {
        return Err(mismatch.unwrap_or_else(|| {
            ApiError::bad_request("Link a wallet before topping up your account balance.")
        }));
    };

    let credited = credit_verified_top_up(
        &state,
        &claims.uid,
        &funding_hash,
        &deposit.from_address,
        deposit.amount_in,
        false,
    )
    .await?;
    Ok(private_json(json!({
        "ok": true,
        "amountPkn": deposit.amount_in,
        "txHash": funding_hash,
        "credited": credited,
    })))
}

async fn credit_verified_top_up(
    state: &DomainState,
    uid: &str,
    funding_hash: &str,
    from_address: &str,
    amount_pkn: f64,
    reconciled: bool,
) -> Result<bool, ApiError> {
    let amount = amount_pkn.trunc() as i64;
    if amount <= 0 {
        return Err(ApiError::bad_request("Enter a whole PKN amount greater than zero."));
    }
    let firestore = state.firestore()?;
    // A funding hash belongs to exactly one account.
    if let Some(existing) = firestore
        .get_document(&firestore.document_path(store::NATIVE_DEPOSITS, funding_hash))
        .await?
    {
        let owner = existing.get("uid").and_then(Value::as_str).unwrap_or_default();
        if owner == uid {
            return Ok(false);
        }
        return Err(ApiError::conflict(
            "This top-up transaction was already used by another account.",
        ));
    }

    let op = LedgerOp::mint(uid, amount, "account_top_up")
        .with_idempotency(format!("native_topup:{funding_hash}"))
        .with_ref(funding_hash)
        .with_meta(json!({
            "txHash": funding_hash,
            "fromAddress": from_address,
            "reconciled": reconciled,
        }));
    let outcome = store::apply(firestore, &op).await?;
    if outcome.applied {
        let document = json!({
            "uid": uid,
            "txHash": funding_hash,
            "fromAddress": from_address,
            "amountPkn": amount,
            "purpose": "account_top_up",
            "reconciled": reconciled,
            "createdAt": store::now_iso(),
        });
        if reconciled {
            firestore
                .set_document(
                    &firestore.document_path(store::NATIVE_DEPOSITS, funding_hash),
                    &document,
                )
                .await?;
        } else {
            match firestore
                .create_document(store::NATIVE_DEPOSITS, funding_hash, &document)
                .await
            {
                Ok(_) | Err(crate::error::StoreError::Conflict(_)) => {}
                Err(other) => return Err(other.into()),
            }
        }
    }
    Ok(outcome.applied)
}

// ---------------------------------------------------------------------------
// POST /api/transfer-account-balance
// ---------------------------------------------------------------------------

pub async fn transfer_account_balance(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let to_username = text_field(&body, &["recipientUsername"], 40).to_ascii_lowercase();
    let amount = body
        .get("amountPkn")
        .and_then(Value::as_f64)
        .map(|value| value.trunc() as i64)
        .unwrap_or(0);
    if !mr::username_re().is_match(&to_username) {
        return Err(ApiError::bad_request("Enter a valid recipient username."));
    }
    if amount <= 0 {
        return Err(ApiError::bad_request(
            "Enter a whole PKN amount greater than zero.",
        ));
    }
    let recipient_uid = uid_for_username(&state, &to_username)
        .await?
        .ok_or_else(|| ApiError::not_found("No Pokoin account was found for that username."))?;
    if recipient_uid == claims.uid {
        return Err(ApiError::bad_request("You cannot send PKN to your own account."));
    }
    let sender_username = username_for_uid(&state, &claims.uid).await?;
    let recipient = store::read_user(state.firestore()?, &recipient_uid).await?;
    let recipient_email = recipient
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let recipient_display = recipient
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or(&to_username)
        .to_string();

    let op = LedgerOp::transfer(&claims.uid, &recipient_uid, amount, "account_transfer_sent")
        .with_meta(json!({}));
    let mut op = op;
    op.receive_reason = Some("account_transfer_received".into());
    op.counterparty = Some(recipient_uid.clone());
    op.counterparty_username = Some(to_username.clone());
    store::apply(state.firestore()?, &op).await?;

    // Delivery goes through the real Resend path (`_email.js`); a missing key is
    // reported as skipped, never as sent.
    let email_delivery = notify_pkn_received(
        &state,
        &recipient_email,
        &recipient_display,
        &sender_username,
        amount,
    )
    .await;

    Ok(private_json(json!({
        "ok": true,
        "creditedAccountBalance": true,
        "emailNotification": email_delivery,
    })))
}

async fn notify_pkn_received(
    state: &DomainState,
    to_address: &str,
    recipient_display: &str,
    sender_username: &str,
    amount: i64,
) -> Value {
    if !crate::email::can_email_user(to_address) {
        return json!({
            "ok": true, "skipped": true,
            "reason": "Recipient has no deliverable email.",
        });
    }
    let subject = "You received PKN";
    let text = format!("{recipient_display}, {sender_username} sent you {amount} PKN.");
    match crate::email::send_email(
        state.http(),
        &crate::email::no_reply_email_from(),
        to_address,
        subject,
        &text,
        &format!("<p>{}</p>", crate::domain::notify::escape_html(&text)),
    )
    .await
    {
        Ok(delivery) => json!({
            "ok": true,
            "skipped": delivery.skipped,
            "reason": delivery.reason,
            "deliveryId": delivery.id,
        }),
        Err(error) => json!({ "ok": false, "error": error.message }),
    }
}

// ---------------------------------------------------------------------------
// POST /api/request-pkn-withdraw
// ---------------------------------------------------------------------------

pub async fn request_pkn_withdraw(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let address = text_field(&body, &["toAddress"], 80);
    let amount = body
        .get("amountPkn")
        .and_then(Value::as_f64)
        .map(|value| value.trunc() as i64)
        .unwrap_or(0);
    if !address.starts_with("0x") || address.len() != 42 {
        return Err(ApiError::bad_request("Enter a valid 0x payout address."));
    }
    if amount <= 0 {
        return Err(ApiError::bad_request(
            "Enter a whole PKN amount greater than zero.",
        ));
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let lock = LedgerOp::lock(&claims.uid, amount, "withdraw_requested")
        .with_ref(&request_id)
        .with_meta(json!({ "toAddress": address }));
    store::apply(state.firestore()?, &lock).await?;

    let mut request = json!({
        "uid": claims.uid,
        "email": claims.email,
        "toAddress": address,
        "amountPkn": amount,
        "status": "pending",
        "source": "site_balance",
        "createdAt": store::now_iso(),
        "updatedAt": store::now_iso(),
    });
    let _ = state
        .firestore()?
        .set_document(
            &state
                .firestore()?
                .document_path(store::WITHDRAW_REQUESTS, &request_id),
            &request,
        )
        .await;

    match state.chain().send_bank_pkn(&address, amount as f64).await {
        Ok((mode, tx_hash)) => match tx_hash {
            Some(tx_hash) => {
                let unlock = LedgerOp::unlock(&claims.uid, amount, "withdraw_paid", false)
                    .with_ref(&request_id)
                    .with_meta(json!({ "payoutTxHash": tx_hash, "toAddress": address }));
                store::apply(state.firestore()?, &unlock).await?;
                if let Some(object) = request.as_object_mut() {
                    object.insert("status".into(), json!("completed"));
                    object.insert("payoutMode".into(), json!(mode));
                    object.insert("payoutTxHash".into(), json!(tx_hash));
                    object.insert("completedAt".into(), json!(store::now_iso()));
                    object.insert("updatedAt".into(), json!(store::now_iso()));
                }
                let _ = state
                    .firestore()?
                    .set_document(
                        &state
                            .firestore()?
                            .document_path(store::WITHDRAW_REQUESTS, &request_id),
                        &request,
                    )
                    .await;
                Ok(private_json(json!({
                    "ok": true, "requestId": request_id, "status": "completed",
                    "payoutTxHash": tx_hash,
                })))
            }
            None => {
                if let Some(object) = request.as_object_mut() {
                    object.insert("payoutMode".into(), json!(mode));
                }
                let _ = state
                    .firestore()?
                    .set_document(
                        &state
                            .firestore()?
                            .document_path(store::WITHDRAW_REQUESTS, &request_id),
                        &request,
                    )
                    .await;
                Ok(private_json(json!({
                    "ok": true, "requestId": request_id, "status": "pending",
                    "payoutTxHash": Value::Null,
                })))
            }
        },
        Err(error) => {
            if let Some(object) = request.as_object_mut() {
                object.insert("payoutMode".into(), json!("manual_pending"));
                object.insert("payoutError".into(), json!(error.to_string()));
            }
            let _ = state
                .firestore()?
                .set_document(
                    &state
                        .firestore()?
                        .document_path(store::WITHDRAW_REQUESTS, &request_id),
                    &request,
                )
                .await;
            Ok(private_json(json!({
                "ok": true, "requestId": request_id, "status": "pending",
                "payoutTxHash": Value::Null,
                "warning": "Withdraw request created, but automatic bank payout is pending manual review.",
            })))
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/unlock-silver
// ---------------------------------------------------------------------------

pub async fn unlock_silver(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
) -> Result<Response, ApiError> {
    let price = state.config().silver_price_pkn;
    let treasury_username = state.config().pokoin_treasury_username.clone();
    let profile = store::read_user(state.firestore()?, &claims.uid).await?;
    let role = profile
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let silver_until = profile
        .get("silverUntil")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis());
    let balance = store::balance(state.firestore()?, &claims.uid).await?;

    let active = silver_until.map(|until| until > state.now_ms()).unwrap_or(false);
    if claims.has_admin_access() || role == "silver" || active {
        let until = silver_until
            .map(|until| {
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(until)
                    .unwrap_or_else(chrono::Utc::now)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_else(|| {
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
                    state.now_ms() + SILVER_DURATION_MS,
                )
                .unwrap_or_else(chrono::Utc::now)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            });
        return Ok(private_json(json!({
            "ok": true,
            "pricePkn": price,
            "availablePkn": balance.available_pkn,
            "silverUntil": until,
        })));
    }
    if balance.available_pkn < price {
        return Err(ApiError::bad_request(
            "Your site balance is too low for Silver.",
        ));
    }
    let treasury = uid_for_username(&state, &treasury_username)
        .await?
        .ok_or_else(|| ApiError::internal("Pokoin treasury account is not configured."))?;
    if treasury == claims.uid {
        return Err(ApiError::bad_request(
            "Pokoin treasury account cannot unlock Silver for itself.",
        ));
    }
    let until = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
        state.now_ms() + SILVER_DURATION_MS,
    )
    .unwrap_or_else(chrono::Utc::now);

    let op = LedgerOp::transfer(
        &claims.uid,
        &treasury,
        price,
        "silver_unlock_payment_sent",
    )
    .with_meta(json!({
        "purpose": "silver_membership",
        "silverUntil": until.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "counterpartyUsername": treasury_username,
    }));
    store::apply(state.firestore()?, &op).await?;

    store::write_user(
        state.firestore()?,
        &claims.uid,
        json!({
            "role": "silver",
            "silverUntil": until.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "silverUnlockedAt": store::now_iso(),
        }),
    )
    .await?;

    Ok(private_json(json!({
        "ok": true,
        "pricePkn": price,
        "availablePkn": balance.available_pkn - price,
        "silverUntil": until.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })))
}

// ---------------------------------------------------------------------------
// /api/money-request
// ---------------------------------------------------------------------------

pub async fn money_request_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let action = query.get("action").cloned().unwrap_or_else(|| "list".into());
    let firestore = state.firestore()?;
    if action == "notifications" {
        let rows = firestore
            .run_query(
                &StructuredQuery::collection(store::NOTIFICATIONS)
                    .where_eq("uid", json!(claims.uid))
                    .order_by("createdAt", true)
                    .limit(30),
            )
            .await?;
        let notifications: Vec<Value> = rows
            .iter()
            .map(|row| {
                json!({
                    "id": row.get("id").cloned().unwrap_or(Value::Null),
                    "type": row.get("type").cloned().unwrap_or(Value::Null),
                    "requestId": row.get("requestId").cloned().unwrap_or(Value::Null),
                    "actorUsername": row.get("actorUsername").cloned().unwrap_or(Value::Null),
                    "amountPkn": row.get("amountPkn").and_then(Value::as_i64).unwrap_or(0),
                    "read": row.get("read").and_then(Value::as_bool).unwrap_or(false),
                    "createdAt": row.get("createdAt").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        return Ok(private_json(json!({ "notifications": notifications })));
    }

    let incoming = load_money_requests(&state, "toUid", &claims.uid).await?;
    let outgoing = load_money_requests(&state, "fromUid", &claims.uid).await?;
    Ok(private_json(json!({ "incoming": incoming, "outgoing": outgoing })))
}

async fn load_money_requests(
    state: &DomainState,
    column: &str,
    uid: &str,
) -> Result<Vec<Value>, ApiError> {
    let firestore = state.firestore()?;
    let rows = firestore
        .run_query(
            &StructuredQuery::collection(store::MONEY_REQUESTS)
                .where_eq(column, json!(uid))
                .limit(50),
        )
        .await?;
    let mut out: Vec<Value> = rows
        .iter()
        .map(|row| {
            let created = row
                .get("createdAt")
                .and_then(Value::as_str)
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.timestamp_millis())
                .unwrap_or(0);
            let status = row
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or(mr::STATUS_PENDING);
            json!({
                "id": row.get("id").cloned().unwrap_or(Value::Null),
                "requestId": row.get("id").cloned().unwrap_or(Value::Null),
                "fromUid": row.get("fromUid").cloned().unwrap_or(Value::Null),
                "fromUsername": row.get("fromUsername").cloned().unwrap_or(Value::Null),
                "toUid": row.get("toUid").cloned().unwrap_or(Value::Null),
                "toUsername": row.get("toUsername").cloned().unwrap_or(Value::Null),
                "amountPkn": row.get("amountPkn").and_then(Value::as_i64).unwrap_or(0),
                "note": row.get("note").cloned().unwrap_or(Value::Null),
                "status": mr::effective_status(status, created, state.now_ms()),
                "createdAt": row.get("createdAt").cloned().unwrap_or(Value::Null),
                "paidAt": row.get("paidAt").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        let left = a.get("createdAt").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("createdAt").and_then(Value::as_str).unwrap_or_default();
        right.cmp(left)
    });
    Ok(out)
}

pub async fn money_request_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .or_else(|| query.get("action").cloned())
        .unwrap_or_else(|| "create".into());

    match action.as_str() {
        "create" => money_request_create(&state, &claims, &body).await,
        "pay" => money_request_pay(&state, &claims, &body).await,
        "decline" | "cancel" => money_request_resolve(&state, &claims, &body, &action).await,
        "read-notifications" => {
            let firestore = state.firestore()?;
            let rows = firestore
                .run_query(
                    &StructuredQuery::collection(store::NOTIFICATIONS)
                        .where_eq("uid", json!(claims.uid))
                        .where_eq("read", json!(false))
                        .limit(100),
                )
                .await?;
            let mut marked = 0u64;
            for row in &rows {
                let Some(id) = row.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let _ = firestore
                    .update_document(
                        &firestore.document_path(store::NOTIFICATIONS, id),
                        &json!({ "read": true, "readAt": store::now_iso() }),
                        Some(&["read", "readAt"]),
                    )
                    .await;
                marked += 1;
            }
            Ok(private_json(json!({ "ok": true, "marked": marked })))
        }
        _ => Err(ApiError::bad_request("Unknown action.")),
    }
}

async fn push_notification(
    state: &DomainState,
    uid: &str,
    kind: &str,
    request_id: &str,
    actor_username: &str,
    amount_pkn: i64,
) -> Result<(), ApiError> {
    let firestore = state.firestore()?;
    let id = store::auto_id();
    let document = json!({
        "uid": uid,
        "type": kind,
        "requestId": request_id,
        "actorUsername": actor_username,
        "amountPkn": amount_pkn,
        "read": false,
        "createdAt": store::now_iso(),
    });
    match firestore
        .create_document(store::NOTIFICATIONS, &id, &document)
        .await
    {
        Ok(_) | Err(crate::error::StoreError::Conflict(_)) => Ok(()),
        Err(other) => Err(other.into()),
    }
}

async fn load_request(state: &DomainState, request_id: &str) -> Result<Option<Value>, ApiError> {
    let firestore = state.firestore()?;
    Ok(firestore
        .get_document(&firestore.document_path(store::MONEY_REQUESTS, request_id))
        .await?)
}

async fn money_request_create(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let request = mr::validate_create(body).map_err(ApiError::bad_request)?;
    let to_uid = uid_for_username(state, &request.to_username)
        .await?
        .ok_or_else(|| ApiError::not_found("No Pokoin account was found for that username."))?;
    if to_uid == claims.uid {
        return Err(ApiError::bad_request(
            "You cannot request PKN from your own account.",
        ));
    }
    let from_username = username_for_uid(state, &claims.uid).await?;
    let request_id = if request.client_token.is_empty() {
        store::auto_id()
    } else {
        mr::request_doc_id(&claims.uid, &request.client_token)
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect()
    };
    let firestore = state.firestore()?;
    if firestore
        .get_document(&firestore.document_path(store::MONEY_REQUESTS, &request_id))
        .await?
        .is_some()
    {
        return Ok(private_json(json!({
            "ok": true,
            "requestId": request_id,
            "duplicate": true,
        })));
    }
    let document = json!({
        "fromUid": claims.uid,
        "fromUsername": from_username,
        "toUid": to_uid,
        "toUsername": request.to_username,
        "amountPkn": request.amount_pkn,
        "note": request.note,
        "status": mr::STATUS_PENDING,
        "clientToken": if request.client_token.is_empty() { Value::Null } else { json!(request.client_token) },
        "createdAt": store::now_iso(),
    });
    firestore
        .set_document(
            &firestore.document_path(store::MONEY_REQUESTS, &request_id),
            &document,
        )
        .await?;
    let _ = push_notification(
        state,
        &to_uid,
        "money_request_created",
        &request_id,
        &from_username,
        request.amount_pkn,
    )
    .await;
    Ok(private_json(json!({
        "ok": true,
        "requestId": request_id,
        "duplicate": false,
    })))
}

async fn money_request_pay(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
) -> Result<Response, ApiError> {
    let request_id = text_field(body, &["requestId"], 120);
    if request_id.is_empty() {
        return Err(ApiError::bad_request("Missing request id."));
    }
    let request = load_request(state, &request_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Request not found."))?;
    let from_uid = request
        .get("fromUid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let to_uid = request
        .get("toUid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let created_ms = request
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    let status = request
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(mr::STATUS_PENDING);
    let guard = mr::can_pay(
        status,
        &from_uid,
        &to_uid,
        created_ms,
        &claims.uid,
        state.now_ms(),
    );
    if !guard.ok {
        return Err(ApiError::bad_request(guard.error));
    }
    let amount = request.get("amountPkn").and_then(Value::as_i64).unwrap_or(0);
    let from_username = request
        .get("fromUsername")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let to_username = request
        .get("toUsername")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // The ledger op is keyed by request id, so a double tap cannot pay twice.
    let mut op = LedgerOp::transfer(&claims.uid, &from_uid, amount, "money_request_paid_sent")
        .with_idempotency(format!("money_request_pay:{request_id}"));
    op.receive_reason = Some("money_request_paid_received".into());
    op.counterparty = Some(from_uid.clone());
    op.counterparty_username = Some(from_username.clone());
    op.ref_id = Some(request_id.clone());
    let outcome = store::apply(state.firestore()?, &op).await?;
    if !outcome.applied {
        return Err(ApiError::conflict("This request was already paid."));
    }

    state
        .firestore()?
        .set_document(
            &state
                .firestore()?
                .document_path(store::MONEY_REQUESTS, &request_id),
            &json!({
                "status": mr::STATUS_PAID,
                "paidAt": store::now_iso(),
                "paidBy": claims.uid,
            }),
        )
        .await?;
    let _ = push_notification(
        state,
        &from_uid,
        "money_request_paid",
        &request_id,
        &to_username,
        amount,
    )
    .await;

    Ok(private_json(json!({
        "ok": true,
        "amountPkn": amount,
        "fromUsername": from_username,
    })))
}

async fn money_request_resolve(
    state: &DomainState,
    claims: &Claims,
    body: &Value,
    action: &str,
) -> Result<Response, ApiError> {
    let request_id = text_field(body, &["requestId"], 120);
    if request_id.is_empty() {
        return Err(ApiError::bad_request("Missing request id."));
    }
    let request = load_request(state, &request_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Request not found."))?;
    let from_uid = request
        .get("fromUid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let to_uid = request
        .get("toUid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let created_ms = request
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    let status = request
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(mr::STATUS_PENDING);
    let guard = mr::can_respond(
        status,
        &from_uid,
        &to_uid,
        created_ms,
        &claims.uid,
        action,
        state.now_ms(),
    );
    if !guard.ok {
        return Err(ApiError::bad_request(guard.error));
    }
    let new_status = if action == "decline" {
        mr::STATUS_DECLINED
    } else {
        mr::STATUS_CANCELLED
    };
    state
        .firestore()?
        .set_document(
            &state
                .firestore()?
                .document_path(store::MONEY_REQUESTS, &request_id),
            &json!({ "status": new_status, "resolvedAt": store::now_iso() }),
        )
        .await?;
    let notify_uid = if action == "decline" { &from_uid } else { &to_uid };
    let actor = if action == "decline" {
        request
            .get("toUsername")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    } else {
        request
            .get("fromUsername")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let _ = push_notification(
        state,
        notify_uid,
        if action == "decline" {
            "money_request_declined"
        } else {
            "money_request_cancelled"
        },
        &request_id,
        &actor,
        request.get("amountPkn").and_then(Value::as_i64).unwrap_or(0),
    )
    .await;
    Ok(private_json(json!({ "ok": true, "status": new_status })))
}

// ---------------------------------------------------------------------------
// POST /api/earn-pkn
// ---------------------------------------------------------------------------

pub async fn earn_pkn(
    State(state): State<DomainState>,
    axum::Json(body): axum::Json<Value>,
) -> Result<Response, ApiError> {
    let submission = super::earn_pkn::normalize(&body)?;
    let submitted_at = store::now_iso();
    let (subject, text, html) = super::earn_pkn::email(&submission, &submitted_at);
    let delivery = crate::email::send_email(
        state.http(),
        &crate::email::earn_pkn_email_from(),
        &crate::email::earn_pkn_email_to(),
        &subject,
        &text,
        &html,
    )
    .await?;
    // Node answers 503 when the provider is not configured: a submission the
    // team will never see must not look accepted.
    if delivery.skipped {
        return Ok((axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({
            "error":"Earn PKN email delivery is not configured.",
            "reason":delivery.reason.unwrap_or_else(|| "Email provider is not configured.".into()),
        }))).into_response());
    }
    Ok(axum::Json(json!({ "ok": true, "email": {"ok": true, "id": delivery.id} })).into_response())

}
