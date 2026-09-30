'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'marketplace-event.js');

function loadHandler({ read, write }) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') return { marketplaceQuery: read, marketplaceWriteQuery: write };
    if (request === './_marketplace_image_log') return { recordMarketplaceImage: () => {} };
    if (request === './_firebase') return { verifyBearerToken: async () => ({ uid: 'user-1' }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
  }
}

function response() {
  const res = {
    statusCode: 0,
    ended: false,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
  return res;
}

test('events are written to the writer, never the read replica', async () => {
  const writes = [];
  const handler = loadHandler({
    read: async () => { throw Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' }); },
    write: async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; },
  });
  const res = response();
  await handler({
    method: 'POST',
    headers: {},
    body: { cardId: 249662, eventType: 'search', metadata: { query: 'aron', language: 'en', bogus: 'x' } },
  }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /insert into public\.marketplace_card_events/);
  assert.equal(writes[0].params[0], 249662);
  assert.equal(JSON.parse(writes[0].params[3]).bogus, undefined);
  assert.match(writes[1].sql, /record_marketplace_query_chunks/);
});

test('the beacon answers 204 before the database write finishes', async () => {
  let release;
  const handler = loadHandler({
    read: async () => ({ rows: [] }),
    write: () => new Promise((resolve) => { release = resolve; }),
  });
  const res = response();
  const pending = handler({ method: 'POST', headers: {}, body: { cardId: 1, eventType: 'view' } }, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  release({ rows: [] });
  await pending;
});

test('a writer outage is swallowed and does not change the answer', async () => {
  const handler = loadHandler({
    read: async () => ({ rows: [] }),
    write: async () => { throw new Error('connect ETIMEDOUT'); },
  });
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { cardId: 1, eventType: 'view' } }, res);
  assert.equal(res.statusCode, 204);
});

test('bad input and wrong method', async () => {
  const handler = loadHandler({ read: async () => ({}), write: async () => ({}) });
  const bad = response();
  await handler({ method: 'POST', headers: {}, body: { cardId: -1, eventType: 'view' } }, bad);
  assert.equal(bad.statusCode, 400);
  const get = response();
  await handler({ method: 'GET', headers: {}, body: {} }, get);
  assert.equal(get.statusCode, 405);
});
