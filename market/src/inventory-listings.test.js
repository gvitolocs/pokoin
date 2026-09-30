import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterInventoryRows,
  inventoryFacets,
  inventoryListingHref,
  inventoryListingMeta,
  inventoryRowDate,
  isLiveInventoryListing,
  liveInventoryListings,
  sortInventoryRows,
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

test('inventory meta includes scan location when present', () => {
  const meta = inventoryListingMeta(
    {
      pricePkn: 200,
      condition: 'NM',
      quantityAvailable: 2,
      language: 'EN',
      location: 'box1·47',
    },
    (n) => `${n} PKN`,
  );
  assert.equal(meta, '200 PKN · NM · qty 2 · box1·47');
});

test('inventory meta omits blank location', () => {
  const meta = inventoryListingMeta(
    { pricePkn: 100, condition: 'LP', quantityAvailable: 1, location: '  ' },
    (n) => `${n} PKN`,
  );
  assert.equal(meta, '100 PKN · LP · qty 1');
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

test('inventory filters by query, status, condition and language', () => {
  const rows = [
    { id: '1', cardName: 'Hoothoot', setName: 'Prismatic Evolutions', collectorNumber: '077/131', status: 'active', condition: 'NM', language: 'IT', pricePkn: 33, quantityAvailable: 1, createdAt: '2026-09-30T10:00:00Z' },
    { id: '2', cardName: 'Hoothoot', setName: 'Prismatic Evolutions', collectorNumber: '132-4', status: 'paused', condition: 'NM', language: 'IT', pricePkn: 300, quantityAvailable: 3, createdAt: '2026-09-29T10:00:00Z' },
    { id: '3', cardName: 'Gambler', setName: 'Fossil', collectorNumber: '060/062', status: 'active', condition: 'SP', language: 'EN', pricePkn: 12, quantityAvailable: 1, createdAt: '2026-09-28T10:00:00Z' },
  ];
  assert.deepEqual(filterInventoryRows(rows, { query: 'hoothoot' }).map((r) => r.id), ['1', '2']);
  assert.deepEqual(filterInventoryRows(rows, { query: 'fossil' }).map((r) => r.id), ['3']);
  assert.deepEqual(filterInventoryRows(rows, { status: 'paused' }).map((r) => r.id), ['2']);
  assert.deepEqual(filterInventoryRows(rows, { condition: 'sp' }).map((r) => r.id), ['3']);
  assert.deepEqual(filterInventoryRows(rows, { language: 'it' }).map((r) => r.id), ['1', '2']);
  assert.deepEqual(filterInventoryRows(rows, { query: '077' }).map((r) => r.id), ['1']);
  assert.equal(filterInventoryRows(rows, {}).length, 3);
});

test('inventory sorts by date, price, qty and name', () => {
  const rows = [
    { id: 'a', cardName: 'Hoothoot', pricePkn: 300, quantityAvailable: 3, createdAt: '2026-09-29' },
    { id: 'b', cardName: 'Gambler', pricePkn: 12, quantityAvailable: 1, createdAt: '2026-09-30' },
    { id: 'c', cardName: 'Abra', pricePkn: 100, quantityAvailable: 2, createdAt: '2026-09-28' },
  ];
  assert.deepEqual(sortInventoryRows(rows, 'newest').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(sortInventoryRows(rows, 'oldest').map((r) => r.id), ['c', 'a', 'b']);
  assert.deepEqual(sortInventoryRows(rows, 'price-up').map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(sortInventoryRows(rows, 'price-down').map((r) => r.id), ['a', 'c', 'b']);
  assert.deepEqual(sortInventoryRows(rows, 'qty-down').map((r) => r.id), ['a', 'c', 'b']);
  assert.deepEqual(sortInventoryRows(rows, 'name').map((r) => r.id), ['c', 'b', 'a']);
});

test('inventory facets list distinct conditions and languages', () => {
  const facets = inventoryFacets([
    { condition: 'NM', language: 'IT' },
    { condition: 'nm', language: 'it' },
    { condition: 'SP', language: 'EN' },
  ]);
  assert.deepEqual(facets.conditions, ['NM', 'SP']);
  assert.deepEqual(facets.languages, ['EN', 'IT']);
});

test('inventory row date formats to day/month', () => {
  assert.equal(inventoryRowDate({ createdAt: '2026-09-30T10:00:00Z' }), '30/09');
  assert.equal(inventoryRowDate({ created_at: '2026-09-09T10:00:00Z' }), '09/09');
  assert.equal(inventoryRowDate({}), '');
});
