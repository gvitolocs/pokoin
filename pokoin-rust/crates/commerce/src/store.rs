//! Balances, the ledger and event idempotency — on Firestore, matching the
//! Node collections exactly (`balances/{uid}`, `ledger_entries/{id}`,
//! `commerce_idempotency/{hash}`).
//!
//! State is never migrated: the wallet documents keep their real field names
//! (`availablePkn`, `lockedPkn`, `updatedAt`) and the ledger keeps
//! `{ uid, type, amountPkn, ... }`. Every movement is one Firestore
//! transaction: read the idempotency marker and the balance documents (one
//! batchGet), compute the delta, then commit the balance writes, the ledger
//! entries and the marker (create-only) together. A replayed key returns the
//! recorded result instead of moving money twice; two racing callers cannot
//! both commit because only one marker create can succeed.

use std::sync::{Arc, Mutex};

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
    /// A settled payout: the lock gives up what it holds, up to `amount`, and
    /// what it could not give is recorded on the entry (`lockedShortfallPkn`).
    UnlockBurn,
    /// A returned hold: `from.lockedPkn -= amount`,
    /// `from.availablePkn += amount`, and never more than that lock holds.
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
    let document = fs.get_document(&fs.document_path(BALANCES, uid)?).await?;
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
    apply_all(fs, std::slice::from_ref(op), op.idem_key.as_deref()).await
}

/// What the transaction body saw on its last attempt.
enum TxSeen {
    /// The idempotency marker already existed: nothing was written.
    Replayed(Value),
    /// Balances after every op, committed together with the marker.
    Applied(Vec<(String, FirestoreBalance)>),
}

/// Apply several ledger operations as ONE Firestore transaction (all or
/// nothing), guarded by one idempotency key. The outcome's balances are those
/// of `ops[0]`'s parties. Each op's own `idem_key` is ignored here.
pub async fn apply_all(
    fs: &FirestoreClient,
    ops: &[LedgerOp],
    idem_key: Option<&str>,
) -> Result<LedgerOutcome, StoreError> {
    let Some(first) = ops.first() else {
        return Err(StoreError::Invalid("No ledger operation.".into()));
    };
    if ops
        .iter()
        .any(|op| op.amount <= 0 && op.mode != MoveMode::RecordOnly)
    {
        return Err(StoreError::Invalid(
            "Enter a whole PKN amount greater than zero.".into(),
        ));
    }
    let idem_key = idem_key.filter(|key| !key.is_empty()).map(str::to_string);

    let mut uids: Vec<String> = Vec::new();
    for op in ops {
        for uid in [op.from_uid.as_ref(), op.to_uid.as_ref()].into_iter().flatten() {
            if !uid.is_empty() && !uids.contains(uid) {
                uids.push(uid.clone());
            }
        }
    }
    uids.sort();
    if uids.len() + 2 * ops.len() + 1 > MAX_WRITES_PER_COMMIT {
        return Err(StoreError::Invalid(
            "Too many parties in one ledger op.".into(),
        ));
    }

    // Tags this call's marker, so a commit whose response was lost still
    // reads back as applied by us rather than as someone else's replay.
    let apply_id = uuid::Uuid::new_v4().to_string();
    let seen: Arc<Mutex<Option<TxSeen>>> = Arc::new(Mutex::new(None));
    let client_for_tx = fs.clone();
    let ops_for_tx = ops.to_vec();
    let uids_for_tx = uids.clone();
    let key_for_tx = idem_key.clone();
    let apply_id_for_tx = apply_id.clone();
    let seen_for_tx = seen.clone();
    let result = fs
        .run_transaction(move |transaction| {
            let client = client_for_tx.clone();
            let mut ops = ops_for_tx.clone();
            let uids = uids_for_tx.clone();
            let key = key_for_tx.clone();
            let apply_id = apply_id_for_tx.clone();
            let seen = seen_for_tx.clone();
            Box::pin(async move {
                *seen.lock().unwrap() = None;
                let mut paths = Vec::with_capacity(uids.len() + 1);
                for uid in &uids {
                    paths.push(client.document_path(BALANCES, uid)?);
                }
                let marker_path = match &key {
                    Some(key) => Some(client.document_path(IDEMPOTENCY, &idempotency_doc_id(key))?),
                    None => None,
                };
                if let Some(path) = &marker_path {
                    paths.push(path.clone());
                }
                let mut documents = client
                    .get_documents_in_transaction(&paths, &transaction)
                    .await?;
                if marker_path.is_some() {
                    if let Some(record) = documents.pop().flatten() {
                        *seen.lock().unwrap() = Some(TxSeen::Replayed(merged_record(record)));
                        return Ok(Vec::new());
                    }
                }
                let mut balances: Vec<(String, FirestoreBalance)> = uids
                    .iter()
                    .zip(documents.iter())
                    .map(|(uid, document)| {
                        (
                            uid.clone(),
                            document
                                .as_ref()
                                .map(FirestoreBalance::from_document)
                                .unwrap_or_default(),
                        )
                    })
                    .collect();
                for op in &mut ops {
                    let locked_shortfall = apply_mode(&mut balances, op)?;
                    if locked_shortfall > 0 {
                        if !op.meta.is_object() {
                            op.meta = json!({});
                        }
                        if let Some(object) = op.meta.as_object_mut() {
                            object.insert("lockedShortfallPkn".into(), json!(locked_shortfall));
                        }
                    }
                }
                let mut writes = build_writes(&client, &uids, &balances, &ops)?;
                if let (Some(path), Some(key)) = (marker_path, key) {
                    let (from_available, to_available) = party_balances(&balances, &ops[0]);
                    writes.push(FirestoreWrite::Create {
                        path,
                        value: json!({
                            "key": key,
                            "applyId": apply_id,
                            "fromAvailable": from_available,
                            "toAvailable": to_available,
                            "applied": true,
                            "createdAt": now_iso(),
                        }),
                    });
                }
                *seen.lock().unwrap() = Some(TxSeen::Applied(balances));
                Ok(writes)
            })
        })
        .await;

    let seen = seen.lock().unwrap().take();
    match result {
        Ok(_) => match seen {
            Some(TxSeen::Replayed(record)) => Ok(outcome_from_record(&record, &apply_id)),
            Some(TxSeen::Applied(balances)) => {
                let (from_available, to_available) = party_balances(&balances, first);
                Ok(LedgerOutcome {
                    applied: true,
                    from_available,
                    to_available,
                    ledger_ids: Vec::new(),
                })
            }
            None => Err(StoreError::Cache("Ledger transaction returned no result.".into())),
        },
        Err(error) => {
            // A racing caller committed the marker first (precondition
            // failure), or our own commit landed but its response was lost.
            if let Some(key) = &idem_key {
                if let Some(record) = idempotency_result(fs, key).await? {
                    return Ok(outcome_from_record(&record, &apply_id));
                }
            }
            Err(error)
        }
    }
}

/// `(from.availablePkn, to.availablePkn)` for one op's parties.
fn party_balances(balances: &[(String, FirestoreBalance)], op: &LedgerOp) -> (i64, i64) {
    let available = |uid: Option<&String>| {
        uid.and_then(|uid| balances.iter().find(|(candidate, _)| candidate == uid))
            .map(|(_, balance)| balance.available_pkn)
            .unwrap_or(0)
    };
    (available(op.from_uid.as_ref()), available(op.to_uid.as_ref()))
}

/// Apply one operation to the balances. The `Ok` value is the PKN the
/// operation asked for beyond the lock it found — only a settled payout
/// accepts that, and the entry records it; every other operation reports zero.
fn apply_mode(
    balances: &mut [(String, FirestoreBalance)],
    op: &LedgerOp,
) -> Result<i64, StoreError> {
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
            // The payout or the purchase settled outside the ledger, so this
            // cannot be refused: the lock gives up what it holds and the
            // remainder is reported for the entry to record.
            let burned = op.amount.min(balances[index].1.locked_pkn);
            balances[index].1.locked_pkn -= burned;
            return Ok(op.amount - burned);
        }
        MoveMode::UnlockRelease => {
            let Some(from) = from_uid.as_ref() else {
                return Err(StoreError::Invalid("Unlock needs a source.".into()));
            };
            let index = index_of(balances, from).expect("locked");
            if balances[index].1.locked_pkn < op.amount {
                return Err(StoreError::Conflict(
                    "release exceeds the locked amount".into(),
                ));
            }
            balances[index].1.locked_pkn -= op.amount;
            balances[index].1.available_pkn += op.amount;
        }
        MoveMode::RecordOnly => {}
    }
    Ok(0)
}

fn build_writes(
    client: &FirestoreClient,
    uids: &[String],
    balances: &[(String, FirestoreBalance)],
    ops: &[LedgerOp],
) -> Result<Vec<FirestoreWrite>, StoreError> {
    let created_at = now_iso();
    let mut writes: Vec<FirestoreWrite> = Vec::new();
    for (uid, balance) in balances {
        if !uids.contains(uid) {
            continue;
        }
        writes.push(FirestoreWrite::Set {
            path: client.document_path(BALANCES, uid)?,
            value: balance_document(
                balance.available_pkn.max(0),
                balance.locked_pkn.max(0),
                &created_at,
            ),
        });
    }

    for op in ops {
        let from_uid = op.from_uid.clone().filter(|uid| !uid.is_empty());
        let to_uid = op.to_uid.clone().filter(|uid| !uid.is_empty());
        let mut push_entry = |uid: &str, kind: &str, amount: i64, counterparty: Option<&str>| {
            let id = uuid::Uuid::new_v4().to_string();
            writes.push(FirestoreWrite::Set {
                path: client.document_path(LEDGER_ENTRIES, &id)?,
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
            Ok::<(), StoreError>(())
        };

        match op.mode {
            MoveMode::Transfer => {
                if let (Some(from), Some(to)) = (from_uid.as_ref(), to_uid.as_ref()) {
                    push_entry(from, &op.reason, -op.amount, Some(to))?;
                    push_entry(
                        to,
                        op.receive_reason.as_deref().unwrap_or(&op.reason),
                        op.amount,
                        Some(from),
                    )?;
                }
            }
            MoveMode::Mint => {
                if let Some(to) = to_uid.as_ref() {
                    push_entry(to, &op.reason, op.amount, op.counterparty.as_deref())?;
                }
            }
            MoveMode::Burn | MoveMode::Lock => {
                if let Some(from) = from_uid.as_ref() {
                    push_entry(from, &op.reason, -op.amount, op.counterparty.as_deref())?;
                }
            }
            // `withdraw_paid` / `wpkn_exchange_pkn_paid_out` record the settled
            // amount as a positive figure, matching the Node writers.
            MoveMode::UnlockBurn | MoveMode::UnlockRelease => {
                if let Some(from) = from_uid.as_ref() {
                    push_entry(from, &op.reason, op.amount, op.counterparty.as_deref())?;
                }
            }
            MoveMode::RecordOnly => {
                let uid = from_uid.or_else(|| to_uid.clone()).unwrap_or_default();
                if !uid.is_empty() {
                    push_entry(&uid, &op.reason, op.amount, op.counterparty.as_deref())?;
                }
            }
        }
    }
    Ok(writes)
}

/// Outcome of a recorded marker; `applied` only when it is this call's own.
fn outcome_from_record(record: &Value, apply_id: &str) -> LedgerOutcome {
    LedgerOutcome {
        applied: record.get("applyId").and_then(Value::as_str) == Some(apply_id),
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
    let path = fs.document_path(IDEMPOTENCY, &id)?;
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
    let document = fs.get_document(&fs.document_path(IDEMPOTENCY, &id)?).await?;
    Ok(document.map(merged_record))
}

/// Merge the recorded `result` into the wrapper so both `fromAvailable`
/// (ledger) and `result` (orders) callers work.
fn merged_record(mut document: Value) -> Value {
    if let Some(result) = document.get("result").cloned() {
        if let (Some(target), Some(extra)) = (document.as_object_mut(), result.as_object()) {
            for (key, value) in extra {
                target.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    document
}

/// Drop an idempotency claim so the work it guarded can run again (a
/// handler that failed after claiming).
pub async fn release_idempotency(fs: &FirestoreClient, key: &str) -> Result<(), StoreError> {
    let path = fs.document_path(IDEMPOTENCY, &idempotency_doc_id(key))?;
    fs.delete_document(&path).await?;
    Ok(())
}

/// Merge fields into an existing idempotency claim (e.g. `done: true`).
pub async fn update_idempotency(
    fs: &FirestoreClient,
    key: &str,
    fields: &Value,
) -> Result<(), StoreError> {
    let path = fs.document_path(IDEMPOTENCY, &idempotency_doc_id(key))?;
    fs.set_document(&path, fields).await?;
    Ok(())
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
        .get_document(&fs.document_path(USERS, uid)?)
        .await?
        .unwrap_or_else(|| json!({})))
}

/// Merge-write selected `users/{uid}` fields.
pub async fn write_user(fs: &FirestoreClient, uid: &str, fields: Value) -> Result<(), StoreError> {
    let mut payload = fields;
    if let Some(object) = payload.as_object_mut() {
        object.insert("updatedAt".into(), json!(now_iso()));
    }
    fs.set_document(&fs.document_path(USERS, uid)?, &payload)
        .await?;
    Ok(())
}

/// Resolve a username through `usernames/{username}` then `users.usernameLower`.
pub async fn uid_for_username(
    fs: &FirestoreClient,
    username: &str,
) -> Result<Option<String>, StoreError> {
    let clean = username_doc_id(username);
    if crate::firestore::validate_document_id(&clean).is_err() {
        return Ok(None);
    }
    if let Some(document) = fs.get_document(&fs.document_path(USERNAMES, &clean)?).await? {
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
        let writes = build_writes(&client, &uids, &state, std::slice::from_ref(&op)).unwrap();
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

/// The rules `apply_mode` holds for any sequence of operations: PKN enters a
/// balance only through a Mint, a release returns no more than its lock held,
/// a refusal changes nothing, and no accepted operation leaves a balance below
/// zero.
#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;

    const BALANCE_MAX: i64 = 10_000;
    const AMOUNT_MAX: i64 = 20_000;

    /// Where an operation's amount comes from: a plain figure, or an edge of
    /// the balance the operation is measured against.
    #[derive(Clone, Copy, Debug)]
    enum Amount {
        Plain(i64),
        WholeBalance,
        JustAboveBalance,
    }

    #[derive(Clone, Copy, Debug)]
    struct Planned {
        mode: MoveMode,
        from: usize,
        to: usize,
        amount: Amount,
    }

    /// A transfer between two accounts, its amount within the sender's
    /// available balance or beyond it.
    #[derive(Clone, Copy, Debug)]
    struct Transfer {
        sender_available: i64,
        sender_locked: i64,
        receiver_available: i64,
        receiver_locked: i64,
        amount: i64,
    }

    /// The balance an operation is measured against.
    fn measured(balance: FirestoreBalance, mode: MoveMode) -> i64 {
        match mode {
            MoveMode::UnlockBurn | MoveMode::UnlockRelease => balance.locked_pkn,
            _ => balance.available_pkn,
        }
    }

    fn accounts_of(values: &[(i64, i64)]) -> Vec<(String, FirestoreBalance)> {
        values
            .iter()
            .enumerate()
            .map(|(index, (available, locked))| {
                (
                    format!("account-{index}"),
                    FirestoreBalance {
                        available_pkn: *available,
                        locked_pkn: *locked,
                    },
                )
            })
            .collect()
    }

    /// Total PKN across every account: what a Mint alone is allowed to raise.
    fn supply(state: &[(String, FirestoreBalance)]) -> i64 {
        state
            .iter()
            .map(|(_, balance)| balance.available_pkn + balance.locked_pkn)
            .sum()
    }

    /// One operation as it met the balances.
    struct Step {
        mode: MoveMode,
        amount: i64,
        /// The account the operation acted on, as an index into the state.
        subject: usize,
        /// The lock of the account the operation acted on, before it ran.
        locked_before: i64,
        accepted: bool,
        supply_before: i64,
        before: Vec<(String, FirestoreBalance)>,
        after: Vec<(String, FirestoreBalance)>,
    }

    /// Build one operation the way the handlers build it, with its amount read
    /// from the balance it will meet, and apply it.
    fn run_step(state: &mut [(String, FirestoreBalance)], plan: &Planned) -> Step {
        let from = plan.from % state.len();
        let to = plan.to % state.len();
        let subject = if plan.mode == MoveMode::Mint {
            to
        } else {
            from
        };
        let subject_before = state[subject].1;
        let amount = match plan.amount {
            Amount::Plain(value) => value,
            Amount::WholeBalance => measured(subject_before, plan.mode),
            Amount::JustAboveBalance => measured(subject_before, plan.mode) + 1,
        };
        let uid = |index: usize| state[index].0.clone();
        let op = match plan.mode {
            MoveMode::Transfer => {
                LedgerOp::transfer(&uid(from), &uid(to), amount, "account_transfer_sent")
            }
            MoveMode::Mint => LedgerOp::mint(&uid(to), amount, "account_top_up"),
            MoveMode::Burn => LedgerOp::burn(&uid(from), amount, "crypto_pkn_sale"),
            MoveMode::Lock => LedgerOp::lock(&uid(from), amount, "withdraw_requested"),
            MoveMode::UnlockBurn => LedgerOp::unlock(&uid(from), amount, "withdraw_paid", false),
            MoveMode::UnlockRelease => {
                LedgerOp::unlock(&uid(from), amount, "wpkn_exchange_released", true)
            }
            MoveMode::RecordOnly => LedgerOp::record(&uid(from), amount, "crypto_pkn_sale_deposit"),
        };
        let before = state.to_vec();
        let supply_before = supply(&before);
        let accepted = apply_mode(state, &op).is_ok();
        Step {
            mode: plan.mode,
            amount,
            subject,
            locked_before: subject_before.locked_pkn,
            accepted,
            supply_before,
            before,
            after: state.to_vec(),
        }
    }

    /// The change in total PKN that an accepted operation of this mode is
    /// allowed to make.
    fn allowed_supply_change(mode: MoveMode, amount: i64, locked_before: i64) -> i64 {
        match mode {
            MoveMode::Mint => amount,
            MoveMode::Burn => -amount,
            // A settled payout burns what is locked, and never more of it.
            MoveMode::UnlockBurn => -amount.min(locked_before.max(0)),
            MoveMode::Transfer
            | MoveMode::Lock
            | MoveMode::UnlockRelease
            | MoveMode::RecordOnly => 0,
        }
    }

    fn plan_strategy() -> impl Strategy<Value = Planned> {
        let mode = prop_oneof![
            Just(MoveMode::Transfer),
            Just(MoveMode::Mint),
            Just(MoveMode::Burn),
            Just(MoveMode::Lock),
            Just(MoveMode::UnlockBurn),
            Just(MoveMode::UnlockRelease),
            Just(MoveMode::RecordOnly),
        ];
        (mode, 0usize..4, 0usize..4, amount_strategy()).prop_map(|(mode, from, to, amount)| {
            Planned {
                mode,
                from,
                to,
                amount,
            }
        })
    }

    fn amount_strategy() -> impl Strategy<Value = Amount> {
        prop_oneof![
            (0i64..=AMOUNT_MAX).prop_map(Amount::Plain),
            Just(Amount::WholeBalance),
            Just(Amount::JustAboveBalance),
        ]
    }

    fn sequence_strategy() -> impl Strategy<Value = (Vec<(i64, i64)>, Vec<Planned>)> {
        (
            prop::collection::vec((0i64..=BALANCE_MAX, 0i64..=BALANCE_MAX), 1..=4),
            prop::collection::vec(plan_strategy(), 0..=16),
        )
    }

    fn transfer_strategy() -> impl Strategy<Value = Transfer> {
        (0i64..=BALANCE_MAX).prop_flat_map(|sender_available| {
            (
                Just(sender_available),
                0i64..=sender_available,
                0i64..=BALANCE_MAX,
                0i64..=BALANCE_MAX,
                0i64..=BALANCE_MAX,
                any::<bool>(),
            )
                .prop_map(
                    |(
                        sender_available,
                        amount,
                        sender_locked,
                        receiver_available,
                        receiver_locked,
                        overspend,
                    )| Transfer {
                        sender_available,
                        sender_locked,
                        receiver_available,
                        receiver_locked,
                        amount: if overspend {
                            amount + sender_available + 1
                        } else {
                            amount
                        },
                    },
                )
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        /// Total PKN rises with a Mint and falls with a burn; every other
        /// accepted operation leaves the total where it was.
        #[test]
        fn supply_changes_only_by_mint_and_burn(sequence in sequence_strategy()) {
            let (accounts, plans) = sequence;
            let mut state = accounts_of(&accounts);
            for plan in &plans {
                let step = run_step(&mut state, plan);
                if !step.accepted {
                    continue;
                }
                let expected = allowed_supply_change(step.mode, step.amount, step.locked_before);
                prop_assert_eq!(
                    supply(&step.after) - step.supply_before,
                    expected,
                    "{:?} of {} against a lock of {}",
                    step.mode,
                    step.amount,
                    step.locked_before
                );
            }
        }

        /// No accepted operation leaves a balance below zero. These are the
        /// balances the transaction computed, before any write is prepared.
        #[test]
        fn accepted_operations_leave_no_balance_below_zero(sequence in sequence_strategy()) {
            let (accounts, plans) = sequence;
            let mut state = accounts_of(&accounts);
            for plan in &plans {
                let step = run_step(&mut state, plan);
                if !step.accepted {
                    continue;
                }
                for (uid, balance) in &step.after {
                    prop_assert!(
                        balance.available_pkn >= 0,
                        "{uid} available below zero after {:?} of {}",
                        step.mode,
                        step.amount
                    );
                    prop_assert!(
                        balance.locked_pkn >= 0,
                        "{uid} lock below zero after {:?} of {}",
                        step.mode,
                        step.amount
                    );
                }
            }
        }

        /// A lock gives up only what it holds. A release returns exactly the
        /// amount it asked for; a settled payout burns the smaller of its
        /// amount and the lock, and the total falls by just that much.
        #[test]
        fn a_lock_gives_up_only_what_it_holds(sequence in sequence_strategy()) {
            let (accounts, plans) = sequence;
            let mut state = accounts_of(&accounts);
            for plan in &plans {
                let step = run_step(&mut state, plan);
                if !step.accepted {
                    continue;
                }
                let before = step.before[step.subject].1;
                let after = step.after[step.subject].1;
                match step.mode {
                    MoveMode::UnlockRelease => {
                        prop_assert_eq!(
                            before.locked_pkn - after.locked_pkn,
                            step.amount,
                            "a release of {} against a lock of {} gave up something else",
                            step.amount,
                            step.locked_before
                        );
                        prop_assert_eq!(
                            after.available_pkn - before.available_pkn,
                            step.amount,
                            "a release of {} moved something else into available",
                            step.amount
                        );
                        prop_assert_eq!(supply(&step.after), step.supply_before);
                    }
                    MoveMode::UnlockBurn => {
                        let burned = before.locked_pkn - after.locked_pkn;
                        prop_assert_eq!(
                            burned,
                            step.amount.min(before.locked_pkn),
                            "a settled payout of {} against a lock of {} burned something else",
                            step.amount,
                            step.locked_before
                        );
                        prop_assert_eq!(
                            supply(&step.after) - step.supply_before,
                            -burned,
                            "a settled payout of {} changed the total by something else",
                            step.amount
                        );
                    }
                    MoveMode::Lock => {
                        prop_assert_eq!(
                            after.locked_pkn - before.locked_pkn,
                            step.amount,
                            "a lock of {} moved something else into the lock",
                            step.amount
                        );
                        prop_assert_eq!(supply(&step.after), step.supply_before);
                    }
                    _ => {
                        prop_assert_eq!(after.locked_pkn, before.locked_pkn);
                    }
                }
            }
        }

        /// An operation the ledger refuses leaves every balance as it found
        /// them.
        #[test]
        fn a_refused_operation_leaves_every_balance_unchanged(sequence in sequence_strategy()) {
            let (accounts, plans) = sequence;
            let mut state = accounts_of(&accounts);
            for plan in &plans {
                let step = run_step(&mut state, plan);
                if step.accepted {
                    continue;
                }
                prop_assert_eq!(
                    &step.after,
                    &step.before,
                    "a refused {:?} of {} changed the balances",
                    step.mode,
                    step.amount
                );
            }
        }

        /// A transfer moves the amount from the sender to the receiver and
        /// touches nothing else: neither lock, and no new PKN anywhere.
        #[test]
        fn a_transfer_moves_exactly_the_amount_between_the_two_parties(case in transfer_strategy()) {
            let mut state = accounts_of(&[
                (case.sender_available, case.sender_locked),
                (case.receiver_available, case.receiver_locked),
            ]);
            let total = supply(&state);
            let op = LedgerOp::transfer(
                "account-0",
                "account-1",
                case.amount,
                "account_transfer_sent",
            );
            let accepted = apply_mode(&mut state, &op).is_ok();
            if accepted {
                prop_assert!(
                    case.amount <= case.sender_available,
                    "a transfer of {} out of {} available was accepted",
                    case.amount,
                    case.sender_available
                );
                prop_assert_eq!(state[0].1.available_pkn, case.sender_available - case.amount);
                prop_assert_eq!(state[0].1.locked_pkn, case.sender_locked);
                prop_assert_eq!(state[1].1.available_pkn, case.receiver_available + case.amount);
                prop_assert_eq!(state[1].1.locked_pkn, case.receiver_locked);
                prop_assert_eq!(supply(&state), total);
            } else {
                prop_assert_eq!(&state, &accounts_of(&[
                    (case.sender_available, case.sender_locked),
                    (case.receiver_available, case.receiver_locked),
                ]));
            }
        }

        /// An operation that stays within the balance it is measured against
        /// is accepted, at the boundary and below it.
        #[test]
        fn an_operation_within_its_balance_is_accepted(
            available in 0i64..=BALANCE_MAX,
            locked in 0i64..=BALANCE_MAX,
        ) {
            let state = accounts_of(&[(available, locked), (available, locked)]);
            let ops = vec![
                LedgerOp::lock("account-0", available, "withdraw_requested"),
                LedgerOp::burn("account-0", available, "crypto_pkn_sale"),
                LedgerOp::transfer("account-0", "account-1", available, "account_transfer_sent"),
                LedgerOp::unlock("account-0", locked, "wpkn_exchange_released", true),
                LedgerOp::unlock("account-0", locked, "withdraw_paid", false),
                LedgerOp::mint("account-0", 1, "account_top_up"),
                LedgerOp::record("account-0", available, "crypto_pkn_sale_deposit"),
            ];
            for op in &ops {
                let mut step_state = state.clone();
                prop_assert!(
                    apply_mode(&mut step_state, op).is_ok(),
                    "{:?} of {} within its balance was refused",
                    op.mode,
                    op.amount
                );
            }
        }
    }
}
