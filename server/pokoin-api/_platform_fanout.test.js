'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFirestore } = require('./_firestore_fake');

const {
  SALES_COLLECTION,
  saleDocId,
  normalizeSoldItem,
  fanOutStockChange,
  applyExternalSale,
  applyExternalCancel,
  pollProvider,
} = require('./_platform_fanout');

// ---------------------------------------------------------------------------
// Harness: an in-memory Postgres + Firestore + adapter double.
// ---------------------------------------------------------------------------

function eventKey(row) {
  return [row.sellerUid, row.provider, row.orderId, row.itemId, row.kind].join('|');
}

function createHarness({
  listing = null,
  links = [],
  linksByExternal = [],
  saleEvents = [],
  adapters = {},
  adjustCardTrader = null,
  fetchSoldItems = null,
  integration = null,
} = {}) {
  const state = {
    listing: listing ? { ...listing } : null,
    eventRows: new Map(),
    sql: [],
    marked: [],
    fanoutCalls: [],
    refreshed: [],
    invalidated: [],
    lastPolledAt: null,
    sawPlatformSyncSetting: false,
    linkReadQuery: null,
    findLinkQuery: null,
    findEventQuery: null,
    cardTraderCalls: [],
  };

  function exec(sql, params) {
    const text = String(sql);
    state.sql.push({ sql: text, params });
    if (text.includes("set_config('pokoin.platform_sync'")) state.sawPlatformSyncSetting = true;
    if (/select source_listing_id/.test(text)) {
      const row = state.listing;
      return row
        ? { rows: [{ source_listing_id: row.source_listing_id }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/update public\.marketplace_user_listings/.test(text)) {
      const [, id, qty, sellerUid] = params;
      const row = state.listing;
      const decrement = /quantity_available - \$3/.test(text);
      if (!row || String(row.id) !== String(id) || row.seller_uid !== sellerUid) {
        return { rows: [], rowCount: 0 };
      }
      if (decrement) {
        const status = String(row.status).toLowerCase();
        if (row.quantity_available < qty || !['active', 'paused'].includes(status)) {
          return { rows: [], rowCount: 0 };
        }
        row.quantity_available -= qty;
        if (row.quantity_available <= 0) row.status = 'sold_out';
      } else {
        row.quantity_available += qty;
        if (String(row.status).toLowerCase() === 'sold_out') row.status = 'active';
      }
      return { rows: [{ ...row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  const firestore = createFirestore().firestore;
  for (const row of saleEvents) {
    const stored = { kind: 'sale', ...row, listing_id: row.listing_id || row.listingId || '' };
    state.eventRows.set(eventKey(stored), stored);
  }

  const linksModule = {
    async linksForListing(_listingId, query) {
      state.linkReadQuery = query;
      return links;
    },
    async findLinkByExternal({ provider, externalId }, query) {
      state.findLinkQuery = query;
      return linksByExternal.find(
        (row) => row.provider === provider
          && (row.external_id === externalId || row.sku === externalId),
      ) || null;
    },
    async findEvent(row, query) {
      state.findEventQuery = query;
      return state.eventRows.get(eventKey(row)) || null;
    },
    async claimEvent(row) {
      const key = eventKey(row);
      if (state.eventRows.has(key)) return false;
      state.eventRows.set(key, { ...row });
      return true;
    },
    async releaseEvent(row) {
      state.eventRows.delete(eventKey(row));
    },
    async markPushed(row) {
      state.marked.push({ ...row });
    },
  };

  const integrations = {
    async readIntegration() {
      if (!integration) return { exists: false, data: () => undefined };
      return { exists: true, data: () => ({ ...integration }) };
    },
    async decryptSecrets() {
      return { token: 'decrypted-token' };
    },
    async patchIntegration(_firestore, _uid, _provider, patch) {
      state.lastPolledAt = patch.lastPolledAt;
    },
  };

  const deps = {
    links: linksModule,
    integrations,
    getAdapter: (provider) => adapters[provider] || null,
    withTransaction: (fn) => fn({ query: exec }),
    writeQuery: exec,
    fetchFn: async () => ({ ok: true }),
    refreshPriceSummary: async (cardId) => { state.refreshed.push(cardId); },
    invalidateCache: async (args) => { state.invalidated.push(args); },
  };
  if (adjustCardTrader) {
    deps.adjustCardTrader = adjustCardTrader;
  } else {
    // Never touch the real CardTrader client from a unit test.
    deps.adjustCardTrader = async (args) => {
      state.cardTraderCalls.push(args);
      return { ok: true, sold: Math.abs(args.delta) };
    };
  }
  if (fetchSoldItems) {
    deps.getAdapter = (provider) => (
      adapters[provider] || (fetchSoldItems[provider] ? { fetchSoldItems: fetchSoldItems[provider] } : null)
    );
  }

  return { state, firestore, deps };
}

const LISTING = {
  id: '11111111-1111-4111-8111-111111111111',
  seller_uid: 'seller-1',
  card_id: '633380',
  quantity_available: 3,
  status: 'active',
  source_listing_id: 'ct:777',
  price_pkn: 100,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('saleDocId keys provider + order + item and strips slashes', () => {
  assert.equal(saleDocId('shopify', '1001', '55'), 'shopify_1001__55');
  assert.equal(saleDocId('tcgplayer', 'a/b', 'c/d'), 'tcgplayer_a_b__c_d');
});

test('normalizeSoldItem drops junk and keeps the sold item shape', () => {
  const item = normalizeSoldItem({
    orderId: 1001,
    itemId: 'line-1',
    externalId: 4242,
    quantity: '2',
    unitPriceCents: 12.6,
    currency: 'EUR',
    soldAt: '2026-10-01T00:00:00Z',
    listingId: '',
  });
  assert.equal(item.orderId, '1001');
  assert.equal(item.itemId, 'line-1');
  assert.equal(item.externalId, '4242');
  assert.equal(item.quantity, 2);
  assert.equal(item.unitPriceCents, 13);
  assert.equal(item.currency, 'EUR');
  assert.equal(item.skipped, undefined);
  assert.equal(normalizeSoldItem({ quantity: 0 }).quantity, 0);
});

// ---------------------------------------------------------------------------
// fanOutStockChange
// ---------------------------------------------------------------------------

test('fanOutStockChange pushes a relative delta to every other link', async () => {
  const adapters = {
    shopify: { adjustStock: async (_ctx, { link, delta }) => ({ ok: true, delta, id: link.external_id }) },
    tcgplayer: { adjustStock: async (_ctx, { delta }) => ({ ok: true, delta }) },
  };
  const { deps, state } = createHarness({
    links: [
      { listing_id: LISTING.id, provider: 'shopify', external_id: 'sku-1' },
      { listing_id: LISTING.id, provider: 'cardtrader', external_id: '777', source_listing_id: 'ct:777' },
      { listing_id: LISTING.id, provider: 'tcgplayer', external_id: 'sku-2' },
      { listing_id: LISTING.id, provider: 'pokoin', external_id: 'x' },
    ],
    adapters,
  });
  const result = await fanOutStockChange({
    origin: 'pokoin',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -2,
    firestore: createFirestore().firestore,
    deps,
  });
  assert.equal(result.ok, true);
  const byProvider = Object.fromEntries(result.items.map((row) => [row.provider, row]));
  assert.equal(byProvider.shopify.delta, -2);
  assert.equal(byProvider.tcgplayer.delta, -2);
  // CardTrader keeps its own path for a Pokoin sale.
  assert.equal(byProvider.cardtrader.skipped, true);
  assert.equal(byProvider.cardtrader.reason, 'cardtrader_path');
  assert.equal(byProvider.pokoin.skipped, true);
  assert.equal(byProvider.pokoin.reason, 'origin');
  // markPushed ran for the two real pushes, with no error text.
  assert.deepEqual(
    state.marked.map((row) => [row.provider, row.error]),
    [['shopify', ''], ['tcgplayer', '']],
  );
});

test('fanOutStockChange never echoes to the origin provider', async () => {
  const adapters = {
    shopify: { adjustStock: async () => ({ ok: true }) },
    tcgplayer: { adjustStock: async () => ({ ok: true }) },
  };
  const { deps } = createHarness({
    links: [
      { listing_id: LISTING.id, provider: 'shopify', external_id: 'sku-1' },
      { listing_id: LISTING.id, provider: 'tcgplayer', external_id: 'sku-2' },
    ],
    adapters,
  });
  const result = await fanOutStockChange({
    origin: 'shopify',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -1,
    firestore: createFirestore().firestore,
    deps,
  });
  const byProvider = Object.fromEntries(result.items.map((row) => [row.provider, row]));
  assert.equal(byProvider.shopify.skipped, true);
  assert.equal(byProvider.shopify.reason, 'origin');
  assert.equal(byProvider.tcgplayer.delta, -1);
});

test('fanOutStockChange includes CardTrader for an external sale and uses the ct: link', async () => {
  const calls = [];
  const adapters = { shopify: { adjustStock: async () => ({ ok: true }) } };
  const { deps } = createHarness({
    links: [
      { listing_id: LISTING.id, provider: 'cardtrader', external_id: '777', source_listing_id: 'ct:777' },
      { listing_id: LISTING.id, provider: 'shopify', external_id: 'sku-1' },
    ],
    adapters,
    adjustCardTrader: async (args) => { calls.push(args); return { ok: true, sold: Math.abs(args.delta) }; },
  });
  const result = await fanOutStockChange({
    origin: 'tcgplayer',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -2,
    includeCardTrader: true,
    firestore: createFirestore().firestore,
    deps,
  });
  assert.equal(result.items.find((row) => row.provider === 'cardtrader').ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceListingId, 'ct:777');
  assert.equal(calls[0].delta, -2);
  assert.equal(result.items.find((row) => row.provider === 'shopify').delta, -2);
});

test('fanOutStockChange records adapter errors and a missing adapter', async () => {
  const adapters = {
    shopify: { adjustStock: async () => { throw new Error('shopify down'); } },
  };
  const { deps, state } = createHarness({
    links: [
      { listing_id: LISTING.id, provider: 'shopify', external_id: 'sku-1' },
      { listing_id: LISTING.id, provider: 'magus', external_id: 'sku-2' },
    ],
    adapters,
  });
  const result = await fanOutStockChange({
    origin: 'pokoin',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -1,
    firestore: createFirestore().firestore,
    deps,
  });
  assert.equal(result.ok, false);
  const shopify = result.items.find((row) => row.provider === 'shopify');
  assert.equal(shopify.ok, false);
  assert.match(shopify.error, /shopify down/);
  assert.equal(result.items.find((row) => row.provider === 'magus').reason, 'no_adapter');
  assert.equal(state.marked.find((row) => row.provider === 'shopify').error, 'shopify down');
});

test('fanOutStockChange is a no-op for a zero delta', async () => {
  const { deps, state } = createHarness({ links: [{ provider: 'shopify' }] });
  const result = await fanOutStockChange({
    origin: 'pokoin',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: 0,
    deps,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_change');
  assert.equal(state.sql.length, 0);
});

// ---------------------------------------------------------------------------
// applyExternalSale
// ---------------------------------------------------------------------------

test('applyExternalSale claims, decrements with the platform_sync guard, records the sale and fans out', async () => {
  const adjustCalls = [];
  const adapters = {
    tcgplayer: { adjustStock: async (_ctx, { delta }) => { adjustCalls.push(['tcgplayer', delta]); return { ok: true }; } },
  };
  const { deps, firestore, state } = createHarness({
    listing: LISTING,
    links: [
      { listing_id: LISTING.id, provider: 'tcgplayer', external_id: 'sku-2' },
      { listing_id: LISTING.id, provider: 'cardtrader', external_id: '777', source_listing_id: 'ct:777' },
    ],
    adapters,
    adjustCardTrader: async ({ delta }) => { adjustCalls.push(['cardtrader', delta]); return { ok: true }; },
  });

  const result = await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1001',
    itemId: 'line-9',
    listingId: LISTING.id,
    quantity: 2,
    unitPriceCents: 1250,
    currency: 'EUR',
    firestore,
    deps,
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(state.listing.quantity_available, 1);
  assert.equal(state.listing.status, 'active');
  assert.equal(state.sawPlatformSyncSetting, true);
  assert.deepEqual(adjustCalls, [['tcgplayer', -2], ['cardtrader', -2]]);

  const sale = firestore.dump(`${SALES_COLLECTION}/${saleDocId('shopify', '1001', 'line-9')}`);
  assert.equal(sale.source, 'shopify');
  assert.equal(sale.provider, 'shopify');
  assert.equal(sale.quantity, 2);
  assert.equal(sale.listingId, LISTING.id);
  assert.equal(sale.voided, false);

  assert.deepEqual(state.refreshed, ['633380']);
  assert.equal(state.invalidated[0].reason, 'shopify_sale');
  assert.equal(state.invalidated[0].sellerUid, 'seller-1');
});

test('applyExternalSale marks the listing sold_out when the last unit leaves', async () => {
  const { deps, firestore, state } = createHarness({ listing: { ...LISTING, quantity_available: 2 } });
  const result = await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1002',
    itemId: 'line-1',
    listingId: LISTING.id,
    quantity: 2,
    firestore,
    deps,
  });
  assert.equal(result.applied, true);
  assert.equal(state.listing.quantity_available, 0);
  assert.equal(state.listing.status, 'sold_out');
});

test('applyExternalSale is exactly-once: a repeat is a duplicate and stock does not move twice', async () => {
  const { deps, firestore, state } = createHarness({ listing: { ...LISTING, quantity_available: 5 } });
  const args = {
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1003',
    itemId: 'line-1',
    listingId: LISTING.id,
    quantity: 2,
    firestore,
    deps,
  };
  const first = await applyExternalSale(args);
  const second = await applyExternalSale(args);
  assert.equal(first.applied, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
  assert.equal(state.listing.quantity_available, 3);
});

test('applyExternalSale releases the claim when the guarded decrement fails', async () => {
  const { deps, firestore, state } = createHarness({ listing: { ...LISTING, quantity_available: 1 } });
  const result = await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1004',
    itemId: 'line-1',
    listingId: LISTING.id,
    quantity: 3,
    firestore,
    deps,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient_stock');
  assert.equal(result.released, true);
  assert.equal(state.listing.quantity_available, 1);
  // Claim deleted, so a corrected retry can succeed.
  assert.equal(state.eventRows.size, 0);
});

test('applyExternalSale resolves an unlinked item by SKU, else reports it unmatched', async () => {
  const { deps, firestore, state } = createHarness({
    listing: { ...LISTING, quantity_available: 4 },
    linksByExternal: [{ provider: 'shopify', external_id: 'variant-42', listing_id: LISTING.id }],
  });
  const matched = await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1005',
    itemId: 'line-1',
    externalId: 'variant-42',
    quantity: 1,
    firestore,
    deps,
  });
  assert.equal(matched.applied, true);
  assert.equal(state.listing.quantity_available, 3);

  const unmatched = await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1006',
    itemId: 'line-1',
    externalId: 'variant-does-not-exist',
    quantity: 1,
    firestore,
    deps,
  });
  assert.equal(unmatched.skipped, true);
  assert.equal(unmatched.reason, 'unmatched_item');
  assert.equal(state.listing.quantity_available, 3);
});

test('applyExternalSale rejects CardTrader (own path) and invalid input', async () => {
  const { deps, firestore } = createHarness({ listing: { ...LISTING } });
  const cardtrader = await applyExternalSale({
    provider: 'cardtrader',
    sellerUid: 'seller-1',
    orderId: '1',
    itemId: '1',
    listingId: LISTING.id,
    quantity: 1,
    firestore,
    deps,
  });
  assert.equal(cardtrader.reason, 'cardtrader_uses_own_path');

  const invalid = await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1',
    itemId: '1',
    listingId: LISTING.id,
    quantity: 0,
    firestore,
    deps,
  });
  assert.equal(invalid.reason, 'invalid_quantity');
});

// ---------------------------------------------------------------------------
// applyExternalCancel
// ---------------------------------------------------------------------------

test('applyExternalSale runs claim + decrement in one _outbox writer transaction', async () => {
  const outbox = require('./_outbox');
  const original = outbox.withWriterTransaction;
  const seen = { transactions: 0, clientSql: [] };
  const { deps, firestore, state } = createHarness({ listing: { ...LISTING, quantity_available: 2 } });
  delete deps.withTransaction;
  const client = {
    query: (sql, params) => {
      seen.clientSql.push(String(sql));
      return deps.writeQuery(sql, params);
    },
  };
  outbox.withWriterTransaction = async (fn) => {
    seen.transactions += 1;
    return fn(client);
  };
  let result;
  try {
    result = await applyExternalSale({
      provider: 'shopify',
      sellerUid: 'seller-1',
      orderId: '1101',
      itemId: 'line-1',
      listingId: LISTING.id,
      quantity: 1,
      firestore,
      deps,
    });
  } finally {
    outbox.withWriterTransaction = original;
  }
  assert.equal(result.applied, true);
  assert.equal(seen.transactions, 1);
  // The decrement (claim + stock write) shared the transaction's client.
  assert.equal(seen.clientSql.filter((sql) => /update public\.marketplace_user_listings/.test(sql)).length, 1);
  assert.equal(state.listing.quantity_available, 1);
  assert.equal(state.sawPlatformSyncSetting, true);
});

test('applyExternalSale falls back to writeQuery when _outbox has no writer pool', async () => {
  const outbox = require('./_outbox');
  const original = outbox.withWriterTransaction;
  let transactions = 0;
  const { deps, firestore, state } = createHarness({ listing: { ...LISTING, quantity_available: 2 } });
  delete deps.withTransaction;
  outbox.withWriterTransaction = async () => {
    transactions += 1;
    return null;
  };
  let result;
  try {
    result = await applyExternalSale({
      provider: 'shopify',
      sellerUid: 'seller-1',
      orderId: '1102',
      itemId: 'line-1',
      listingId: LISTING.id,
      quantity: 1,
      firestore,
      deps,
    });
  } finally {
    outbox.withWriterTransaction = original;
  }
  assert.equal(result.applied, true);
  assert.equal(transactions, 1);
  assert.equal(state.listing.quantity_available, 1);
  assert.equal(state.sawPlatformSyncSetting, true);
});

test('fanOutStockChange resolves a CardTrader target from sourceListingId with no link row', async () => {
  const calls = [];
  const { deps } = createHarness({
    links: [{ listing_id: LISTING.id, provider: 'shopify', external_id: 'sku-1' }],
    adapters: { shopify: { adjustStock: async () => ({ ok: true }) } },
    adjustCardTrader: async (args) => { calls.push(args); return { ok: true, sold: Math.abs(args.delta) }; },
  });
  const result = await fanOutStockChange({
    origin: 'tcgplayer',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    sourceListingId: 'ct:777',
    delta: -2,
    includeCardTrader: true,
    firestore: createFirestore().firestore,
    deps,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceListingId, 'ct:777');
  assert.equal(calls[0].delta, -2);
  assert.equal(result.items.find((row) => row.provider === 'cardtrader').ok, true);
  assert.equal(result.items.find((row) => row.provider === 'shopify').delta, -2);
});

test('fanOutStockChange resolves source_listing_id through the writer when not given', async () => {
  const calls = [];
  const { deps, state } = createHarness({
    listing: { ...LISTING },
    links: [{ listing_id: LISTING.id, provider: 'shopify' }],
    adapters: { shopify: { adjustStock: async () => ({ ok: true }) } },
    adjustCardTrader: async (args) => { calls.push(args); return { ok: true }; },
  });
  const result = await fanOutStockChange({
    origin: 'shopify',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -1,
    includeCardTrader: true,
    firestore: createFirestore().firestore,
    deps,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceListingId, 'ct:777');
  assert.equal(result.items.find((row) => row.provider === 'cardtrader').ok, true);
  assert.ok(state.sql.some((row) => /select source_listing_id/.test(row.sql)));
});

test('fanOutStockChange skips the extra CardTrader target for a non-ct: listing or a CardTrader origin', async () => {
  const calls = [];
  const notLinked = createHarness({
    listing: { ...LISTING, source_listing_id: '' },
    links: [],
    adjustCardTrader: async (args) => { calls.push(args); return { ok: true }; },
  });
  const skipped = await fanOutStockChange({
    origin: 'shopify',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -1,
    includeCardTrader: true,
    firestore: createFirestore().firestore,
    deps: notLinked.deps,
  });
  assert.equal(calls.length, 0);
  assert.equal(skipped.items.find((row) => row.provider === 'cardtrader'), undefined);

  const cardTraderOrigin = createHarness({
    listing: { ...LISTING },
    links: [{ listing_id: LISTING.id, provider: 'shopify' }],
    adapters: { shopify: { adjustStock: async () => ({ ok: true }) } },
    adjustCardTrader: async (args) => { calls.push(args); return { ok: true }; },
  });
  await fanOutStockChange({
    origin: 'cardtrader',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -1,
    includeCardTrader: true,
    firestore: createFirestore().firestore,
    deps: cardTraderOrigin.deps,
  });
  assert.equal(calls.length, 0);
});

test('applyExternalSale pushes CardTrader from the RETURNING source_listing_id', async () => {
  const calls = [];
  const { deps, firestore, state } = createHarness({
    listing: { ...LISTING, quantity_available: 2 },
    links: [{ listing_id: LISTING.id, provider: 'shopify' }],
    adjustCardTrader: async (args) => { calls.push(args); return { ok: true, sold: Math.abs(args.delta) }; },
  });
  const result = await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1201',
    itemId: 'line-1',
    listingId: LISTING.id,
    quantity: 1,
    firestore,
    deps,
  });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceListingId, 'ct:777');
  assert.equal(calls[0].delta, -1);
  // The RETURNING row already carried the source, so no extra SELECT was run.
  assert.equal(state.sql.some((row) => /select source_listing_id/.test(row.sql)), false);
});

test('applyExternalCancel pushes a positive CardTrader delta from the RETURNING source_listing_id', async () => {
  const calls = [];
  const { deps, firestore } = createHarness({
    listing: { ...LISTING, quantity_available: 1 },
    links: [{ listing_id: LISTING.id, provider: 'shopify' }],
    saleEvents: [{ sellerUid: 'seller-1', provider: 'shopify', orderId: '1202', itemId: 'line-1', listingId: LISTING.id, quantity: 1 }],
    adjustCardTrader: async (args) => { calls.push(args); return { ok: true, restored: Math.abs(args.delta) }; },
  });
  const result = await applyExternalCancel({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1202',
    itemId: 'line-1',
    quantity: 1,
    firestore,
    deps,
  });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceListingId, 'ct:777');
  assert.equal(calls[0].delta, 1);
});

test('fanOutStockChange and the cancels read links through the writer executor', async () => {
  const { deps, state } = createHarness({
    links: [{ listing_id: LISTING.id, provider: 'shopify' }],
    adapters: { shopify: { adjustStock: async () => ({ ok: true }) } },
  });
  await fanOutStockChange({
    origin: 'pokoin',
    sellerUid: 'seller-1',
    listingId: LISTING.id,
    delta: -1,
    firestore: createFirestore().firestore,
    deps,
  });
  assert.equal(typeof state.linkReadQuery, 'function');
  const before = state.sql.length;
  await state.linkReadQuery('select writer_probe', []);
  assert.equal(state.sql.length, before + 1);
  assert.equal(state.sql[state.sql.length - 1].sql, 'select writer_probe');

  const unmatched = createHarness({ listing: { ...LISTING } });
  await applyExternalSale({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1301',
    itemId: 'line-1',
    externalId: 'unknown-variant',
    quantity: 1,
    firestore: createFirestore().firestore,
    deps: unmatched.deps,
  });
  assert.equal(typeof unmatched.state.findLinkQuery, 'function');

  const noClaim = createHarness({ listing: { ...LISTING } });
  await applyExternalCancel({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '1401',
    itemId: 'line-1',
    quantity: 1,
    firestore: createFirestore().firestore,
    deps: noClaim.deps,
  });
  assert.equal(typeof noClaim.state.findEventQuery, 'function');
});

test('applyExternalCancel restores only when the sale claim exists', async () => {
  const { deps, firestore, state } = createHarness({ listing: { ...LISTING, quantity_available: 1 } });
  const missing = await applyExternalCancel({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '2001',
    itemId: 'line-1',
    quantity: 1,
    firestore,
    deps,
  });
  assert.equal(missing.skipped, true);
  assert.equal(missing.reason, 'no_sale_claim');
  assert.equal(state.listing.quantity_available, 1);
});

test('applyExternalCancel restores once, voids the Sold row and fans out a positive delta', async () => {
  const { deps, firestore, state } = createHarness({
    listing: { ...LISTING, quantity_available: 1 },
    saleEvents: [{ sellerUid: 'seller-1', provider: 'shopify', orderId: '3001', itemId: 'line-1', listingId: LISTING.id, quantity: 2 }],
    links: [{ listing_id: LISTING.id, provider: 'tcgplayer', external_id: 'sku-2' }],
    adapters: { tcgplayer: { adjustStock: async (_ctx, { delta }) => ({ ok: true, delta }) } },
  });
  // Seed the sold row that the cancel will void.
  await firestore.collection(SALES_COLLECTION).doc(saleDocId('shopify', '3001', 'line-1')).set({
    listingId: LISTING.id,
    quantity: 2,
    source: 'shopify',
    voided: false,
  });

  const result = await applyExternalCancel({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '3001',
    itemId: 'line-1',
    quantity: 2,
    firestore,
    deps,
  });
  assert.equal(result.applied, true);
  assert.equal(result.restored, 2);
  assert.equal(state.listing.quantity_available, 3);
  assert.equal(state.listing.status, 'active');
  assert.equal(result.fanout.items.find((row) => row.provider === 'tcgplayer').delta, 2);
  const sale = firestore.dump(`${SALES_COLLECTION}/${saleDocId('shopify', '3001', 'line-1')}`);
  assert.equal(sale.voided, true);
  assert.equal(sale.voidReason, 'shopify_order_cancelled');

  const again = await applyExternalCancel({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '3001',
    itemId: 'line-1',
    quantity: 2,
    firestore,
    deps,
  });
  assert.equal(again.duplicate, true);
  assert.equal(state.listing.quantity_available, 3);
});

test('applyExternalCancel releases the cancel claim when the listing is gone', async () => {
  const { deps, firestore, state } = createHarness({
    listing: null,
    saleEvents: [{ sellerUid: 'seller-1', provider: 'shopify', orderId: '3002', itemId: 'line-1', listingId: LISTING.id, quantity: 1 }],
  });
  const result = await applyExternalCancel({
    provider: 'shopify',
    sellerUid: 'seller-1',
    orderId: '3002',
    itemId: 'line-1',
    listingId: LISTING.id,
    quantity: 1,
    firestore,
    deps,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'listing_missing');
  assert.equal(state.eventRows.has(eventKey({ sellerUid: 'seller-1', provider: 'shopify', orderId: '3002', itemId: 'line-1', kind: 'cancel' })), false);
});

// ---------------------------------------------------------------------------
// pollProvider
// ---------------------------------------------------------------------------

test('pollProvider skips a disconnected seller and a provider with no poller', async () => {
  const { deps, firestore } = createHarness({ integration: null });
  const disconnected = await pollProvider({
    provider: 'shopify',
    sellerUid: 'seller-1',
    firestore,
    deps,
  });
  assert.equal(disconnected.skipped, true);
  assert.equal(disconnected.reason, 'not_connected');

  const connected = createHarness({ integration: { uid: 'seller-1', enabled: true, metadata: {} } });
  const noPoller = await pollProvider({
    provider: 'shopify',
    sellerUid: 'seller-1',
    firestore: connected.firestore,
    deps: connected.deps,
  });
  assert.equal(noPoller.reason, 'no_poller');
});

test('pollProvider never removes stock on an incomplete read', async () => {
  const { deps, firestore, state } = createHarness({
    listing: { ...LISTING },
    integration: { uid: 'seller-1', enabled: true, metadata: {} },
    fetchSoldItems: {
      shopify: async () => ({ complete: false, sales: [{ orderId: '1', itemId: '1', quantity: 5, externalId: 'x' }] }),
    },
  });
  const result = await pollProvider({ provider: 'shopify', sellerUid: 'seller-1', firestore, deps });
  assert.equal(result.complete, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'incomplete_read');
  assert.equal(result.sales, 1);
  assert.equal(state.listing.quantity_available, 3);
  assert.equal(state.sql.length, 0);
});

test('pollProvider applies complete sales and cancels, reports unmatched items and stamps lastPolledAt', async () => {
  const { deps, firestore, state } = createHarness({
    listing: { ...LISTING, quantity_available: 3 },
    integration: { uid: 'seller-1', enabled: true, metadata: { shopDomain: 'x.myshopify.com' } },
    linksByExternal: [{ provider: 'shopify', external_id: 'variant-9', listing_id: LISTING.id }],
    fetchSoldItems: {
      shopify: async () => ({
        complete: true,
        sales: [
          { orderId: '4001', itemId: 'l1', externalId: 'variant-9', quantity: 1, unitPriceCents: 500, currency: 'EUR', soldAt: '2026-10-01T00:00:00Z' },
          { orderId: '4002', itemId: 'l2', externalId: 'unknown', quantity: 1 },
        ],
        cancels: [],
      }),
    },
  });
  const result = await pollProvider({
    provider: 'shopify',
    sellerUid: 'seller-1',
    firestore,
    now: () => '2026-10-02T00:00:00.000Z',
    deps,
  });
  assert.equal(result.complete, true);
  assert.equal(result.applied, 1);
  assert.equal(state.listing.quantity_available, 2);
  const unmatched = result.results.find((row) => row.reason === 'unmatched_item');
  assert.equal(unmatched.skipped, true);
  assert.equal(state.lastPolledAt, '2026-10-02T00:00:00.000Z');
  const sale = firestore.dump(`${SALES_COLLECTION}/${saleDocId('shopify', '4001', 'l1')}`);
  assert.equal(sale.source, 'shopify');
  assert.equal(sale.unitPriceCents, 500);
});

test('pollProvider stamps lastPolledAt with the pre-fetch start time', async () => {
  const stamps = ['start-mark', 'end-mark'];
  const { deps, firestore, state } = createHarness({
    listing: { ...LISTING },
    integration: { uid: 'seller-1', enabled: true, metadata: {} },
    fetchSoldItems: { shopify: async () => ({ complete: true, sales: [], cancels: [] }) },
  });
  const result = await pollProvider({
    provider: 'shopify',
    sellerUid: 'seller-1',
    firestore,
    now: () => stamps.shift(),
    deps,
  });
  assert.equal(result.complete, true);
  assert.equal(state.lastPolledAt, 'start-mark');
});

test('pollProvider since falls back lastPolledAt -> connectedAt -> 30 days ago, never null', async () => {
  const seen = [];
  const adapter = async (_ctx, { since }) => {
    seen.push(since);
    return { complete: true, sales: [], cancels: [] };
  };

  const withBoth = createHarness({
    integration: {
      uid: 'seller-1',
      enabled: true,
      lastPolledAt: '2026-09-01T00:00:00Z',
      connectedAt: '2026-08-01T00:00:00Z',
    },
    fetchSoldItems: { shopify: adapter },
  });
  await pollProvider({ provider: 'shopify', sellerUid: 'seller-1', firestore: withBoth.firestore, deps: withBoth.deps });

  const withConnected = createHarness({
    integration: { uid: 'seller-1', enabled: true, connectedAt: '2026-08-01T00:00:00Z' },
    fetchSoldItems: { shopify: adapter },
  });
  await pollProvider({ provider: 'shopify', sellerUid: 'seller-1', firestore: withConnected.firestore, deps: withConnected.deps });

  const withNeither = createHarness({
    integration: { uid: 'seller-1', enabled: true },
    fetchSoldItems: { shopify: adapter },
  });
  await pollProvider({ provider: 'shopify', sellerUid: 'seller-1', firestore: withNeither.firestore, deps: withNeither.deps });

  assert.equal(seen[0], '2026-09-01T00:00:00.000Z');
  assert.equal(seen[1], '2026-08-01T00:00:00.000Z');
  assert.equal(typeof seen[2], 'string');
  assert.notEqual(seen[2], '');
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(new Date(seen[2]).getTime() - thirtyDaysAgo) < 60 * 1000);
});
