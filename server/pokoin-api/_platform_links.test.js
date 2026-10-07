'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  upsertLink,
  findLinkByExternal,
  linksForListing,
  deleteLinksForProvider,
  deleteLink,
  markPushed,
  claimEvent,
  releaseEvent,
  findEvent,
} = require('./_platform_links');

/** Capture every SQL call; answer from `onWrite` / `onRead`. */
function fakeQueries({ onWrite, onRead } = {}) {
  const calls = { write: [], read: [] };
  const write = async (sql, values) => {
    calls.write.push({ sql: String(sql), values });
    return onWrite ? onWrite(String(sql), values, calls.write.length) : { rows: [], rowCount: 0 };
  };
  const read = async (sql, values) => {
    calls.read.push({ sql: String(sql), values });
    return onRead ? onRead(String(sql), values, calls.read.length) : { rows: [], rowCount: 0 };
  };
  return { calls, write, read };
}

test('upsertLink writes one row per (listing, provider) and returns it', async () => {
  const row = { listing_id: 'L1', provider: 'shopify', external_id: 'sku-1' };
  const { calls, write } = fakeQueries({ onWrite: () => ({ rows: [row], rowCount: 1 }) });
  const result = await upsertLink({
    listingId: 'L1',
    sellerUid: 'seller-1',
    provider: 'shopify',
    externalId: 'sku-1',
    externalMeta: { variantId: '42' },
    matchMethod: 'sku',
  }, write);
  assert.deepEqual(result, row);
  assert.match(calls.write[0].sql, /on conflict \(listing_id, provider\) do update/);
  assert.deepEqual(calls.write[0].values, ['L1', 'seller-1', 'shopify', 'sku-1', '{"variantId":"42"}', 'sku']);
});

test('upsertLink returns null when the write returns no row', async () => {
  const { write } = fakeQueries({ onWrite: () => ({ rows: [], rowCount: 0 }) });
  assert.equal(await upsertLink({
    listingId: 'L1',
    sellerUid: 's',
    provider: 'shopify',
    externalId: 'x',
    matchMethod: 'manual',
  }, write), null);
});

test('findLinkByExternal joins the Pokoin listing so the caller sees card and stock', async () => {
  const { calls, write } = fakeQueries({
    onWrite: () => ({ rows: [{ listing_id: 'L1', card_id: '633380', quantity_available: 2 }], rowCount: 1 }),
  });
  const result = await findLinkByExternal({ sellerUid: 'seller-1', provider: 'shopify', externalId: 'sku-1' }, write);
  assert.equal(result.card_id, '633380');
  assert.match(calls.write[0].sql, /join public\.marketplace_user_listings u on u\.id = l\.listing_id/);
  assert.deepEqual(calls.write[0].values, ['seller-1', 'shopify', 'sku-1']);
});

test('linksForListing returns every provider link for the listing', async () => {
  const { calls, write } = fakeQueries({
    onWrite: () => ({ rows: [{ provider: 'shopify' }, { provider: 'tcgplayer' }], rowCount: 2 }),
  });
  const rows = await linksForListing('L1', write);
  assert.equal(rows.length, 2);
  assert.deepEqual(calls.write[0].values, ['L1']);
});

test('deletes target the provider or the single link', async () => {
  const { calls, write } = fakeQueries({ onWrite: () => ({ rows: [], rowCount: 3 }) });
  assert.equal(await deleteLinksForProvider({ sellerUid: 's', provider: 'shopify' }, write), 3);
  assert.deepEqual(calls.write[0].values, ['s', 'shopify']);
  assert.equal(await deleteLink({ listingId: 'L1', provider: 'shopify', sellerUid: 's' }, write), 3);
  assert.deepEqual(calls.write[1].values, ['L1', 'shopify', 's']);
});

test('markPushed stamps success or a truncated error', async () => {
  const { calls, write } = fakeQueries({ onWrite: () => ({ rows: [], rowCount: 1 }) });
  await markPushed({ listingId: 'L1', provider: 'shopify' }, write);
  assert.equal(calls.write[0].values[2], '');
  await markPushed({ listingId: 'L1', provider: 'shopify', error: 'x'.repeat(900) }, write);
  assert.equal(calls.write[1].values[2].length, 500);
});

test('claimEvent is exactly-once: an inserted key wins, a conflict loses', async () => {
  const { calls, write } = fakeQueries({
    onWrite: (sql, values, n) => (n === 1 ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }),
  });
  const payload = {
    sellerUid: 's',
    provider: 'shopify',
    orderId: 'O1',
    itemId: 'I1',
    kind: 'sale',
    listingId: 'L1',
    quantity: 2,
  };
  assert.equal(await claimEvent(payload, write), true);
  assert.equal(await claimEvent(payload, write), false);
  assert.match(calls.write[0].sql, /on conflict \(seller_uid, provider, external_order_id, external_item_id, kind\) do nothing/);
  assert.deepEqual(calls.write[0].values, ['s', 'shopify', 'O1', 'I1', 'sale', 'L1', 2]);
});

test('claimEvent accepts a returning flag as well as a row count', async () => {
  const { write } = fakeQueries({ onWrite: () => ({ rows: [{ '?column?': 1 }], rowCount: 0 }) });
  assert.equal(await claimEvent({
    sellerUid: 's',
    provider: 'shopify',
    orderId: 'O1',
    itemId: 'I1',
    kind: 'cancel',
    listingId: 'L1',
    quantity: 1,
  }, write), true);
});

test('releaseEvent removes the exact claim so a retry can succeed', async () => {
  const { calls, write } = fakeQueries({ onWrite: () => ({ rows: [], rowCount: 1 }) });
  await releaseEvent({
    sellerUid: 's',
    provider: 'shopify',
    orderId: 'O1',
    itemId: 'I1',
    kind: 'sale',
  }, write);
  assert.match(calls.write[0].sql, /delete from public\.marketplace_platform_sync_events/);
  assert.deepEqual(calls.write[0].values, ['s', 'shopify', 'O1', 'I1', 'sale']);
});

test('findEvent returns the stored claim or null', async () => {
  const { calls, write } = fakeQueries({
    onWrite: (sql, values, n) => (n === 1
      ? { rows: [{ listing_id: 'L1', quantity: 2 }], rowCount: 1 }
      : { rows: [], rowCount: 0 }),
  });
  const payload = { sellerUid: 's', provider: 'shopify', orderId: 'O1', itemId: 'I1', kind: 'sale' };
  assert.equal((await findEvent(payload, write)).listing_id, 'L1');
  assert.equal(await findEvent(payload, write), null);
  assert.deepEqual(calls.write[0].values, ['s', 'shopify', 'O1', 'I1', 'sale']);
});

test('the stock-driving reads default to the writer, never the read replica', async () => {
  const Module = require('node:module');
  const calls = [];
  const originalLoad = Module._load;
  Module._load = function load(request) {
    if (request === './_marketplace_db') {
      return {
        marketplaceQuery: async (sql) => {
          calls.push({ kind: 'read', sql: String(sql) });
          return { rows: [], rowCount: 0 };
        },
        marketplaceWriteQuery: async (sql) => {
          calls.push({ kind: 'write', sql: String(sql) });
          return { rows: [], rowCount: 0 };
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    await linksForListing('L1');
    await findLinkByExternal({ sellerUid: 's', provider: 'shopify', externalId: 'sku-1' });
    await findEvent({ sellerUid: 's', provider: 'shopify', orderId: 'O1', itemId: 'I1', kind: 'sale' });
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((row) => row.kind), ['write', 'write', 'write']);
});
