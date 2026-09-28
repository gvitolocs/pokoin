'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cappedQuantity,
  orderItemIsSale,
  planBackfill,
  soldAfterImport,
} = require('./cardtrader-sales-backfill');
const { cardTraderSaleDoc } = require('./_native_sales');

const UID = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';

function maps(rows) {
  const byId = new Map();
  const byProduct = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
    byProduct.set(String(row.ct_product_id), row);
  }
  return { byId, byProduct };
}

test('only paid-onward CardTrader orders count as sales', () => {
  assert.equal(orderItemIsSale({ state: 'hub_pending' }), true);
  assert.equal(orderItemIsSale({ state: 'sent' }), true);
  assert.equal(orderItemIsSale({ state: 'pending' }), false);
  assert.equal(orderItemIsSale({ state: 'canceled' }), false);
});

test('a CardTrader sale before the Pokoin import is not a Pokoin sale', () => {
  const listing = { created_at: '2026-09-21T19:08:04Z' };
  assert.equal(soldAfterImport({ created_at: '2026-09-20T10:00:00Z' }, listing), false);
  assert.equal(soldAfterImport({ created_at: '2026-09-28T08:40:31Z' }, listing), true);
});

test('Pokoin quantity is capped at what CardTrader still has', () => {
  assert.equal(cappedQuantity({ quantity_available: 3 }, 1), 1);
  assert.equal(cappedQuantity({ quantity_available: 1 }, 0), 0);
  assert.equal(cappedQuantity({ quantity_available: 1 }, 4), 1);
});

test('plan: sold items become sales, vanished-without-order become delisted', () => {
  const listings = [
    { id: 'sold-1', ct_product_id: 442157429, status: 'sold_out', quantity_available: 0, created_at: '2026-09-21T00:00:00Z' },
    { id: 'live-1', ct_product_id: 449564446, status: 'active', quantity_available: 1, created_at: '2026-09-21T00:00:00Z' },
    { id: 'gone-1', ct_product_id: 1, status: 'active', quantity_available: 2, created_at: '2026-09-21T00:00:00Z' },
    { id: 'claimed', ct_product_id: 2, status: 'sold_out', quantity_available: 0, created_at: '2026-09-21T00:00:00Z' },
  ];
  const orders = [
    {
      id: 40359230,
      state: 'hub_pending',
      order_items: [{ id: 115545729, product_id: 442157429, quantity: 1, created_at: '2026-09-28T08:40:31Z' }],
    },
    {
      id: 7,
      state: 'sent',
      order_items: [{ id: 8, product_id: 2, quantity: 1, created_at: '2026-09-25T00:00:00Z' }],
    },
  ];
  const plan = planBackfill({
    orders,
    maps: maps(listings),
    exportQuantities: new Map([['449564446', 1]]),
    claimedEventIds: new Set([`${UID}_7_8`]),
    uid: UID,
  });
  assert.deepEqual(plan.sales.map((row) => row.listing.id), ['sold-1']);
  assert.deepEqual(plan.stock.map((row) => [row.listing.id, row.quantity]), [['gone-1', 0]]);
  assert.deepEqual(plan.delisted.map((row) => row.listing.id), ['gone-1']);
});

test('CardTrader sale doc is keyed by order + item and carries the real price', () => {
  const doc = cardTraderSaleDoc({
    sellerUid: UID,
    order: { id: 40359230, code: '20260928gdgleb', state: 'hub_pending' },
    item: {
      id: 115545729,
      product_id: 442157429,
      name: 'Arbok δ Delta Species',
      quantity: 1,
      properties: { condition: 'Near Mint', pokemon_language: 'en' },
      seller_price: { cents: 267, currency: 'EUR' },
      created_at: '2026-09-28T08:40:31.000Z',
    },
    listing: { id: 'a8333656', card_id: '230000' },
  });
  assert.equal(doc.id, 'ct_40359230__115545729');
  assert.equal(doc.data.source, 'cardtrader');
  assert.equal(doc.data.condition, 'NM');
  assert.equal(doc.data.language, 'EN');
  assert.equal(doc.data.unitPriceEURCents, 267);
  assert.equal(doc.data.soldAt, '2026-09-28T08:40:31.000Z');
});
