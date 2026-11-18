import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dropListing,
  invalidateListings,
  listingsAgeMs,
  listingsKnown,
  mergeCreatedListing,
  mergeListingRows,
  omitListings,
  peekHasListingRows,
  peekListings,
  peekSellerListings,
  rememberCreatedListing,
  rememberListings,
  rememberListingRows,
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

test('optimistic replace and rollback drop the pending ask', () => {
  const pending = { id: 'pending-1', pending: true, pricePkn: 10 };
  const saved = { id: '99', pricePkn: 12, replaceId: 'pending-1' };
  assert.deepEqual(mergeListingRows([{ id: 'old' }], pending), [pending, { id: 'old' }]);
  assert.deepEqual(mergeListingRows([pending, { id: 'old' }], saved), [saved, { id: 'old' }]);
  assert.deepEqual(
    mergeListingRows([pending, { id: 'old' }], { remove: true, id: 'pending-1' }),
    [{ id: 'old' }],
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

test('a known listings answer includes the empty one (CARD-01 P1)', () => {
  resetListingsCacheForTests();
  assert.equal(listingsKnown('236234'), false, 'nothing cached is the only unknown');
  rememberListings('236234', { listings: [] }, 0);
  assert.equal(listingsKnown('236234'), true, 'nobody selling it is an answer');
  rememberListings('236234', { listings: [{ id: '1', pricePkn: 12 }] }, 0);
  assert.equal(listingsKnown('236234'), true);
  // The same answer from a revalidation never takes the known state away.
  rememberListings('236234', { listings: [] }, 0);
  assert.equal(listingsKnown('236234'), true, 'an empty answer keeps an answer');
  invalidateListings('236234');
  assert.equal(listingsKnown('236234'), false, 'only the visitors own write forgets it');
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

test('seller shop cache includes limit/offset so short fetches cannot poison', () => {
  resetListingsCacheForTests();
  rememberSellerListings('redshakkio', { listings: [{ id: 'a' }], total: 1 }, { limit: 100, offset: 0 });
  rememberSellerListings('redshakkio', { listings: [{ id: 'b' }], total: 9153 }, { limit: 100, offset: 100 });
  assert.equal(peekSellerListings('redshakkio', { limit: 100, offset: 0 }).listings[0].id, 'a');
  assert.equal(peekSellerListings('redshakkio', { limit: 100, offset: 100 }).total, 9153);
  // Legacy username-only key stays separate
  rememberSellerListings('redshakkio', { listings: [{ id: 'legacy' }] });
  assert.equal(peekSellerListings('redshakkio').listings[0].id, 'legacy');
});

test('seller shop cache is isolated by selected game', () => {
  resetListingsCacheForTests();
  const base = { limit: 100, offset: 0, sort: 'price-asc' };
  rememberSellerListings('redshakkio', { listings: [{ id: 'pokemon' }] }, { ...base, game: 'pokemon' });
  rememberSellerListings('redshakkio', { listings: [{ id: 'sorcery' }] }, { ...base, game: 'sorcery' });
  assert.equal(peekSellerListings('redshakkio', { ...base, game: 'pokemon' }).listings[0].id, 'pokemon');
  assert.equal(peekSellerListings('redshakkio', { ...base, game: 'sorcery' }).listings[0].id, 'sorcery');
});

/**
 * PH-R034 P9 (N12): the live channel is the one thing on a desk that knows about a
 * listing before the next read does. Its frame has to reach both the cell the
 * visitor sees and the answer the next desk adopts (P2) — and it may only ever
 * correct an answer this card already has.
 */
test('a live frame moves the cached answer without inventing one', () => {
  resetListingsCacheForTests();
  const rows = [{ id: 'just-listed', pricePkn: 120 }];
  // A card nobody was selling: `[]` is an answer (P1), and the event that ends it
  // must land on the copy, not only on the painted cell.
  rememberListings('236234', { listings: [], total: 0, limit: 40 }, 0);
  assert.deepEqual(rememberListingRows('236234', rows).listings, rows);
  assert.deepEqual(peekListings('236234').listings, rows);
  assert.equal(peekListings('236234').limit, 40, 'the answer stays the answer it was');
  assert.equal(listingsAgeMs('236234'), 0, 'the patch is as fresh as the event that made it');
  // Nothing cached is nothing to correct: the desk cannot manufacture an answer
  // for a card it never asked about, or for rows that are not rows.
  assert.equal(rememberListingRows('999999', rows), null);
  assert.equal(rememberListingRows('236234', undefined), null);
  assert.deepEqual(peekListings('236234').listings, rows, 'and a rejected patch changed nothing');
  assert.equal(rememberListingRows('', rows), null);
  // The visitor own write forgets the answer, so the event that races it has
  // nothing left to patch.
  invalidateListings('236234');
  assert.equal(rememberListingRows('236234', [{ id: 'late' }]), null);
  assert.equal(listingsKnown('236234'), false);
});
