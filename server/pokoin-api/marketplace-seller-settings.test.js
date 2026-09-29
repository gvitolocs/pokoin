'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');

const TARGET = path.resolve(__dirname, 'marketplace-seller-settings.js');

function load(seed, uid = 'marco') {
  const { admin, firestore } = createFirestore(seed);
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function stub(request, parent, isMain) {
    if (String(request).endsWith('_firebase')) {
      return { getFirebaseAdmin: () => admin, verifyBearerToken: async () => ({ uid }) };
    }
    if (request === './_marketplace_db') return { marketplaceWriteQuery: async () => ({ rowCount: 0 }) };
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
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  };
}

const seed = () => ({ users: { marco: { username: 'marco', shipFromCountry: 'IT', shipFromCountrySource: 'user' }, anna: { username: 'anna' } } });

test('a seller opts out of PKN payments and back in', async () => {
  const { handler, firestore } = load(seed());
  const get = response();
  await handler({ method: 'GET', headers: {}, url: '/api/marketplace-seller-settings' }, get);
  assert.equal(get.body.acceptsPkn, true);

  const off = response();
  await handler({ method: 'POST', headers: {}, body: { acceptsPkn: false } }, off);
  assert.equal(off.statusCode, 200);
  assert.equal(off.body.acceptsPkn, false);
  assert.equal(off.body.shipFromCountry, 'IT');
  assert.equal(firestore.dump('users/marco').acceptsPkn, false);

  const ignored = response();
  await handler({ method: 'POST', headers: {}, body: { acceptsPkn: 'no' } }, ignored);
  assert.equal(ignored.body.acceptsPkn, false);

  const on = response();
  await handler({ method: 'POST', headers: {}, body: { acceptsPkn: true } }, on);
  assert.equal(on.body.acceptsPkn, true);
});

test('checkout asks which cart sellers take card payments only', async () => {
  const world = seed();
  world.users.marco.acceptsPkn = false;
  const { handler } = load(world, 'buyer');
  const res = response();
  await handler({ method: 'GET', headers: {}, url: '/api/marketplace-seller-settings?sellers=marco,anna' }, res);
  assert.deepEqual(res.body, { pknRefused: [{ uid: 'marco', name: 'marco' }] });
});
