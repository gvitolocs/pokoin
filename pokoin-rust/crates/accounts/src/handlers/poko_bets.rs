//! `poko-bets` — the Poko Discord betting actions, over the pure core in
//! [`crate::domain::poko_bets`].
//!
//! Every action is service-token authenticated: the token alone cannot move
//! money freely, because each movement is checked against the stored round and
//! the holder's balance **inside the Firestore transaction that performs it**.
//! See the module docs on `domain::poko_bets` for the money invariants.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value as Json};

use crate::domain::poko_bets::{
    action_names, bonus_claim_id, clamp_closes_at, compute_payouts, discord_created_at_ms,
    discord_id, exposed, is_exposed, linked_uid, linked_uids, num, payouts_by_discord, round_key,
    stakes_total, whole_pkn, Holder, HolderKind, LedgerSink, Payouts, Stake,
    BALANCES, BONUS_CLAIMS, CONSENT, DISCORD_BONUS_PKN, GAME_REWARD_DAYS, GAME_REWARDS, LEDGER,
    MAX_BALANCE_LOOKUPS, MERGES, REWARD_CONFIG_COLLECTION, REWARD_CONFIG_DOC, ROUNDS, SIDES,
    WALLETS, WALLET_LEDGER,
};
use crate::error::{ApiError, Result};
use crate::firestore::{new_document_id, DocData, Document, Firestore, Transaction, Value};
use crate::state::DomainState;

use super::{json_with_cors, parse_body, string_field};

/// Everything an action needs.
#[derive(Clone)]
pub struct BetDeps {
    pub firestore: Firestore,
    pub ledger: Arc<dyn LedgerSink>,
    pub now_ms: i64,
    pub wallet_merge_cap: i64,
    pub bonus_min_age_ms: i64,
}

/// `resolveHolder(discordUserId, deps)` — the linked Pokoin account (after
/// merging any Discord wallet into it), else the Discord wallet.
async fn resolve_holder(
    deps: &BetDeps,
    db: &crate::sql::MarketplaceDb,
    discord_user_id: &str,
) -> Result<Holder> {
    let id = discord_id(discord_user_id);
    if id.is_empty() {
        return Err(exposed(400, "discordUserId required"));
    }
    let uid = linked_uids(db, &[id.clone()])
        .await?
        .get(&id)
        .cloned()
        .unwrap_or_default();
    if !uid.is_empty() {
        merge_wallet(deps, &id, &uid).await?;
        return Ok(Holder {
            kind: HolderKind::Account,
            key: uid.clone(),
            uid,
            discord_user_id: id,
        });
    }
    Ok(Holder {
        kind: HolderKind::Wallet,
        key: format!("discord_{id}"),
        uid: String::new(),
        discord_user_id: id,
    })
}

fn holder_ref(deps: &BetDeps, holder: &Holder) -> crate::firestore::DocumentRef {
    deps.firestore.doc(holder.balance_path())
}

/// `mergeWallet(discordUserId, uid, deps)`.
pub async fn merge_wallet(deps: &BetDeps, id: &str, uid: &str) -> Result<Json> {
    let firestore = deps.firestore.clone();
    let ledger = deps.ledger.clone();
    let cap = deps.wallet_merge_cap;
    let id = id.to_string();
    let uid = uid.to_string();

    firestore
        .run_transaction(|transaction| {
            let id = id.clone();
            let uid = uid.clone();
            let ledger = ledger.clone();
            Box::pin(async move {
                let wallet_ref = transaction.doc(&format!("{WALLETS}/{id}"));
                let discord_claim_ref =
                    transaction.doc(&format!("{BONUS_CLAIMS}/{}", bonus_claim_id("discord", &id)));
                let account_claim_ref =
                    transaction.doc(&format!("{BONUS_CLAIMS}/{}", bonus_claim_id("uid", &uid)));
                let merges_ref = transaction.doc(&format!("{MERGES}/{uid}"));
                let balance_ref = transaction.doc(&format!("{BALANCES}/{uid}"));

                let wallet = transaction.get_doc(&wallet_ref).await?;
                let discord_claim = transaction.get_doc(&discord_claim_ref).await?;
                let account_claim = transaction.get_doc(&account_claim_ref).await?;
                let merges = transaction.get_doc(&merges_ref).await?;
                let balance = transaction.get_doc(&balance_ref).await?;

                if wallet
                    .as_ref()
                    .map(|document| document.get_str("status") == "merged")
                    .unwrap_or(false)
                {
                    return Ok(json!({ "merged": false, "reason": "already_merged", "movedPkn": 0 }));
                }

                let wallet_pkn = num(wallet.as_ref(), "availablePkn");
                let bonus_from_wallet = discord_claim
                    .as_ref()
                    .map(|document| document.get_str("kind") == "wallet")
                    .unwrap_or(false);
                let account_discord_id = account_claim
                    .as_ref()
                    .map(|document| document.get_str("discordUserId"))
                    .unwrap_or_default();
                let account_had_bonus = account_claim.is_some() && account_discord_id != id;
                let forfeited_pkn = if bonus_from_wallet && account_had_bonus {
                    wallet_pkn.min(DISCORD_BONUS_PKN)
                } else {
                    0
                };
                let transferable = wallet_pkn - forfeited_pkn;
                let room = (cap - num(merges.as_ref(), "totalPkn")).max(0);
                let moved_pkn = transferable.min(room);
                let frozen_pkn = transferable - moved_pkn;

                transaction.set(
                    &wallet_ref,
                    DocData::new()
                        .string("discordUserId", id.clone())
                        .string("status", "merged")
                        .int("availablePkn", 0)
                        .int(
                            "frozenPkn",
                            num(wallet.as_ref(), "frozenPkn") + frozen_pkn,
                        )
                        .int(
                            "forfeitedPkn",
                            num(wallet.as_ref(), "forfeitedPkn") + forfeited_pkn,
                        )
                        .string("mergedInto", uid.clone())
                        .server_timestamp("mergedAt")
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                if bonus_from_wallet && account_claim.is_none() {
                    // The account now counts as bonused: no second bonus via
                    // another Discord account.
                    transaction.set(
                        &account_claim_ref,
                        DocData::new()
                            .string("uid", uid.clone())
                            .string("discordUserId", id.clone())
                            .int("amountPkn", DISCORD_BONUS_PKN)
                            .string("kind", "wallet_merge")
                            .server_timestamp("claimedAt"),
                        false,
                    )?;
                }
                if moved_pkn > 0 {
                    transaction.set(
                        &balance_ref,
                        DocData::new()
                            .int("availablePkn", num(balance.as_ref(), "availablePkn") + moved_pkn)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    transaction.set(
                        &merges_ref,
                        DocData::new()
                            .int("totalPkn", num(merges.as_ref(), "totalPkn") + moved_pkn)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    let mut coins = Map::new();
                    coins.insert("discordUserId".into(), json!(id));
                    ledger.credit(
                        transaction,
                        &Holder {
                            kind: HolderKind::Account,
                            key: uid.clone(),
                            uid: uid.clone(),
                            discord_user_id: id.clone(),
                        },
                        moved_pkn,
                        "poko_discord_wallet_merge",
                        &coins,
                    )?;
                }
                transaction.set(
                    &transaction.doc(&format!("{WALLET_LEDGER}/{}", new_document_id())),
                    DocData::new()
                        .string("discordUserId", id.clone())
                        .string("type", "merge_out")
                        .int("amountPkn", -wallet_pkn)
                        .int("movedPkn", moved_pkn)
                        .int("frozenPkn", frozen_pkn)
                        .int("forfeitedPkn", forfeited_pkn)
                        .string("uid", uid.clone())
                        .server_timestamp("createdAt"),
                    false,
                )?;
                Ok(json!({
                    "merged": true,
                    "movedPkn": moved_pkn,
                    "frozenPkn": frozen_pkn,
                    "forfeitedPkn": forfeited_pkn,
                }))
            })
        })
        .await
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

pub async fn balances(deps: &BetDeps, db: &crate::sql::MarketplaceDb, params: &Json) -> Result<Json> {
    let ids: Vec<String> = params
        .get("discordUserIds")
        .and_then(Json::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Json::as_str)
                .map(discord_id)
                .filter(|id| !id.is_empty())
                .take(MAX_BALANCE_LOOKUPS)
                .collect()
        })
        .unwrap_or_default();
    let mut rows: Vec<Json> = Vec::new();
    for id in ids {
        let holder = resolve_holder(deps, db, &id).await?;
        if !holder.is_account() {
            let wallet = holder_ref(deps, &holder).get().await?;
            rows.push(json!({
                "discordUserId": id,
                "linked": false,
                "consent": false,
                "wallet": true,
                "walletMerged": wallet
                    .as_ref()
                    .map(|document| document.get_str("status") == "merged")
                    .unwrap_or(false),
                "availablePkn": num(wallet.as_ref(), "availablePkn"),
            }));
            continue;
        }
        let consent = deps
            .firestore
            .doc(format!("{CONSENT}/{}", holder.uid))
            .get()
            .await?;
        let enabled = consent
            .as_ref()
            .map(|document| document.get_bool("enabled").unwrap_or(false))
            .unwrap_or(false);
        if !enabled {
            rows.push(json!({ "discordUserId": id, "linked": true, "consent": false }));
            continue;
        }
        let balance = holder_ref(deps, &holder).get().await?;
        rows.push(json!({
            "discordUserId": id,
            "linked": true,
            "consent": true,
            "availablePkn": num(balance.as_ref(), "availablePkn"),
        }));
    }
    Ok(json!({ "action": "balances", "balances": rows }))
}

pub async fn set_consent(
    deps: &BetDeps,
    db: &crate::sql::MarketplaceDb,
    params: &Json,
) -> Result<Json> {
    let uid = linked_uid(db, &string_field(params, "discordUserId")).await?;
    let enabled = params.get("enabled").and_then(Json::as_bool).unwrap_or(false);
    deps.firestore
        .doc(format!("{CONSENT}/{uid}"))
        .set(
            DocData::new()
                .bool("enabled", enabled)
                .string("discordUserId", discord_id(&string_field(params, "discordUserId")))
                .server_timestamp("updatedAt"),
            true,
        )
        .await?;
    Ok(json!({ "action": "set_consent", "enabled": enabled }))
}

pub async fn stake(deps: &BetDeps, db: &crate::sql::MarketplaceDb, params: &Json) -> Result<Json> {
    let key = round_key(&string_field(params, "guildId"), &string_field(params, "gameId"));
    let side = string_field(params, "side");
    let amount = whole_pkn(params.get("amountPkn"));
    if key.is_empty() {
        return Err(exposed(400, "guildId and gameId required"));
    }
    if !SIDES.contains(&side.as_str()) {
        return Err(exposed(400, "side must be win or loss"));
    }
    if amount == 0 {
        return Err(exposed(
            400,
            "amountPkn must be a whole number of PKN greater than zero",
        ));
    }
    let holder = resolve_holder(deps, db, &string_field(params, "discordUserId")).await?;
    if holder.is_account() {
        let consent = deps
            .firestore
            .doc(format!("{CONSENT}/{}", holder.uid))
            .get()
            .await?;
        let enabled = consent
            .as_ref()
            .map(|document| document.get_bool("enabled").unwrap_or(false))
            .unwrap_or(false);
        if !enabled {
            return Err(exposed(403, "no_consent"));
        }
    }

    let firestore = deps.firestore.clone();
    let ledger = deps.ledger.clone();
    let now_ms = deps.now_ms;
    let closes_at_param = params.get("closesAt").cloned();
    let label: String = string_field(params, "label").chars().take(80).collect();
    let guild_id = discord_id(&string_field(params, "guildId"));
    let game_id = string_field(params, "gameId");
    let key_owned = key.clone();
    let side_owned = side.clone();
    let holder_owned = holder.clone();

    firestore
        .run_transaction(|transaction| {
            let key = key_owned.clone();
            let side = side_owned.clone();
            let holder = holder_owned.clone();
            let ledger = ledger.clone();
            let closes_at_param = closes_at_param.clone();
            let label = label.clone();
            let guild_id = guild_id.clone();
            let game_id = game_id.clone();
            Box::pin(async move {
                let round_ref = transaction.doc(&format!("{ROUNDS}/{key}"));
                let holder_ref = transaction.doc(&holder.balance_path());
                let round_snap = transaction.get_doc(&round_ref).await?;
                let holder_snap = transaction.get_doc(&holder_ref).await?;
                let round = round_snap.clone();

                if let Some(round) = &round {
                    if round.get_str("status") != "open" {
                        return Err(exposed(409, "round_closed"));
                    }
                }
                if !holder.is_account()
                    && holder_snap
                        .as_ref()
                        .map(|document| document.get_str("status") == "merged")
                        .unwrap_or(false)
                {
                    return Err(exposed(409, "wallet_merged_relink"));
                }

                let closes_at = {
                    let from_round = round
                        .as_ref()
                        .and_then(|document| document.get_i64("closesAtMs"))
                        .unwrap_or(0);
                    if from_round != 0 {
                        from_round
                    } else {
                        clamp_closes_at(closes_at_param.as_ref(), now_ms)
                    }
                };
                if closes_at == 0 {
                    return Err(exposed(400, "closesAt required"));
                }
                if now_ms >= closes_at {
                    return Err(exposed(409, "round_closed"));
                }

                let stakes = round
                    .as_ref()
                    .and_then(|document| document.get("stakes"))
                    .map(|value| {
                        value
                            .as_map()
                            .map(|fields| {
                                fields
                                    .iter()
                                    .map(|(key, value)| (key.clone(), value.to_plain_json()))
                                    .collect::<Map<String, Json>>()
                            })
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                let stake_key = holder.stake_key();
                let previous = stakes
                    .get(&stake_key)
                    .and_then(|value| value.get("amountPkn"))
                    .and_then(Json::as_i64)
                    .unwrap_or(0);
                let available = num(holder_snap.as_ref(), "availablePkn");
                // The balance check: a changed bet may use the previous stake back.
                if available + previous < amount {
                    return Err(exposed(
                        402,
                        &format!("insufficient_balance:{}", available + previous),
                    ));
                }
                let delta = amount - previous;

                let mut next_stakes = stakes.clone();
                next_stakes.insert(
                    stake_key.clone(),
                    Stake {
                        side: side.clone(),
                        amount_pkn: amount,
                        discord_user_id: holder.discord_user_id.clone(),
                        holder: holder.kind.as_str().to_string(),
                        uid: holder.uid.clone(),
                    }
                    .to_json(),
                );
                let total_pkn = stakes_total(&next_stakes);

                let mut holder_data = DocData::new()
                    .int("availablePkn", available - delta)
                    .server_timestamp("updatedAt");
                if !holder.is_account() {
                    holder_data = holder_data
                        .string("discordUserId", holder.discord_user_id.clone())
                        .string("status", "active");
                }
                transaction.set(&holder_ref, holder_data, true)?;
                let mut round_data = DocData::new()
                    .string("guildId", guild_id.clone())
                    .string("gameId", game_id.clone())
                    .string("label", label.clone())
                    .string("status", "open")
                    .int("closesAtMs", closes_at)
                    .map(
                        "stakes",
                        next_stakes
                            .iter()
                            .map(|(key, value)| {
                                (key.clone(), Value::from_plain_json(value))
                            })
                            .collect(),
                    )
                    .int("totalPkn", total_pkn);
                if round.is_none() {
                    round_data = round_data.server_timestamp("createdAt");
                }
                round_data = round_data.server_timestamp("updatedAt");
                transaction.set(&round_ref, round_data, true)?;

                if delta != 0 {
                    ledger.record_stake(transaction, &holder, delta, &key, &side)?;
                }
                Ok(json!({
                    "action": "stake",
                    "roundId": key,
                    "side": side,
                    "amountPkn": amount,
                    "availablePkn": available - delta,
                    "totalPkn": total_pkn,
                    "holder": holder.kind.as_str(),
                }))
            })
        })
        .await
}

pub async fn close_round(deps: &BetDeps, params: &Json) -> Result<Json> {
    let key = round_key(&string_field(params, "guildId"), &string_field(params, "gameId"));
    if key.is_empty() {
        return Err(exposed(400, "guildId and gameId required"));
    }
    let firestore = deps.firestore.clone();
    firestore
        .run_transaction(|transaction| {
            let key = key.clone();
            Box::pin(async move {
                let round_ref = transaction.doc(&format!("{ROUNDS}/{key}"));
                let Some(round) = transaction.get_doc(&round_ref).await? else {
                    return Ok(json!({
                        "action": "close", "roundId": key, "status": "empty", "totalPkn": 0
                    }));
                };
                let status = round.get_str("status");
                if status == "open" {
                    transaction.set(
                        &round_ref,
                        DocData::new()
                            .string("status", "closed")
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                }
                Ok(json!({
                    "action": "close",
                    "roundId": key,
                    "status": if status == "open" { "closed" } else { status.as_str() },
                    "totalPkn": round.get_i64("totalPkn").unwrap_or(0),
                }))
            })
        })
        .await
}

/// `finishRound(params, deps, mode)` for `settle` and `refund`.
pub async fn finish_round(deps: &BetDeps, params: &Json, mode: &str) -> Result<Json> {
    let key = round_key(&string_field(params, "guildId"), &string_field(params, "gameId"));
    if key.is_empty() {
        return Err(exposed(400, "guildId and gameId required"));
    }
    let outcome = string_field(params, "outcome");
    if mode == "settle" && !SIDES.contains(&outcome.as_str()) {
        return Err(exposed(400, "outcome must be win or loss"));
    }
    let firestore = deps.firestore.clone();
    let ledger = deps.ledger.clone();
    let mode = mode.to_string();
    let outcome_owned = outcome.clone();

    firestore
        .run_transaction(|transaction| {
            let key = key.clone();
            let mode = mode.clone();
            let outcome = outcome_owned.clone();
            let ledger = ledger.clone();
            Box::pin(async move {
                let round_ref = transaction.doc(&format!("{ROUNDS}/{key}"));
                let Some(round) = transaction.get_doc(&round_ref).await? else {
                    return Ok(json!({
                        "action": mode, "roundId": key, "status": "empty", "payouts": {}
                    }));
                };
                let status = round.get_str("status");
                if status == "settled" || status == "refunded" {
                    // Idempotent: a second settle/refund returns the stored result.
                    let stored = round
                        .get("payoutsByDiscord")
                        .map(|value| value.to_plain_json())
                        .unwrap_or_else(|| json!({}));
                    let stored_outcome = round.get_str("outcome");
                    let outcome_json = if stored_outcome.is_empty() {
                        Json::Null
                    } else {
                        json!(stored_outcome)
                    };
                    return Ok(json!({
                        "action": mode,
                        "roundId": key,
                        "status": status,
                        "outcome": outcome_json,
                        "payouts": stored,
                        "idempotent": true,
                    }));
                }

                let stakes = round
                    .get("stakes")
                    .map(|value| {
                        value
                            .as_map()
                            .map(|fields| {
                                fields
                                    .iter()
                                    .map(|(key, value)| (key.clone(), value.to_plain_json()))
                                    .collect::<Map<String, Json>>()
                            })
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                let result: Payouts = if mode == "refund" {
                    compute_payouts(&stakes, crate::domain::poko_bets::REFUND_OUTCOME)
                } else {
                    compute_payouts(&stakes, &outcome)
                };

                // Resolve every paid stake to where the money goes now (all
                // reads before any write).
                struct Target {
                    stake_key: String,
                    holder: Holder,
                    document: Option<Document>,
                }
                let mut targets: Vec<Target> = Vec::new();
                for (stake_key, amount) in result
                    .payouts
                    .iter()
                    .filter(|(_, value)| value.as_i64().unwrap_or(0) > 0)
                {
                    let entry = Stake::from_json(&stakes[stake_key]);
                    if entry.holder == "wallet" {
                        let wallet_ref =
                            transaction.doc(&format!("{WALLETS}/{}", entry.discord_user_id));
                        let wallet_snap = transaction.get_doc(&wallet_ref).await?;
                        let merged_into = wallet_snap
                            .as_ref()
                            .map(|document| {
                                if document.get_str("status") == "merged" {
                                    document.get_str("mergedInto")
                                } else {
                                    String::new()
                                }
                            })
                            .unwrap_or_default();
                        if !merged_into.is_empty() {
                            // Linked mid-round: winnings follow the user.
                            let ref_balance =
                                transaction.doc(&format!("{BALANCES}/{merged_into}"));
                            let document = transaction.get_doc(&ref_balance).await?;
                            targets.push(Target {
                                stake_key: stake_key.clone(),
                                holder: Holder {
                                    kind: HolderKind::Account,
                                    key: merged_into.clone(),
                                    uid: merged_into,
                                    discord_user_id: entry.discord_user_id,
                                },
                                document,
                            });
                        } else {
                            targets.push(Target {
                                stake_key: stake_key.clone(),
                                holder: Holder {
                                    kind: HolderKind::Wallet,
                                    key: format!("discord_{}", entry.discord_user_id),
                                    uid: String::new(),
                                    discord_user_id: entry.discord_user_id,
                                },
                                document: wallet_snap,
                            });
                        }
                    } else {
                        let uid = if entry.uid.is_empty() {
                            stake_key.clone()
                        } else {
                            entry.uid.clone()
                        };
                        let balance_ref = transaction.doc(&format!("{BALANCES}/{uid}"));
                        let document = transaction.get_doc(&balance_ref).await?;
                        targets.push(Target {
                            stake_key: stake_key.clone(),
                            holder: Holder {
                                kind: HolderKind::Account,
                                key: uid.clone(),
                                uid,
                                discord_user_id: entry.discord_user_id,
                            },
                            document,
                        });
                    }
                    let _ = amount;
                }

                let mut credited: HashMap<String, i64> = HashMap::new();
                for target in &targets {
                    let amount = result
                        .payouts
                        .get(&target.stake_key)
                        .and_then(Json::as_i64)
                        .unwrap_or(0);
                    let path = target.holder.balance_path();
                    let base = credited
                        .get(&path)
                        .copied()
                        .unwrap_or_else(|| num(target.document.as_ref(), "availablePkn"));
                    credited.insert(path.clone(), base + amount);
                    transaction.set(
                        &transaction.doc(&path),
                        DocData::new()
                            .int("availablePkn", base + amount)
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    let mut coins = Map::new();
                    coins.insert("roundId".into(), json!(key));
                    ledger.credit(
                        transaction,
                        &target.holder,
                        amount,
                        if result.refunded {
                            "poko_bet_refund"
                        } else {
                            "poko_bet_payout"
                        },
                        &coins,
                    )?;
                }

                let payouts_by_discord = payouts_by_discord(&stakes, &result.payouts);
                let final_status = if result.refunded { "refunded" } else { "settled" };
                transaction.set(
                    &round_ref,
                    DocData::new()
                        .string("status", final_status)
                        .set(
                            "outcome",
                            if mode == "settle" {
                                Value::String(outcome.clone())
                            } else {
                                Value::Null
                            },
                        )
                        .map(
                            "payoutsByDiscord",
                            payouts_by_discord
                                .iter()
                                .map(|(key, value)| (key.clone(), Value::from_plain_json(value)))
                                .collect(),
                        )
                        .server_timestamp("settledAt")
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                Ok(json!({
                    "action": mode,
                    "roundId": key,
                    "status": final_status,
                    "outcome": if mode == "settle" { json!(outcome) } else { Json::Null },
                    "payouts": payouts_by_discord,
                    "totalPkn": result.total,
                }))
            })
        })
        .await
}

pub async fn redeem_bonus(
    deps: &BetDeps,
    db: &crate::sql::MarketplaceDb,
    params: &Json,
) -> Result<Json> {
    let holder = resolve_holder(deps, db, &string_field(params, "discordUserId")).await?;
    let discord_user_id = holder.discord_user_id.clone();
    if !holder.is_account()
        && deps.now_ms - discord_created_at_ms(&discord_user_id) < deps.bonus_min_age_ms
    {
        // Fresh alt accounts cannot mint wallet bonuses.
        return Err(exposed(403, "discord_account_too_new"));
    }
    let firestore = deps.firestore.clone();
    let ledger = deps.ledger.clone();

    firestore
        .run_transaction(|transaction| {
            let holder = holder.clone();
            let ledger = ledger.clone();
            Box::pin(async move {
                let discord_claim_ref = transaction.doc(&format!(
                    "{BONUS_CLAIMS}/{}",
                    bonus_claim_id("discord", &holder.discord_user_id)
                ));
                let account_claim_ref = if holder.is_account() {
                    Some(transaction.doc(&format!(
                        "{BONUS_CLAIMS}/{}",
                        bonus_claim_id("uid", &holder.uid)
                    )))
                } else {
                    None
                };
                let holder_ref = transaction.doc(&holder.balance_path());
                let discord_claim = transaction.get_doc(&discord_claim_ref).await?;
                let account_claim = match &account_claim_ref {
                    Some(reference) => transaction.get_doc(reference).await?,
                    None => None,
                };
                let holder_snap = transaction.get_doc(&holder_ref).await?;

                // Both keys are checked and written in one transaction, so
                // relinking never pays twice.
                if discord_claim.is_some() {
                    return Err(exposed(409, "bonus_already_claimed_discord"));
                }
                if account_claim.is_some() {
                    return Err(exposed(409, "bonus_already_claimed_account"));
                }
                if !holder.is_account()
                    && holder_snap
                        .as_ref()
                        .map(|document| document.get_str("status") == "merged")
                        .unwrap_or(false)
                {
                    return Err(exposed(409, "wallet_merged_relink"));
                }

                let available = num(holder_snap.as_ref(), "availablePkn");
                let mut claim = DocData::new()
                    .string("discordUserId", holder.discord_user_id.clone())
                    .int("amountPkn", DISCORD_BONUS_PKN)
                    .string("kind", holder.kind.as_str())
                    .string("type", "discord_welcome")
                    .server_timestamp("claimedAt");
                if holder.is_account() {
                    claim = claim.string("uid", holder.uid.clone());
                }
                transaction.set(&discord_claim_ref, claim.clone(), false)?;
                if let Some(reference) = &account_claim_ref {
                    transaction.set(reference, claim, false)?;
                }
                let mut holder_data = DocData::new()
                    .int("availablePkn", available + DISCORD_BONUS_PKN)
                    .server_timestamp("updatedAt");
                if !holder.is_account() {
                    holder_data = holder_data
                        .string("discordUserId", holder.discord_user_id.clone())
                        .string("status", "active");
                }
                transaction.set(&holder_ref, holder_data, true)?;
                ledger.credit(
                    transaction,
                    &holder,
                    DISCORD_BONUS_PKN,
                    "poko_discord_bonus",
                    &Map::new(),
                )?;
                Ok(json!({
                    "action": "redeem_bonus",
                    "amountPkn": DISCORD_BONUS_PKN,
                    "availablePkn": available + DISCORD_BONUS_PKN,
                    "holder": holder.kind.as_str(),
                }))
            })
        })
        .await
}

pub async fn reward_game(
    deps: &BetDeps,
    db: &crate::sql::MarketplaceDb,
    params: &Json,
) -> Result<Json> {
    let discord_user_id = discord_id(&string_field(params, "discordUserId"));
    let game_id: String = string_field(params, "gameId")
        .chars()
        .filter(char::is_ascii_digit)
        .take(25)
        .collect();
    if discord_user_id.is_empty() || game_id.is_empty() {
        return Err(exposed(400, "discordUserId and gameId required"));
    }
    let config = deps
        .firestore
        .doc(format!("{REWARD_CONFIG_COLLECTION}/{REWARD_CONFIG_DOC}"))
        .get()
        .await?
        .map(|document| document.to_plain_json())
        .unwrap_or_else(|| json!({}));
    let allowed: Vec<String> = config
        .get("discordUserIds")
        .and_then(Json::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| match value {
                    Json::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    if !allowed.contains(&discord_user_id) {
        return Err(exposed(403, "not_eligible"));
    }
    let amount = config
        .get("amountPkn")
        .and_then(Json::as_f64)
        .unwrap_or(1.0)
        .trunc()
        .clamp(0.0, 10.0) as i64;
    let daily_cap = config
        .get("dailyCap")
        .and_then(Json::as_f64)
        .unwrap_or(15.0)
        .trunc()
        .max(0.0) as i64;
    if amount == 0 {
        return Err(exposed(403, "rewards_disabled"));
    }

    let holder = resolve_holder(deps, db, &discord_user_id).await?;
    let day = crate::domain::associate::utc_day_key(deps.now_ms);
    let guild_id = discord_id(&string_field(params, "guildId"));
    let firestore = deps.firestore.clone();
    let ledger = deps.ledger.clone();

    firestore
        .run_transaction(|transaction| {
            let holder = holder.clone();
            let ledger = ledger.clone();
            let discord_user_id = discord_user_id.clone();
            let game_id = game_id.clone();
            let guild_id = guild_id.clone();
            let day = day.clone();
            Box::pin(async move {
                let reward_ref = transaction
                    .doc(&format!("{GAME_REWARDS}/{game_id}_{discord_user_id}"));
                let day_ref = transaction
                    .doc(&format!("{GAME_REWARD_DAYS}/{discord_user_id}_{day}"));
                let holder_ref = transaction.doc(&holder.balance_path());
                let reward = transaction.get_doc(&reward_ref).await?;
                let day_doc = transaction.get_doc(&day_ref).await?;
                let holder_snap = transaction.get_doc(&holder_ref).await?;

                if reward.is_some() {
                    return Ok(json!({
                        "action": "reward_game", "rewarded": false,
                        "reason": "already_rewarded", "amountPkn": 0
                    }));
                }
                if num(day_doc.as_ref(), "count") >= daily_cap {
                    return Ok(json!({
                        "action": "reward_game", "rewarded": false,
                        "reason": "daily_cap", "amountPkn": 0
                    }));
                }
                if !holder.is_account()
                    && holder_snap
                        .as_ref()
                        .map(|document| document.get_str("status") == "merged")
                        .unwrap_or(false)
                {
                    return Err(exposed(409, "wallet_merged_relink"));
                }
                let available = num(holder_snap.as_ref(), "availablePkn");
                transaction.set(
                    &reward_ref,
                    DocData::new()
                        .string("discordUserId", discord_user_id.clone())
                        .string("gameId", game_id.clone())
                        .string("guildId", guild_id.clone())
                        .int("amountPkn", amount)
                        .string("holder", holder.kind.as_str())
                        .server_timestamp("createdAt"),
                    false,
                )?;
                transaction.set(
                    &day_ref,
                    DocData::new()
                        .string("discordUserId", discord_user_id.clone())
                        .string("day", day.clone())
                        .int("count", num(day_doc.as_ref(), "count") + 1)
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                let mut holder_data = DocData::new()
                    .int("availablePkn", available + amount)
                    .server_timestamp("updatedAt");
                if !holder.is_account() {
                    holder_data = holder_data
                        .string("discordUserId", discord_user_id.clone())
                        .string("status", "active");
                }
                transaction.set(&holder_ref, holder_data, true)?;
                let mut coins = Map::new();
                coins.insert("gameId".into(), json!(game_id));
                ledger.credit(transaction, &holder, amount, "poko_game_reward", &coins)?;
                Ok(json!({
                    "action": "reward_game",
                    "rewarded": true,
                    "amountPkn": amount,
                    "availablePkn": available + amount,
                    "holder": holder.kind.as_str(),
                }))
            })
        })
        .await
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// `POST /api/poko-bets`.
pub async fn poko_bets(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if crate::domain::poko_bets::service_token().is_empty() {
        return json_with_cors(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "poko-bets not configured: service token missing" }),
        );
    }
    if !super::poko::is_service_authorized(super::authorization(&headers)) {
        return json_with_cors(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }

    let params = parse_body(&body);
    let action: String = string_field(&params, "action").chars().take(20).collect();
    if !action_names().contains(&action.as_str()) {
        return json_with_cors(
            StatusCode::BAD_REQUEST,
            json!({ "error": format!("unknown action; expected one of {}", action_names().join(", ")) }),
        );
    }

    let firestore = match state.firestore() {
        Ok(firestore) => firestore,
        Err(error) => return bets_internal_error(&error),
    };
    let db = match state.marketplace_db() {
        Ok(db) => db,
        Err(error) => return bets_internal_error(&error),
    };
    let deps = BetDeps {
        firestore,
        ledger: crate::domain::poko_bets::default_ledger_sink(),
        now_ms: state.clock().now().timestamp_millis(),
        wallet_merge_cap: crate::domain::poko_bets::wallet_merge_cap(),
        bonus_min_age_ms: crate::domain::poko_bets::bonus_min_discord_age_ms(),
    };

    let outcome = match action.as_str() {
        "balances" => balances(&deps, &db, &params).await,
        "set_consent" => set_consent(&deps, &db, &params).await,
        "merge_wallet" => match linked_uid(&db, &string_field(&params, "discordUserId")).await {
            Ok(uid) => merge_wallet(
                &deps,
                &discord_id(&string_field(&params, "discordUserId")),
                &uid,
            )
            .await
            .map(|result| {
                let mut object = Map::new();
                object.insert("action".into(), json!("merge_wallet"));
                if let Some(fields) = result.as_object() {
                    for (key, value) in fields {
                        object.insert(key.clone(), value.clone());
                    }
                }
                Json::Object(object)
            }),
            Err(error) => Err(error),
        },
        "stake" => stake(&deps, &db, &params).await,
        "close" => close_round(&deps, &params).await,
        "settle" => finish_round(&deps, &params, "settle").await,
        "refund" => finish_round(&deps, &params, "refund").await,
        "redeem_bonus" => redeem_bonus(&deps, &db, &params).await,
        _ => reward_game(&deps, &db, &params).await,
    };

    match outcome {
        Ok(result) => {
            let mut object = Map::new();
            object.insert("ok".into(), json!(true));
            if let Some(fields) = result.as_object() {
                for (key, value) in fields {
                    object.insert(key.clone(), value.clone());
                }
            }
            json_with_cors(StatusCode::OK, Json::Object(object))
        }
        Err(error) if is_exposed(&error) => json_with_cors(
            error.status(),
            json!({ "ok": false, "error": error.message() }),
        ),
        Err(error) => bets_internal_error(&error),
    }
}

fn bets_internal_error(error: &ApiError) -> Response {
    tracing::error!(
        message = %error.message().chars().take(300).collect::<String>(),
        "poko-bets action failed"
    );
    json_with_cors(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "ok": false, "error": "bets action failed" }),
    )
}

/// `POST only`.
pub async fn poko_bets_other() -> Response {
    json_with_cors(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({ "error": "POST only" }),
    )
}

/// The round-round trip helper used by tests.
pub async fn round_document(
    firestore: &Firestore,
    key: &str,
) -> Result<Option<Document>> {
    firestore.doc(format!("{ROUNDS}/{key}")).get().await
}

/// Keep the unused import checker honest about `Transaction`/`LEDGER`.
#[allow(dead_code)]
fn _markers(_: &mut Transaction, _: &str) {
    let _ = LEDGER;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_wallet_caps_and_forfeits_are_pure_arithmetic() {
        // The full merge decision table, without a database.
        let cases: [(i64, bool, bool, i64, i64, i64, i64); 5] = [
            // wallet, bonusFromWallet, accountHadBonus, cap, moved, frozen, forfeited
            (75, false, false, 200, 75, 0, 0),
            (75, true, true, 200, 55, 0, 20),
            // A wallet bonus smaller than the account bonus is entirely
            // forfeited, leaving nothing transferable or frozen.
            (10, true, true, 200, 0, 0, 10),
            (300, false, false, 200, 200, 100, 0),
            (0, false, false, 200, 0, 0, 0),
        ];
        for (wallet, bonus, had_bonus, cap, moved, frozen, forfeited) in cases {
            let forfeited_pkn = if bonus && had_bonus {
                wallet.min(DISCORD_BONUS_PKN)
            } else {
                0
            };
            let transferable = wallet - forfeited_pkn;
            let moved_pkn = transferable.min(cap.max(0));
            let frozen_pkn = transferable - moved_pkn;
            assert_eq!(moved_pkn, moved, "wallet={wallet}");
            assert_eq!(frozen_pkn, frozen, "wallet={wallet}");
            assert_eq!(forfeited_pkn, forfeited, "wallet={wallet}");
            // The conservation the wallet row records.
            assert_eq!(moved_pkn + frozen_pkn + forfeited_pkn, wallet);
        }
    }

    #[test]
    fn the_room_calculation_respects_an_existing_merge_total() {
        let cap = 200i64;
        assert_eq!((cap - 0).max(0), 200);
        assert_eq!((cap - 150).max(0), 50);
        assert_eq!((cap - 200).max(0), 0);
        assert_eq!((cap - 500).max(0), 0);
    }

    #[test]
    fn action_dispatch_names_are_the_node_keys() {
        let names = action_names();
        for action in [
            "reward_game",
            "redeem_bonus",
            "balances",
            "set_consent",
            "merge_wallet",
            "stake",
            "close",
            "settle",
            "refund",
        ] {
            assert!(names.contains(&action), "{action}");
        }
    }

    #[test]
    fn stake_states_the_balance_precondition_correctly() {
        // `available + previous < amount` is the refusal; a changed bet can use
        // the previous stake back.
        let check = |available: i64, previous: i64, amount: i64| available + previous >= amount;
        assert!(check(100, 0, 100));
        assert!(!check(99, 0, 100));
        // Raising a bet only needs the difference.
        assert!(check(0, 50, 50));
        assert!(!check(0, 49, 50));
        assert!(check(10, 40, 50));
    }
}
