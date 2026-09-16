import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendListingRows,
  listingFacetFlags,
  listingPopulation,
  takeListingRows,
} from './cardtrader-market-rows.js';

function row(id, cents, extra = {}) {
  return { externalListingId: String(id), priceCents: cents, sellerAccountId: extra.seller || 's', quantity: extra.qty ?? 1 };
}

test('blueprint complete book keeps every listing, not the cheap 25', () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(index + 1, (index + 1) * 100));
  assert.equal(takeListingRows(rows, 0).length, 40);
  assert.equal(takeListingRows(rows, 25).length, 25);
  assert.equal(takeListingRows(rows, 25)[0].externalListingId, '1');
});

test('population capped only when the cheap-25 window applied', () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(index + 1, 100, { seller: `s${index}` }));
  assert.equal(listingPopulation(rows, 9, 25).capped, true);
  assert.equal(listingPopulation(rows, 9, 0).capped, false);
  assert.equal(listingPopulation(rows, 9, 0).listingCount, 40);
});

test('appendListingRows with limit 0 stores the full book', () => {
  const target = [];
  const incoming = Array.from({ length: 30 }, (_, index) => row(index + 1, 50));
  assert.equal(appendListingRows(target, incoming, 1_000_000, 0), false);
  assert.equal(target.length, 30);
});

test('facet flags keep french-graded-1st-NM-reverse as separate bits', () => {
  assert.deepEqual(
    listingFacetFlags({
      pokemon_language: 'fr',
      condition: 'Near Mint',
      pokemon_reverse: true,
      first_edition: true,
      graded: true,
    }, { graded: true }),
    { reverse: true, firstEdition: true, graded: true },
  );
  assert.deepEqual(listingFacetFlags({ pokemon_reverse: false }), {
    reverse: false,
    firstEdition: false,
    graded: false,
  });
});
