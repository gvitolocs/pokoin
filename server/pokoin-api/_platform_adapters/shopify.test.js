'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  API_VERSION,
  normalizeShopDomain,
  validate,
  registerWebhooks,
  removeWebhooks,
  verifyWebhook,
  parseWebhook,
  fetchSoldItems,
  listInventory,
  adjustStock,
} = require('./shopify');

// ---------------------------------------------------------------------------
// Harness: a recording fake fetch returning Response-like objects.
// ---------------------------------------------------------------------------

function jsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
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

function shopCtx(fetchFn, metadata = {}) {
  return {
    credentials: { accessToken: 'shpat_secret', apiSecretKey: 'shh_secret' },
    metadata: { shopDomain: 'test.myshopify.com', locationId: '99', ...metadata },
    fetchFn,
  };
}

const ORDER = {
  id: 4455,
  currency: 'EUR',
  processed_at: '2026-01-02T03:04:05Z',
  line_items: [
    { id: 9, variant_id: 777, sku: 'PKN-1', price: '12.50', quantity: 2 },
    { id: 10, variant_id: null, sku: 'SKIP-ME', price: '1.00', quantity: 1 },
  ],
};

const CANCELLED_ORDER = {
  id: 4456,
  currency: 'EUR',
  cancelled_at: '2026-01-03T00:00:00Z',
  created_at: '2026-01-02T00:00:00Z',
  line_items: [{ id: 11, variant_id: 778, sku: 'PKN-2', price: '5.00', quantity: 1 }],
};

// ---------------------------------------------------------------------------
// Domain normalization
// ---------------------------------------------------------------------------

test('normalizeShopDomain accepts a name, a host and an admin URL', () => {
  assert.equal(normalizeShopDomain('mystore'), 'mystore.myshopify.com');
  assert.equal(normalizeShopDomain('mystore.myshopify.com'), 'mystore.myshopify.com');
  assert.equal(
    normalizeShopDomain('https://mystore.myshopify.com/admin/api/2025-07/shop.json'),
    'mystore.myshopify.com',
  );
  assert.equal(normalizeShopDomain('  mystore-2.myshopify.com/  '), 'mystore-2.myshopify.com');
});

test('normalizeShopDomain rejects anything that is not a shop handle', () => {
  for (const bad of ['', 'Bad Shop', '-mystore', 'mystore_store', 'mystore.myshopify.com.evil.com', 'https:///admin']) {
    assert.throws(
      () => normalizeShopDomain(bad),
      (error) => error.statusCode === 400 && error.code === 'shopify_shop_invalid',
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

test('validate sends the access token and picks the first active location', async () => {
  const { fetchFn, calls } = createFetch((call) => {
    if (call.url.endsWith('/shop.json')) {
      return jsonResponse(200, { shop: { name: 'Test Shop', currency: 'EUR' } });
    }
    if (call.url.endsWith('/locations.json')) {
      return jsonResponse(200, {
        locations: [
          { id: 11, name: 'Closed', active: false },
          { id: 22, name: 'Main', active: true },
        ],
      });
    }
    throw new Error(`unexpected url ${call.url}`);
  });

  const result = await validate(
    { fetchFn },
    {
      shopDomain: 'test.myshopify.com',
      accessToken: 'shpat_secret',
      apiSecretKey: 'shh_secret',
    },
  );

  assert.equal(result.metadata.shopDomain, 'test.myshopify.com');
  assert.equal(result.metadata.shopName, 'Test Shop');
  assert.equal(result.metadata.currency, 'EUR');
  assert.equal(result.metadata.locationId, '22');
  assert.equal(result.metadata.locationName, 'Main');
  assert.deepEqual(result.credentials, { accessToken: 'shpat_secret', apiSecretKey: 'shh_secret' });
  assert.equal(calls[0].options.headers['X-Shopify-Access-Token'], 'shpat_secret');
  assert.match(calls[0].url, new RegExp(`/admin/api/${API_VERSION}/shop\\.json$`));
});

test('validate requires all three connection fields', async () => {
  await assert.rejects(
    validate({ fetchFn: async () => jsonResponse(200, {}) }, { shopDomain: 'test' }),
    (error) => error.statusCode === 400 && error.code === 'shopify_fields_required',
  );
});

test('validate reports rejected credentials without leaking the token', async () => {
  const { fetchFn } = createFetch(() => jsonResponse(401, { errors: 'Invalid API key' }));
  await assert.rejects(
    validate(
      { fetchFn },
      { shopDomain: 'test', accessToken: 'shpat_secret', apiSecretKey: 'shh_secret' },
    ),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, 'shopify_rejected');
      assert.ok(!error.message.includes('shpat_secret'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

test('verifyWebhook accepts the matching signature and rejects a tampered body', () => {
  const body = Buffer.from(JSON.stringify(ORDER));
  const secret = 'shh_secret';
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(
    verifyWebhook(body, new Headers({ 'x-shopify-hmac-sha256': good }), { apiSecretKey: secret }),
    true,
  );
  assert.equal(
    verifyWebhook(body, { 'X-Shopify-Hmac-Sha256': good }, { apiSecretKey: secret }),
    true,
  );
  assert.equal(
    verifyWebhook(Buffer.from('{"id":999}'), new Headers({ 'x-shopify-hmac-sha256': good }), {
      apiSecretKey: secret,
    }),
    false,
  );
  assert.equal(verifyWebhook(body, new Headers(), { apiSecretKey: secret }), false);
  assert.equal(
    verifyWebhook(body, new Headers({ 'x-shopify-hmac-sha256': 'c2hvcnQ=' }), { apiSecretKey: secret }),
    false,
  );
});

test('parseWebhook maps paid and cancelled orders', () => {
  const sale = parseWebhook(ORDER, new Headers({ 'x-shopify-topic': 'orders/paid' }));
  assert.equal(sale.kind, 'sale');
  assert.deepEqual(sale.items, [
    {
      orderId: '4455',
      itemId: '9',
      externalId: '777',
      sku: 'PKN-1',
      quantity: 2,
      unitPriceCents: 1250,
      currency: 'EUR',
      soldAt: '2026-01-02T03:04:05Z',
    },
  ]);

  const cancel = parseWebhook(JSON.stringify(CANCELLED_ORDER), {
    'x-shopify-topic': 'orders/cancelled',
  });
  assert.equal(cancel.kind, 'cancel');
  assert.equal(cancel.items.length, 1);
  assert.equal(cancel.items[0].externalId, '778');

  assert.deepEqual(parseWebhook(ORDER, new Headers({ 'x-shopify-topic': 'products/update' })), {
    kind: 'ignore',
    items: [],
  });
});

test('registerWebhooks registers both topics and removeWebhooks deletes them', async () => {
  const { fetchFn, calls } = createFetch((call) => (
    call.options.method === 'DELETE' ? jsonResponse(200, {}) : jsonResponse(201, { webhook: { id: 42 } })
  ));
  const ctx = shopCtx(fetchFn);

  const registered = await registerWebhooks(ctx, 'https://api.pokoin.com/api/platform-webhook/shopify/uid-1');
  assert.deepEqual(registered.ids, ['42', '42']);
  const bodies = calls.map((call) => JSON.parse(call.options.body).webhook);
  assert.deepEqual(bodies.map((webhook) => webhook.topic), ['orders/paid', 'orders/cancelled']);
  assert.ok(bodies.every((webhook) => webhook.format === 'json'));
  assert.ok(bodies.every((webhook) => webhook.address.endsWith('/uid-1')));

  const removed = await removeWebhooks(ctx, [42, '']);
  assert.equal(removed.removed, 1);
  assert.match(calls[2].url, /\/webhooks\/42\.json$/);
  assert.equal(calls[2].options.method, 'DELETE');
});

test('removeWebhooks ignores a 404', async () => {
  const { fetchFn } = createFetch(() => jsonResponse(404, {}));
  const removed = await removeWebhooks(shopCtx(fetchFn), ['99']);
  assert.equal(removed.removed, 0);
});

// ---------------------------------------------------------------------------
// Sold items
// ---------------------------------------------------------------------------

test('fetchSoldItems follows page_info links and splits cancels', async () => {
  const { fetchFn, calls } = createFetch((call, index) => (
    index === 0
      ? jsonResponse(200, [ORDER], {
        link: '</admin/api/2025-07/orders.json?page_info=abc&limit=250>; rel="next"',
      })
      : jsonResponse(200, [CANCELLED_ORDER])
  ));
  const ctx = shopCtx(fetchFn);

  const result = await fetchSoldItems(ctx, { since: '2026-01-01T00:00:00Z' });

  assert.equal(result.complete, true);
  assert.equal(calls.length, 2);
  assert.equal(result.sales.length, 1);
  assert.equal(result.cancels.length, 1);
  assert.equal(result.sales[0].orderId, '4455');
  assert.equal(result.cancels[0].orderId, '4456');
  assert.match(calls[0].url, /status=any/);
  assert.match(calls[0].url, /financial_status=paid/);
  assert.match(calls[0].url, /updated_at_min=/);
  assert.match(calls[0].url, /limit=250/);
  assert.match(calls[1].url, /page_info=abc/);
});

test('fetchSoldItems marks the read incomplete at the page cap', async () => {
  const { fetchFn, calls } = createFetch(() => jsonResponse(200, [], {
    link: '</admin/api/2025-07/orders.json?page_info=next>; rel="next"',
  }));

  const result = await fetchSoldItems(shopCtx(fetchFn), { since: '2026-01-01T00:00:00Z' });

  assert.equal(result.complete, false);
  assert.equal(calls.length, 20);
});

test('fetchSoldItems marks the read incomplete when a page fails', async () => {
  const { fetchFn } = createFetch(() => jsonResponse(500, { errors: 'boom' }));
  const result = await fetchSoldItems(shopCtx(fetchFn), { since: '2026-01-01T00:00:00Z' });
  assert.equal(result.complete, false);
  assert.deepEqual(result.sales, []);
});

// ---------------------------------------------------------------------------
// Inventory + adjust
// ---------------------------------------------------------------------------

test('listInventory pages productVariants and shapes the items', async () => {
  const page = {
    data: {
      productVariants: {
        pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
        nodes: [
          {
            legacyResourceId: '1001',
            sku: 'PKN-1',
            title: 'Variant',
            inventoryQuantity: 3,
            inventoryItem: { legacyResourceId: '2001' },
            product: { title: 'Product' },
          },
        ],
      },
    },
  };
  const last = {
    data: {
      productVariants: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    },
  };
  const { fetchFn, calls } = createFetch((call, index) => jsonResponse(200, index === 0 ? page : last));

  const result = await listInventory(shopCtx(fetchFn));

  assert.equal(result.complete, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/graphql\.json$/);
  assert.deepEqual(result.items, [
    {
      externalId: '1001',
      sku: 'PKN-1',
      title: 'Product Variant',
      quantity: 3,
      meta: { inventoryItemId: '2001' },
    },
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body).variables, { cursor: 'CUR1' });
});

test('adjustStock sends gid ids and delta, and maps userErrors to ok:false', async () => {
  const ok = createFetch(() => jsonResponse(200, {
    data: { inventoryAdjustQuantities: { userErrors: [] } },
  }));
  const result = await adjustStock(shopCtx(ok.fetchFn), {
    link: { external_id: '777', external_meta: { inventoryItemId: '555' } },
    delta: -2,
  });

  assert.deepEqual(result, { ok: true });
  const body = JSON.parse(ok.calls[0].options.body);
  assert.match(body.query, /inventoryAdjustQuantities/);
  assert.match(body.query, /gid:\/\/shopify\/InventoryItem\/555/);
  assert.match(body.query, /gid:\/\/shopify\/Location\/99/);
  assert.match(body.query, /delta: -2/);

  const failing = createFetch(() => jsonResponse(200, {
    data: {
      inventoryAdjustQuantities: { userErrors: [{ field: 'input', message: 'invalid quantity' }] },
    },
  }));
  const bad = await adjustStock(shopCtx(failing.fetchFn), {
    link: { external_id: '777', external_meta: { inventoryItemId: '555' } },
    delta: 1,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid quantity/);
});

test('adjustStock looks the inventory item up when the link has none', async () => {
  const { fetchFn, calls } = createFetch((call) => {
    if (call.url.includes('/variants/777.json')) {
      return jsonResponse(200, { variant: { inventory_item_id: 8899 } });
    }
    return jsonResponse(200, { data: { inventoryAdjustQuantities: { userErrors: [] } } });
  });

  const result = await adjustStock(shopCtx(fetchFn), {
    link: { external_id: '777', external_meta: {} },
    delta: 1,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/variants\/777\.json$/);
  assert.match(JSON.parse(calls[1].options.body).query, /InventoryItem\/8899/);
});
