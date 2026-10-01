'use strict';

/**
 * Poko Discord bets settled in real site PKN (Firestore balances/{uid}.availablePkn).
 *
 * Hermes (Poko's Discord bot) calls this with the shared Poko service token.
 * The token alone cannot move money freely:
 * - only Discord users linked via poko-connect AND opted in (set_consent) can stake;
 * - PKN only moves user -> round escrow (stake) and round escrow -> the same
 *   round's stakers (settle/refund); never user -> user or out of a round;
 * - the server computes the pari-mutuel payout from the stored stakes;
 * - the stake is checked against the site balance inside the Firestore
 *   transaction that debits it, so nobody can bet more than they have;
 * - settle/refund are idempotent and every movement writes a ledger entry.
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

async function balances(params, { firestore }) {
  const ids = (Array.isArray(params.discordUserIds) ? params.discordUserIds : [])
    .map(discordId)
    .filter(Boolean)
    .slice(0, MAX_BALANCE_LOOKUPS);
  const uids = await linkedUids(ids);
  const rows = await Promise.all(ids.map(async (id) => {
    const uid = uids.get(id);
    if (!uid) return { discordUserId: id, linked: false, consent: false };
    const consent = await firestore.collection(CONSENT).doc(uid).get();
    if (!consent.exists || consent.data()?.enabled !== true) {
      return { discordUserId: id, linked: true, consent: false };
    }
    const balance = await firestore.collection('balances').doc(uid).get();
    return {
      discordUserId: id,
      linked: true,
      consent: true,
      availablePkn: Math.trunc(Number(balance.data()?.availablePkn || 0)),
    };
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

async function stake(params, { firestore, admin }) {
  const key = roundKey(params.guildId, params.gameId);
  const side = String(params.side || '');
  const amount = wholePkn(params.amountPkn);
  if (!key) throw fail('guildId and gameId required');
  if (!SIDES.has(side)) throw fail('side must be win or loss');
  if (!amount) throw fail('amountPkn must be a whole number of PKN greater than zero');
  const uid = await linkedUid(params.discordUserId);
  const consent = await firestore.collection(CONSENT).doc(uid).get();
  if (!consent.exists || consent.data()?.enabled !== true) throw fail('no_consent', 403);

  const roundRef = firestore.collection(ROUNDS).doc(key);
  const balanceRef = firestore.collection('balances').doc(uid);
  const ledger = firestore.collection('ledger_entries');
  return firestore.runTransaction(async (tx) => {
    const roundSnap = await tx.get(roundRef);
    const balanceSnap = await tx.get(balanceRef);
    const round = roundSnap.exists ? roundSnap.data() : null;
    if (round && round.status !== 'open') throw fail('round_closed', 409);
    const nowMs = Date.now();
    const closesAt = round?.closesAtMs || clampClosesAt(params.closesAt, nowMs);
    if (!closesAt) throw fail('closesAt required');
    if (nowMs >= closesAt) throw fail('round_closed', 409);
    const previous = round?.stakes?.[uid]?.amountPkn || 0;
    const available = Math.trunc(Number(balanceSnap.data()?.availablePkn || 0));
    // The site balance check: a changed bet may use the previous stake back.
    if (available + previous < amount) throw fail(`insufficient_balance:${available + previous}`, 402);
    const delta = amount - previous;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const stakes = { ...(round?.stakes || {}) };
    stakes[uid] = { side, amountPkn: amount, discordUserId: discordId(params.discordUserId) };
    const totalPkn = Object.values(stakes).reduce((sum, entry) => sum + entry.amountPkn, 0);
    tx.set(balanceRef, { availablePkn: available - delta, updatedAt: now }, { merge: true });
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
      tx.set(ledger.doc(), {
        uid,
        type: delta > 0 ? 'poko_bet_stake' : 'poko_bet_stake_reduced',
        amountPkn: -delta,
        roundId: key,
        side,
        createdAt: now,
      });
    }
    return { action: 'stake', roundId: key, side, amountPkn: amount, availablePkn: available - delta, totalPkn };
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
  const ledger = firestore.collection('ledger_entries');
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
    const uids = Object.keys(result.payouts).filter((uid) => result.payouts[uid] > 0);
    const balanceRefs = uids.map((uid) => firestore.collection('balances').doc(uid));
    const balanceSnaps = [];
    for (const ref of balanceRefs) balanceSnaps.push(await tx.get(ref));
    const now = admin.firestore.FieldValue.serverTimestamp();
    const payoutsByDiscord = {};
    uids.forEach((uid, index) => {
      const amount = result.payouts[uid];
      const current = Math.trunc(Number(balanceSnaps[index].data()?.availablePkn || 0));
      tx.set(balanceRefs[index], { availablePkn: current + amount, updatedAt: now }, { merge: true });
      tx.set(ledger.doc(), {
        uid,
        type: result.refunded ? 'poko_bet_refund' : 'poko_bet_payout',
        amountPkn: amount,
        roundId: key,
        createdAt: now,
      });
    });
    for (const [uid, entry] of Object.entries(round.stakes || {})) {
      payoutsByDiscord[entry.discordUserId] = result.payouts[uid] || 0;
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

const ACTIONS = {
  balances,
  set_consent: setConsent,
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

module.exports._test = { computePayouts, roundKey, discordId, wholePkn, isServiceAuthorized, ACTIONS };
