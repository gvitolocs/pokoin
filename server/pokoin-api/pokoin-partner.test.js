'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const handler = require('./pokoin-partner.js');

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('directory lists placeholder partner stores', async () => {
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/pokoin-partner?action=directory', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.stores.length >= 3);
  assert.equal(res.body.stores[0].status, 'placeholder');
});

test('contract documents partner app QR and actions', async () => {
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/pokoin-partner?action=contract', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.partnerApp, 'pokoin-partner');
  assert.ok(res.body.qr.buyerPickup.type.includes('handoff'));
  assert.ok(res.body.actions.some((row) => row.action === 'intake'));
});

test('mutating partner actions are coming_soon', async () => {
  for (const action of ['intake', 'bag', 'receive-hub', 'handoff']) {
    const res = mockRes();
    await handler({
      method: 'POST',
      url: `/api/pokoin-partner?action=${action}`,
      headers: {},
      body: { storeId: 'milan-ace' },
    }, res);
    assert.equal(res.statusCode, 501, action);
    assert.equal(res.body.code, 'coming_soon', action);
  }
});
