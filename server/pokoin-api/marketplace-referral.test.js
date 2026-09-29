'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');
const { ambassadorProgress } = require('./_ambassador_core');

const TARGET = path.resolve(__dirname, 'marketplace-referral.js');
const DAY = 24 * 60 * 60 * 1000;

function load({ seed, decoded, createdMs = Date.now() - DAY, roster = [], contributions = [] }) {
  const { admin, firestore } = createFirestore(seed);
  admin.auth = () => ({ getUser: async () => ({ metadata: { creationTime: new Date(createdMs).toUTCString() } }) });
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function stub(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return {
        marketplaceQuery: async (sql, params) => {
          if (/marketplace_ambassador_contributions/.test(sql)) return { rows: contributions.filter((r) => r.email === params[0]) };
          return { rows: roster.filter((r) => r.email === params[0]) };
        },
      };
    }
    if (request === './_firebase') {
      return {
        verifyBearerToken: async () => {
          if (!decoded) throw Object.assign(new Error('Sign in first.'), { statusCode: 401 });
          return decoded;
        },
        getFirebaseAdmin: () => admin,
        authErrorResponse: (error) => ({ statusCode: error.statusCode || 401, body: { error: error.message } }),
      };
    }
    if (request === './_marketplace_react_card') return { setCorsHeaders: () => {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(TARGET), firestore };
  } finally {
    Module._load = originalLoad;
  }
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

const seed = () => ({
  usernames: { pokoin: { uid: 'treasury' }, peppev: { uid: 'alice' }, bob: { uid: 'bob' } },
  users: { alice: { username: 'peppev' }, bob: { username: 'bob' } },
  balances: { treasury: { availablePkn: 1000 } },
});

test('anonymous is 401; wrong method is 405', async () => {
  const { handler } = load({ seed: seed() });
  const res = response();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 401);
  const put = response();
  await handler({ method: 'PUT', headers: {} }, put);
  assert.equal(put.statusCode, 405);
});

test('claim then first purchase pays both sides on the next GET', async () => {
  const world = seed();
  const bob = load({ seed: world, decoded: { uid: 'bob', email: 'bob@example.com' } });
  const res = response();
  await bob.handler({ method: 'POST', headers: {}, body: { action: 'claim', code: 'peppev' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.claim, 'pending');
  assert.equal(res.body.referredBy.username, 'peppev');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');

  await bob.firestore.collection('orders').doc('o1').set({
    uid: 'bob', sellerUids: ['carl'], paymentStatus: 'paid', createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  const again = response();
  await bob.handler({ method: 'GET', headers: {} }, again);
  assert.equal(again.body.referredBy.status, 'rewarded');
  assert.equal(bob.firestore.dump('balances/bob').availablePkn, 20);
  assert.equal(bob.firestore.dump('balances/alice').availablePkn, 20);
});

test('old accounts cannot claim', async () => {
  const { handler } = load({ seed: seed(), decoded: { uid: 'bob' }, createdMs: Date.now() - 30 * DAY });
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { action: 'claim', code: 'peppev' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'not_new');
});

test('roster ambassador sees missions and tier', async () => {
  const { handler } = load({
    seed: seed(),
    decoded: { uid: 'alice', email: 'amb@example.com' },
    roster: [{ email: 'amb@example.com', role: 'ambassador', city: '', active: true }],
    contributions: [{ email: 'amb@example.com', mission: 'content', note: 'TikTok', link: '', verified_at: new Date() }],
  });
  const res = response();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, 'peppev');
  assert.equal(res.body.ambassador.tier, 'ambassador');
  assert.deepEqual(res.body.ambassador.completed, ['content']);
  assert.equal(res.body.ambassador.contributions[0].note, 'TikTok');
});

test('ambassador tiers: 3 missions unlock, senior needs 5 + 10 referrals, city needs roster city', () => {
  const rows = (...keys) => keys.map((mission) => ({ mission }));
  assert.equal(ambassadorProgress({ contributions: rows('content', 'feedback') }).tier, 'collector');
  assert.equal(ambassadorProgress({ contributions: rows('content', 'feedback') }).next.missionsLeft, 1);
  assert.equal(ambassadorProgress({ activatedReferrals: 3, contributions: rows('content', 'feedback') }).tier, 'ambassador');
  assert.equal(ambassadorProgress({ contributions: rows('content', 'content', 'feedback', 'nope') }).completed.length, 2);
  const five = rows('content', 'feedback', 'bug_report', 'seller_onboard');
  assert.equal(ambassadorProgress({ activatedReferrals: 9, contributions: five }).tier, 'ambassador');
  assert.equal(ambassadorProgress({ activatedReferrals: 10, contributions: five }).tier, 'senior');
  assert.equal(ambassadorProgress({ roster: { role: 'ambassador', city: 'Milano' } }).tier, 'city');
  assert.equal(ambassadorProgress({ roster: { role: 'distributor', city: 'Milano' } }).tier, 'collector');
  assert.equal(ambassadorProgress({ roster: { role: 'ambassador', city: 'Roma', active: false } }).tier, 'collector');
  const founder = ambassadorProgress({ roster: { role: 'founder_ambassador', city: '' } });
  assert.deepEqual([founder.tier, founder.founder, founder.onRoster], ['ambassador', true, true]);
  assert.equal(ambassadorProgress({ roster: { role: 'ambassador' } }).founder, false);
  assert.equal(ambassadorProgress({ roster: { role: 'founder_ambassador', city: 'Napoli' } }).tier, 'city');
});
