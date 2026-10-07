'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');

const { createFirestore } = require('./_firestore_fake');
const providers = require('./_platform_providers');
const integrations = require('./_platform_integration');
const shopify = require('./_platform_adapters/shopify');
const { createHandler } = require('./platform-webhook')._test;
const { pollAllIntegrations } = require('./platform-sync-poll-all');

function response() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const ORDER = {
  id: 5001,
  currency: 'EUR',
  processed_at: '2026-10-07T09:00:00Z',
  line_items: [
    { id: 71, variant_id: 901, sku: 'abc', quantity: 1, price: '12.50' },
    { id: 72, variant_id: 902, sku: 'def', quantity: 2, price: '3.00' },
  ],
};

async function harness() {
  const { firestore } = createFirestore();
  await integrations.storeIntegration({
    firestore,
    uid: 'seller-1',
    provider: 'shopify',
    secrets: { accessToken: 'tok', apiSecretKey: 'whsec' },
    metadata: { shopDomain: 'demo.myshopify.com', locationId: '9' },
  });
  const calls = { sale: [], cancel: [] };
  const handler = createHandler({
    getFirebaseAdmin: () => ({ firestore: () => firestore }),
    providers,
    integrations,
    getAdapter: () => shopify,
    rawBodyBuffer: async (req) => req.raw,
    applyExternalSale: async (args) => { calls.sale.push(args); return { ok: true, applied: true }; },
    applyExternalCancel: async (args) => { calls.cancel.push(args); return { ok: true, applied: true }; },
  });
  async function deliver({ topic = 'orders/paid', body = ORDER, secret = 'whsec', uid = 'seller-1', tamper = false } = {}) {
    const raw = Buffer.from(JSON.stringify(body));
    const hmac = crypto.createHmac('sha256', secret).update(raw).digest('base64');
    const res = response();
    await handler({
      method: 'POST',
      params: { provider: 'shopify', uid },
      headers: { 'x-shopify-hmac-sha256': hmac, 'x-shopify-topic': topic },
      raw: tamper ? Buffer.from(JSON.stringify({ ...body, id: 9999 })) : raw,
    }, res);
    return res;
  }
  return { firestore, calls, deliver };
}

test('a bad signature is 401 and applies nothing', async () => {
  const h = await harness();
  assert.equal((await h.deliver({ secret: 'wrong' })).statusCode, 401);
  assert.equal((await h.deliver({ tamper: true })).statusCode, 401);
  assert.equal(h.calls.sale.length, 0);
});

test('orders/paid applies one external sale per line item for that seller', async () => {
  const h = await harness();
  const res = await h.deliver();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.applied, 2);
  assert.deepEqual(h.calls.sale.map((row) => [row.provider, row.sellerUid, row.orderId, row.itemId, row.externalId, row.quantity]), [
    ['shopify', 'seller-1', '5001', '71', '901', 1],
    ['shopify', 'seller-1', '5001', '72', '902', 2],
  ]);
  assert.equal(h.calls.sale[0].unitPriceCents, 1250);
});

test('orders/cancelled restores through applyExternalCancel; other topics are ignored', async () => {
  const h = await harness();
  const cancelled = await h.deliver({ topic: 'orders/cancelled' });
  assert.equal(cancelled.body.kind, 'cancel');
  assert.equal(h.calls.cancel.length, 2);
  const ignored = await h.deliver({ topic: 'products/update' });
  assert.equal(ignored.statusCode, 200);
  assert.equal(ignored.body.kind, 'ignore');
  assert.equal(h.calls.sale.length, 0);
});

test('a seller that is not connected is 404', async () => {
  const h = await harness();
  assert.equal((await h.deliver({ uid: 'someone-else' })).statusCode, 404);
});

test('one failing item does not stop the others and still answers 200', async () => {
  const h = await harness();
  let first = true;
  const handler = createHandler({
    getFirebaseAdmin: () => ({ firestore: () => h.firestore }),
    providers,
    integrations,
    getAdapter: () => shopify,
    rawBodyBuffer: async (req) => req.raw,
    applyExternalSale: async () => {
      if (first) { first = false; throw new Error('db down'); }
      return { ok: true, applied: true };
    },
  });
  const raw = Buffer.from(JSON.stringify(ORDER));
  const res = response();
  await handler({
    method: 'POST',
    params: { provider: 'shopify', uid: 'seller-1' },
    headers: {
      'x-shopify-hmac-sha256': crypto.createHmac('sha256', 'whsec').update(raw).digest('base64'),
      'x-shopify-topic': 'orders/paid',
    },
    raw,
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.applied, 1);
});

test('poll-all polls connected integrations, skips pending ones and isolates failures', async () => {
  const polled = [];
  const result = await pollAllIntegrations({
    firestore: {},
    deps: {
      integrations: {
        listEnabledIntegrations: async () => [
          { uid: 'a', provider: 'cardmarket', state: 'connected' },
          { uid: 'b', provider: 'tcgplayer', state: 'connected' },
          { uid: 'c', provider: 'sortswift', state: 'pending_activation' },
        ],
      },
      pollProvider: async ({ provider, sellerUid }) => {
        polled.push(`${sellerUid}:${provider}`);
        if (provider === 'tcgplayer') throw new Error('TCGplayer down');
        return { ok: true, complete: true, applied: 3 };
      },
    },
  });
  assert.deepEqual(polled, ['a:cardmarket', 'b:tcgplayer']);
  assert.equal(result.failed, 1);
  assert.equal(result.allFailed, false);
  assert.equal(result.results.find((row) => row.uid === 'c').reason, 'pending_activation');
  assert.equal(result.results.find((row) => row.uid === 'a').applied, 3);
});
