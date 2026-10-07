'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _resetTokenCache,
  validate,
  fetchSoldItems,
  listInventory,
  adjustStock,
} = require('./tcgplayer');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ENV = { TCGPLAYER_PUBLIC_KEY: 'pub-key', TCGPLAYER_PRIVATE_KEY: 'priv-key' };

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function createFetch(handler) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const record = { url: String(url), options: options || {} };
    calls.push(record);
    return handler(record, calls.length - 1);
  };
  return { fetchFn, calls };
}

function storeCtx(fetchFn, metadata = { storeKey: '777' }) {
  return {
    credentials: { accessToken: 'STORE-TOKEN' },
    metadata,
    env: ENV,
    fetchFn,
  };
}

// ---------------------------------------------------------------------------
// Bearer + connect
// ---------------------------------------------------------------------------

test('validate caches the bearer and sends the store access token', async () => {
  _resetTokenCache();
  const { fetchFn, calls } = createFetch((call) => {
    if (call.url.endsWith('/token')) return jsonResponse(200, { access_token: 'BEARER', expires_in: 3600 });
    if (call.url.includes('/app/authorize/')) return jsonResponse(200, { accessToken: 'STORE-TOKEN' });
    if (call.url.endsWith('/stores/self')) {
      return jsonResponse(200, { results: [{ storeKey: 777, name: 'My Store' }] });
    }
    throw new Error(`unexpected url ${call.url}`);
  });

  const ctx = { fetchFn, env: ENV };
  const first = await validate(ctx, { authCode: 'code-1' });
  assert.deepEqual(first, {
    credentials: { accessToken: 'STORE-TOKEN' },
    metadata: { storeKey: '777', storeName: 'My Store' },
  });

  const tokenCalls = () => calls.filter((call) => call.url.endsWith('/token')).length;
  assert.equal(tokenCalls(), 1);
  const storeCall = calls.find((call) => call.url.endsWith('/stores/self'));
  assert.equal(storeCall.options.headers.Authorization, 'bearer BEARER');
  assert.equal(storeCall.options.headers['X-Tcg-Access-Token'], 'STORE-TOKEN');
  const tokenCall = calls[0];
  assert.equal(tokenCall.options.method, 'POST');
  assert.match(tokenCall.options.headers['Content-Type'], /x-www-form-urlencoded/);
  assert.match(tokenCall.options.body, /grant_type=client_credentials/);
  assert.match(tokenCall.options.body, /client_id=pub-key/);

  await validate(ctx, { authCode: 'code-2' });
  assert.equal(tokenCalls(), 1, 'the second connect must reuse the cached bearer');
});

test('missing TCGplayer keys is 503 platform_unavailable', async () => {
  _resetTokenCache();
  await assert.rejects(
    validate({ env: {}, fetchFn: async () => jsonResponse(200, {}) }, { authCode: 'code' }),
    (error) => error.statusCode === 503 && error.code === 'platform_unavailable',
  );
});

test('validate requires the store authorization code', async () => {
  _resetTokenCache();
  await assert.rejects(
    validate({ env: ENV, fetchFn: async () => jsonResponse(200, {}) }, {}),
    (error) => error.statusCode === 400 && error.code === 'tcgplayer_auth_code_required',
  );
});

// ---------------------------------------------------------------------------
// Sold items
// ---------------------------------------------------------------------------

test('fetchSoldItems stops at since and shapes the items', async () => {
  _resetTokenCache();
  const { fetchFn, calls } = createFetch((call) => {
    if (call.url.endsWith('/token')) return jsonResponse(200, { access_token: 'B', expires_in: 3600 });
    if (call.url.includes('/orders?')) {
      return jsonResponse(200, {
        results: [
          { orderNumber: 'A1', orderDate: '2026-02-05T00:00:00Z', status: 'Completed' },
          { orderNumber: 'A0', orderDate: '2026-01-01T00:00:00Z', status: 'Completed' },
        ],
      });
    }
    if (call.url.includes('/orders/A1/items')) {
      return jsonResponse(200, { results: [{ skuId: 5, quantity: 2, price: 1.5 }] });
    }
    throw new Error(`unexpected url ${call.url}`);
  });

  const result = await fetchSoldItems(storeCtx(fetchFn), { since: '2026-02-01T00:00:00Z' });

  assert.equal(result.complete, true);
  assert.equal(result.sales.length, 1);
  assert.deepEqual(result.sales[0], {
    orderId: 'A1',
    itemId: '5',
    externalId: '5',
    quantity: 2,
    unitPriceCents: 150,
    currency: 'USD',
    soldAt: '2026-02-05T00:00:00Z',
  });
  assert.ok(!calls.some((call) => call.url.includes('/orders/A0/items')), 'older orders are never read');
  assert.match(
    calls.find((call) => call.url.includes('/orders?')).url,
    /\/stores\/777\/orders\?limit=100&offset=0&sort=OrderDate%20Desc$/,
  );
});

test('fetchSoldItems routes a Cancelled order to cancels', async () => {
  _resetTokenCache();
  const { fetchFn } = createFetch((call) => {
    if (call.url.endsWith('/token')) return jsonResponse(200, { access_token: 'B', expires_in: 3600 });
    if (call.url.includes('/orders?')) {
      return jsonResponse(200, { results: [{ orderNumber: 'C1', orderDate: '2026-02-05T00:00:00Z', status: { name: 'Cancelled' } }] });
    }
    if (call.url.includes('/orders/C1/items')) {
      return jsonResponse(200, { results: [{ skuId: 6, quantity: 1, price: 2 }] });
    }
    throw new Error(`unexpected url ${call.url}`);
  });

  const result = await fetchSoldItems(storeCtx(fetchFn), { since: '2026-02-01T00:00:00Z' });
  assert.equal(result.complete, true);
  assert.deepEqual(result.sales, []);
  assert.equal(result.cancels.length, 1);
  assert.equal(result.cancels[0].orderId, 'C1');
});

test('fetchSoldItems marks the read incomplete when a page fails', async () => {
  _resetTokenCache();
  const { fetchFn } = createFetch((call) => {
    if (call.url.endsWith('/token')) return jsonResponse(200, { access_token: 'B', expires_in: 3600 });
    return jsonResponse(500, { errors: [{ message: 'boom' }] });
  });
  const result = await fetchSoldItems(storeCtx(fetchFn), { since: '2026-02-01T00:00:00Z' });
  assert.equal(result.complete, false);
});

// ---------------------------------------------------------------------------
// Inventory + adjust
// ---------------------------------------------------------------------------

test('listInventory shapes each SKU of every product', async () => {
  _resetTokenCache();
  const { fetchFn, calls } = createFetch((call) => {
    if (call.url.endsWith('/token')) return jsonResponse(200, { access_token: 'B', expires_in: 3600 });
    return jsonResponse(200, {
      results: [{
        productId: 10,
        name: 'Pikachu',
        group: { name: 'Base Set' },
        skus: [
          { skuId: 5, condition: { name: 'Near Mint' }, language: { name: 'English' }, printing: { name: 'Foil' }, quantity: 3, price: 1.25 },
          { skuId: 6, condition: 'Lightly Played', language: 'Japanese', printing: 'Normal', quantity: 1, price: 2 },
        ],
      }],
    });
  });

  const result = await listInventory(storeCtx(fetchFn));

  assert.equal(result.complete, true);
  assert.equal(calls[1].url, 'https://api.tcgplayer.com/stores/777/inventory/products?limit=100&offset=0');
  assert.deepEqual(result.items[0], {
    externalId: '5',
    sku: '5',
    name: 'Pikachu',
    setName: 'Base Set',
    collectorNumber: '',
    condition: 'Near Mint',
    language: 'English',
    foil: true,
    quantity: 3,
    priceCents: 125,
    currency: 'USD',
    meta: { productId: '10' },
  });
  assert.equal(result.items[1].foil, false);
  assert.equal(result.items[1].condition, 'Lightly Played');
  assert.equal(result.items[1].language, 'Japanese');
});

test('adjustStock posts the relative delta and maps success:false', async () => {
  _resetTokenCache();
  const ctx = storeCtx(async (url) => {
    if (url.endsWith('/token')) return jsonResponse(200, { access_token: 'B', expires_in: 3600 });
    return jsonResponse(200, { success: true });
  });

  const result = await adjustStock(ctx, { link: { external_id: 'sku-9' }, delta: -1 });
  assert.deepEqual(result, { ok: true });

  const failing = createFetch((call) => {
    if (call.url.endsWith('/token')) return jsonResponse(200, { access_token: 'B', expires_in: 3600 });
    return jsonResponse(200, { success: false, errors: [{ message: 'not enough stock' }] });
  });
  const bad = await adjustStock(storeCtx(failing.fetchFn), { link: { external_id: 'sku-9' }, delta: -2 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not enough stock/);

  const post = failing.calls.find((call) => call.url.includes('/inventory/skus/sku-9/quantity'));
  assert.ok(post);
  assert.equal(post.options.method, 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { quantity: -2 });
  assert.match(post.url, /\/stores\/777\/inventory\/skus\/sku-9\/quantity$/);
});
