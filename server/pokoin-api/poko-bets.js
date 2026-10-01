'use strict';

/**
 * Poko Discord bets settled in real site PKN (Firestore balances/{uid}.availablePkn).
 *
 * Hermes (Poko's Discord bot) calls this with the shared Poko service token.
 * The token alone cannot move money freely:
 * - linked users play with their Pokoin balance (after opting in); unlinked
 *   users play with a Discord wallet that is merged ONCE into the Pokoin account
 *   when they link (capped, bonus not carried twice, wallet closed afterwards);
 * - PKN only moves user -> round escrow (stake) and round escrow -> the same
 *   round's stakers (settle/refund); never user -> user or out of a round;
 * - the server computes the pari-mutuel payout from the stored stakes;
 * - the stake is checked against the site balance inside the Firestore
 *   transaction that debits it, so nobody can bet more than they have;
 * - settle/refund are idempotent and every movement writes a ledger entry;
 * - redeem_bonus pays a one-time 20 PKN welcome bonus, at most once per
 *   Discord account and once per Pokoin account.
 *
 * Deploy with `scripts/deploy-poko-market-api.sh` (ships the poko handlers).
 */

const crypto = require('node:crypto');

const { marketplaceQuery } = require('./_marketplace_db');
const { getFirebaseAdmin } = require('./_firebase');

const ROUNDS = 'poko_bet_rounds';
const CONSENT = 'poko_bets_consent';
const MAX_BALANCE_LOOKUPS = 25;
const SIDES = new Set(['win', 'loss']);
// Bets close at minute 5 of the game; the first stake pins the deadline and
// the server refuses later stakes even if the bot's own close is late.
const MAX_BET_WINDOW_MS = 10 * 60 * 1000;
// One-time Discord welcome bonus: once per Discord account AND once per Pokoin account.
const BONUS_CLAIMS = 'poko_bonus_claims';
const DISCORD_BONUS_PKN = 20;
// Discord-only players: a per-Discord-user wallet, merged once into the Pokoin
// account on link. Caps make alt-account farming pointless.
const WALLETS = 'poko_discord_wallets';
const WALLET_LEDGER = 'poko_discord_wallet_ledger';
const MERGES = 'poko_wallet_merges';
const WALLET_MERGE_CAP = Number(process.env.POKO_WALLET_MERGE_CAP || 200);
const BONUS_MIN_DISCORD_AGE_MS = Number(process.env.POKO_BONUS_MIN_DISCORD_AGE_DAYS || 14) * 24 * 60 * 60 * 1000;

function serviceToken() {
  return String(process.env.POKO_MARKET_SERVICE_TOKEN || process.env.POKONTACT_SERVICE_TOKEN || '').trim();
}

function timingSafeEqualText(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isServiceAuthorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || ''));
  if (!match) return false;
  return timingSafeEqualText(match[1].trim(), expected);
}

function discordId(value) {
  const id = String(value ?? '').replace(/[^0-9]/g, '').slice(0, 25);
  return id.length >= 5 ? id : '';
}

function roundKey(guildId, gameId) {
  const guild = discordId(guildId);
  const game = String(gameId ?? '').replace(/[^0-9]/g, '').slice(0, 25);
  return guild && game ? `${guild}_${game}` : '';
}

function wholePkn(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

function clampClosesAt(value, nowMs) {
  const closesAt = Number(value);
  if (!Number.isSafeInteger(closesAt) || closesAt <= 0) return 0;
  // never accept a deadline further out than one bet window from now
  return Math.min(closesAt, nowMs + MAX_BET_WINDOW_MS);
}

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

async function linkedUids(discordUserIds) {
  const ids = [...new Set(discordUserIds.map(discordId).filter(Boolean))];
  if (!ids.length) return new Map();
  const result = await marketplaceQuery(
    `select discord_user_id, firebase_uid
       from poko_discord_links
      where discord_user_id = any($1::text[]) and unlinked_at is null`,
    [ids],
  );
  return new Map((result.rows || []).map((row) => [String(row.discord_user_id), String(row.firebase_uid)]));
}

async function linkedUid(discordUserId) {
  const id = discordId(discordUserId);
  if (!id) throw fail('discordUserId required');
  const uid = (await linkedUids([id])).get(id);
  if (!uid) throw fail('not_linked', 403);
  return uid;
}

/** Discord snowflake -> account creation time (ms). Cannot be faked for a given id. */
function discordCreatedAtMs(id) {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
}

function num(snap, field = 'availablePkn') {
  return Math.trunc(Number(snap?.data?.()?.[field] || 0));
}

/**
 * One-time move of a Discord wallet into the linked Pokoin account.
 * - once per Discord account (wallet becomes status 'merged', never refunded again);
 * - a wallet bonus is not carried into an account that already got a bonus
 *   through another Discord account (alt farming);
 * - at most WALLET_MERGE_CAP PKN per Pokoin account across all merges, the
 *   excess stays frozen on the wallet for manual review.
 */
async function mergeWallet(discordUserId, uid, { firestore, admin }) {
  const id = discordId(discordUserId);
  const walletRef = firestore.collection(WALLETS).doc(id);
  const discordClaimRef = firestore.collection(BONUS_CLAIMS).doc(`discord_${id}`);
  const accountClaimRef = firestore.collection(BONUS_CLAIMS).doc(`uid_${uid}`);
  const mergesRef = firestore.collection(MERGES).doc(uid);
  const balanceRef = firestore.collection('balances').doc(uid);
  return firestore.runTransaction(async (tx) => {
    const wallet = await tx.get(walletRef);
    const discordClaim = await tx.get(discordClaimRef);
    const accountClaim = await tx.get(accountClaimRef);
    const merges = await tx.get(mergesRef);
    const balance = await tx.get(balanceRef);
    const now = admin.firestore.FieldValue.serverTimestamp();
    if (wallet.exists && wallet.data()?.status === 'merged') {
      return { merged: false, reason: 'already_merged', movedPkn: 0 };
    }
    const walletPkn = num(wallet);
    const bonusFromWallet = discordClaim.exists && discordClaim.data()?.kind === 'wallet';
    const accountHadBonus = accountClaim.exists && accountClaim.data()?.discordUserId !== id;
    const forfeitedPkn = bonusFromWallet && accountHadBonus ? Math.min(walletPkn, DISCORD_BONUS_PKN) : 0;
    const transferable = walletPkn - forfeitedPkn;
    const room = Math.max(0, WALLET_MERGE_CAP - num(merges, 'totalPkn'));
    const movedPkn = Math.min(transferable, room);
    const frozenPkn = transferable - movedPkn;
    tx.set(walletRef, {
      discordUserId: id,
      status: 'merged',
      availablePkn: 0,
      frozenPkn: num(wallet, 'frozenPkn') + frozenPkn,
      forfeitedPkn: num(wallet, 'forfeitedPkn') + forfeitedPkn,
      mergedInto: uid,
      mergedAt: now,
      updatedAt: now,
    }, { merge: true });
    if (bonusFromWallet && !accountClaim.exists) {
      // the account now counts as bonused: no second bonus via another Discord
      tx.set(accountClaimRef, { uid, discordUserId: id, amountPkn: DISCORD_BONUS_PKN, kind: 'wallet_merge', claimedAt: now });
    }
    if (movedPkn > 0) {
      tx.set(balanceRef, { availablePkn: num(balance) + movedPkn, updatedAt: now }, { merge: true });
      tx.set(mergesRef, { totalPkn: num(merges, 'totalPkn') + movedPkn, updatedAt: now }, { merge: true });
      tx.set(firestore.collection('ledger_entries').doc(), {
        uid, type: 'poko_discord_wallet_merge', amountPkn: movedPkn, discordUserId: id, createdAt: now,
      });
    }
    tx.set(firestore.collection(WALLET_LEDGER).doc(), {
      discordUserId: id, type: 'merge_out', amountPkn: -walletPkn, movedPkn, frozenPkn, forfeitedPkn, uid, createdAt: now,
    });
    return { merged: true, movedPkn, frozenPkn, forfeitedPkn };
  });
}

/**
 * Who holds a Discord user's PKN: the linked Pokoin account (after merging any
 * Discord wallet into it), otherwise the user's Discord wallet.
 */
async function resolveHolder(discordUserId, deps) {
  const id = discordId(discordUserId);
  if (!id) throw fail('discordUserId required');
  const uid = (await linkedUids([id])).get(id);
  if (uid) {
    const merge = await mergeWallet(id, uid, deps);
    return { kind: 'account', key: uid, uid, discordUserId: id, ref: deps.firestore.collection('balances').doc(uid), merge };
  }
  return { kind: 'wallet', key: `discord_${id}`, discordUserId: id, ref: deps.firestore.collection(WALLETS).doc(id) };
}

/**
 * Pure pari-mutuel split. Losers' stakes go to winners pro rata (floor);
 * the rounding remainder goes to the largest winning stake so the escrow
 * always pays out exactly what it holds. No winners -> full refund.
 */
function computePayouts(stakes, outcome) {
  const entries = Object.entries(stakes || {});
  const total = entries.reduce((sum, [, stake]) => sum + stake.amountPkn, 0);
  const winners = entries.filter(([, stake]) => stake.side === outcome);
  if (!winners.length) {
    return { refunded: true, total, payouts: Object.fromEntries(entries.map(([uid, stake]) => [uid, stake.amountPkn])) };
  }
  const winnersTotal = winners.reduce((sum, [, stake]) => sum + stake.amountPkn, 0);
  const payouts = {};
  let paid = 0;
  for (const [uid, stake] of winners) {
    payouts[uid] = Math.floor((total * stake.amountPkn) / winnersTotal);
    paid += payouts[uid];
  }
  const [largestUid] = winners.reduce((best, entry) => (entry[1].amountPkn > best[1].amountPkn ? entry : best));
  payouts[largestUid] += total - paid;
  for (const [uid] of entries) if (!(uid in payouts)) payouts[uid] = 0;
  return { refunded: false, total, payouts };
}

// ---------------------------------------------------------------------------
// Actions (all service-token authenticated)
// ---------------------------------------------------------------------------

async function balances(params, deps) {
  const { firestore } = deps;
  const ids = (Array.isArray(params.discordUserIds) ? params.discordUserIds : [])
    .map(discordId)
    .filter(Boolean)
    .slice(0, MAX_BALANCE_LOOKUPS);
  const rows = await Promise.all(ids.map(async (id) => {
    const holder = await resolveHolder(id, deps);
    if (holder.kind === 'wallet') {
      const wallet = await holder.ref.get();
      return {
        discordUserId: id,
        linked: false,
        consent: false,
        wallet: true,
        walletMerged: wallet.data()?.status === 'merged',
        availablePkn: num(wallet),
      };
    }
    const consent = await firestore.collection(CONSENT).doc(holder.uid).get();
    if (!consent.exists || consent.data()?.enabled !== true) {
      return { discordUserId: id, linked: true, consent: false };
    }
    const balance = await holder.ref.get();
    return { discordUserId: id, linked: true, consent: true, availablePkn: num(balance) };
  }));
  return { action: 'balances', balances: rows };
}

async function setConsent(params, { firestore, admin }) {
  const uid = await linkedUid(params.discordUserId);
  const enabled = params.enabled === true;
  await firestore.collection(CONSENT).doc(uid).set({
    enabled,
    discordUserId: discordId(params.discordUserId),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { action: 'set_consent', enabled };
}

async function mergeWalletAction(params, deps) {
  const uid = await linkedUid(params.discordUserId);
  const result = await mergeWallet(params.discordUserId, uid, deps);
  return { action: 'merge_wallet', ...result };
}

async function stake(params, deps) {
  const { firestore, admin } = deps;
  const key = roundKey(params.guildId, params.gameId);
  const side = String(params.side || '');
  const amount = wholePkn(params.amountPkn);
  if (!key) throw fail('guildId and gameId required');
  if (!SIDES.has(side)) throw fail('side must be win or loss');
  if (!amount) throw fail('amountPkn must be a whole number of PKN greater than zero');
  const holder = await resolveHolder(params.discordUserId, deps);
  if (holder.kind === 'account') {
    const consent = await firestore.collection(CONSENT).doc(holder.uid).get();
    if (!consent.exists || consent.data()?.enabled !== true) throw fail('no_consent', 403);
  }

  const roundRef = firestore.collection(ROUNDS).doc(key);
  return firestore.runTransaction(async (tx) => {
    const roundSnap = await tx.get(roundRef);
    const holderSnap = await tx.get(holder.ref);
    const round = roundSnap.exists ? roundSnap.data() : null;
    if (round && round.status !== 'open') throw fail('round_closed', 409);
    if (holder.kind === 'wallet' && holderSnap.data()?.status === 'merged') throw fail('wallet_merged_relink', 409);
    const nowMs = Date.now();
    const closesAt = round?.closesAtMs || clampClosesAt(params.closesAt, nowMs);
    if (!closesAt) throw fail('closesAt required');
    if (nowMs >= closesAt) throw fail('round_closed', 409);
    const previous = round?.stakes?.[holder.key]?.amountPkn || 0;
    const available = num(holderSnap);
    // The balance check: a changed bet may use the previous stake back.
    if (available + previous < amount) throw fail(`insufficient_balance:${available + previous}`, 402);
    const delta = amount - previous;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const stakes = { ...(round?.stakes || {}) };
    stakes[holder.key] = {
      side,
      amountPkn: amount,
      discordUserId: holder.discordUserId,
      holder: holder.kind,
      ...(holder.uid ? { uid: holder.uid } : {}),
    };
    const totalPkn = Object.values(stakes).reduce((sum, entry) => sum + entry.amountPkn, 0);
    tx.set(holder.ref, {
      availablePkn: available - delta,
      ...(holder.kind === 'wallet' ? { discordUserId: holder.discordUserId, status: 'active' } : {}),
      updatedAt: now,
    }, { merge: true });
    tx.set(roundRef, {
      guildId: discordId(params.guildId),
      gameId: String(params.gameId),
      label: String(params.label || '').slice(0, 80),
      status: 'open',
      closesAtMs: closesAt,
      stakes,
      totalPkn,
      ...(round ? {} : { createdAt: now }),
      updatedAt: now,
    }, { merge: true });
    if (delta !== 0) {
      const entry = { type: delta > 0 ? 'poko_bet_stake' : 'poko_bet_stake_reduced', amountPkn: -delta, roundId: key, side, createdAt: now };
      if (holder.kind === 'account') tx.set(firestore.collection('ledger_entries').doc(), { uid: holder.uid, ...entry });
      else tx.set(firestore.collection(WALLET_LEDGER).doc(), { discordUserId: holder.discordUserId, ...entry });
    }
    return { action: 'stake', roundId: key, side, amountPkn: amount, availablePkn: available - delta, totalPkn, holder: holder.kind };
  });
}

async function closeRound(params, { firestore, admin }) {
  const key = roundKey(params.guildId, params.gameId);
  if (!key) throw fail('guildId and gameId required');
  const roundRef = firestore.collection(ROUNDS).doc(key);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(roundRef);
    if (!snap.exists) return { action: 'close', roundId: key, status: 'empty', totalPkn: 0 };
    const round = snap.data();
    if (round.status === 'open') {
      tx.set(roundRef, { status: 'closed', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    return { action: 'close', roundId: key, status: round.status === 'open' ? 'closed' : round.status, totalPkn: round.totalPkn || 0 };
  });
}

async function finishRound(params, { firestore, admin }, mode) {
  const key = roundKey(params.guildId, params.gameId);
  if (!key) throw fail('guildId and gameId required');
  const outcome = String(params.outcome || '');
  if (mode === 'settle' && !SIDES.has(outcome)) throw fail('outcome must be win or loss');
  const roundRef = firestore.collection(ROUNDS).doc(key);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(roundRef);
    if (!snap.exists) return { action: mode, roundId: key, status: 'empty', payouts: {} };
    const round = snap.data();
    if (round.status === 'settled' || round.status === 'refunded') {
      return { action: mode, roundId: key, status: round.status, outcome: round.outcome || null, payouts: round.payoutsByDiscord || {}, idempotent: true };
    }
    const result = mode === 'refund'
      ? computePayouts(round.stakes, '__refund__')
      : computePayouts(round.stakes, outcome);
    // Resolve every paid stake to where the money goes now (all reads first).
    const targets = [];
    for (const stakeKey of Object.keys(result.payouts).filter((k) => result.payouts[k] > 0)) {
      const entry = round.stakes[stakeKey];
      if (entry.holder === 'wallet') {
        const walletRef = firestore.collection(WALLETS).doc(entry.discordUserId);
        const walletSnap = await tx.get(walletRef);
        const mergedInto = walletSnap.data()?.status === 'merged' ? walletSnap.data().mergedInto : '';
        if (mergedInto) {
          // linked mid-round: winnings follow the user to the Pokoin account
          const ref = firestore.collection('balances').doc(mergedInto);
          targets.push({ stakeKey, entry, kind: 'account', uid: mergedInto, ref, snap: await tx.get(ref) });
        } else {
          targets.push({ stakeKey, entry, kind: 'wallet', ref: walletRef, snap: walletSnap });
        }
      } else {
        const uid = entry.uid || stakeKey;
        const ref = firestore.collection('balances').doc(uid);
        targets.push({ stakeKey, entry, kind: 'account', uid, ref, snap: await tx.get(ref) });
      }
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    const credited = new Map();
    for (const target of targets) {
      const amount = result.payouts[target.stakeKey];
      const refKey = target.ref.path || target.ref.key || `${target.kind}:${target.uid || target.entry.discordUserId}`;
      const base = credited.has(refKey) ? credited.get(refKey) : num(target.snap);
      credited.set(refKey, base + amount);
      tx.set(target.ref, { availablePkn: base + amount, updatedAt: now }, { merge: true });
      const entry = { type: result.refunded ? 'poko_bet_refund' : 'poko_bet_payout', amountPkn: amount, roundId: key, createdAt: now };
      if (target.kind === 'account') tx.set(firestore.collection('ledger_entries').doc(), { uid: target.uid, ...entry });
      else tx.set(firestore.collection(WALLET_LEDGER).doc(), { discordUserId: target.entry.discordUserId, ...entry });
    }
    const payoutsByDiscord = {};
    for (const [stakeKey, entry] of Object.entries(round.stakes || {})) {
      payoutsByDiscord[entry.discordUserId] = (payoutsByDiscord[entry.discordUserId] || 0) + (result.payouts[stakeKey] || 0);
    }
    const status = result.refunded ? 'refunded' : 'settled';
    tx.set(roundRef, {
      status,
      outcome: mode === 'settle' ? outcome : null,
      payoutsByDiscord,
      settledAt: now,
      updatedAt: now,
    }, { merge: true });
    return { action: mode, roundId: key, status, outcome: mode === 'settle' ? outcome : null, payouts: payoutsByDiscord, totalPkn: result.total };
  });
}

async function redeemBonus(params, deps) {
  const { firestore, admin } = deps;
  const holder = await resolveHolder(params.discordUserId, deps);
  const discordUserId = holder.discordUserId;
  const discordClaimRef = firestore.collection(BONUS_CLAIMS).doc(`discord_${discordUserId}`);
  const accountClaimRef = holder.uid ? firestore.collection(BONUS_CLAIMS).doc(`uid_${holder.uid}`) : null;
  if (holder.kind === 'wallet' && Date.now() - discordCreatedAtMs(discordUserId) < BONUS_MIN_DISCORD_AGE_MS) {
    // fresh alt accounts cannot mint wallet bonuses
    throw fail('discord_account_too_new', 403);
  }
  return firestore.runTransaction(async (tx) => {
    const discordClaim = await tx.get(discordClaimRef);
    const accountClaim = accountClaimRef ? await tx.get(accountClaimRef) : null;
    const holderSnap = await tx.get(holder.ref);
    // Both keys are checked and written in one transaction, so relinking a
    // Discord account to another Pokoin profile (or vice versa) never pays twice.
    if (discordClaim.exists) throw fail('bonus_already_claimed_discord', 409);
    if (accountClaim?.exists) throw fail('bonus_already_claimed_account', 409);
    if (holder.kind === 'wallet' && holderSnap.data()?.status === 'merged') throw fail('wallet_merged_relink', 409);
    const available = num(holderSnap);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const claim = { discordUserId, amountPkn: DISCORD_BONUS_PKN, kind: holder.kind, type: 'discord_welcome', claimedAt: now, ...(holder.uid ? { uid: holder.uid } : {}) };
    tx.set(discordClaimRef, claim);
    if (accountClaimRef) tx.set(accountClaimRef, claim);
    tx.set(holder.ref, {
      availablePkn: available + DISCORD_BONUS_PKN,
      ...(holder.kind === 'wallet' ? { discordUserId, status: 'active' } : {}),
      updatedAt: now,
    }, { merge: true });
    const entry = { type: 'poko_discord_bonus', amountPkn: DISCORD_BONUS_PKN, discordUserId, createdAt: now };
    if (holder.kind === 'account') tx.set(firestore.collection('ledger_entries').doc(), { uid: holder.uid, ...entry });
    else tx.set(firestore.collection(WALLET_LEDGER).doc(), entry);
    return { action: 'redeem_bonus', amountPkn: DISCORD_BONUS_PKN, availablePkn: available + DISCORD_BONUS_PKN, holder: holder.kind };
  });
}

const ACTIONS = {
  redeem_bonus: redeemBonus,
  balances,
  set_consent: setConsent,
  merge_wallet: mergeWalletAction,
  stake,
  close: closeRound,
  settle: (params, deps) => finishRound(params, deps, 'settle'),
  refund: (params, deps) => finishRound(params, deps, 'refund'),
};

module.exports = async function handler(req, res) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!serviceToken()) {
    res.status(503).json({ error: 'poko-bets not configured: service token missing' });
    return;
  }
  if (!isServiceAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(params.action || '').slice(0, 20);
  const run = ACTIONS[action];
  if (!run) {
    res.status(400).json({ error: `unknown action; expected one of ${Object.keys(ACTIONS).join(', ')}` });
    return;
  }
  try {
    const admin = getFirebaseAdmin();
    const result = await run(params, { admin, firestore: admin.firestore() });
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    if (error.expose) {
      res.status(error.statusCode || 400).json({ ok: false, error: error.message });
      return;
    }
    console.error('poko-bets action failed', { action, error: String(error?.message || error).slice(0, 300) });
    res.status(500).json({ ok: false, error: 'bets action failed' });
  }
};

module.exports._test = { computePayouts, roundKey, discordId, wholePkn, isServiceAuthorized, discordCreatedAtMs, ACTIONS, WALLET_MERGE_CAP };
