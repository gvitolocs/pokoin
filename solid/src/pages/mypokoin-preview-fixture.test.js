import assert from 'node:assert/strict';
import test from 'node:test';
import { previewCollection, previewListings } from './mypokoin-preview-fixture.js';

test('every desk gets its own preview book', () => {
  const listings = previewListings();
  const collection = previewCollection();
  assert.ok(Array.isArray(listings), 'the listings desk reads an array');
  assert.ok(Array.isArray(collection.rows), 'the collection desk reads { rows }');
  assert.ok(Array.isArray(collection.listings));
  assert.equal(Object.keys(collection.asks).length, collection.rows.length, 'one ask per held row');
});

test('a repeated desk mount reuses the generated rows', () => {
  const listings = previewListings();
  assert.equal(previewListings(), listings, 'the book is handed back, not rebuilt');
  const rows = previewCollection().rows;
  assert.equal(previewCollection().rows, rows, 'so board derivations keyed by identity hit');
});
