import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inventoryListingHref,
  inventoryListingMeta,
  isLiveInventoryListing,
  liveInventoryListings,
  summarizeLiveInventory,
} from './inventory-listings.js';

test('inventory hides cancelled and sold-out rows', () => {
  const rows = liveInventoryListings([
    { id: '1', status: 'active', quantityAvailable: 1, cardId: '244538' },
    { id: '2', status: 'inactive', quantityAvailable: 1, cardId: '573732' },
    { id: '3', status: 'sold_out', quantityAvailable: 0, cardId: '713832' },
    { id: '4', status: 'paused', quantityAvailable: 2, cardId: '243340' },
    { id: '5', status: 'active', quantityAvailable: 0, cardId: '238622' },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['1', '4']);
  assert.equal(isLiveInventoryListing({ status: 'inactive', quantityAvailable: 1 }), false);
});

test('inventory links prefer canonical desk paths', () => {
  assert.equal(
    inventoryListingHref({
      cardId: '244538',
      canonicalPath: '/marketplace/en/cards/244538/card-mewtwo-lv-x-legends-awakened',
    }),
    '/marketplace/en/cards/244538/card-mewtwo-lv-x-legends-awakened',
  );
  assert.equal(inventoryListingHref({ cardId: '244538' }), '/marketplace/en/cards/244538');
  assert.equal(inventoryListingHref({}), '/marketplace');
});

test('inventory meta marks paused and non-EN language', () => {
  const meta = inventoryListingMeta(
    { pricePkn: 324, condition: 'NM', quantityAvailable: 1, status: 'paused', language: 'JP' },
    (n) => `${n} PKN`,
  );
  assert.equal(meta, '324 PKN · NM · qty 1 · paused · JP');
});

test('summarizeLiveInventory counts qty and asking value for live rows only', () => {
  const summary = summarizeLiveInventory([
    { status: 'active', quantityAvailable: 2, pricePkn: 100 },
    { status: 'paused', quantityAvailable: 1, pricePkn: 50 },
    { status: 'inactive', quantityAvailable: 9, pricePkn: 999 },
    { status: 'sold_out', quantityAvailable: 0, pricePkn: 40 },
    { status: 'active', quantityAvailable: 0, pricePkn: 10 },
  ]);
  assert.equal(summary.listings, 2);
  assert.equal(summary.cards, 3);
  assert.equal(summary.listedPkn, 250);
});

test('summarizeLiveInventory empty input is zeroes', () => {
  assert.deepEqual(summarizeLiveInventory([]), { listings: 0, cards: 0, listedPkn: 0 });
  assert.deepEqual(summarizeLiveInventory(null), { listings: 0, cards: 0, listedPkn: 0 });
});
