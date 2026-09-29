'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');

const TARGET = path.resolve(__dirname, 'unlock-silver.js');

function load(seed, uid = 'buyer') {
  const { admin, firestore } = createFirestore(seed);
  admin.firestore.Timestamp = { fromDate: (date) => date };
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function stub(request, parent, isMain) {
    if (request === '../server/_firebase') {
      return { getFirebaseAdmin: () => admin, verifyBearerToken: async () => ({ uid, email: `${uid}@example.com` }) };
    }
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
    setHeader(name, value) { this.headers[name] = value; },
  };
}

const seed = (pkn) => ({
  usernames: { pokoin: { uid: 'treasury' } },
  users: { buyer: {} },
  balances: { buyer: { availablePkn: pkn }, treasury: { availablePkn: 0 } },
});

test('Silver costs 100 PKN, paid to the treasury', async () => {
  const { handler, firestore } = load(seed(150));
  assert.equal(handler.SILVER_PRICE_PKN, 100);
  const res = response();
  await handler({ method: 'POST', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pricePkn, 100);
  assert.equal(res.body.availablePkn, 50);
  assert.equal(firestore.dump('balances/buyer').availablePkn, 50);
  assert.equal(firestore.dump('balances/treasury').availablePkn, 100);
  assert.equal(firestore.dump('users/buyer').role, 'silver');
  const ledger = firestore.all('ledger_entries');
  assert.equal(ledger.reduce((sum, row) => sum + row.amountPkn, 0), 0);
});

test('a balance below 100 PKN is refused and nothing moves', async () => {
  const { handler, firestore } = load(seed(99));
  const res = response();
  await handler({ method: 'POST', headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(firestore.dump('balances/buyer').availablePkn, 99);
  assert.equal(firestore.all('ledger_entries').length, 0);
});
