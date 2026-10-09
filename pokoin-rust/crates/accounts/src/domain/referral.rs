//! Pokoin Invite & Earn (referral) core — a port of `_referral_core.js`.
//!
//! ```text
//! referrals/{referredUid}   one per invited account (a user can be invited once)
//!   referrerUid, referredUid, code, status: pending | rewarded
//!   claimedAtMs, rewardedAtMs, qualifyingOrderId, qualifyingKind
//! ```
//!
//! A referral pays when the invited account completes its first real purchase
//! or first real sale (paid / escrow / released / partially refunded order)
//! after joining: both sides get `REWARD_PKN` from the Pokoin treasury account
//! (`usernames/pokoin`), written as balanced ledger entries in one Firestore
//! transaction, exactly once.
//!
//! Guardrails preserved: only accounts created within `CLAIM_WINDOW_DAYS` with
//! no paid order yet can claim; no self or circular referral; an order between
//! the two of them does not qualify; the referrer's side is capped at
//! `REFERRER_CAP_PER_30_DAYS` rewards per rolling 30 days.
//!
//! The two `balances/{uid}` writes plus the paired `ledger_entries` documents
//! are the same contract the commerce worker's `store::apply` implements. They
//! are written here in one transaction so a single reward can never half-apply;
//! [`LedgerSink`] is the seam for handing them to that shared writer instead.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value as Json};

use crate::error::{ApiError, Result};
use crate::firestore::{new_document_id, DocData, Document, Firestore, Query, Value};

pub const REWARD_PKN: i64 = 20;
pub const CLAIM_WINDOW_DAYS: i64 = 14;
pub const REFERRER_CAP_PER_30_DAYS: i64 = 50;
pub const TREASURY_USERNAME: &str = "pokoin";
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Order statuses that count as a real purchase or sale.
pub const QUALIFYING_STATUSES: [&str; 4] = ["paid", "escrow", "released", "partially_refunded"];

pub const REFERENCES: &str = "referrals";
pub const LEDGER: &str = "ledger_entries";
pub const BALANCES: &str = "balances";

/// Invite codes are Pokoin usernames: lowercase a-z / 0-9, 3-32 chars.
pub fn clean_code(value: &str) -> String {
    let code = value
        .trim()
        .trim_start_matches('@')
        .to_ascii_lowercase();
    let valid = (3..=32).contains(&code.len())
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if valid {
        code
    } else {
        String::new()
    }
}

/// Node `toMillis`: Firestore Timestamp, Date, `{seconds}` or an ISO string.
pub fn to_millis(value: Option<&Value>) -> i64 {
    match value {
        None | Some(Value::Null) => 0,
        Some(Value::Timestamp(timestamp)) => timestamp.timestamp_millis(),
        Some(Value::Integer(millis)) => *millis,
        Some(Value::Double(millis)) => *millis as i64,
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|parsed| parsed.timestamp_millis())
            .unwrap_or(0),
        Some(Value::Map(fields)) => fields
            .get("seconds")
            .and_then(|value| value.as_i64())
            .map(|seconds| seconds * 1000)
            .unwrap_or(0),
        _ => 0,
    }
}

fn doc_millis(document: &Document, field: &str) -> i64 {
    to_millis(document.get(field).as_ref())
}

// ---------------------------------------------------------------------------
// Name cache (uid <-> username), 10 minute TTL like the Node WeakMap
// ---------------------------------------------------------------------------

const NAME_TTL: Duration = Duration::from_secs(10 * 60);
const NAME_CACHE_MAX: usize = 5000;

struct NameCache {
    entries: Mutex<HashMap<String, (String, Instant)>>,
}

fn name_cache() -> &'static NameCache {
    static CACHE: OnceLock<NameCache> = OnceLock::new();
    CACHE.get_or_init(|| NameCache {
        entries: Mutex::new(HashMap::new()),
    })
}

/// Drop every cached name. Tests call this so a fixture cannot leak.
pub fn clear_name_cache() {
    if let Ok(mut entries) = name_cache().entries.lock() {
        entries.clear();
    }
}

async fn cached_lookup<F, Fut>(key: String, load: F) -> String
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    {
        let entries = name_cache().entries.lock().expect("name cache");
        if let Some((value, at)) = entries.get(&key) {
            if at.elapsed() < NAME_TTL {
                return value.clone();
            }
        }
    }
    let value = load().await.unwrap_or_default();
    if let Ok(mut entries) = name_cache().entries.lock() {
        if entries.len() >= NAME_CACHE_MAX {
            // Evict an arbitrary entry, mirroring the Map FIFO trim.
            if let Some(first) = entries.keys().next().cloned() {
                entries.remove(&first);
            }
        }
        entries.insert(key, (value.clone(), Instant::now()));
    }
    value
}

pub async fn uid_for_username(firestore: &Firestore, username: &str) -> Result<String> {
    if username.is_empty() {
        return Ok(String::new());
    }
    let key = format!("username:{username}");
    let username = username.to_string();
    Ok(cached_lookup(key, || {
        let firestore = firestore.clone();
        async move {
            Ok(firestore
                .doc(format!("usernames/{username}"))
                .get()
                .await?
                .map(|document| document.get_str("uid").trim().to_string())
                .unwrap_or_default())
        }
    })
    .await)
}

pub async fn username_of(firestore: &Firestore, uid: &str) -> Result<String> {
    if uid.is_empty() {
        return Ok(String::new());
    }
    let key = format!("uid:{uid}");
    let uid = uid.to_string();
    Ok(cached_lookup(key, || {
        let firestore = firestore.clone();
        async move {
            Ok(firestore
                .doc(format!("users/{uid}"))
                .get()
                .await?
                .map(|document| document.get_str("username").trim().to_string())
                .unwrap_or_default())
        }
    })
    .await)
}

// ---------------------------------------------------------------------------
// Qualifying orders
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifyingOrder {
    pub order_id: String,
    /// `purchase` when the invited account was the buyer, `sale` when a seller.
    pub kind: String,
    pub at_ms: i64,
}

fn array_contains(document: &Document, field: &str, needle: &str) -> bool {
    document
        .get(field)
        .and_then(|value| value.as_array().cloned())
        .map(|values| {
            values
                .iter()
                .any(|value| value.as_str() == Some(needle))
        })
        .unwrap_or(false)
}

/// The Node `orderQualifies` predicate.
pub fn order_qualifies(
    document: &Document,
    after_ms: i64,
    counterparty_uid: &str,
    role: &str,
) -> bool {
    if !QUALIFYING_STATUSES.contains(&document.get_str("paymentStatus").as_str()) {
        return false;
    }
    if after_ms != 0 && doc_millis(document, "createdAt") < after_ms {
        return false;
    }
    if !counterparty_uid.is_empty() {
        if role == "buyer" && array_contains(document, "sellerUids", counterparty_uid) {
            return false;
        }
        if role == "seller"
            && (document.get_str("uid") == counterparty_uid
                || document.get_str("buyerUid") == counterparty_uid)
        {
            return false;
        }
    }
    true
}

/// First qualifying order for `uid` as buyer or seller, oldest first.
pub async fn first_qualifying_order(
    firestore: &Firestore,
    uid: &str,
    after_ms: i64,
    counterparty_uid: &str,
) -> Result<Option<QualifyingOrder>> {
    let bought = firestore
        .run_query(&Query::collection("orders").where_eq("uid", uid.to_string()).limit(200))
        .await?;
    let sold = firestore
        .run_query(
            &Query::collection("orders")
                .where_op("sellerUids", crate::firestore::FilterOp::ArrayContains, uid.to_string())
                .limit(200),
        )
        .await?;

    let mut hits: Vec<QualifyingOrder> = Vec::new();
    for document in &bought {
        if order_qualifies(document, after_ms, counterparty_uid, "buyer") {
            hits.push(QualifyingOrder {
                order_id: document.id(),
                kind: "purchase".into(),
                at_ms: doc_millis(document, "createdAt"),
            });
        }
    }
    for document in &sold {
        if order_qualifies(document, after_ms, counterparty_uid, "seller") {
            hits.push(QualifyingOrder {
                order_id: document.id(),
                kind: "sale".into(),
                at_ms: doc_millis(document, "createdAt"),
            });
        }
    }
    hits.sort_by_key(|hit| hit.at_ms);
    Ok(hits.into_iter().next())
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

fn http_error(status: axum::http::StatusCode, message: &str, code: &str) -> ApiError {
    ApiError::new(status, message).with_code(code)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimOutcome {
    pub status: String,
    pub referrer_uid: String,
}

/// Attach the signed-in account to the inviter behind `code`.
pub async fn claim_referral(
    firestore: &Firestore,
    uid: &str,
    code: &str,
    account_created_ms: i64,
    now_ms: i64,
) -> Result<ClaimOutcome> {
    let clean = clean_code(code);
    if clean.is_empty() {
        return Err(http_error(
            axum::http::StatusCode::BAD_REQUEST,
            "That invite link is not valid.",
            "invalid_code",
        ));
    }
    let referrer_uid = uid_for_username(firestore, &clean).await?;
    if referrer_uid.is_empty() {
        return Err(http_error(
            axum::http::StatusCode::NOT_FOUND,
            "No Pokoin account uses that invite code.",
            "invalid_code",
        ));
    }
    if referrer_uid == uid {
        return Err(http_error(
            axum::http::StatusCode::BAD_REQUEST,
            "You cannot use your own invite link.",
            "self_referral",
        ));
    }

    let reference = firestore.doc(format!("{REFERENCES}/{uid}"));
    if let Some(existing) = reference.get().await? {
        return Ok(ClaimOutcome {
            status: "already_claimed".into(),
            referrer_uid: existing.get_str("referrerUid"),
        });
    }
    if account_created_ms == 0 || now_ms - account_created_ms > CLAIM_WINDOW_DAYS * DAY_MS {
        return Err(http_error(
            axum::http::StatusCode::CONFLICT,
            &format!(
                "Invite links work for accounts created in the last {CLAIM_WINDOW_DAYS} days."
            ),
            "not_new",
        ));
    }
    if first_qualifying_order(firestore, uid, 0, "").await?.is_some() {
        return Err(http_error(
            axum::http::StatusCode::CONFLICT,
            "Invite links are for new collectors who have not bought or sold yet.",
            "not_new",
        ));
    }
    if let Some(inviter) = firestore.doc(format!("{REFERENCES}/{referrer_uid}")).get().await? {
        if inviter.get_str("referrerUid") == uid {
            return Err(http_error(
                axum::http::StatusCode::BAD_REQUEST,
                "You invited this collector yourself.",
                "circular",
            ));
        }
    }

    let uid_owned = uid.to_string();
    let code_owned = clean.clone();
    let referrer_owned = referrer_uid.clone();
    firestore
        .run_transaction(|transaction| {
            let uid = uid_owned.clone();
            let code = code_owned.clone();
            let referrer_uid = referrer_owned.clone();
            Box::pin(async move {
                let reference = transaction.doc(&format!("{REFERENCES}/{uid}"));
                if transaction.get_doc(&reference).await?.is_some() {
                    return Ok(());
                }
                transaction.set(
                    &reference,
                    DocData::new()
                        .string("referrerUid", referrer_uid)
                        .string("referredUid", uid)
                        .string("code", code)
                        .string("status", "pending")
                        .int("rewardPkn", REWARD_PKN)
                        .server_timestamp("claimedAt")
                        .int("claimedAtMs", now_ms),
                    false,
                )?;
                Ok(())
            })
        })
        .await?;

    Ok(ClaimOutcome {
        status: "pending".into(),
        referrer_uid,
    })
}

/// How many rewards the referrer has already been paid inside the window.
pub async fn referrer_rewards_since(
    firestore: &Firestore,
    referrer_uid: &str,
    since_ms: i64,
) -> Result<usize> {
    let documents = firestore
        .run_query(
            &Query::collection(REFERENCES)
                .where_eq("referrerUid", referrer_uid.to_string())
                .limit(1000),
        )
        .await?;
    Ok(documents
        .iter()
        .filter(|document| {
            document.get_str("status") == "rewarded"
                && document.get_i64("referrerRewardPkn").unwrap_or(0) > 0
                && doc_millis(document, "rewardedAtMs") >= since_ms
        })
        .count())
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleOutcome {
    Rewarded {
        order_id: String,
        kind: String,
        referrer_pkn: i64,
        referred_pkn: i64,
    },
    Waiting,
    NotPending,
    TreasuryLow,
}

impl SettleOutcome {
    pub fn status(&self) -> &'static str {
        match self {
            SettleOutcome::Rewarded { .. } => "rewarded",
            SettleOutcome::Waiting => "waiting",
            SettleOutcome::NotPending => "not_pending",
            SettleOutcome::TreasuryLow => "treasury_low",
        }
    }
}

/// Pay one pending referral if the invited account has qualified.
pub async fn settle_referral(
    firestore: &Firestore,
    referred_uid: &str,
    now_ms: i64,
) -> Result<SettleOutcome> {
    let reference = firestore.doc(format!("{REFERENCES}/{referred_uid}"));
    let Some(row) = reference.get().await? else {
        return Ok(SettleOutcome::NotPending);
    };
    if row.get_str("status") != "pending" {
        return Ok(SettleOutcome::NotPending);
    }

    let referrer_uid = row.get_str("referrerUid");
    let after_ms = row.get_i64("claimedAtMs").unwrap_or(0);
    let Some(order) =
        first_qualifying_order(firestore, referred_uid, after_ms, &referrer_uid).await?
    else {
        return Ok(SettleOutcome::Waiting);
    };

    let treasury_uid = uid_for_username(firestore, TREASURY_USERNAME).await?;
    if treasury_uid.is_empty() {
        return Err(http_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Pokoin treasury account is not configured.",
            "no_treasury",
        ));
    }
    let capped = referrer_rewards_since(firestore, &referrer_uid, now_ms - 30 * DAY_MS).await?
        >= REFERRER_CAP_PER_30_DAYS as usize;
    let referrer_pkn = if capped { 0 } else { REWARD_PKN };
    let referred_pkn = REWARD_PKN;
    let total = referrer_pkn + referred_pkn;

    let referred_owned = referred_uid.to_string();
    let referrer_owned = referrer_uid.clone();
    let treasury_owned = treasury_uid.clone();
    let order_owned = order.clone();
    firestore
        .run_transaction(|transaction| {
            let referred_uid = referred_owned.clone();
            let referrer_uid = referrer_owned.clone();
            let treasury_uid = treasury_owned.clone();
            let order = order_owned.clone();
            Box::pin(async move {
                let reference = transaction.doc(&format!("{REFERENCES}/{referred_uid}"));
                let treasury_ref = transaction.doc(&format!("{BALANCES}/{treasury_uid}"));
                let current = transaction.get_doc(&reference).await?;
                let treasury = transaction.get_doc(&treasury_ref).await?;

                let Some(current) = current else {
                    return Ok(SettleOutcome::NotPending);
                };
                if current.get_str("status") != "pending" {
                    return Ok(SettleOutcome::NotPending);
                }
                let available = treasury
                    .as_ref()
                    .and_then(|document| document.get_i64("availablePkn"))
                    .unwrap_or(0);
                if available < total {
                    return Ok(SettleOutcome::TreasuryLow);
                }

                // One balanced pair per credited side, all in this transaction.
                let credit = |transaction: &mut crate::firestore::Transaction,
                              uid: &str,
                              amount: i64,
                              side: &str|
                 -> Result<()> {
                    transaction.set(
                        &transaction.doc(&format!("{BALANCES}/{uid}")),
                        DocData::new()
                            .increment("availablePkn", amount)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    transaction.set(
                        &transaction.doc(&format!("{LEDGER}/{}", new_document_id())),
                        DocData::new()
                            .string("uid", uid)
                            .string("type", "referral_reward_received")
                            .int("amountPkn", amount)
                            .string("counterpartyUid", treasury_uid.clone())
                            .string("counterpartyUsername", TREASURY_USERNAME)
                            .string("purpose", "referral_reward")
                            .string("referralSide", side)
                            .string("referralId", referred_uid.clone())
                            .string("orderId", order.order_id.clone())
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    transaction.set(
                        &transaction.doc(&format!("{LEDGER}/{}", new_document_id())),
                        DocData::new()
                            .string("uid", treasury_uid.clone())
                            .string("type", "referral_reward_sent")
                            .int("amountPkn", -amount)
                            .string("counterpartyUid", uid)
                            .string("purpose", "referral_reward")
                            .string("referralSide", side)
                            .string("referralId", referred_uid.clone())
                            .string("orderId", order.order_id.clone())
                            .server_timestamp("createdAt"),
                        false,
                    )?;
                    Ok(())
                };

                transaction.set(
                    &treasury_ref,
                    DocData::new()
                        .increment("availablePkn", -total)
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                credit(transaction, &referred_uid, referred_pkn, "invited")?;
                if referrer_pkn != 0 {
                    credit(transaction, &referrer_uid, referrer_pkn, "inviter")?;
                }
                transaction.set(
                    &reference,
                    DocData::new()
                        .string("status", "rewarded")
                        .server_timestamp("rewardedAt")
                        .int("rewardedAtMs", now_ms)
                        .string("qualifyingOrderId", order.order_id.clone())
                        .string("qualifyingKind", order.kind.clone())
                        .int("referredRewardPkn", referred_pkn)
                        .int("referrerRewardPkn", referrer_pkn)
                        .bool("referrerCapped", capped),
                    true,
                )?;
                Ok(SettleOutcome::Rewarded {
                    order_id: order.order_id.clone(),
                    kind: order.kind.clone(),
                    referrer_pkn,
                    referred_pkn,
                })
            })
        })
        .await
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SettleCounts {
    pub checked: usize,
    pub rewarded: usize,
    pub waiting: usize,
    pub treasury_low: usize,
    pub failed: usize,
}

/// Pay every pending referral that has qualified (timer + page visits).
pub async fn settle_pending(
    firestore: &Firestore,
    now_ms: i64,
    limit: i64,
    only_referrer_uid: &str,
) -> Result<SettleCounts> {
    let mut query = Query::collection(REFERENCES).where_eq("status", "pending").limit(limit);
    if !only_referrer_uid.is_empty() {
        query = query.where_eq("referrerUid", only_referrer_uid.to_string());
    }
    let documents = firestore.run_query(&query).await?;

    let mut counts = SettleCounts::default();
    for document in documents {
        counts.checked += 1;
        match settle_referral(firestore, &document.id(), now_ms).await {
            Ok(SettleOutcome::Rewarded { .. }) => counts.rewarded += 1,
            Ok(SettleOutcome::Waiting) => counts.waiting += 1,
            Ok(SettleOutcome::TreasuryLow) => counts.treasury_low += 1,
            Ok(SettleOutcome::NotPending) => {}
            Err(error) => {
                counts.failed += 1;
                tracing::error!(referral = %document.id(), %error, "referral settle failed");
            }
        }
    }
    Ok(counts)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

fn iso_from_millis(millis: i64) -> Option<String> {
    if millis == 0 {
        return None;
    }
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// `publicRow(row, username)`.
pub fn public_row(row: &Document, username: &str) -> Json {
    let status = row.get_str("status");
    let referrer_reward = row.get_i64("referrerRewardPkn").unwrap_or(0);
    let display_username = if username.is_empty() {
        "new collector".to_string()
    } else {
        username.to_string()
    };
    let kind = row.get_str("qualifyingKind");
    let kind = if kind.is_empty() {
        Json::Null
    } else {
        json!(kind)
    };
    let earned = if status == "rewarded" {
        referrer_reward
    } else {
        0
    };
    json!({
        "username": display_username,
        "status": status,
        "claimedAt": iso_from_millis(row.get_i64("claimedAtMs").unwrap_or(0)),
        "rewardedAt": iso_from_millis(row.get_i64("rewardedAtMs").unwrap_or(0)),
        "kind": kind,
        "earnedPkn": earned,
    })
}

/// What `/invite` shows the signed-in account.
pub async fn referral_summary(firestore: &Firestore, uid: &str) -> Result<Json> {
    let username = username_of(firestore, uid).await?;
    let invited_documents = firestore
        .run_query(
            &Query::collection(REFERENCES)
                .where_eq("referrerUid", uid.to_string())
                .limit(500),
        )
        .await?;
    let mine = firestore.doc(format!("{REFERENCES}/{uid}")).get().await?;

    let inviter_name = match &mine {
        Some(row) => username_of(firestore, &row.get_str("referrerUid")).await?,
        None => String::new(),
    };
    let mut rows: Vec<(Document, String)> = Vec::new();
    for document in invited_documents {
        let name = username_of(firestore, &document.id()).await?;
        rows.push((document, name));
    }

    let mut invited: Vec<Json> = rows
        .iter()
        .map(|(document, name)| public_row(document, name))
        .collect();
    invited.sort_by(|a, b| {
        let key = |value: &Json| {
            value
                .get("claimedAt")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string()
        };
        // Newest first; nulls sort last like `String(null || '')`.
        key(b).cmp(&key(a))
    });
    let activated = invited
        .iter()
        .filter(|row| row.get("status").and_then(Json::as_str) == Some("rewarded"))
        .count();

    let referred_by = mine.as_ref().map(|row| {
        let status = row.get_str("status");
        json!({
            "username": inviter_name,
            "status": status,
            "earnedPkn": if status == "rewarded" {
                row.get_i64("referredRewardPkn").unwrap_or(0)
            } else {
                0
            },
        })
    });
    let referred_earned = referred_by
        .as_ref()
        .and_then(|value| value.get("earnedPkn"))
        .and_then(Json::as_i64)
        .unwrap_or(0);
    let invited_earned: i64 = invited
        .iter()
        .map(|row| row.get("earnedPkn").and_then(Json::as_i64).unwrap_or(0))
        .sum();

    let total_invited = invited.len();
    Ok(json!({
        "code": clean_code(&username),
        "rewardPkn": REWARD_PKN,
        "claimWindowDays": CLAIM_WINDOW_DAYS,
        "invited": invited.into_iter().take(100).collect::<Vec<_>>(),
        "stats": {
            "invited": total_invited,
            "pending": total_invited - activated,
            "activated": activated,
            "earnedPkn": invited_earned + referred_earned,
        },
        "referredBy": referred_by,
    }))
}

/// The distinct referrer uids in a batch, used by the reconcile timer.
pub fn referrer_set(rows: &[Document]) -> HashSet<String> {
    rows.iter()
        .map(|row| row.get_str("referrerUid"))
        .filter(|uid| !uid.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firestore::Document;

    fn order_document(fields: Json) -> Document {
        Document {
            name: "projects/p/databases/(default)/documents/orders/o1".into(),
            create_time: None,
            update_time: None,
            fields: serde_json::from_value(fields).ok(),
        }
    }

    #[test]
    fn invite_codes_are_usernames() {
        assert_eq!(clean_code("Ash"), "ash");
        assert_eq!(clean_code("@ash"), "ash");
        assert_eq!(clean_code("  ash99 "), "ash99");
        assert_eq!(clean_code("ab"), "");
        assert_eq!(clean_code("has space"), "");
        assert_eq!(clean_code("Ash-Ketchum"), "");
        assert_eq!(clean_code(&"a".repeat(33)), "");
    }

    #[test]
    fn to_millis_handles_every_stored_shape() {
        assert_eq!(to_millis(None), 0);
        assert_eq!(to_millis(Some(&Value::Null)), 0);
        assert_eq!(to_millis(Some(&Value::Integer(5))), 5);
        assert_eq!(
            to_millis(Some(&Value::String("2026-10-08T00:00:00Z".into()))),
            1_791_417_600_000
        );
        assert_eq!(to_millis(Some(&Value::String("nonsense".into()))), 0);
        assert_eq!(
            to_millis(Some(&Value::map([(
                "seconds".to_string(),
                Value::Integer(2)
            )]))),
            2000
        );
    }

    #[test]
    fn only_real_paid_orders_qualify() {
        let paid = order_document(json!({
            "paymentStatus": { "stringValue": "paid" },
            "createdAt": { "timestampValue": "2026-10-08T00:00:00Z" }
        }));
        assert!(order_qualifies(&paid, 0, "", "buyer"));
        let pending = order_document(json!({
            "paymentStatus": { "stringValue": "pending" }
        }));
        assert!(!order_qualifies(&pending, 0, "", "buyer"));
        // Every qualifying status is accepted.
        for status in QUALIFYING_STATUSES {
            let document = order_document(json!({
                "paymentStatus": { "stringValue": status }
            }));
            assert!(order_qualifies(&document, 0, "", "buyer"), "{status}");
        }
    }

    #[test]
    fn order_qualifies_applies_the_time_and_counterparty_guards() {
        let document = order_document(json!({
            "paymentStatus": { "stringValue": "escrow" },
            "createdAt": { "timestampValue": "2026-10-08T00:00:00Z" },
            "uid": { "stringValue": "buyer-1" },
            "buyerUid": { "stringValue": "buyer-1" },
            "sellerUids": { "arrayValue": { "values": [
                { "stringValue": "seller-1" }, { "stringValue": "referrer-1" }] } }
        }));
        let created = 1_791_417_600_000;
        // Claimed after the order: does not qualify.
        assert!(!order_qualifies(&document, created + 1, "", "buyer"));
        assert!(order_qualifies(&document, created, "", "buyer"));
        // The referrer was the seller: not a real purchase/sale between them.
        assert!(!order_qualifies(&document, 0, "referrer-1", "buyer"));
        // As a seller, the referrer being the buyer also disqualifies.
        assert!(!order_qualifies(&document, 0, "buyer-1", "seller"));
        // An unrelated counterparty does not disqualify.
        assert!(order_qualifies(&document, 0, "someone-else", "seller"));
    }

    #[test]
    fn public_rows_match_the_node_shape() {
        let row = order_document(json!({
            "status": { "stringValue": "rewarded" },
            "claimedAtMs": { "integerValue": "1791417600000" },
            "rewardedAtMs": { "integerValue": "1795059600000" },
            "qualifyingKind": { "stringValue": "purchase" },
            "referrerRewardPkn": { "integerValue": "20" }
        }));
        let public = public_row(&row, "ash");
        assert_eq!(public["username"], json!("ash"));
        assert_eq!(public["status"], json!("rewarded"));
        assert_eq!(public["earnedPkn"], json!(20));
        assert_eq!(public["kind"], json!("purchase"));
        assert!(public["claimedAt"].as_str().unwrap().ends_with('Z'));

        // A pending row earns nothing and has no qualifying kind.
        let row = order_document(json!({ "status": { "stringValue": "pending" } }));
        let public = public_row(&row, "");
        assert_eq!(public["username"], json!("new collector"));
        assert_eq!(public["earnedPkn"], json!(0));
        assert_eq!(public["kind"], Json::Null);
        assert_eq!(public["claimedAt"], Json::Null);
    }

    #[test]
    fn settle_outcome_statuses_match_node() {
        assert_eq!(SettleOutcome::Waiting.status(), "waiting");
        assert_eq!(SettleOutcome::NotPending.status(), "not_pending");
        assert_eq!(SettleOutcome::TreasuryLow.status(), "treasury_low");
        assert_eq!(
            SettleOutcome::Rewarded {
                order_id: "o".into(),
                kind: "sale".into(),
                referrer_pkn: 20,
                referred_pkn: 20
            }
            .status(),
            "rewarded"
        );
    }

    #[test]
    fn name_cache_is_bounded_and_clearable() {
        {
            let mut entries = name_cache().entries.lock().unwrap();
            for index in 0..(NAME_CACHE_MAX + 10) {
                entries.insert(
                    format!("k{index}"),
                    (format!("v{index}"), Instant::now()),
                );
            }
        }
        clear_name_cache();
        assert!(name_cache().entries.lock().unwrap().is_empty());
    }
}
