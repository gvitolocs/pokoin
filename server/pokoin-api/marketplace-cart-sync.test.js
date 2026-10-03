'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.resolve(__dirname, 'marketplace-cart-sync.js');

function loadHandler(stubs) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request) {
    if (request === './_marketplace_db') {
      return { marketplaceQuery: stubs.read, marketplaceWriteQuery: stubs.write };
    }
    if (request === './_firebase') {
      return {
        verifyBearerToken: stubs.verify,
        authErrorResponse: (error) => ({ statusCode: error.statusCode || 401, body: { error: error.message } }),
      };
    }
    if (request === './_marketplace_game') {
      return { runWithGame: async (_game, fn) => fn() };
    }
    if (request === './_marketplace_react_card') {
      return { setCorsHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*') };
    }
    if (request === './_rate_limit') {
      return { limitBestEffort: async () => stubs.limit || { allowed: true } };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
    delete require.cache[TARGET];
  }
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

const cartRow = { items: [{ id: 'l1', cardId: '598056', name: 'Medicham ex', qty: 1, pricePkn: 400 }], saved: [], gift: false, rev: 2, updated_at: null };

test('preflight answers PUT with Authorization', async () => {
  const handler = loadHandler({});
  const res = mockRes();
  await handler({ method: 'OPTIONS', headers: {} }, res);
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['Access-Control-Allow-Methods'], /PUT/);
  assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('no token is 401 and never cached', async () => {
  const handler = loadHandler({
    verify: async () => { throw Object.assign(new Error('Missing Pokoin bearer token.'), { statusCode: 401 }); },
  });
  const res = mockRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('GET returns the account cart', async () => {
  const handler = loadHandler({
    verify: async () => ({ uid: 'u1' }),
    read: async (sql, values) => {
      assert.deepEqual(values, ['u1']);
      return { rows: [cartRow] };
    },
  });
  const res = mockRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rev, 2);
  assert.equal(res.body.items[0].cardId, '598056');
});

test('PUT saves against baseRev and returns the new revision', async () => {
  const handler = loadHandler({
    verify: async () => ({ uid: 'u1' }),
    write: async (sql, values) => {
      assert.equal(values[0], 'u1');
      assert.equal(values[5], 2);
      return { rows: [{ ...cartRow, rev: 3 }] };
    },
  });
  const res = mockRes();
  await handler({ method: 'PUT', headers: { authorization: 'Bearer t' }, body: { items: cartRow.items, baseRev: 2 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rev, 3);
});

test('PUT from a stale revision is 409 with the current cart', async () => {
  let call = 0;
  const handler = loadHandler({
    verify: async () => ({ uid: 'u1' }),
    write: async () => {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [{ ...cartRow, rev: 7 }] };
    },
  });
  const res = mockRes();
  await handler({ method: 'PUT', headers: { authorization: 'Bearer t' }, body: { items: [], baseRev: 1 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'CART_REV');
  assert.equal(res.body.cart.rev, 7);
});

test('a runaway save loop is throttled', async () => {
  const handler = loadHandler({
    verify: async () => ({ uid: 'u1' }),
    limit: { allowed: false, retryAfterSec: 30 },
  });
  const res = mockRes();
  await handler({ method: 'PUT', headers: { authorization: 'Bearer t' }, body: {} }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '30');
});

test('other methods are 405', async () => {
  const handler = loadHandler({});
  const res = mockRes();
  await handler({ method: 'DELETE', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
