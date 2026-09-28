'use strict';

// Seller-owned CardTrader stock: a card is SOLD only when CardTrader has a
// seller order for it; a product the seller removed is delisted, and Pokoin
// never overwrites CardTrader quantities with its own.

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

// _cardtrader_seller_listings loads the API image's Postgres helper; stub it.
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../server/_marketplace_db') {
    return { marketplaceWriteQuery: async () => ({ rows: [] }), marketplaceQuery: async () => ({ rows: [] }) };
  }
  return realLoad.call(this, request, parent, isMain);
};
const { decrementLinkedCardTraderProduct } = require(path.join(__dirname, '_cardtrader_seller_listings'));
Module._load = realLoad;

const {
  classifyVanishedProduct,
  orderIsSale,
  saleItemsByProduct,
} = require('./_cardtrader_inventory_sync_core');

const LISTING = { id: 'l1', created_at: '2026-09-21T19:08:04Z' };

function order(id, state, productId, createdAt = '2026-09-27T10:00:00Z') {
  return { id, state, order_items: [{ id: id * 10, product_id: productId, quantity: 1, created_at: createdAt }] };
}

test('only real CardTrader orders are sale evidence', () => {
  assert.equal(orderIsSale({ state: 'hub_pending' }), true);
  assert.equal(orderIsSale({ state: 'paid' }), true);
  assert.equal(orderIsSale({ state: 'sent' }), true);
  assert.equal(orderIsSale({ state: 'pending' }), false);
  assert.equal(orderIsSale({ state: 'canceled' }), false);
  const sales = saleItemsByProduct([order(1, 'hub_pending', 442157429), order(2, 'canceled', 5)]);
  assert.deepEqual([...sales.keys()], ['442157429']);
});

test('vanished product with a CardTrader order is sold', () => {
  const sales = saleItemsByProduct([order(40359230, 'hub_pending', 442157429)]);
  const verdict = classifyVanishedProduct({ productId: '442157429', listing: LISTING, sales });
  assert.equal(verdict.kind, 'sold');
  assert.equal(verdict.sales.length, 1);
});

test('vanished product with no order is a seller delisting, not a sale', () => {
  const sales = saleItemsByProduct([order(1, 'hub_pending', 1)]);
  assert.equal(classifyVanishedProduct({ productId: '449564446', listing: LISTING, sales }).kind, 'delisted');
});

test('a cancelled order or a sale before the Pokoin import does not make it sold', () => {
  const sales = saleItemsByProduct([
    order(1, 'canceled', 7),
    order(2, 'sent', 7, '2026-09-10T00:00:00Z'),
  ]);
  assert.equal(classifyVanishedProduct({ productId: '7', listing: LISTING, sales }).kind, 'delisted');
});

test('without order data nothing is claimed as sold', () => {
  assert.equal(classifyVanishedProduct({ productId: '7', listing: LISTING, sales: null }).kind, 'unknown');
});

const connected = {
  readDocFn: async () => ({ exists: true, data: () => ({ enabled: true }) }),
  tokenFn: async () => 'ct-token',
};

test('Pokoin sale takes exactly the sold quantity off CardTrader (relative, never absolute)', async () => {
  const calls = [];
  const result = await decrementLinkedCardTraderProduct({
    ...connected,
    uid: 'seller',
    sourceListingId: 'ct:420555233',
    quantity: 1,
    incrementFn: async (token, productId, delta) => {
      calls.push([productId, delta]);
      return { resource: { id: 420555233, quantity: 2 } };
    },
    destroyFn: async () => { throw new Error('must not destroy'); },
  });
  assert.deepEqual(calls, [['420555233', -1]]);
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 2);
});

test('last copy sold on Pokoin removes the CardTrader product', async () => {
  const destroyed = [];
  const result = await decrementLinkedCardTraderProduct({
    ...connected,
    uid: 'seller',
    sourceListingId: 'ct:1',
    quantity: 1,
    incrementFn: async () => ({ quantity: 0 }),
    destroyFn: async (token, id) => { destroyed.push(id); },
  });
  assert.deepEqual(destroyed, ['1']);
  assert.equal(result.destroyed, true);
});

test('CardTrader refusing the decrement leaves CardTrader untouched', async () => {
  let destroyed = false;
  const result = await decrementLinkedCardTraderProduct({
    ...connected,
    uid: 'seller',
    sourceListingId: 'ct:1',
    quantity: 1,
    incrementFn: async () => { throw new Error('Product not found'); },
    destroyFn: async () => { destroyed = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(destroyed, false);
});

test('disconnected seller: CardTrader is never called', async () => {
  const result = await decrementLinkedCardTraderProduct({
    readDocFn: async () => ({ exists: true, data: () => ({ enabled: false }) }),
    tokenFn: async () => { throw new Error('no token'); },
    uid: 'seller',
    sourceListingId: 'ct:1',
    quantity: 1,
    incrementFn: async () => { throw new Error('must not call'); },
  });
  assert.equal(result.reason, 'not_connected');
});
