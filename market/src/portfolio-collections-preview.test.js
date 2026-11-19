import assert from 'node:assert/strict';
import test from 'node:test';
import {
  itemPriceLine,
  newDraft,
  normalizeCollections,
  setItem,
} from './portfolio-collections.js';
import { createCollectionsStore } from './portfolio-collections-store.js';
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

test('the fixture prices every list from its own book, never from the write', () => {
  // A save body carries no price (the server resolves them), so a preview that
  // rebuilt its answer off the body would leave every item unpriced after it.
  const asked = [
    { ...PREVIEW_COLLECTIONS[0].items[0], quantity: 5, pricePkn: 1 },
    { game: 'pokemon', cardId: '999999', condition: 'NM', language: 'EN', quantity: 1, pricePkn: 777 },
  ];
  const answer = previewCollectionsFrom(SERIES, [{ id: 'moved', name: 'Moved list', items: asked }]);
  const [kept, unknown] = answer.collections[0].items;
  assert.equal(kept.pricePkn, 480, 'the price the book has for that slice, whatever the body said');
  assert.equal(unknown.pricePkn, null, 'a slice the book does not know is one nobody has sold');
  const items = normalizeCollections(answer).collections[0].items;
  assert.equal(itemPriceLine(items[0]), 'amount');
  assert.equal(itemPriceLine(items[1]), 'sold', 'and the row says the truth about it');
  // The moved quantity counts, so the list is worth more than it was.
  const day = answer.days.at(-1).segments['collection:moved'];
  assert.ok(day[0] > 480, `the row keeps a value: ${day[0]}`);
  assert.deepEqual(day.slice(1), [5, 6], 'the unsold card is held and not priced');
});

test('saving a changed list in preview keeps the prices of what was not touched', async () => {
  const store = createCollectionsStore({
    bearer: () => 't',
    fetchCollections: () => Promise.reject(new Error('the preview asks nothing')),
    saveCollection: () => Promise.reject(new Error('the preview asks nothing')),
    deleteCollection: () => Promise.reject(new Error('the preview asks nothing')),
    previewAnswer: (rows, seeding) => previewCollectionsFrom(SERIES, seeding ? PREVIEW_COLLECTIONS : rows),
  });
  await store.load('preview');
  const list = store.get().collections[0];
  const before = list.items.map((item) => item.pricePkn);
  const draft = setItem(newDraft(list), list.items[0].id, { quantity: 3 });
  const result = await store.save(draft);
  assert.equal(result.ok, true);
  const after = store.get().collections[0];
  assert.equal(after.items[0].quantity, 3, 'the change landed');
  assert.deepEqual(after.items.map((item) => item.pricePkn), before, 'every item is priced as it was');
  assert.deepEqual(after.items.map((item) => itemPriceLine(item)), after.items.map(() => 'amount'));
  const rows = segmentGroups({ defs: [], days: [], collections: store.model() }, COLLECTIONS_LEVEL, {})[0].rows;
  assert.equal(rows[0].state, 'ok', 'and the row still has a line to plot');
  assert.deepEqual(rows.map((row) => row.held), [9, 6], 'the changed copies count in the row');
  assert.ok(rows[0].valuePkn > 0);
});
