'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');
const core = require('./_referral_core');

const NOW = Date.parse('2026-09-29T16:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function world(extra = {}) {
  return createFirestore({
    usernames: { pokoin: { uid: 'treasury' }, peppev: { uid: 'alice' }, bob: { uid: 'bob' }, carl: { uid: 'carl' } },
    users: { alice: { username: 'peppev' }, bob: { username: 'bob' }, carl: { username: 'carl' } },
    balances: { treasury: { availablePkn: 1000 }, alice: { availablePkn: 5 } },
    ...extra,
  });
}

const claim = (firestore, admin, uid, code, createdMs = NOW - DAY) => core.claimReferral({
  firestore, FieldValue: admin.firestore.FieldValue, uid, code, accountCreatedMs: createdMs, nowMs: NOW,
});
const settle = (firestore, admin, uid, nowMs = NOW + DAY) => core.settleReferral({
  firestore, FieldValue: admin.firestore.FieldValue, referredUid: uid, nowMs,
});

test('invite → first purchase pays both sides 20 PKN from the treasury, once', async () => {
  const { firestore, admin } = world();
  assert.deepEqual(await claim(firestore, admin, 'bob', '@PeppeV'), { status: 'pending', referrerUid: 'alice' });
  assert.equal((await settle(firestore, admin, 'bob')).status, 'waiting');

  await firestore.collection('orders').doc('o1').set({
    uid: 'bob', sellerUids: ['carl'], paymentStatus: 'escrow', createdAt: new Date(NOW + 2 * 3600e3).toISOString(),
  });
  const paid = await settle(firestore, admin, 'bob');
  assert.equal(paid.status, 'rewarded');
  assert.equal(paid.kind, 'purchase');
  assert.equal(firestore.dump('balances/bob').availablePkn, 20);
  assert.equal(firestore.dump('balances/alice').availablePkn, 25);
  assert.equal(firestore.dump('balances/treasury').availablePkn, 960);
  const ledger = firestore.all('ledger_entries');
  assert.equal(ledger.length, 4);
  assert.equal(ledger.reduce((sum, row) => sum + row.amountPkn, 0), 0);
  assert.equal(firestore.dump('referrals/bob').status, 'rewarded');

  assert.equal((await settle(firestore, admin, 'bob')).status, 'not_pending');
  assert.equal(firestore.all('ledger_entries').length, 4);
});

test('a first sale qualifies too', async () => {
  const { firestore, admin } = world();
  await claim(firestore, admin, 'bob', 'peppev');
  await firestore.collection('orders').doc('s1').set({
    uid: 'carl', sellerUids: ['bob'], paymentStatus: 'released', createdAt: new Date(NOW + 3600e3).toISOString(),
  });
  const paid = await settle(firestore, admin, 'bob');
  assert.equal(paid.kind, 'sale');
});

test('guardrails: bad code, self, old account, existing customer, circular, counterparty order', async () => {
  const { firestore, admin } = world({
    orders: { old: { uid: 'carl', sellerUids: ['x'], paymentStatus: 'paid', createdAt: new Date(NOW - DAY).toISOString() } },
  });
  await assert.rejects(claim(firestore, admin, 'bob', 'no such!'), { code: 'invalid_code' });
  await assert.rejects(claim(firestore, admin, 'bob', 'nobodyhere'), { code: 'invalid_code' });
  await assert.rejects(claim(firestore, admin, 'alice', 'peppev'), { code: 'self_referral' });
  await assert.rejects(claim(firestore, admin, 'bob', 'peppev', NOW - 20 * DAY), { code: 'not_new' });
  await assert.rejects(claim(firestore, admin, 'carl', 'peppev'), { code: 'not_new' });

  await claim(firestore, admin, 'bob', 'peppev');
  assert.equal((await claim(firestore, admin, 'bob', 'carl')).status, 'already_claimed');
  await firestore.collection('referrals').doc('alice').set({ referrerUid: 'bob', status: 'pending' });
  const fresh = createFirestore({ usernames: { bob: { uid: 'bob' } }, referrals: { bob: { referrerUid: 'alice', status: 'pending' } } });
  await assert.rejects(core.claimReferral({
    firestore: fresh.firestore, FieldValue: fresh.admin.firestore.FieldValue, uid: 'alice', code: 'bob', accountCreatedMs: NOW, nowMs: NOW,
  }), { code: 'circular' });

  // An order between inviter and invited does not qualify.
  await firestore.collection('orders').doc('self-deal').set({
    uid: 'bob', sellerUids: ['alice'], paymentStatus: 'paid', createdAt: new Date(NOW + 3600e3).toISOString(),
  });
  assert.equal((await settle(firestore, admin, 'bob')).status, 'waiting');
  // Unpaid orders do not qualify either.
  await firestore.collection('orders').doc('unpaid').set({
    uid: 'bob', sellerUids: ['carl'], paymentStatus: 'pending_stripe', createdAt: new Date(NOW + 3600e3).toISOString(),
  });
  assert.equal((await settle(firestore, admin, 'bob')).status, 'waiting');
});

test('treasury too low leaves the referral pending; cap drops only the inviter side', async () => {
  const low = world({ balances: { treasury: { availablePkn: 30 } } });
  await claim(low.firestore, low.admin, 'bob', 'peppev');
  await low.firestore.collection('orders').doc('o').set({ uid: 'bob', sellerUids: ['carl'], paymentStatus: 'paid', createdAt: new Date(NOW + 1).toISOString() });
  assert.equal((await settle(low.firestore, low.admin, 'bob')).status, 'treasury_low');
  assert.equal(low.firestore.dump('referrals/bob').status, 'pending');

  const rewarded = {};
  for (let i = 0; i < core.REFERRER_CAP_PER_30_DAYS; i += 1) {
    rewarded[`r${i}`] = { referrerUid: 'alice', status: 'rewarded', referrerRewardPkn: 20, rewardedAtMs: NOW - DAY };
  }
  const capped = world({ referrals: rewarded });
  await claim(capped.firestore, capped.admin, 'bob', 'peppev');
  await capped.firestore.collection('orders').doc('o').set({ uid: 'bob', sellerUids: ['carl'], paymentStatus: 'paid', createdAt: new Date(NOW + 1).toISOString() });
  const paid = await settle(capped.firestore, capped.admin, 'bob');
  assert.deepEqual([paid.referredPkn, paid.referrerPkn], [20, 0]);
  assert.equal(capped.firestore.dump('balances/alice').availablePkn, 5);
});

test('settlePending pays qualified referrals and the summary shows them', async () => {
  const { firestore, admin } = world();
  await claim(firestore, admin, 'bob', 'peppev');
  await claim(firestore, admin, 'carl', 'peppev');
  await firestore.collection('orders').doc('o').set({ uid: 'bob', sellerUids: ['zed'], paymentStatus: 'paid', createdAt: new Date(NOW + 1).toISOString() });
  const counts = await core.settlePending({ firestore, FieldValue: admin.firestore.FieldValue, nowMs: NOW + DAY });
  assert.deepEqual(counts, { checked: 2, rewarded: 1, waiting: 1, treasuryLow: 0, failed: 0 });

  const summary = await core.referralSummary({ firestore, uid: 'alice' });
  assert.equal(summary.code, 'peppev');
  assert.deepEqual(summary.stats, { invited: 2, pending: 1, activated: 1, earnedPkn: 20 });
  assert.deepEqual(summary.invited.map((row) => [row.username, row.status]).sort(), [['bob', 'rewarded'], ['carl', 'pending']]);
  const bobView = await core.referralSummary({ firestore, uid: 'bob' });
  assert.deepEqual(bobView.referredBy, { username: 'peppev', status: 'rewarded', earnedPkn: 20 });
});
