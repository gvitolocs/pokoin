import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inventoryListingHref,
  inventoryListingMeta,
  isLiveInventoryListing,
  liveInventoryListings,
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
