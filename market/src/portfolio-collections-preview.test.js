import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCollections } from './portfolio-collections.js';
import { PREVIEW_COLLECTIONS, previewCollectionsFrom } from './portfolio-collections-preview.js';
import { COLLECTIONS_LEVEL, segmentGroups } from './portfolio-segments.js';

const SERIES = [
  { date: '2026-11-15', cardsValuePkn: null, cardsHeld: 0 },
  { date: '2026-11-16', cardsValuePkn: 1000, cardsHeld: 20 },
  { date: '2026-11-17', cardsValuePkn: 1100, cardsHeld: 20 },
  { date: '2026-11-18', cardsValuePkn: 1045, cardsHeld: 20 },
];

const BINDER = PREVIEW_COLLECTIONS[0].items.reduce((acc, item) => acc + item.pricePkn * item.quantity, 0);

test('the preview fixture is the two lists the layout shows', () => {
  assert.deepEqual(PREVIEW_COLLECTIONS.map((row) => row.name), ['Charizard binder', 'What if: 2023 sealed']);
  assert.equal(PREVIEW_COLLECTIONS[0].items.length, 6);
  assert.equal(PREVIEW_COLLECTIONS[1].items.length, 3);
  assert.equal(PREVIEW_COLLECTIONS[1].items.filter((item) => item.pricePkn == null).length, 1, 'one box nobody has sold');
  for (const collection of PREVIEW_COLLECTIONS) {
    for (const item of collection.items) assert.match(item.cardId, /^\d+$/, 'public card ids only');
  }
});

test('the preview series derives from the history and is the same twice', () => {
  const first = previewCollectionsFrom(SERIES);
  assert.deepEqual(previewCollectionsFrom(SERIES), first, 'deterministic: no clock, no randomness');
  assert.deepEqual(first.days.map((day) => day.segments && Object.keys(day.segments).length), [0, 2, 2, 2], 'a day with no book value has no split');
  assert.deepEqual(first.segmentDefs.map((def) => def.group), ['collection', 'collection']);
  const binder = first.days[1].segments['collection:preview-charizard'];
  assert.ok(Math.abs(binder[0] - BINDER) / BINDER < 0.02, `day one is the sum of the prices: ${binder[0]} vs ${BINDER}`);
  assert.deepEqual(binder.slice(1), [7, 7], 'every copy of a priced list is priced');
  const sealed = first.days[2].segments['collection:preview-whatif'];
  assert.deepEqual(sealed.slice(1), [4, 6], 'the unsold box is held but not priced');
  assert.ok(sealed[0] > 0 && sealed[0] < 1310, `the unsold box is out of the value: ${sealed[0]}`);
  // The line follows the book up and back down inside a few percent.
  const path = first.days.slice(1).map((day) => day.segments['collection:preview-charizard'][0]);
  assert.ok(path[1] > path[0] && path[2] < path[1], `it moves with the book: ${path.join(', ')}`);
  for (const value of path) assert.equal(Math.round(value * 100) / 100, value, 'to the cent');
});

test('the answer normalizes into the rows the Collections level tables', () => {
  const state = normalizeCollections(previewCollectionsFrom(SERIES));
  assert.equal(state.collections.length, 2);
  assert.deepEqual(state.model.defs.map((def) => def.label), ['Charizard binder', 'What if: 2023 sealed']);
  const rows = segmentGroups({ defs: [], days: [], collections: state.model }, COLLECTIONS_LEVEL, {})[0].rows;
  assert.deepEqual(rows.map((row) => row.label), ['Charizard binder', 'What if: 2023 sealed']);
  assert.deepEqual(rows.map((row) => row.state), ['ok', 'ok']);
  assert.deepEqual(rows.map((row) => row.held), [7, 6]);
  assert.equal(rows[0].series.length, 4, 'the window is the history window');
  assert.deepEqual(previewCollectionsFrom([]).days, []);
  assert.deepEqual(previewCollectionsFrom('junk').days, []);
  assert.deepEqual(previewCollectionsFrom(SERIES, []).segmentDefs, []);
});
