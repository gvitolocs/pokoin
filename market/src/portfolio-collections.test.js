import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTIONS_LEVEL, normalizeSegments, segmentGroups, segmentLevels, withCollections } from './portfolio-segments.js';
import {
  addItem,
  collectionErrorMessage,
  collectionIdFromKey,
  collectionKey,
  draftErrors,
  DEFAULT_LIMITS,
  emptyCollections,
  errorCode,
  itemIdOf,
  nameProblem,
  newDraft,
  newItem,
  normalizeCollections,
  normalizeLimits,
  removeItem,
  saveBody,
  setItem,
} from './portfolio-collections.js';

function payload() {
  return {
    priceBasis: 'ct-last-sold',
    limits: { collections: 20, items: 300, quantity: 999, name: 40 },
    collections: [
      {
        id: 'c1',
        name: 'Charizard binder',
        createdAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-17T09:00:00Z',
        items: [
          { game: 'pokemon', cardId: '129552', condition: 'NM', language: 'EN', reverse: false, firstEdition: true, graded: false, quantity: 2, name: 'Charizard', setName: 'Base Set', pricePkn: 900 },
          { game: 'pokemon', cardId: '397269', condition: 'SP', language: 'JP', reverse: true, firstEdition: false, graded: true, quantity: 1, name: 'Charizard', setName: 'Team Up', pricePkn: null },
        ],
      },
      { id: 'c2', name: 'Sealed', items: [] },
    ],
    segmentDefs: [
      { key: 'collection:c1', group: 'collection', label: 'Charizard binder' },
      { key: 'game:pokemon', group: 'game', game: 'pokemon', label: 'Pokémon' },
    ],
    days: [
      { date: '2026-11-17', segments: { 'collection:c1': [1800, 2, 3], 'collection:c2': [0, 0, 0] } },
      { date: '2026-11-16', segments: { 'collection:c1': [1500, 2, 3] } },
    ],
  };
}

test('normalizeCollections answers limits, saved lists and a segments model', () => {
  const state = normalizeCollections(payload());
  assert.deepEqual(state.limits, DEFAULT_LIMITS);
  assert.equal(state.collections.length, 2);
  assert.equal(state.collections[0].name, 'Charizard binder');
  assert.equal(state.collections[0].items.length, 2);
  assert.deepEqual(state.collections[0].items[1], {
    id: 'pokemon|397269|SP|JP|R|-|G',
    game: 'pokemon',
    cardId: '397269',
    condition: 'SP',
    language: 'JP',
    reverse: true,
    firstEdition: false,
    graded: true,
    quantity: 1,
    name: 'Charizard',
    setName: 'Team Up',
    pricePkn: null,
  });
  assert.deepEqual(state.model.defs.map((def) => def.key), ['collection:c1', 'collection:c2']);
  assert.deepEqual(state.model.days.map((day) => day.date), ['2026-11-16', '2026-11-17']);
  assert.deepEqual(state.model.days[1].segments['collection:c1'], { valuePkn: 1800, priced: 2, held: 3 });
});

test('the model holds a def per saved collection even with nothing in it', () => {
  const state = normalizeCollections({ collections: [{ id: 'c9', name: 'Empty', items: [] }], days: [] });
  assert.deepEqual(state.model.defs, [{ key: 'collection:c9', group: 'collection', game: '', label: 'Empty', years: undefined }]);
  assert.deepEqual(state.model.days, []);
});

test('a missing or malformed answer is the empty state, never a throw', () => {
  for (const junk of [null, undefined, 'text', 42, [], {}, { collections: 'no' }, { collections: [{}] }, { days: [{}] }]) {
    const state = normalizeCollections(junk);
    assert.deepEqual(state.collections, []);
    assert.deepEqual(state.model, { defs: [], days: [] });
    assert.deepEqual(state.limits, DEFAULT_LIMITS);
  }
});

test('junk inside a saved list is dropped, not half-read', () => {
  const state = normalizeCollections({
    limits: { collections: 0, items: -5, quantity: 'x', name: null },
    collections: [
      { id: '', name: 'No id', items: [] },
      { id: 'c1', name: 'Mixed', items: [{ cardId: 'abc' }, { cardId: 12 }, { cardId: '12' }, { cardId: '13', quantity: 0 }, { cardId: '14', quantity: 99999 }] },
      { id: 'c1', name: 'Repeat', items: [] },
    ],
    segmentDefs: [{ key: 'collection:nope', group: 'collection', label: 'Gone' }, { key: 'x', group: 'nonsense' }],
    days: [{ date: 'not-a-day', segments: { 'collection:c1': [1, 1, 1] } }, { date: '2026-11-17', segments: { 'collection:c1': [-3, 1, 1] } }],
  });
  assert.deepEqual(state.limits, DEFAULT_LIMITS, 'limits fall back when they are not sensible');
  assert.deepEqual(state.collections.map((row) => row.id), ['c1']);
  assert.deepEqual(state.collections[0].items.map((item) => item.cardId), ['12', '13', '14'], 'a real id, once, with a usable quantity');
  assert.equal(state.collections[0].items[2].quantity, 999);
  assert.deepEqual(state.model.defs.map((def) => def.key), ['collection:nope', 'collection:c1']);
  assert.deepEqual(state.model.days, [], 'a day whose only entry is negative is not a day');
});

test('a def the server already sent is kept as it sent it', () => {
  const state = normalizeCollections({
    collections: [{ id: 'c1', name: 'Renamed', items: [] }],
    segmentDefs: [{ key: 'collection:c1', group: 'collection', label: 'Saved label', years: [2020, 2024] }],
    days: [{ date: '2026-11-17', segments: { 'collection:c1': [0, 0, 1] } }],
  });
  assert.deepEqual(state.model.defs, [{ key: 'collection:c1', group: 'collection', game: '', label: 'Saved label', years: [2020, 2024] }]);
});

test('emptyCollections is the state before any answer', () => {
  assert.deepEqual(emptyCollections(), { limits: DEFAULT_LIMITS, collections: [], model: { defs: [], days: [] } });
  assert.deepEqual(emptyCollections({ collections: 3 }).limits.collections, 3);
  assert.deepEqual(normalizeLimits(undefined), DEFAULT_LIMITS);
});

test('the key is the slice: id, condition, language and the three flags', () => {
  assert.equal(collectionKey(' c1 '), 'collection:c1');
  assert.equal(collectionKey(''), '');
  assert.equal(collectionIdFromKey('collection:c1'), 'c1');
  assert.equal(collectionIdFromKey('game:pokemon'), '');
  assert.equal(itemIdOf({ cardId: '1', condition: 'NM', language: 'EN' }), 'pokemon|1|NM|EN|-|-|-');
  assert.equal(
    itemIdOf({ cardId: 1, condition: 'Poor', language: 'en', reverse: 1, graded: 'true' }),
    'pokemon|1|Poor|EN|R|-|G',
    'a language is a code, a grade keeps the form the listing sends',
  );
});

test('newDraft starts from a saved list, and a card straight from search', () => {
  const saved = normalizeCollections(payload()).collections[0];
  const draft = newDraft(saved);
  assert.deepEqual(draft, { id: 'c1', name: 'Charizard binder', items: saved.items });
  assert.notEqual(draft.items[0], saved.items[0], 'the draft never writes through to the saved copy');
  assert.deepEqual(newDraft(null), { id: '', name: '', items: [] });
  assert.deepEqual(newDraft(undefined), { id: '', name: '', items: [] });
  const item = newItem({ id: '77', name: 'Pikachu', set: 'Surging Sparks', nationality: 'western' });
  assert.equal(item.cardId, '77');
  assert.equal(item.condition, 'NM');
  assert.equal(item.language, 'EN');
  assert.equal(item.quantity, 1);
  assert.equal(item.setName, 'Surging Sparks');
  assert.equal(item.pricePkn, null);
  assert.equal(newItem({ id: 77, game: 'riftbound' }).game, 'riftbound', 'the game the search row carries');
  assert.equal(newItem({ id: 'not-a-card-id' }), null, 'a result without a public card id is refused');
  assert.equal(newItem({ id: '3.5' }), null);
  assert.equal(newItem(null), null);
});

test('adding the same slice merges the quantity instead of doubling the row', () => {
  let draft = newDraft();
  draft = addItem(draft, { cardId: '1', name: 'Charizard', quantity: 2 });
  draft = addItem(draft, { cardId: '1', quantity: 3 });
  assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].quantity, 5);
  assert.equal(draft.items[0].name, 'Charizard', 'a merge keeps the name it already had');
  draft = addItem(draft, { cardId: '1', quantity: 999 });
  assert.equal(draft.items[0].quantity, 999, 'the merge stops at the server limit');
  const other = addItem(draft, { cardId: '1', condition: 'MP' });
  assert.deepEqual(other.items.map((item) => item.id), ['pokemon|1|NM|EN|-|-|-', 'pokemon|1|MP|EN|-|-|-']);
});

test('adding past the item limit leaves the draft alone', () => {
  const limits = { ...DEFAULT_LIMITS, items: 2 };
  let draft = newDraft();
  draft = addItem(draft, { cardId: '1' }, limits);
  draft = addItem(draft, { cardId: '2' }, limits);
  const refused = addItem(draft, { cardId: '3' }, limits);
  assert.deepEqual(refused, draft);
  assert.equal(addItem(draft, { cardId: 'bad' }, limits).items.length, 2);
});

test('remove one row, change one row, and a facet that lands on another row', () => {
  let draft = addItem(addItem(newDraft(), { cardId: '1', quantity: 2 }), { cardId: '2', quantity: 1 });
  assert.deepEqual(draft.items.map((item) => item.cardId), ['1', '2']);
  draft = removeItem(draft, 'pokemon|2|NM|EN|-|-|-');
  assert.deepEqual(draft.items.map((item) => item.cardId), ['1']);
  assert.deepEqual(removeItem(draft, 'nope'), draft);
  assert.equal(setItem(draft, 'pokemon|1|NM|EN|-|-|-', { quantity: 40 }).items[0].quantity, 40);
  assert.equal(setItem(draft, 'pokemon|1|NM|EN|-|-|-', { quantity: 5000 }).items[0].quantity, 999, 'the quantity stops at the limit');
  assert.equal(setItem(draft, 'pokemon|1|NM|EN|-|-|-', { quantity: 0 }).items[0].quantity, 1);
  assert.equal(setItem(draft, 'pokemon|1|NM|EN|-|-|-', { graded: true }).items[0].id, 'pokemon|1|NM|EN|-|-|G');
  assert.deepEqual(setItem(draft, 'gone', { quantity: 2 }), draft);
  const two = addItem(addItem(newDraft(), { cardId: '1', quantity: 4 }), { cardId: '1', condition: 'SP', quantity: 5 });
  const moved = setItem(two, 'pokemon|1|NM|EN|-|-|-', { condition: 'SP' });
  assert.deepEqual(moved.items.map((item) => item.id), ['pokemon|1|SP|EN|-|-|-'], 'the moved row is one row');
  assert.equal(moved.items[0].quantity, 9, 'and its quantity follows it');
  const fresh = setItem(two, 'pokemon|1|NM|EN|-|-|-', { language: 'JP' });
  assert.deepEqual(fresh.items.map((item) => item.id), ['pokemon|1|NM|JP|-|-|-', 'pokemon|1|SP|EN|-|-|-'], 'the row stays where it was');
  assert.equal(fresh.items[0].quantity, 4, 'a facet that is free moves the row on its own');
  assert.deepEqual(setItem(two, 'pokemon|1|NM|EN|-|-|-', { cardId: 'oops' }).items.map((item) => item.id), two.items.map((item) => item.id), 'a row without a usable id is left alone');
});

test('the name check: 1 to 40 characters, taken names compared case-insensitively', () => {
  const others = [{ name: 'Charizard binder' }, { name: 'Sealed' }];
  assert.equal(nameProblem('My Charizards', others), '');
  assert.equal(nameProblem('  My Charizards  ', others), '', 'padded first');
  assert.match(nameProblem('', others), /needs a name/i);
  assert.match(nameProblem('   ', others), /needs a name/i);
  assert.match(nameProblem('x'.repeat(41), others), /at most 40/);
  assert.equal(nameProblem('x'.repeat(40), others), '');
  assert.match(nameProblem('charizard BINDER', others), /already have/i);
  assert.match(nameProblem('Short', others, { ...DEFAULT_LIMITS, name: 4 }), /at most 4/);
  assert.equal(nameProblem('Anything', 'not a list'), '');
});

test('draftErrors lists every reason this draft cannot be saved', () => {
  const others = [{ name: 'Sealed' }];
  let draft = newDraft();
  assert.deepEqual(draftErrors(draft, others), ['A collection needs a name.', 'Add at least one card.']);
  draft = addItem({ ...draft, name: 'Sealed' }, { cardId: '1' });
  assert.deepEqual(draftErrors(draft, others), ['You already have a collection with that name.']);
  draft = { id: 'c1', name: 'Charizards', items: [{ id: 'pokemon|1|NM|EN|-|-|-', cardId: '1', quantity: 0 }] };
  assert.deepEqual(draftErrors(draft, others), ['Each card needs a quantity between 1 and 999.']);
  draft = { ...draft, items: [{ id: 'x', cardId: '1', quantity: 2 }, { id: 'x', cardId: '1', quantity: 3 }] };
  assert.deepEqual(draftErrors(draft, others), ['The collection lists the same card twice.']);
  draft = { ...draft, items: [{ id: 'x', cardId: 'not-an-id', quantity: 2 }] };
  assert.deepEqual(draftErrors(draft, others), ['Every card in the collection needs its card id.']);
  const full = Array.from({ length: 301 }, (_, index) => ({ id: `i${index}`, cardId: String(index), quantity: 1 }));
  assert.deepEqual(draftErrors({ name: 'Huge', items: full }, others), ['A collection holds up to 300 cards.']);
  const atLimit = Array.from({ length: 20 }, (_, index) => ({ id: `c${index}`, name: `List ${index}` }));
  assert.deepEqual(
    draftErrors({ name: 'One too many', items: [{ id: 'x', cardId: '1', quantity: 1 }] }, atLimit),
    ['You can keep up to 20 collections.'],
  );
  assert.deepEqual(
    draftErrors({ id: 'c20', name: 'Renamed', items: [{ id: 'x', cardId: '1', quantity: 1 }] }, atLimit),
    [],
    'renaming one of the existing lists is not the twenty-first',
  );
  assert.deepEqual(draftErrors({ name: 'Fine', items: [{ id: 'x', cardId: '1', quantity: 1 }] }, others), []);
});

test('the save body carries the items the server reads back', () => {
  const draft = newDraft({ id: 'c1', name: 'Charizard binder', items: [{ game: 'pokemon', cardId: '1', condition: 'NM', language: 'EN', reverse: false, firstEdition: true, graded: false, quantity: 2, name: 'Charizard', setName: 'Base Set', pricePkn: 900 }] });
  assert.deepEqual(saveBody(draft), {
    id: 'c1',
    name: 'Charizard binder',
    items: [{
      game: 'pokemon', cardId: '1', condition: 'NM', language: 'EN', reverse: false, firstEdition: true, graded: false, quantity: 2, name: 'Charizard', setName: 'Base Set', pricePkn: 900,
    }],
  });
  assert.equal('id' in saveBody(newDraft({ name: 'New', items: [] })), false, 'a new list sends no id');
  assert.equal(saveBody({ name: 'x', items: [{ id: 'slice', cardId: '1', quantity: 1 }] }).items[0].id, undefined, 'the client slice key stays home');
});

test('every error code reads as a sentence', () => {
  assert.equal(collectionErrorMessage('collection_name_required'), 'A collection needs a name.');
  assert.equal(collectionErrorMessage('collection_limit'), 'You can keep up to 20 collections. Delete one first.');
  assert.equal(collectionErrorMessage('collection_items_limit'), 'A collection holds up to 300 cards.');
  assert.equal(collectionErrorMessage('collection_item_invalid'), 'One of the cards in this collection is not a card we know.');
  assert.equal(collectionErrorMessage('collection_not_found'), 'That collection is not there any more.');
  assert.equal(collectionErrorMessage('collection_name_taken'), 'You already have a collection with that name.');
  assert.equal(collectionErrorMessage('COLLECTION_NAME_TAKEN'), collectionErrorMessage('collection_name_taken'));
  assert.equal(collectionErrorMessage('401'), 'Sign in again to save your collections.');
  assert.equal(collectionErrorMessage(''), 'Could not save the collection.');
  assert.equal(collectionErrorMessage(undefined), 'Could not save the collection.');
});

test('the code of a thrown request is the body code, else its status', () => {
  assert.equal(errorCode({ body: { code: 'collection_name_taken' }, status: 409 }), 'collection_name_taken');
  assert.equal(errorCode({ status: 401 }), '401');
  assert.equal(errorCode({ status: 0 }), '');
  assert.equal(errorCode(null), '');
  assert.equal(collectionErrorMessage(errorCode({ body: { code: 'collection_limit' } })), 'You can keep up to 20 collections. Delete one first.');
});

test('the model it hands over is a segments model the table can read', () => {
  const state = normalizeCollections(payload());
  const book = normalizeSegments({
    segmentDefs: [{ key: 'game:pokemon', group: 'game', game: 'pokemon', label: 'Pokémon' }, { key: 'pokemon:era:sv', group: 'era', game: 'pokemon', label: 'Scarlet & Violet' }],
    days: [
      { date: '2026-11-16', cardsValuePkn: 1400, segments: { 'game:pokemon': [1400, 9, 40] } },
      { date: '2026-11-17', cardsValuePkn: 1600, segments: { 'game:pokemon': [1600, 9, 40] } },
    ],
  });
  const model = withCollections(book, state.model);
  assert.deepEqual(segmentLevels(model).map((level) => level.id), ['all', 'pokemon', COLLECTIONS_LEVEL]);
  const rows = segmentGroups(model, COLLECTIONS_LEVEL, {})[0].rows;
  assert.deepEqual(rows.map((row) => [row.label, row.state, row.held, row.priced, row.valuePkn]), [
    ['Charizard binder', 'ok', 3, 2, 1800],
    ['Sealed', 'empty', 0, 0, 0],
  ]);
  assert.deepEqual(rows[0].series.map((point) => point.valuePkn), [1500, 1800]);
  assert.equal(rows[0].changePct, 20);
  assert.equal(rows[1].sub, '', 'the label comes from the saved name, not from a stale def');
  // The book's own levels are untouched by it.
  assert.deepEqual(segmentGroups(model, 'pokemon', {}).flatMap((group) => group.rows).map((row) => row.key), ['pokemon:era:sv']);
});
