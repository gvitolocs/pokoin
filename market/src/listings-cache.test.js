import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dropListing,
  invalidateListings,
  mergeCreatedListing,
  mergeListingRows,
  omitListings,
  peekHasListingRows,
  peekListings,
  peekSellerListings,
  rememberCreatedListing,
  rememberListings,
  rememberSellerListings,
  resetListingsCacheForTests,
} from './listings-cache.js';

test('merge listing rows prepends the created ask and dedupes by id', () => {
  const created = { id: 'new', pricePkn: 12 };
  assert.deepEqual(mergeListingRows([], created), [created]);
  assert.deepEqual(
    mergeListingRows([{ id: 'old', pricePkn: 9 }, { id: 'new', pricePkn: 1 }], created),
    [created, { id: 'old', pricePkn: 9 }],
  );
});

test('shop payload keeps existing offers when POST returns a listing', () => {
  const next = mergeCreatedListing(
    { card: { id: '713832' }, offers: [] },
    { id: '2933', pricePkn: 489235, sellerName: 'vitologiuseppe17' },
  );
  assert.equal(next.offers.length, 1);
  assert.equal(next.offers[0].pricePkn, 489235);
});

test('stale in-flight empty payload does not overwrite a newer cache after invalidate', () => {
  resetListingsCacheForTests();
  const empty = { listings: [] };
  const live = { listings: [{ id: '2933', pricePkn: 489235 }] };
  rememberListings('713832', empty, 0);
  invalidateListings('713832');
  const kept = rememberListings('713832', empty, 0);
  assert.equal(kept, empty);
  assert.equal(peekListings('713832'), null);
  rememberCreatedListing('713832', live.listings[0]);
  const ignored = rememberListings('713832', empty, 0);
  assert.equal(ignored.listings[0].id, '2933');
  assert.equal(peekListings('713832').listings[0].pricePkn, 489235);
});

test('empty listings cache is a hit but does not count as ready rows', () => {
  resetListingsCacheForTests();
  rememberListings('236234', { listings: [] }, 0);
  assert.equal(Boolean(peekListings('236234')), true);
  assert.equal(peekHasListingRows(peekListings('236234')), false);
  rememberListings('236234', { listings: [{ id: '1', pricePkn: 12 }] }, 0);
  assert.equal(peekHasListingRows(peekListings('236234')), true);
});

test('dropListing removes that ask from the shop cache', () => {
  resetListingsCacheForTests();
  rememberListings('713832', {
    listings: [
      { id: 'keep', pricePkn: 10 },
      { id: 'gone', pricePkn: 20 },
    ],
  }, 0);
  dropListing('713832', 'gone');
  assert.deepEqual(peekListings('713832').listings, [{ id: 'keep', pricePkn: 10 }]);
  assert.deepEqual(
    omitListings({ offers: [{ id: 'keep' }, { id: 'gone' }] }, ['gone']).offers,
    [{ id: 'keep' }],
  );
});

test('seller inventory cache is keyed by username', () => {
  resetListingsCacheForTests();
  const payload = { listings: [{ id: '1', sellerName: 'vitologiuseppe17' }] };
  rememberSellerListings('VitoLoGiuseppe17', payload);
  assert.equal(peekSellerListings('vitologiuseppe17').listings[0].id, '1');
});
