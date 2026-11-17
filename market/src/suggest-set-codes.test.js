import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTypedQuery } from './suggest-rank.js';
import {
  parseResolutionParam,
  resolveSuggestQuery,
  serializeResolution,
} from './suggest-resolve.js';
import {
  liveSuggestGroups,
  rememberPrintings,
  resetSuggestLive,
} from './suggest-live.js';

/** Every Flareon printing the owner saw in the `flareon dex` results. */
const FLAREON_PRINTINGS = [
  ['Radiant Collection', 'Flareon ex'],
  ['Watson 2006 World Championships', 'Flareon'],
  ['EX Delta Species', 'Flareon EX'],
  ['Prismatic Evolutions', 'Flareon ex'],
  ['Dark Explorers', 'Flareon'],
].map(([set, name], index) => ({
  id: `flareon-${index}`,
  name,
  set,
  set_name: set,
  product_type: 'card',
  item_kind: 'single',
}));

const POOL = [{ display: 'Flareon', prior: 300 }];

/** Set displays the Singles peel took off the query. */
function peeledSets(query) {
  return parseTypedQuery(query).setTokens.flatMap((token) => token.setNames);
}

function setNames(query) {
  return resolveSuggestQuery(query).best.entities.set.map((entity) => entity.display);
}

function nameNames(query) {
  return resolveSuggestQuery(query).best.entities.name.map((entity) => entity.display);
}

function paintedSets(query) {
  resetSuggestLive();
  rememberPrintings('Flareon', FLAREON_PRINTINGS);
  return liveSuggestGroups(query, { pool: POOL }).groups
    .flatMap((group) => group.printings.map((printing) => printing.set_name || printing.set));
}

test('a set short name binds its expansion and leaves the card name alone', () => {
  for (const [query, display] of [
    ['flareon dex', 'Dark Explorers'],
    ['pikachu plf', 'Plasma Freeze'],
    ['eevee bkt', 'BREAKthrough'],
    ['blastoise pre', 'Prismatic Evolutions'],
    ['charizard svi', 'Scarlet & Violet'],
    ['palkia evo', 'Evolutions'],
  ]) {
    assert.deepEqual(setNames(query), [display], query);
    assert.ok(nameNames(query).length, `${query} keeps its card name`);
  }
});

test('a code whose letters end in a mechanic tail still reads as the set', () => {
  // Neither token is in the name pool, so the `…ex` / `…v` tail is not a suffix.
  assert.deepEqual(setNames('pikachu neorev'), ['Neo Revelation']);
  assert.deepEqual(setNames('charizard sv1v'), ['Violet ex']);
});

test('a name suffixed with ex keeps its meaning next to a code', () => {
  assert.deepEqual(nameNames('flareon ex'), ['Flareon ex']);
  assert.equal(resolveSuggestQuery('flareon ex').best.entities.set.length, 0);

  // The ex-suffixed name plus a code is still the name, now in that expansion.
  assert.deepEqual(nameNames('flareon ex dex'), ['Flareon ex']);
  assert.deepEqual(setNames('flareon ex dex'), ['Dark Explorers']);
});

test('short codes are set intent in the peel that paints Singles', () => {
  for (const [query, display] of [
    ['flareon dex', 'Dark Explorers'],
    ['eevee bkt', 'BREAKthrough'],
    ['palkia evo', 'Evolutions'],
  ]) {
    assert.ok(peeledSets(query).includes(display), `${query} peels ${display}`);
  }
});

test('the typeahead leads with the code expansion', () => {
  const bare = paintedSets('flareon');
  assert.ok(bare.includes('Dark Explorers'), 'bare Flareon lists every printing');
  assert.ok(bare.length > 1, 'bare Flareon is not already one set');
  assert.equal(paintedSets('flareon dex')[0], 'Dark Explorers');
});

test('the results page is scoped through the serialized set', () => {
  const serialized = serializeResolution(resolveSuggestQuery('flareon dex'));
  // The card name stays in `q` (the page ranks it); the code only rides as the
  // set filter, which is what the owner cannot express in free text today.
  assert.equal(serialized, 'set:Dark Explorers');
  assert.deepEqual(parseResolutionParam(serialized).sets, ['Dark Explorers']);
});

test('a code that is also a card name wins only beside another name', () => {
  // MEW is expansion 151's short name and Mew's own name.
  assert.deepEqual(nameNames('mew'), ['Mew']);
  assert.deepEqual(setNames('mew'), []);
  assert.deepEqual(nameNames('pikachu mew'), ['Pikachu']);
  assert.deepEqual(setNames('pikachu mew'), ['151']);
});

test('short codes do not steal a token from an existing reading', () => {
  // `ex` is a mechanic word, `sl` a two-letter era code, `i` a name letter.
  assert.deepEqual(peeledSets('palkia sl'), ['Call of Legends']);
  assert.equal(parseTypedQuery('flareon ex').setTokens.length, 0);
  assert.deepEqual(nameNames('eevee i'), ['Eevee']);
});
