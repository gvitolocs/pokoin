//! Balances, the ledger and event idempotency — on Firestore, matching the
//! Node collections exactly (`balances/{uid}`, `ledger_entries/{id}`,
//! `commerce_idempotency/{hash}`).
//!
//! State is never migrated: the wallet documents keep their real field names
//! (`availablePkn`, `lockedPkn`, `updatedAt`) and the ledger keeps
//! `{ uid, type, amountPkn, ... }`. Every movement is one Firestore
//! transaction: read the balance documents, compute the delta, then commit the
//! balance writes, the ledger entries and the idempotency marker together. A
//! replayed key returns the recorded result instead of moving money twice.

use serde_json::{json, Value};

use crate::error::StoreError;
use crate::firestore::{
    balance_document, commit_body, document_fields, FirestoreBalance, FirestoreClient,
    FirestoreWrite, MAX_WRITES_PER_COMMIT,
};

pub const BALANCES: &str = "balances";
pub const LEDGER_ENTRIES: &str = "ledger_entries";
pub const IDEMPOTENCY: &str = "commerce_idempotency";
pub const NATIVE_DEPOSITS: &str = "native_pkn_deposits";
pub const WITHDRAW_REQUESTS: &str = "withdraw_requests";
pub const PKN_PURCHASES: &str = "pkn_purchases";
pub const ORDERS: &str = "orders";
pub const SALES_COLLECTION: &str = "marketplace_sales";
pub const MONEY_REQUESTS: &str = "money_requests";
pub const NOTIFICATIONS: &str = "notifications";
pub const USERS: &str = "users";
pub const USERNAMES: &str = "usernames";
pub const WALLET_ADDRESSES: &str = "wallet_addresses";
/// Seller owned-collection records (`_user_card_collection.js`).
pub const USER_CARD_COLLECTIONS: &str = "user_card_collections";
/// NFT physical-shipping requests.
pub const NFT_SHIPPING_REQUESTS: &str = "nft_shipping_requests";
/// Seller sale email markers (`_marketplace_sale_notifications.js`).
pub const ORDER_SELLER_SALE_NOTIFICATIONS: &str = "order_seller_sale_notifications";
pub const CRYPTO_PURCHASE_QUOTES: &str = "crypto_pkn_purchase_quotes";
pub const CRYPTO_PURCHASE_REQUESTS: &str = "crypto_pkn_purchase_requests";
pub const CRYPTO_PURCHASE_DEPOSITS: &str = "crypto_pkn_purchase_deposits";
pub const CRYPTO_SALE_QUOTES: &str = "crypto_pkn_sale_quotes";
pub const CRYPTO_SALE_REQUESTS: &str = "crypto_pkn_sale_requests";
pub const CRYPTO_SALE_PAYOUTS: &str = "crypto_pkn_sale_payouts";
pub const WPKN_EXCHANGE_QUOTES: &str = "wpkn_exchange_quotes";
pub const WPKN_EXCHANGE_REQUESTS: &str = "wpkn_exchange_requests";
pub const WPKN_EXCHANGE_DEPOSITS: &str = "wpkn_exchange_deposits";
pub const WPKN_EXCHANGE_CONFIG: &str = "wpkn_exchange_config";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveMode {
    /// `from.availablePkn -= amount`, `to.availablePkn += amount`.
    Transfer,
    /// `to.availablePkn += amount` (external funding).
    Mint,
    /// `from.availablePkn -= amount` (PKN left the site).
    Burn,
    /// `from.availablePkn -= amount`, `from.lockedPkn += amount`.
    Lock,
    /// `from.lockedPkn -= amount` (payout settled).
    UnlockBurn,
    /// `from.lockedPkn -= amount`, `from.availablePkn += amount`.
    UnlockRelease,
    /// Ledger-only entry (no balance change).
    RecordOnly,
}

#[derive(Debug, Clone)]
pub struct LedgerOp {
    pub idem_key: Option<String>,
    pub reason: String,
    pub receive_reason: Option<String>,
    pub from_uid: Option<String>,
    pub to_uid: Option<String>,
    pub amount: i64,
    pub counterparty: Option<String>,
    pub counterparty_username: Option<String>,
    pub ref_id: Option<String>,
    pub meta: Value,
    pub mode: MoveMode,
    /// Reject when the sender balance is short (default `true`).
    pub require_available: bool,
}

impl LedgerOp {
    fn base(from: Option<&str>, to: Option<&str>, amount: i64, reason: &str, mode: MoveMode) -> Self {
        Self {
            idem_key: None,
            reason: reason.to_string(),
            receive_reason: None,
            from_uid: from.map(|value| value.to_string()),
            to_uid: to.map(|value| value.to_string()),
            amount,
            counterparty: None,
            counterparty_username: None,
            ref_id: None,
            meta: json!({}),
            mode,
            require_available: true,
        }
    }

    pub fn transfer(from: &str, to: &str, amount: i64, reason: &str) -> Self {
        Self::base(Some(from), Some(to), amount, reason, MoveMode::Transfer)
    }

    pub fn mint(to: &str, amount: i64, reason: &str) -> Self {
        let mut op = Self::base(None, Some(to), amount, reason, MoveMode::Mint);
        op.require_available = false;
        op
    }

    pub fn lock(from: &str, amount: i64, reason: &str) -> Self {
        Self::base(Some(from), None, amount, reason, MoveMode::Lock)
    }

    pub fn unlock(from: &str, amount: i64, reason: &str, release: bool) -> Self {
        let mut op = Self::base(
            Some(from),
            None,
            amount,
            reason,
            if release {
                MoveMode::UnlockRelease
            } else {
                MoveMode::UnlockBurn
            },
        );
        op.require_available = false;
        op
    }

    pub fn burn(from: &str, amount: i64, reason: &str) -> Self {
        Self::base(Some(from), None, amount, reason, MoveMode::Burn)
    }

    pub fn record(uid: &str, amount: i64, reason: &str) -> Self {
        let mut op = Self::base(Some(uid), None, amount, reason, MoveMode::RecordOnly);
        op.require_available = false;
        op
    }

    pub fn with_idempotency(mut self, key: impl Into<String>) -> Self {
        self.idem_key = Some(key.into());
        self
    }

    pub fn with_ref(mut self, reference: impl Into<String>) -> Self {
        self.ref_id = Some(reference.into());
        self
    }

    pub fn with_meta(mut self, meta: Value) -> Self {
        self.meta = meta;
        self
    }

    pub fn with_counterparty(mut self, uid: impl Into<String>, username: impl Into<String>) -> Self {
        self.counterparty = Some(uid.into());
        self.counterparty_username = Some(username.into());
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct LedgerOutcome {
    pub applied: bool,
    pub from_available: i64,
    pub to_available: i64,
    pub ledger_ids: Vec<String>,
}

/// Firestore document ids cannot contain `/`, so a caller-provided key is
/// hashed and the original key is stored inside the document.
pub fn idempotency_doc_id(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    format!("idem_{}", hex::encode(&digest[..16]))
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Read a wallet balance (a missing document is a zero balance).
pub async fn balance(fs: &FirestoreClient, uid: &str) -> Result<FirestoreBalance, StoreError> {
    let document = fs.get_document(&fs.document_path(BALANCES, uid)).await?;
    Ok(document
        .as_ref()
        .map(FirestoreBalance::from_document)
        .unwrap_or_default())
}

/// The ledger entry fields the Node writers use.
#[allow(clippy::too_many_arguments)]
pub fn ledger_entry_document(
    uid: &str,
    kind: &str,
    amount: i64,
    counterparty: Option<&str>,
    counterparty_username: Option<&str>,
    reference: Option<&str>,
    meta: &Value,
    created_at: &str,
) -> Value {
    let mut entry = json!({
        "uid": uid,
        "type": kind,
        "amountPkn": amount,
        "createdAt": created_at,
    });
    if let Some(object) = entry.as_object_mut() {
        if let Some(value) = counterparty {
            object.insert("counterpartyUid".into(), json!(value));
        }
        if let Some(value) = counterparty_username {
            object.insert("counterpartyUsername".into(), json!(value));
        }
        if let Some(value) = reference {
            object.insert("ref".into(), json!(value));
        }
        if let Some(extra) = meta.as_object() {
            for (key, value) in extra {
                if !value.is_null() {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
    }
    entry
}

/// Apply one ledger operation atomically on Firestore.
pub async fn apply(fs: &FirestoreClient, op: &LedgerOp) -> Result<LedgerOutcome, StoreError> {
    if op.amount <= 0 && op.mode != MoveMode::RecordOnly {
        return Err(StoreError::Invalid(
            "Enter a whole PKN amount greater than zero.".into(),
        ));
    }

    if let Some(key) = &op.idem_key {
        if let Some(existing) = idempotency_result(fs, key).await? {
            return Ok(outcome_from_record(&existing));
        }
    }

    let from_uid = op.from_uid.clone().filter(|uid| !uid.is_empty());
    let to_uid = op.to_uid.clone().filter(|uid| !uid.is_empty());
    let mut uids: Vec<String> = Vec::new();
    for uid in [from_uid.as_ref(), to_uid.as_ref()].into_iter().flatten() {
        if !uids.contains(uid) {
            uids.push(uid.clone());
        }
    }
    uids.sort();
    if uids.len() > MAX_WRITES_PER_COMMIT / 2 {
        return Err(StoreError::Invalid(
            "Too many parties in one ledger op.".into(),
        ));
    }

    let client_for_tx = fs.clone();
    let op_for_tx = op.clone();
    let uids_for_tx = uids.clone();
    let result = fs
        .run_transaction(move |transaction| {
            let client = client_for_tx.clone();
            let op = op_for_tx.clone();
            let uids = uids_for_tx.clone();
            Box::pin(async move {
                let mut balances: Vec<(String, FirestoreBalance)> = Vec::new();
                for uid in &uids {
                    let path = client.document_path(BALANCES, uid);
                    let document = client
                        .get_document_in_transaction(&path, &transaction)
                        .await?;
                    balances.push((
                        uid.clone(),
                        document
                            .as_ref()
                            .map(FirestoreBalance::from_document)
                            .unwrap_or_default(),
                    ));
                }
                apply_mode(&mut balances, &op)?;
                Ok(build_writes(&client, &uids, &balances, &op))
            })
        })
        .await;

    match result {
        Ok(_) => {
            // Read back the committed balances for the response.
            let mut from_available = 0;
            let mut to_available = 0;
            for uid in &uids {
                let new_balance = balance(fs, uid).await?;
                if Some(uid) == from_uid.as_ref() {
                    from_available = new_balance.available_pkn;
                }
                if Some(uid) == to_uid.as_ref() {
                    to_available = new_balance.available_pkn;
                }
            }
            if let Some(key) = &op.idem_key {
                let _ = record_idempotency(
                    fs,
                    json!({
                        "key": key,
                        "fromAvailable": from_available,
                        "toAvailable": to_available,
                        "applied": true,
                    }),
                )
                .await;
            }
            Ok(LedgerOutcome {
                applied: true,
                from_available,
                to_available,
                ledger_ids: Vec::new(),
            })
        }
        Err(error) => {
            if let Some(key) = &op.idem_key {
                if let Some(record) = idempotency_result(fs, key).await? {
                    return Ok(outcome_from_record(&record));
                }
            }
            Err(error)
        }
    }
}

fn apply_mode(
    balances: &mut [(String, FirestoreBalance)],
    op: &LedgerOp,
) -> Result<(), StoreError> {
    let from_uid = op.from_uid.clone().filter(|uid| !uid.is_empty());
    let to_uid = op.to_uid.clone().filter(|uid| !uid.is_empty());
    let index_of = |balances: &[(String, FirestoreBalance)], uid: &str| {
        balances.iter().position(|(candidate, _)| candidate == uid)
    };
    match op.mode {
        MoveMode::Transfer => {
            let (Some(from), Some(to)) = (from_uid.as_ref(), to_uid.as_ref()) else {
                return Err(StoreError::Invalid("Transfer needs both parties.".into()));
            };
            let from_index = index_of(balances, from).expect("locked");
            let to_index = index_of(balances, to).expect("locked");
            if op.require_available && balances[from_index].1.available_pkn < op.amount {
                return Err(StoreError::Insufficient);
            }
            balances[from_index].1.available_pkn -= op.amount;
            balances[to_index].1.available_pkn += op.amount;
        }
        MoveMode::Mint => {
            let Some(to) = to_uid.as_ref() else {
                return Err(StoreError::Invalid("Mint needs a recipient.".into()));
            };
            let index = index_of(balances, to).expect("locked");
            balances[index].1.available_pkn += op.amount;
        }
        MoveMode::Burn => {
            let Some(from) = from_uid.as_ref() else {
                return Err(StoreError::Invalid("Burn needs a source.".into()));
            };
            let index = index_of(balances, from).expect("locked");
            if op.require_available && balances[index].1.available_pkn < op.amount {
                return Err(StoreError::Insufficient);
            }
            balances[index].1.available_pkn -= op.amount;
        }
        MoveMode::Lock => {
            let Some(from) = from_uid.as_ref() else {
                return Err(StoreError::Invalid("Lock needs a source.".into()));
            };
            let index = index_of(balances, from).expect("locked");
            if op.require_available && balances[index].1.available_pkn < op.amount {
                return Err(StoreError::Insufficient);
            }
            balances[index].1.available_pkn -= op.amount;
            balances[index].1.locked_pkn += op.amount;
        }
        MoveMode::UnlockBurn => {
            let Some(from) = from_uid.as_ref() else {
                return Err(StoreError::Invalid("Unlock needs a source.".into()));
            };
            let index = index_of(balances, from).expect("locked");
            balances[index].1.locked_pkn = (balances[index].1.locked_pkn - op.amount).max(0);
        }
        MoveMode::UnlockRelease => {
            let Some(from) = from_uid.as_ref() else {
                return Err(StoreError::Invalid("Unlock needs a source.".into()));
            };
            let index = index_of(balances, from).expect("locked");
            balances[index].1.locked_pkn = (balances[index].1.locked_pkn - op.amount).max(0);
            balances[index].1.available_pkn += op.amount;
        }
        MoveMode::RecordOnly => {}
    }
    Ok(())
}

fn build_writes(
    client: &FirestoreClient,
    uids: &[String],
    balances: &[(String, FirestoreBalance)],
    op: &LedgerOp,
) -> Vec<FirestoreWrite> {
    let created_at = now_iso();
    let mut writes: Vec<FirestoreWrite> = Vec::new();
    for (uid, balance) in balances {
        if !uids.contains(uid) {
            continue;
        }
        writes.push(FirestoreWrite::Set {
            path: client.document_path(BALANCES, uid),
            value: balance_document(
                balance.available_pkn.max(0),
                balance.locked_pkn.max(0),
                &created_at,
            ),
        });
    }

    let from_uid = op.from_uid.clone().filter(|uid| !uid.is_empty());
    let to_uid = op.to_uid.clone().filter(|uid| !uid.is_empty());
    let push_entry = |writes: &mut Vec<FirestoreWrite>, uid: &str, kind: &str, amount: i64, counterparty: Option<&str>| {
        let id = uuid::Uuid::new_v4().to_string();
        writes.push(FirestoreWrite::Set {
            path: client.document_path(LEDGER_ENTRIES, &id),
            value: ledger_entry_document(
                uid,
                kind,
                amount,
                counterparty,
                op.counterparty_username.as_deref(),
                op.ref_id.as_deref(),
                &op.meta,
                &created_at,
            ),
        });
    };

    match op.mode {
        MoveMode::Transfer => {
            if let (Some(from), Some(to)) = (from_uid.as_ref(), to_uid.as_ref()) {
                push_entry(&mut writes, from, &op.reason, -op.amount, Some(to));
                push_entry(
                    &mut writes,
                    to,
                    op.receive_reason.as_deref().unwrap_or(&op.reason),
                    op.amount,
                    Some(from),
                );
            }
        }
        MoveMode::Mint => {
            if let Some(to) = to_uid.as_ref() {
                push_entry(&mut writes, to, &op.reason, op.amount, op.counterparty.as_deref());
            }
        }
        MoveMode::Burn | MoveMode::Lock => {
            if let Some(from) = from_uid.as_ref() {
                push_entry(&mut writes, from, &op.reason, -op.amount, op.counterparty.as_deref());
            }
        }
        // `withdraw_paid` / `wpkn_exchange_pkn_paid_out` record the settled
        // amount as a positive figure, matching the Node writers.
        MoveMode::UnlockBurn | MoveMode::UnlockRelease => {
            if let Some(from) = from_uid.as_ref() {
                push_entry(&mut writes, from, &op.reason, op.amount, op.counterparty.as_deref());
            }
        }
        MoveMode::RecordOnly => {
            let uid = from_uid.or_else(|| to_uid.clone()).unwrap_or_default();
            if !uid.is_empty() {
                push_entry(&mut writes, &uid, &op.reason, op.amount, op.counterparty.as_deref());
            }
        }
    }
    writes
}

fn outcome_from_record(record: &Value) -> LedgerOutcome {
    LedgerOutcome {
        applied: false,
        from_available: record
            .get("fromAvailable")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        to_available: record.get("toAvailable").and_then(Value::as_i64).unwrap_or(0),
        ledger_ids: Vec::new(),
    }
}

/// Record an idempotency marker (`create` semantics: never overwrite).
pub async fn record_idempotency(fs: &FirestoreClient, record: Value) -> Result<(), StoreError> {
    let key = record
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if key.is_empty() {
        return Ok(());
    }
    let id = idempotency_doc_id(&key);
    let path = fs.document_path(IDEMPOTENCY, &id);
    if fs.get_document(&path).await?.is_some() {
        return Ok(());
    }
    let mut payload = record;
    if let Some(object) = payload.as_object_mut() {
        object.insert("key".into(), json!(key));
        object.insert("createdAt".into(), json!(now_iso()));
    }
    match fs.create_document(IDEMPOTENCY, &id, &payload).await {
        Ok(_) => Ok(()),
        Err(StoreError::Conflict(_)) => Ok(()),
        Err(other) => Err(other),
    }
}

/// Claim an idempotency key; `false` means it was already claimed.
pub async fn claim_idempotency(
    fs: &FirestoreClient,
    key: &str,
    uid: Option<&str>,
    result: &Value,
) -> Result<bool, StoreError> {
    let id = idempotency_doc_id(key);
    let mut payload = json!({ "key": key, "createdAt": now_iso(), "result": result });
    if let Some(uid) = uid {
        if let Some(object) = payload.as_object_mut() {
            object.insert("uid".into(), json!(uid));
        }
    }
    match fs.create_document(IDEMPOTENCY, &id, &payload).await {
        Ok(_) => Ok(true),
        Err(StoreError::Conflict(_)) => Ok(false),
        Err(other) => Err(other),
    }
}

/// Read a recorded idempotency document (`result` plus bookkeeping fields).
pub async fn idempotency_result(
    fs: &FirestoreClient,
    key: &str,
) -> Result<Option<Value>, StoreError> {
    let id = idempotency_doc_id(key);
    let document = fs.get_document(&fs.document_path(IDEMPOTENCY, &id)).await?;
    Ok(document.map(|mut document| {
        if let Some(result) = document.get("result").cloned() {
            if !result.is_null() {
                // Merge the recorded result with the wrapper so both
                // `fromAvailable` (ledger) and `result` (orders) callers work.
                if let (Some(target), Some(extra)) = (document.as_object_mut(), result.as_object())
                {
                    for (key, value) in extra {
                        target.entry(key.clone()).or_insert_with(|| value.clone());
                    }
                }
            }
        }
        document
    }))
}

// ---------------------------------------------------------------------------
// Shared helpers used by the handlers
// ---------------------------------------------------------------------------

/// `Math.max(0, Math.trunc(Number(baseRev) || 0))` for the cart revision.
pub fn clean_offset(value: Option<&Value>) -> i64 {
    crate::domain::js_number(value)
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(|number| (number.trunc() as i64).min(50_000))
        .unwrap_or(0)
}

pub fn clean_limit(value: Option<&Value>, fallback: i64) -> i64 {
    match crate::domain::js_number(value) {
        Some(number) if number.is_finite() => (number.trunc() as i64).clamp(1, 1000),
        _ => fallback,
    }
}

/// Firestore document id for the Node `usernames/{username}` registry.
pub fn username_doc_id(username: &str) -> String {
    username.trim().to_ascii_lowercase()
}

/// Read `users/{uid}` as a plain object (empty when missing).
pub async fn read_user(fs: &FirestoreClient, uid: &str) -> Result<Value, StoreError> {
    Ok(fs
        .get_document(&fs.document_path(USERS, uid))
        .await?
        .unwrap_or_else(|| json!({})))
}

/// Merge-write selected `users/{uid}` fields.
pub async fn write_user(fs: &FirestoreClient, uid: &str, fields: Value) -> Result<(), StoreError> {
    let mut payload = fields;
    if let Some(object) = payload.as_object_mut() {
        object.insert("updatedAt".into(), json!(now_iso()));
    }
    fs.set_document(&fs.document_path(USERS, uid), &payload)
        .await?;
    Ok(())
}

/// Resolve a username through `usernames/{username}` then `users.usernameLower`.
pub async fn uid_for_username(
    fs: &FirestoreClient,
    username: &str,
) -> Result<Option<String>, StoreError> {
    let clean = username_doc_id(username);
    if clean.is_empty() {
        return Ok(None);
    }
    if let Some(document) = fs.get_document(&fs.document_path(USERNAMES, &clean)).await? {
        let uid = document
            .get("uid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !uid.is_empty() {
            return Ok(Some(uid));
        }
    }
    let rows = fs
        .run_query(
            &crate::firestore::StructuredQuery::collection(USERS)
                .where_eq("usernameLower", json!(clean))
                .limit(1),
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|row| row.get("id").or_else(|| row.get("uid")))
        .and_then(Value::as_str)
        .map(|value| value.to_string()))
}

pub fn balance_of(document: &Value) -> FirestoreBalance {
    FirestoreBalance::from_document(document)
}

pub fn fields(document: &Value) -> std::collections::HashMap<String, Value> {
    document_fields(document)
}

/// Build a Firestore document id the way `firestore.collection(x).doc()` does.
pub fn auto_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub use crate::firestore::StructuredQuery;

/// Expose the raw commit body builder for adapters and tests.
pub fn commit_body_for(transaction: Option<&str>, writes: &[FirestoreWrite]) -> Value {
    commit_body(transaction, writes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotency_doc_ids_are_firestore_safe_and_stable() {
        let id = idempotency_doc_id("native_topup:0xabc/def");
        assert!(id.starts_with("idem_"));
        assert!(!id.contains('/'));
        assert_eq!(id, idempotency_doc_id("native_topup:0xabc/def"));
        assert_ne!(id, idempotency_doc_id("native_topup:0xabc/deg"));
    }

    #[test]
    fn ledger_entry_fields_match_the_node_writers() {
        let entry = ledger_entry_document(
            "u1",
            "account_transfer_sent",
            -250,
            Some("u2"),
            Some("bob"),
            Some("order-1"),
            &json!({ "purpose": "silver_membership" }),
            "2026-10-08T10:00:00.000Z",
        );
        assert_eq!(entry["uid"], json!("u1"));
        assert_eq!(entry["type"], json!("account_transfer_sent"));
        assert_eq!(entry["amountPkn"], json!(-250));
        assert_eq!(entry["counterpartyUid"], json!("u2"));
        assert_eq!(entry["counterpartyUsername"], json!("bob"));
        assert_eq!(entry["ref"], json!("order-1"));
        assert_eq!(entry["purpose"], json!("silver_membership"));
        assert_eq!(entry["createdAt"], json!("2026-10-08T10:00:00.000Z"));
    }

    #[test]
    fn username_documents_are_lowercased() {
        assert_eq!(username_doc_id("  RedShakkio "), "redshakkio");
        assert_eq!(username_doc_id(""), "");
    }

    fn balances(pairs: &[(&str, i64, i64)]) -> Vec<(String, FirestoreBalance)> {
        pairs
            .iter()
            .map(|(uid, available, locked)| {
                (
                    (*uid).to_string(),
                    FirestoreBalance {
                        available_pkn: *available,
                        locked_pkn: *locked,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn transfer_moves_available_pkn_both_ways() {
        let mut state = balances(&[("a", 500, 0), ("b", 100, 0)]);
        let op = LedgerOp::transfer("a", "b", 250, "account_transfer_sent");
        apply_mode(&mut state, &op).unwrap();
        assert_eq!(state[0].1.available_pkn, 250);
        assert_eq!(state[1].1.available_pkn, 350);
    }

    #[test]
    fn transfer_refuses_an_insufficient_sender() {
        let mut state = balances(&[("a", 100, 0), ("b", 0, 0)]);
        let op = LedgerOp::transfer("a", "b", 250, "account_transfer_sent");
        assert!(matches!(
            apply_mode(&mut state, &op),
            Err(StoreError::Insufficient)
        ));
    }

    #[test]
    fn lock_moves_available_into_locked() {
        let mut state = balances(&[("a", 500, 0)]);
        let op = LedgerOp::lock("a", 200, "withdraw_requested");
        apply_mode(&mut state, &op).unwrap();
        assert_eq!(state[0].1.available_pkn, 300);
        assert_eq!(state[0].1.locked_pkn, 200);
    }

    #[test]
    fn unlock_burn_and_release_clear_the_lock() {
        let mut state = balances(&[("a", 0, 200)]);
        let op = LedgerOp::unlock("a", 200, "withdraw_paid", false);
        apply_mode(&mut state, &op).unwrap();
        assert_eq!(state[0].1.locked_pkn, 0);
        assert_eq!(state[0].1.available_pkn, 0);

        let mut state = balances(&[("a", 0, 200)]);
        let op = LedgerOp::unlock("a", 200, "wpkn_exchange_released", true);
        apply_mode(&mut state, &op).unwrap();
        assert_eq!(state[0].1.locked_pkn, 0);
        assert_eq!(state[0].1.available_pkn, 200);
    }

    #[test]
    fn mint_and_burn_only_touch_one_side() {
        let mut state = balances(&[("a", 10, 0)]);
        let mint = LedgerOp::mint("a", 90, "account_top_up");
        apply_mode(&mut state, &mint).unwrap();
        assert_eq!(state[0].1.available_pkn, 100);

        let burn = LedgerOp::burn("a", 40, "crypto_pkn_sale");
        apply_mode(&mut state, &burn).unwrap();
        assert_eq!(state[0].1.available_pkn, 60);
    }

    #[test]
    fn record_only_leaves_balances_untouched() {
        let mut state = balances(&[("a", 10, 5)]);
        let op = LedgerOp::record("a", -7, "crypto_pkn_sale_deposit");
        apply_mode(&mut state, &op).unwrap();
        assert_eq!(state[0].1.available_pkn, 10);
        assert_eq!(state[0].1.locked_pkn, 5);
    }

    fn test_client() -> FirestoreClient {
        FirestoreClient::with_base(
            reqwest::Client::new(),
            crate::firestore::ServiceAccount {
                project_id: "p".into(),
                client_email: "svc@p.iam.gserviceaccount.com".into(),
                private_key_pem: String::new(),
            },
            "https://firestore.test/v1/projects/p/databases/(default)/documents",
        )
    }

    #[test]
    fn writes_include_balances_and_the_matching_ledger_entries() {
        let client = test_client();
        let uids = vec!["a".to_string(), "b".to_string()];
        let state = balances(&[("a", 250, 0), ("b", 350, 0)]);
        let mut op = LedgerOp::transfer("a", "b", 250, "account_transfer_sent");
        op.receive_reason = Some("account_transfer_received".into());
        let writes = build_writes(&client, &uids, &state, &op);
        assert_eq!(writes.len(), 4);
        let ledger: Vec<Value> = writes
            .iter()
            .map(FirestoreWrite::to_json)
            .filter(|json| {
                json["update"]["name"]
                    .as_str()
                    .map(|name| name.contains("/ledger_entries/"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(ledger.len(), 2);
        let amounts: Vec<i64> = ledger
            .iter()
            .map(|json| {
                json["update"]["fields"]["amountPkn"]["integerValue"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap()
            })
            .collect();
        assert!(amounts.contains(&-250));
        assert!(amounts.contains(&250));
        let kinds: Vec<&str> = ledger
            .iter()
            .map(|json| json["update"]["fields"]["type"]["stringValue"].as_str().unwrap())
            .collect();
        assert!(kinds.contains(&"account_transfer_sent"));
        assert!(kinds.contains(&"account_transfer_received"));
    }

    #[test]
    fn commit_bodies_are_independent() {
        let writes = vec![FirestoreWrite::Delete {
            path: "projects/p/databases/(default)/documents/x/1".into(),
        }];
        let body = commit_body_for(None, &writes);
        assert_eq!(body["writes"].as_array().unwrap().len(), 1);
        assert!(commit_body_for(None, &writes).get("transaction").is_none());
    }

    #[test]
    fn limits_and_offsets_match_the_node_guards() {
        assert_eq!(clean_limit(None, 500), 500);
        assert_eq!(clean_limit(Some(&json!("")), 500), 500);
        assert_eq!(clean_limit(Some(&json!(0)), 1), 1);
        assert_eq!(clean_limit(Some(&json!(5000)), 500), 1000);
        assert_eq!(clean_offset(None), 0);
        assert_eq!(clean_offset(Some(&json!(-5))), 0);
        assert_eq!(clean_offset(Some(&json!(1_000_000))), 50_000);
    }

    #[test]
    fn collection_names_match_the_node_contract() {
        assert_eq!(BALANCES, "balances");
        assert_eq!(LEDGER_ENTRIES, "ledger_entries");
        assert_eq!(ORDERS, "orders");
        assert_eq!(SALES_COLLECTION, "marketplace_sales");
        assert_eq!(USERS, "users");
        assert_eq!(USERNAMES, "usernames");
        assert_eq!(WALLET_ADDRESSES, "wallet_addresses");
        assert_eq!(USER_CARD_COLLECTIONS, "user_card_collections");
        assert_eq!(NFT_SHIPPING_REQUESTS, "nft_shipping_requests");
        assert_eq!(
            ORDER_SELLER_SALE_NOTIFICATIONS,
            "order_seller_sale_notifications"
        );
        assert_eq!(MONEY_REQUESTS, "money_requests");
    }
}
