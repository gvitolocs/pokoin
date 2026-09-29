'use strict';

/**
 * Pokoin Invite & Earn (referral) core. Pure over an injected Firestore Admin
 * instance so the money paths are unit-tested with _firestore_fake.js.
 *
 *   referrals/{referredUid}  one per invited account (a user can be invited once)
 *     referrerUid, referredUid, code, status: pending | rewarded
 *     claimedAtMs, rewardedAtMs, qualifyingOrderId, qualifyingKind
 *
 * A referral pays when the invited account completes its first real purchase
 * or first real sale (paid / escrow / released order) after joining: both get
 * REWARD_PKN from the Pokoin treasury account (usernames/pokoin), written as
 * balanced ledger entries in one transaction, exactly once.
 *
 * Guardrails: only accounts created within CLAIM_WINDOW_DAYS with no paid
 * order yet can claim; no self or circular referral; an order between the
 * two of them does not qualify; the referrer's side is capped at
 * REFERRER_CAP_PER_30_DAYS rewards per rolling 30 days.
 */

const REWARD_PKN = 20;
const CLAIM_WINDOW_DAYS = 14;
const REFERRER_CAP_PER_30_DAYS = 50;
const TREASURY_USERNAME = 'pokoin';
const QUALIFYING_STATUSES = new Set(['paid', 'escrow', 'released', 'partially_refunded']);
const DAY_MS = 24 * 60 * 60 * 1000;

function httpError(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Invite codes are Pokoin usernames: lowercase a–z / 0–9, 3–32 chars. */
function cleanCode(value) {
  const code = String(value || '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9]{3,32}$/.test(code) ? code : '';
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function uidForUsername(firestore, username) {
  if (!username) return '';
  const doc = await firestore.collection('usernames').doc(username).get();
  return String(doc.data()?.uid || '').trim();
}

function orderQualifies(data, { afterMs, counterpartyUid, role }) {
  if (!QUALIFYING_STATUSES.has(String(data.paymentStatus || ''))) return false;
  if (afterMs && toMillis(data.createdAt) < afterMs) return false;
  if (counterpartyUid) {
    const sellers = Array.isArray(data.sellerUids) ? data.sellerUids : [];
    if (role === 'buyer' && sellers.includes(counterpartyUid)) return false;
    if (role === 'seller' && (data.uid === counterpartyUid || data.buyerUid === counterpartyUid)) return false;
  }
  return true;
}

/**
 * First qualifying order for `uid` as buyer or seller, oldest first:
 * { orderId, kind: 'purchase' | 'sale', atMs } or null.
 */
async function firstQualifyingOrder(firestore, uid, { afterMs = 0, counterpartyUid = '' } = {}) {
  const [bought, sold] = await Promise.all([
    firestore.collection('orders').where('uid', '==', uid).limit(200).get(),
    firestore.collection('orders').where('sellerUids', 'array-contains', uid).limit(200).get(),
  ]);
  const hits = [];
  for (const doc of bought.docs) {
    const data = doc.data() || {};
    if (orderQualifies(data, { afterMs, counterpartyUid, role: 'buyer' })) {
      hits.push({ orderId: doc.id, kind: 'purchase', atMs: toMillis(data.createdAt) });
    }
  }
  for (const doc of sold.docs) {
    const data = doc.data() || {};
    if (orderQualifies(data, { afterMs, counterpartyUid, role: 'seller' })) {
      hits.push({ orderId: doc.id, kind: 'sale', atMs: toMillis(data.createdAt) });
    }
  }
  hits.sort((a, b) => a.atMs - b.atMs);
  return hits[0] || null;
}

/**
 * Attach the signed-in account to the inviter behind `code`.
 * Returns { status: 'pending' | 'already_claimed', referrerUid }; throws 4xx
 * errors with a machine code for everything the page explains.
 */
async function claimReferral({ firestore, FieldValue, uid, code, accountCreatedMs, nowMs = Date.now() }) {
  const clean = cleanCode(code);
  if (!clean) throw httpError(400, 'That invite link is not valid.', 'invalid_code');
  const referrerUid = await uidForUsername(firestore, clean);
  if (!referrerUid) throw httpError(404, 'No Pokoin account uses that invite code.', 'invalid_code');
  if (referrerUid === uid) throw httpError(400, 'You cannot use your own invite link.', 'self_referral');

  const ref = firestore.collection('referrals').doc(uid);
  const existing = await ref.get();
  if (existing.exists) {
    return { status: 'already_claimed', referrerUid: existing.data().referrerUid };
  }
  if (!accountCreatedMs || nowMs - accountCreatedMs > CLAIM_WINDOW_DAYS * DAY_MS) {
    throw httpError(409, `Invite links work for accounts created in the last ${CLAIM_WINDOW_DAYS} days.`, 'not_new');
  }
  if (await firstQualifyingOrder(firestore, uid)) {
    throw httpError(409, 'Invite links are for new collectors who have not bought or sold yet.', 'not_new');
  }
  const inviter = await firestore.collection('referrals').doc(referrerUid).get();
  if (inviter.exists && inviter.data()?.referrerUid === uid) {
    throw httpError(400, 'You invited this collector yourself.', 'circular');
  }

  await firestore.runTransaction(async (transaction) => {
    const again = await transaction.get(ref);
    if (again.exists) return;
    transaction.set(ref, {
      referrerUid,
      referredUid: uid,
      code: clean,
      status: 'pending',
      rewardPkn: REWARD_PKN,
      claimedAt: FieldValue.serverTimestamp(),
      claimedAtMs: nowMs,
    });
  });
  return { status: 'pending', referrerUid };
}

async function referrerRewardsSince(firestore, referrerUid, sinceMs) {
  const snap = await firestore.collection('referrals').where('referrerUid', '==', referrerUid).limit(1000).get();
  return snap.docs
    .map((doc) => doc.data() || {})
    .filter((row) => row.status === 'rewarded' && Number(row.referrerRewardPkn) > 0 && Number(row.rewardedAtMs) >= sinceMs)
    .length;
}

/**
 * Pay one pending referral if the invited account has qualified.
 * Returns { status: 'rewarded' | 'waiting' | 'not_pending' | 'treasury_low', ... }.
 */
async function settleReferral({ firestore, FieldValue, referredUid, nowMs = Date.now() }) {
  const ref = firestore.collection('referrals').doc(referredUid);
  const snap = await ref.get();
  const row = snap.data();
  if (!snap.exists || row.status !== 'pending') return { status: 'not_pending' };

  const order = await firstQualifyingOrder(firestore, referredUid, {
    afterMs: Number(row.claimedAtMs) || 0,
    counterpartyUid: row.referrerUid,
  });
  if (!order) return { status: 'waiting' };

  const treasuryUid = await uidForUsername(firestore, TREASURY_USERNAME);
  if (!treasuryUid) throw httpError(500, 'Pokoin treasury account is not configured.', 'no_treasury');
  const capped = await referrerRewardsSince(firestore, row.referrerUid, nowMs - 30 * DAY_MS) >= REFERRER_CAP_PER_30_DAYS;
  const referrerPkn = capped ? 0 : REWARD_PKN;
  const referredPkn = REWARD_PKN;
  const total = referrerPkn + referredPkn;

  const treasuryRef = firestore.collection('balances').doc(treasuryUid);
  return firestore.runTransaction(async (transaction) => {
    const [current, treasury] = await Promise.all([transaction.get(ref), transaction.get(treasuryRef)]);
    if (!current.exists || current.data().status !== 'pending') return { status: 'not_pending' };
    if (Number(treasury.data()?.availablePkn || 0) < total) return { status: 'treasury_low' };

    const now = FieldValue.serverTimestamp();
    const ledger = firestore.collection('ledger_entries');
    const credit = (uid, amount, counterpartyUid, side) => {
      transaction.set(firestore.collection('balances').doc(uid), {
        availablePkn: FieldValue.increment(amount),
        updatedAt: now,
      }, { merge: true });
      transaction.set(ledger.doc(), {
        uid,
        type: 'referral_reward_received',
        amountPkn: amount,
        counterpartyUid,
        counterpartyUsername: TREASURY_USERNAME,
        purpose: 'referral_reward',
        referralSide: side,
        referralId: referredUid,
        orderId: order.orderId,
        createdAt: now,
      });
      transaction.set(ledger.doc(), {
        uid: treasuryUid,
        type: 'referral_reward_sent',
        amountPkn: -amount,
        counterpartyUid: uid,
        purpose: 'referral_reward',
        referralSide: side,
        referralId: referredUid,
        orderId: order.orderId,
        createdAt: now,
      });
    };
    transaction.set(treasuryRef, { availablePkn: FieldValue.increment(-total), updatedAt: now }, { merge: true });
    credit(referredUid, referredPkn, treasuryUid, 'invited');
    if (referrerPkn) credit(row.referrerUid, referrerPkn, treasuryUid, 'inviter');
    transaction.set(ref, {
      status: 'rewarded',
      rewardedAt: now,
      rewardedAtMs: nowMs,
      qualifyingOrderId: order.orderId,
      qualifyingKind: order.kind,
      referredRewardPkn: referredPkn,
      referrerRewardPkn: referrerPkn,
      referrerCapped: capped,
    }, { merge: true });
    return { status: 'rewarded', orderId: order.orderId, kind: order.kind, referrerPkn, referredPkn };
  });
}

/** Pay every pending referral that has qualified (timer + page visits). */
async function settlePending({ firestore, FieldValue, nowMs = Date.now(), limit = 300, onlyReferrerUid = '' } = {}) {
  let query = firestore.collection('referrals').where('status', '==', 'pending');
  if (onlyReferrerUid) query = query.where('referrerUid', '==', onlyReferrerUid);
  const snap = await query.limit(limit).get();
  const counts = { checked: 0, rewarded: 0, waiting: 0, treasuryLow: 0, failed: 0 };
  for (const doc of snap.docs) {
    counts.checked += 1;
    try {
      const result = await settleReferral({ firestore, FieldValue, referredUid: doc.id, nowMs });
      if (result.status === 'rewarded') counts.rewarded += 1;
      else if (result.status === 'waiting') counts.waiting += 1;
      else if (result.status === 'treasury_low') counts.treasuryLow += 1;
    } catch (error) {
      counts.failed += 1;
      console.error('referral settle failed', { referral: doc.id, message: error.message });
    }
  }
  return counts;
}

async function usernameOf(firestore, uid) {
  if (!uid) return '';
  const doc = await firestore.collection('users').doc(uid).get();
  return String(doc.data()?.username || '').trim();
}

function publicRow(row, username) {
  return {
    username: username || 'new collector',
    status: row.status,
    claimedAt: row.claimedAtMs ? new Date(Number(row.claimedAtMs)).toISOString() : null,
    rewardedAt: row.rewardedAtMs ? new Date(Number(row.rewardedAtMs)).toISOString() : null,
    kind: row.qualifyingKind || null,
    earnedPkn: row.status === 'rewarded' ? Number(row.referrerRewardPkn) || 0 : 0,
  };
}

/** What /invite shows the signed-in account. */
async function referralSummary({ firestore, uid }) {
  const [username, invitedSnap, mine] = await Promise.all([
    usernameOf(firestore, uid),
    firestore.collection('referrals').where('referrerUid', '==', uid).limit(500).get(),
    firestore.collection('referrals').doc(uid).get(),
  ]);
  const invitedRows = invitedSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const names = await Promise.all(invitedRows.map((row) => usernameOf(firestore, row.id)));
  const invited = invitedRows
    .map((row, index) => publicRow(row, names[index]))
    .sort((a, b) => String(b.claimedAt || '').localeCompare(String(a.claimedAt || '')));
  const activated = invited.filter((row) => row.status === 'rewarded').length;
  let referredBy = null;
  if (mine.exists) {
    const data = mine.data() || {};
    referredBy = {
      username: await usernameOf(firestore, data.referrerUid),
      status: data.status,
      earnedPkn: data.status === 'rewarded' ? Number(data.referredRewardPkn) || 0 : 0,
    };
  }
  return {
    code: cleanCode(username),
    rewardPkn: REWARD_PKN,
    claimWindowDays: CLAIM_WINDOW_DAYS,
    invited: invited.slice(0, 100),
    stats: {
      invited: invited.length,
      pending: invited.length - activated,
      activated,
      earnedPkn: invited.reduce((sum, row) => sum + row.earnedPkn, 0) + (referredBy?.earnedPkn || 0),
    },
    referredBy,
  };
}

module.exports = {
  REWARD_PKN,
  CLAIM_WINDOW_DAYS,
  REFERRER_CAP_PER_30_DAYS,
  TREASURY_USERNAME,
  cleanCode,
  firstQualifyingOrder,
  claimReferral,
  settleReferral,
  settlePending,
  referralSummary,
};
