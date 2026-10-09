//! Poko Discord bets settled in real site PKN.
//!
//! Ported from `api/poko-bets.js`. The invariants that matter:
//!
//! * PKN only moves **user → round escrow** (a stake) and **round escrow → that
//!   same round's stakers** (settle/refund). Never user → user, and never out of
//!   a round.
//! * The stake is checked against the balance **inside** the same Firestore
//!   transaction that debits it, so nobody can bet more than they hold.
//! * The pari-mutuel split is computed from the stored stakes and the escrow
//!   always pays out exactly what it holds: losers fund winners pro rata with
//!   the rounding remainder going to the largest winning stake; with no winners
//!   every stake is refunded.
//! * `settle`/`refund` are idempotent through the round status, and every
//!   movement writes a ledger entry.
//! * `redeem_bonus` pays a one-time 20 PKN welcome bonus, at most once per
//!   Discord account **and** once per Pokoin account.
//!
//! MONEY STORE: this module writes the same documents the rest of the platform
//! uses — `balances/{key}.availablePkn` plus `ledger_entries` (or the Discord
//! wallet ledger) — inside one Firestore transaction. [`LedgerSink`] is the
//! seam for handing those movements to the shared writer (the commerce worker's
//! `store::apply`) instead; the default [`FirestoreLedgerSink`] reproduces the
//! Node writes byte for byte.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Map, Value as Json};
use sha2::{Digest, Sha256};

use crate::error::{ApiError, Result};
use crate::firestore::{new_document_id, DocData, Document, DocumentRef, Firestore, Transaction};
use crate::sql::{row_text, MarketplaceDb, SqlParam};

pub const ROUNDS: &str = "poko_bet_rounds";
pub const CONSENT: &str = "poko_bets_consent";
pub const MAX_BALANCE_LOOKUPS: usize = 25;
pub const SIDES: [&str; 2] = ["win", "loss"];
/// Bets close at minute 5 of the game; the first stake pins the deadline.
pub const MAX_BET_WINDOW_MS: i64 = 10 * 60 * 1000;
pub const BONUS_CLAIMS: &str = "poko_bonus_claims";
pub const DISCORD_BONUS_PKN: i64 = 20;
pub const WALLETS: &str = "poko_discord_wallets";
pub const REWARD_CONFIG_COLLECTION: &str = "poko_config";
pub const REWARD_CONFIG_DOC: &str = "game_rewards";
pub const GAME_REWARDS: &str = "poko_game_rewards";
pub const GAME_REWARD_DAYS: &str = "poko_game_reward_days";
pub const WALLET_LEDGER: &str = "poko_discord_wallet_ledger";
pub const MERGES: &str = "poko_wallet_merges";
pub const BALANCES: &str = "balances";
pub const LEDGER: &str = "ledger_entries";
/// The refund mode uses an outcome no stake can ever have.
pub const REFUND_OUTCOME: &str = "__refund__";

/// `POKO_WALLET_MERGE_CAP` (default 200).
pub fn wallet_merge_cap() -> i64 {
    std::env::var("POKO_WALLET_MERGE_CAP")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(200)
}

/// `POKO_BONUS_MIN_DISCORD_AGE_DAYS` (default 14) in milliseconds.
pub fn bonus_min_discord_age_ms() -> i64 {
    std::env::var("POKO_BONUS_MIN_DISCORD_AGE_DAYS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(14)
        * 24
        * 60
        * 60
        * 1000
}

/// The service token shared with the other Poko handlers.
pub fn service_token() -> String {
    crate::handlers::poko::service_token()
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// `discordId`: digits only, capped at 25, at least 5 long.
pub fn discord_id(value: &str) -> String {
    let id: String = value
        .chars()
        .filter(char::is_ascii_digit)
        .take(25)
        .collect();
    if id.len() >= 5 {
        id
    } else {
        String::new()
    }
}

/// `roundKey(guildId, gameId)`.
pub fn round_key(guild_id: &str, game_id: &str) -> String {
    let guild = discord_id(guild_id);
    let game: String = game_id
        .chars()
        .filter(char::is_ascii_digit)
        .take(25)
        .collect();
    if guild.is_empty() || game.is_empty() {
        String::new()
    } else {
        format!("{guild}_{game}")
    }
}

/// `wholePkn`: a safe integer greater than zero, else 0.
pub fn whole_pkn(value: Option<&Json>) -> i64 {
    let amount = match value {
        Some(Json::Number(number)) => number
            .as_i64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|value| value.fract() == 0.0 && value.is_finite())
                    .map(|value| value as i64)
            })
            .unwrap_or(0),
        Some(Json::String(text)) => text.trim().parse::<i64>().ok().unwrap_or(0),
        _ => 0,
    };
    if amount > 0 && amount <= 9_007_199_254_740_991 {
        amount
    } else {
        0
    }
}

/// `clampClosesAt`: never accept a deadline further out than one bet window.
pub fn clamp_closes_at(value: Option<&Json>, now_ms: i64) -> i64 {
    let closes_at = whole_pkn(value);
    if closes_at == 0 {
        return 0;
    }
    closes_at.min(now_ms + MAX_BET_WINDOW_MS)
}

/// `discordCreatedAtMs`: the snowflake's embedded timestamp, which cannot be
/// faked for a given id.
pub fn discord_created_at_ms(id: &str) -> i64 {
    match id.parse::<i128>() {
        Ok(snowflake) => ((snowflake >> 22) + 1_420_070_400_000) as i64,
        Err(_) => 0,
    }
}

/// `num(snap, field)` — `Math.trunc(Number(value || 0))`.
pub fn num(document: Option<&Document>, field: &str) -> i64 {
    document
        .and_then(|document| {
            document.get(field).and_then(|value| match value {
                crate::firestore::Value::Integer(value) => Some(value),
                crate::firestore::Value::Double(value) => Some(value.trunc() as i64),
                crate::firestore::Value::String(text) => text.trim().parse::<f64>().ok().map(|v| v.trunc() as i64),
                crate::firestore::Value::Boolean(value) => Some(i64::from(value)),
                _ => None,
            })
        })
        .unwrap_or(0)
}

/// One stake as stored on the round document.
#[derive(Debug, Clone, PartialEq)]
pub struct Stake {
    pub side: String,
    pub amount_pkn: i64,
    pub discord_user_id: String,
    /// `account` or `wallet`.
    pub holder: String,
    pub uid: String,
}

impl Stake {
    pub fn from_json(value: &Json) -> Self {
        Self {
            side: value
                .get("side")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string(),
            amount_pkn: value.get("amountPkn").and_then(Json::as_i64).unwrap_or(0),
            discord_user_id: value
                .get("discordUserId")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string(),
            holder: value
                .get("holder")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string(),
            uid: value
                .get("uid")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string(),
        }
    }

    pub fn to_json(&self) -> Json {
        let mut object = Map::new();
        object.insert("side".into(), json!(self.side));
        object.insert("amountPkn".into(), json!(self.amount_pkn));
        object.insert("discordUserId".into(), json!(self.discord_user_id));
        object.insert("holder".into(), json!(self.holder));
        if !self.uid.is_empty() {
            object.insert("uid".into(), json!(self.uid));
        }
        Json::Object(object)
    }
}

/// The stored `stakes` map. `serde_json::Map` keeps insertion order, which the
/// largest-stake tie-break depends on.
pub fn stakes_from_json(value: Option<&Json>) -> Map<String, Json> {
    value
        .and_then(Json::as_object)
        .cloned()
        .unwrap_or_default()
}

pub fn stakes_total(stakes: &Map<String, Json>) -> i64 {
    stakes
        .values()
        .map(|value| value.get("amountPkn").and_then(Json::as_i64).unwrap_or(0))
        .sum()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Payouts {
    pub refunded: bool,
    pub total: i64,
    pub payouts: Map<String, Json>,
}

/// Pure pari-mutuel split. Losers' stakes fund winners pro rata (floored); the
/// rounding remainder goes to the largest winning stake so the escrow always
/// pays out exactly what it holds. No winners means a full refund.
pub fn compute_payouts(stakes: &Map<String, Json>, outcome: &str) -> Payouts {
    let entries: Vec<(String, i64)> = stakes
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                value.get("amountPkn").and_then(Json::as_i64).unwrap_or(0),
            )
        })
        .collect();
    let total: i64 = entries.iter().map(|(_, amount)| amount).sum();
    let winners: Vec<&(String, i64)> = entries
        .iter()
        .filter(|(key, _)| {
            stakes
                .get(key)
                .and_then(|value| value.get("side"))
                .and_then(Json::as_str)
                == Some(outcome)
        })
        .collect();

    if winners.is_empty() {
        let mut payouts = Map::new();
        for (key, amount) in &entries {
            payouts.insert(key.clone(), json!(amount));
        }
        return Payouts {
            refunded: true,
            total,
            payouts,
        };
    }

    let winners_total: i64 = winners.iter().map(|(_, amount)| amount).sum();
    let mut payouts = Map::new();
    let mut paid: i64 = 0;
    for (key, amount) in &winners {
        let share = if winners_total == 0 {
            0
        } else {
            (total * amount) / winners_total
        };
        payouts.insert(key.clone(), json!(share));
        paid += share;
    }
    // `reduce` with no initial value keeps the FIRST largest on a tie.
    let largest = winners
        .iter()
        .fold(None::<&(String, i64)>, |best, entry| match best {
            Some(best) if best.1 >= entry.1 => Some(best),
            _ => Some(entry),
        })
        .map(|(key, _)| key.clone())
        .unwrap_or_default();
    if let Some(current) = payouts.get(&largest).and_then(Json::as_i64) {
        payouts.insert(largest, json!(current + (total - paid)));
    }
    for (key, _) in &entries {
        if !payouts.contains_key(key) {
            payouts.insert(key.clone(), json!(0));
        }
    }
    Payouts {
        refunded: false,
        total,
        payouts,
    }
}

/// `payoutsByDiscord`: per-Discord-user totals, in stake insertion order.
pub fn payouts_by_discord(stakes: &Map<String, Json>, payouts: &Map<String, Json>) -> Map<String, Json> {
    let mut out: Map<String, Json> = Map::new();
    for (stake_key, value) in stakes {
        let discord_user_id = value
            .get("discordUserId")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string();
        let amount = payouts
            .get(stake_key)
            .and_then(Json::as_i64)
            .unwrap_or(0);
        let current = out
            .get(&discord_user_id)
            .and_then(Json::as_i64)
            .unwrap_or(0);
        out.insert(discord_user_id, json!(current + amount));
    }
    out
}

/// The holder of a Discord user's PKN.
#[derive(Debug, Clone, PartialEq)]
pub enum HolderKind {
    Account,
    Wallet,
}

impl HolderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            HolderKind::Account => "account",
            HolderKind::Wallet => "wallet",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Holder {
    pub kind: HolderKind,
    /// `uid` for an account, `discord_<id>` for a wallet.
    pub key: String,
    pub uid: String,
    pub discord_user_id: String,
}

impl Holder {
    pub fn is_account(&self) -> bool {
        matches!(self.kind, HolderKind::Account)
    }

    pub fn balance_path(&self) -> String {
        if self.is_account() {
            format!("{BALANCES}/{}", self.uid)
        } else {
            format!("{WALLETS}/{}", self.discord_user_id)
        }
    }

    /// The `stakes` map key.
    pub fn stake_key(&self) -> String {
        if self.is_account() {
            self.uid.clone()
        } else {
            format!("discord_{}", self.discord_user_id)
        }
    }
}

/// The escrow movement seam. The default [`FirestoreLedgerSink`] reproduces the
/// Node writes; a shared writer (the commerce worker's `store::apply`) can be
/// supplied instead without touching the handlers.
pub trait LedgerSink: Send + Sync + 'static {
    /// Credit `amount` to a holder inside `transaction`, writing the paired
    /// ledger entry (`ledger_type`) exactly once.
    fn credit(
        &self,
        transaction: &mut Transaction,
        holder: &Holder,
        amount: i64,
        ledger_type: &str,
        coins: &Map<String, Json>,
    ) -> Result<()>;

    /// Write the round-scoped ledger entry for a stake delta. The balance itself
    /// is written by the caller because it also carries holder-specific fields.
    fn record_stake(
        &self,
        transaction: &mut Transaction,
        holder: &Holder,
        delta: i64,
        key: &str,
        side: &str,
    ) -> Result<()>;
}

/// The Node default: `ledger_entries/{auto}` for an account, the Discord wallet
/// ledger for an unlinked wallet.
pub struct FirestoreLedgerSink;

impl FirestoreLedgerSink {
    fn ledger_document(
        holder: &Holder,
        ledger_type: &str,
        amount: i64,
        coins: &Map<String, Json>,
    ) -> DocData {
        let mut data = if holder.is_account() {
            DocData::new().string("uid", holder.uid.clone())
        } else {
            DocData::new().string("discordUserId", holder.discord_user_id.clone())
        };
        data = data.string("type", ledger_type).int("amountPkn", amount);
        for (key, value) in coins {
            data = data.set(key.clone(), crate::firestore::Value::from_plain_json(value));
        }
        data.server_timestamp("createdAt")
    }
}

impl LedgerSink for FirestoreLedgerSink {
    fn credit(
        &self,
        transaction: &mut Transaction,
        holder: &Holder,
        amount: i64,
        ledger_type: &str,
        coins: &Map<String, Json>,
    ) -> Result<()> {
        transaction.set(
            &transaction.doc(&format!("{WALLET_LEDGER}/{}", new_document_id())),
            Self::ledger_document(holder, ledger_type, amount, coins),
            false,
        )
    }

    fn record_stake(
        &self,
        transaction: &mut Transaction,
        holder: &Holder,
        delta: i64,
        key: &str,
        side: &str,
    ) -> Result<()> {
        let ledger_type = if delta > 0 {
            "poko_bet_stake"
        } else {
            "poko_bet_stake_reduced"
        };
        let mut coins = Map::new();
        coins.insert("roundId".into(), json!(key));
        coins.insert("side".into(), json!(side));
        let data = Self::ledger_document(holder, ledger_type, -delta, &coins);
        let path = if holder.is_account() {
            format!("{LEDGER}/{}", new_document_id())
        } else {
            format!("{WALLET_LEDGER}/{}", new_document_id())
        };
        transaction.set(&transaction.doc(&path), data, false)
    }
}

/// A sink that writes account ledger entries to `ledger_entries` and wallet
/// entries to the wallet ledger, matching Node for the payout/bonus paths.
pub struct NodeLedgerSink;

impl LedgerSink for NodeLedgerSink {
    fn credit(
        &self,
        transaction: &mut Transaction,
        holder: &Holder,
        amount: i64,
        ledger_type: &str,
        coins: &Map<String, Json>,
    ) -> Result<()> {
        let mut data = if holder.is_account() {
            DocData::new().string("uid", holder.uid.clone())
        } else {
            DocData::new().string("discordUserId", holder.discord_user_id.clone())
        };
        data = data.string("type", ledger_type).int("amountPkn", amount);
        for (key, value) in coins {
            data = data.set(key.clone(), crate::firestore::Value::from_plain_json(value));
        }
        data = data.server_timestamp("createdAt");
        let path = if holder.is_account() {
            format!("{LEDGER}/{}", new_document_id())
        } else {
            format!("{WALLET_LEDGER}/{}", new_document_id())
        };
        transaction.set(&transaction.doc(&path), data, false)
    }

    fn record_stake(
        &self,
        transaction: &mut Transaction,
        holder: &Holder,
        delta: i64,
        key: &str,
        side: &str,
    ) -> Result<()> {
        let ledger_type = if delta > 0 {
            "poko_bet_stake"
        } else {
            "poko_bet_stake_reduced"
        };
        let mut coins = Map::new();
        coins.insert("roundId".into(), json!(key));
        coins.insert("side".into(), json!(side));
        let mut data = if holder.is_account() {
            DocData::new().string("uid", holder.uid.clone())
        } else {
            DocData::new().string("discordUserId", holder.discord_user_id.clone())
        };
        data = data.string("type", ledger_type).int("amountPkn", -delta);
        for (key, value) in &coins {
            data = data.set(key.clone(), crate::firestore::Value::from_plain_json(value));
        }
        data = data.server_timestamp("createdAt");
        let path = if holder.is_account() {
            format!("{LEDGER}/{}", new_document_id())
        } else {
            format!("{WALLET_LEDGER}/{}", new_document_id())
        };
        transaction.set(&transaction.doc(&path), data, false)
    }
}

/// The document-id of one holder's idempotency claim.
pub fn bonus_claim_id(kind: &str, key: &str) -> String {
    format!("{kind}_{key}")
}

/// A deterministic id for tests and diagnostics.
pub fn digest_id(prefix: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{prefix}_{}", hex::encode(hasher.finalize()))
}

/// The SQL lookup: which Pokoin uid owns each Discord account.
pub async fn linked_uids(
    db: &MarketplaceDb,
    discord_user_ids: &[String],
) -> Result<HashMap<String, String>> {
    let mut ids: Vec<String> = Vec::new();
    for value in discord_user_ids {
        let id = discord_id(value);
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = db
        .query_json(
            "select discord_user_id, firebase_uid from poko_discord_links \
             where discord_user_id = any($1::text[]) and unlinked_at is null",
            &[SqlParam::TextArray(ids)],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row_text(&row, "discord_user_id"),
                row_text(&row, "firebase_uid"),
            )
        })
        .collect())
}

/// `linkedUid(discordUserId)` — 403 `not_linked` when there is no link.
pub async fn linked_uid(db: &MarketplaceDb, discord_user_id: &str) -> Result<String> {
    let id = discord_id(discord_user_id);
    if id.is_empty() {
        return Err(exposed(400, "discordUserId required"));
    }
    let uid = linked_uids(db, &[id.clone()]).await?.get(&id).cloned();
    match uid {
        Some(uid) if !uid.is_empty() => Ok(uid),
        _ => Err(exposed(403, "not_linked")),
    }
}

/// An error the handler is allowed to report verbatim (`error.expose`).
pub fn exposed(status: u16, message: &str) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::from_u16(status)
            .unwrap_or(axum::http::StatusCode::BAD_REQUEST),
        message,
    )
    .with_code("expose")
}

/// True when an error came from [`exposed`].
pub fn is_exposed(error: &ApiError) -> bool {
    error.code() == Some("expose")
}

/// The declared action list, in contract order (used by the 400 fallback).
pub fn action_names() -> Vec<&'static str> {
    vec![
        "reward_game",
        "redeem_bonus",
        "balances",
        "set_consent",
        "merge_wallet",
        "stake",
        "close",
        "settle",
        "refund",
    ]
}

/// The shared `Arc<dyn LedgerSink>` the handlers use.
pub fn default_ledger_sink() -> Arc<dyn LedgerSink> {
    Arc::new(NodeLedgerSink)
}

/// Keep the unused-import checker honest about `DocumentRef`.
#[allow(dead_code)]
fn _doc_ref(_: &DocumentRef, _: &Document, _: &Firestore) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn stakes(rows: &[(&str, &str, i64)]) -> Map<String, Json> {
        let mut map = Map::new();
        for (key, side, amount) in rows {
            map.insert(
                (*key).to_string(),
                json!({ "side": side, "amountPkn": amount, "discordUserId": format!("d{key}"), "holder": "account", "uid": key }),
            );
        }
        map
    }

    #[test]
    fn discord_ids_are_digits_only_and_min_length() {
        assert_eq!(discord_id("12345"), "12345");
        assert_eq!(discord_id(" 12-34 5 "), "12345");
        assert_eq!(discord_id("1234"), "");
        assert_eq!(discord_id("abc"), "");
        assert_eq!(discord_id(&"9".repeat(40)).len(), 25);
    }

    #[test]
    fn round_keys_need_both_ids() {
        assert_eq!(round_key("12345", "67890"), "12345_67890");
        assert_eq!(round_key("g12345", "g67890"), "12345_67890");
        assert_eq!(round_key("", "67890"), "");
        assert_eq!(round_key("12345", ""), "");
        assert_eq!(round_key("1234", "67890"), "");
    }

    #[test]
    fn whole_pkn_rejects_zero_negatives_and_fractions() {
        assert_eq!(whole_pkn(Some(&json!(5))), 5);
        assert_eq!(whole_pkn(Some(&json!("7"))), 7);
        assert_eq!(whole_pkn(Some(&json!(0))), 0);
        assert_eq!(whole_pkn(Some(&json!(-3))), 0);
        assert_eq!(whole_pkn(Some(&json!(1.5))), 0);
        assert_eq!(whole_pkn(Some(&json!("abc"))), 0);
        assert_eq!(whole_pkn(None), 0);
        assert_eq!(whole_pkn(Some(&json!(9_007_199_254_740_992i64))), 0);
    }

    #[test]
    fn closes_at_is_clamped_to_one_bet_window() {
        let now = 1_791_417_600_000i64;
        assert_eq!(clamp_closes_at(Some(&json!(0)), now), 0);
        assert_eq!(clamp_closes_at(None, now), 0);
        // Within the window: unchanged.
        assert_eq!(clamp_closes_at(Some(&json!(now + 60_000)), now), now + 60_000);
        // Beyond the window: clamped.
        assert_eq!(
            clamp_closes_at(Some(&json!(now + 60 * 60 * 1000)), now),
            now + MAX_BET_WINDOW_MS
        );
        // Already in the past stays in the past (the caller then refuses).
        assert_eq!(clamp_closes_at(Some(&json!(now - 1)), now), now - 1);
    }

    #[test]
    fn discord_creation_time_comes_from_the_snowflake() {
        // Discord epoch is 1420070400000 ms; the id embeds (ms - epoch) << 22.
        let created = 1_700_000_000_000i64;
        let snowflake: i128 = ((created as i128) - 1_420_070_400_000i128) << 22;
        assert_eq!(discord_created_at_ms(&snowflake.to_string()), created);
        assert_eq!(discord_created_at_ms("not-a-number"), 0);
    }

    #[test]
    fn no_winners_refunds_every_stake_exactly() {
        let book = stakes(&[("a", "win", 10), ("b", "loss", 25)]);
        let result = compute_payouts(&book, "loss");
        assert!(!result.refunded);
        // Only b wins, so b takes the whole 35.
        assert_eq!(result.total, 35);
        assert_eq!(result.payouts["b"], json!(35));
        assert_eq!(result.payouts["a"], json!(0));

        // The refund outcome matches nothing, so everyone is made whole.
        let refund = compute_payouts(&book, REFUND_OUTCOME);
        assert!(refund.refunded);
        assert_eq!(refund.total, 35);
        assert_eq!(refund.payouts["a"], json!(10));
        assert_eq!(refund.payouts["b"], json!(25));
    }

    #[test]
    fn winners_share_pro_rata_and_the_escrow_pays_out_exactly() {
        let book = stakes(&[("a", "win", 10), ("b", "win", 30), ("c", "loss", 50)]);
        let result = compute_payouts(&book, "win");
        assert!(!result.refunded);
        assert_eq!(result.total, 90);
        // 90 * 10 / 40 = 22 (floored), 90 * 30 / 40 = 67; 67 + 22 = 89, so the
        // remainder of 1 goes to the largest winning stake (b).
        assert_eq!(result.payouts["a"], json!(22));
        assert_eq!(result.payouts["b"], json!(68));
        assert_eq!(result.payouts["c"], json!(0));
        let paid: i64 = result
            .payouts
            .values()
            .map(|value| value.as_i64().unwrap_or(0))
            .sum();
        assert_eq!(paid, result.total, "the escrow must pay out exactly what it holds");
    }

    #[test]
    fn the_remainder_goes_to_the_first_largest_on_a_tie() {
        let book = stakes(&[
            ("a", "win", 10),
            ("b", "win", 10),
            ("c", "win", 10),
            ("d", "loss", 1),
        ]);
        let result = compute_payouts(&book, "win");
        assert_eq!(result.total, 31);
        // floor(31*10/30) = 10 each -> paid 30, remainder 1 to the first (a).
        assert_eq!(result.payouts["a"], json!(11));
        assert_eq!(result.payouts["b"], json!(10));
        assert_eq!(result.payouts["c"], json!(10));
    }

    #[test]
    fn a_single_staker_on_the_winning_side_gets_their_stake_back() {
        let book = stakes(&[("a", "win", 40)]);
        let result = compute_payouts(&book, "win");
        assert_eq!(result.payouts["a"], json!(40));
        assert_eq!(result.total, 40);
    }

    #[test]
    fn an_empty_round_refunds_nothing() {
        let result = compute_payouts(&Map::new(), REFUND_OUTCOME);
        assert!(result.refunded);
        assert_eq!(result.total, 0);
        assert!(result.payouts.is_empty());
    }

    #[test]
    fn every_payout_is_conserved_for_a_range_of_books() {
        // The invariant that matters: sum(payouts) == sum(stakes), for every
        // winner count and every awkward remainder.
        for winners in 1..=5i64 {
            for losers in 0..=5i64 {
                for unit in [1i64, 3, 7, 11, 100] {
                    let mut rows: Vec<(String, &str, i64)> = Vec::new();
                    for index in 0..winners {
                        rows.push((format!("w{index}"), "win", unit));
                    }
                    for index in 0..losers {
                        rows.push((format!("l{index}"), "loss", unit + 1));
                    }
                    let mut book = Map::new();
                    for (key, side, amount) in &rows {
                        book.insert(
                            key.clone(),
                            json!({ "side": side, "amountPkn": amount, "discordUserId": key, "holder": "account", "uid": key }),
                        );
                    }
                    let result = compute_payouts(&book, "win");
                    let paid: i64 = result
                        .payouts
                        .values()
                        .map(|value| value.as_i64().unwrap_or(0))
                        .sum();
                    assert_eq!(
                        paid, result.total,
                        "winners={winners} losers={losers} unit={unit}"
                    );
                    // A settled round never refunds.
                    assert!(!result.refunded);
                }
            }
        }
    }

    #[test]
    fn per_discord_totals_follow_stake_order() {
        let book = stakes(&[("a", "win", 10), ("b", "win", 30), ("c", "loss", 50)]);
        let result = compute_payouts(&book, "win");
        let by_discord = payouts_by_discord(&book, &result.payouts);
        assert_eq!(by_discord["da"], json!(22));
        assert_eq!(by_discord["db"], json!(68));
        assert_eq!(by_discord["dc"], json!(0));
        let keys: Vec<&String> = by_discord.keys().collect();
        assert_eq!(keys, vec!["da", "db", "dc"]);
    }

    #[test]
    fn stakes_round_trip_and_total() {
        let book = stakes(&[("a", "win", 10), ("b", "loss", 25)]);
        assert_eq!(stakes_total(&book), 35);
        let stake = Stake::from_json(&book["a"]);
        assert_eq!(stake.side, "win");
        assert_eq!(stake.amount_pkn, 10);
        assert_eq!(stake.holder, "account");
        assert_eq!(stake.uid, "a");
        let json = stake.to_json();
        assert_eq!(json["side"], json!("win"));
        assert_eq!(json["uid"], json!("a"));
        // A wallet stake carries no uid.
        let wallet = Stake::from_json(&json!({
            "side": "loss", "amountPkn": 5, "discordUserId": "12345", "holder": "wallet"
        }));
        assert!(wallet.to_json().get("uid").is_none());
        assert_eq!(stakes_total(&Map::new()), 0);
    }

    #[test]
    fn holders_resolve_to_the_right_document() {
        let account = Holder {
            kind: HolderKind::Account,
            key: "uid-1".into(),
            uid: "uid-1".into(),
            discord_user_id: "12345".into(),
        };
        assert!(account.is_account());
        assert_eq!(account.balance_path(), "balances/uid-1");
        assert_eq!(account.stake_key(), "uid-1");

        let wallet = Holder {
            kind: HolderKind::Wallet,
            key: "discord_12345".into(),
            uid: String::new(),
            discord_user_id: "12345".into(),
        };
        assert!(!wallet.is_account());
        assert_eq!(wallet.balance_path(), "poko_discord_wallets/12345");
        assert_eq!(wallet.stake_key(), "discord_12345");
        assert_eq!(wallet.kind.as_str(), "wallet");
    }

    #[test]
    fn num_truncates_like_javascript() {
        let document = Document {
            name: "projects/p/databases/(default)/documents/balances/u".into(),
            create_time: None,
            update_time: None,
            fields: serde_json::from_value(json!({
                "availablePkn": { "integerValue": "42" },
                "double": { "doubleValue": 7.9 },
                "text": { "stringValue": "3.4" },
                "flag": { "booleanValue": true },
                "nil": { "nullValue": null }
            }))
            .ok(),
        };
        assert_eq!(num(Some(&document), "availablePkn"), 42);
        assert_eq!(num(Some(&document), "double"), 7);
        assert_eq!(num(Some(&document), "text"), 3);
        assert_eq!(num(Some(&document), "flag"), 1);
        assert_eq!(num(Some(&document), "nil"), 0);
        assert_eq!(num(Some(&document), "missing"), 0);
        assert_eq!(num(None, "availablePkn"), 0);
    }

    #[test]
    fn action_names_match_the_contract_order() {
        assert_eq!(
            action_names(),
            vec![
                "reward_game",
                "redeem_bonus",
                "balances",
                "set_consent",
                "merge_wallet",
                "stake",
                "close",
                "settle",
                "refund"
            ]
        );
    }

    #[test]
    fn exposed_errors_are_marked_exposable() {
        let error = exposed(403, "not_linked");
        assert!(is_exposed(&error));
        assert_eq!(error.status(), axum::http::StatusCode::FORBIDDEN);
        assert_eq!(error.message(), "not_linked");
        let plain = ApiError::internal("boom");
        assert!(!is_exposed(&plain));
    }

    #[test]
    fn bonus_claim_ids_are_namespaced() {
        assert_eq!(bonus_claim_id("discord", "12345"), "discord_12345");
        assert_eq!(bonus_claim_id("uid", "abc"), "uid_abc");
    }

    #[test]
    fn merge_cap_and_bonus_age_have_documented_defaults() {
        std::env::remove_var("POKO_WALLET_MERGE_CAP");
        std::env::remove_var("POKO_BONUS_MIN_DISCORD_AGE_DAYS");
        assert_eq!(wallet_merge_cap(), 200);
        assert_eq!(bonus_min_discord_age_ms(), 14 * 24 * 60 * 60 * 1000);
        std::env::set_var("POKO_WALLET_MERGE_CAP", "50");
        std::env::set_var("POKO_BONUS_MIN_DISCORD_AGE_DAYS", "1");
        assert_eq!(wallet_merge_cap(), 50);
        assert_eq!(bonus_min_discord_age_ms(), 24 * 60 * 60 * 1000);
        std::env::remove_var("POKO_WALLET_MERGE_CAP");
        std::env::remove_var("POKO_BONUS_MIN_DISCORD_AGE_DAYS");
    }
}
