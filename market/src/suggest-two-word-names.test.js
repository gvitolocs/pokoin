/**
 * Two-word card names (`dark jolteon`, `light arcanine`, `rocket's zapdos`).
 *
 * The first word of these names is also the prefix of another Pokémon
 * (`dark` → Darkrai), so any stage that ranks only the first typed word buries
 * and finally drops the compound card. These fixtures paint through
 * `paintCatalogGroups`, the entry point SearchBox uses for the popup.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactQuery } from './suggest-rank.js';
import { catalogRecall } from './suggest-pool.js';
import { createRecallSearch, recallOrder } from './search-recall-core.js';
import { paintCatalogGroups, rememberSuggestGroups, resetSuggestLive } from './suggest-live.js';

const PAINT = { kind: 'singles', printLang: 'all', searchLang: 'en', limit: 20 };

function group(name, sets) {
  return {
    name,
    printings: sets.map(([id, set, number]) => ({
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}`,
      card_id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}`,
      name,
      set,
      set_name: set,
      number,
      card_number: number,
      product_type: 'card',
      itemKind: 'single',
      nationality: 'western',
    })),
  };
}

function paint(query, groups) {
  resetSuggestLive();
  rememberSuggestGroups(groups);
  return paintCatalogGroups(query, PAINT).flatMap((row) => (row.printings || []).map((p) => p.name));
}

const DARK_JOLTEON = group('Dark Jolteon', [['tr', 'Team Rocket', '38/82']]);
const DARK_JOLTEON_JP = group('Dark Jolteon Lv.23', [['rg', 'Rocket Gang', 'No.135']]);
const DARKRAI = group('Darkrai', [
  ['da', 'Darkness Ablaze', '105/189'],
  ['dr', 'Delta Specimen', '063/155'],
  ['tt', 'Trick or Trade', '105/189'],
  ['fs', 'Fusion Strike', '167/264'],
]);
const DARK_PATCH = group('Dark Patch', [['tm', 'Twilight Masquerade', '90/144']]);
const DARKNESS_ENERGY = group('Darkness Energy', [['bs', 'Base Set', '9/130']]);
const JOLTEON = group('Jolteon', [['de', 'Dark Explorers', '37/108'], ['dm', 'Delta Mythos', '41/83']]);

test('the exact two-word card name leads and is never dropped', () => {
  const rows = paint('dark jolteon', [DARK_JOLTEON, DARK_JOLTEON_JP, DARKRAI, DARK_PATCH, DARKNESS_ENERGY, JOLTEON]);
  assert.equal(rows[0], 'Dark Jolteon', `got ${rows.join(', ')}`);
});

test('a partially typed two-word name still beats the first word alone', () => {
  const rows = paint('dark jolte', [DARK_JOLTEON, DARK_JOLTEON_JP, DARKRAI, DARK_PATCH, DARKNESS_ENERGY, JOLTEON]);
  assert.equal(rows[0], 'Dark Jolteon', `got ${rows.join(', ')}`);
});

test('every first-word-is-another-species-prefix name resolves', () => {
  const cases = [
    ['dark charizard', 'Dark Charizard', 'Darkrai'],
    ['dark raichu', 'Dark Raichu', 'Darkrai'],
    ['dark blastoise', 'Dark Blastoise', 'Darkrai'],
    ['dark dragonite', 'Dark Dragonite', 'Darkrai'],
    ['light arcanine', 'Light Arcanine', 'Lightning Energy'],
    ['light pikachu', 'Light Pikachu', 'Lightning Energy'],
    ['shining magikarp', 'Shining Magikarp', 'Shining Celebi'],
    ["rocket's zapdos", "Rocket's Zapdos", "Rocket's Mewtwo"],
    ["brock's onix", "Brock's Onix", "Brock's Grit"],
  ];
  for (const [query, want, rival] of cases) {
    const rivalGroup = group(rival, [['r1', 'Darkness Ablaze', '1/1'], ['r2', 'Noble Rotaries', '2/2']]);
    const rows = paint(query, [group(want, [['x', 'Team Rocket', '1/82']]), rivalGroup]);
    assert.equal(rows[0], want, `${query} → ${rows.slice(0, 4).join(', ')}`);
    assert.ok(rows.includes(want), `${query} dropped ${want}`);
  }
});

test('the popup still fills toward twenty printings of the first word', () => {
  const many = group('Darkrai', Array.from({ length: 24 }, (_, index) => [`m${index}`, `Set ${index}`, `${index + 1}/100`]));
  const rows = paint('dark unknownspecies', [many, DARK_PATCH, DARKNESS_ENERGY]);
  assert.equal(rows.length, 20, `got ${rows.length}`);
  assert.ok(rows.every((name) => name.startsWith('Dark')), `got ${rows.join(', ')}`);
});

test('the results page recall lists the exact compound name before the stem', async () => {
  const server = {
    'dark jolteon': [{ id: 'dark-jolteon' }],
    dark: [
      { id: 'darkrai-1' },
      { id: 'darkrai-2' },
      { id: 'dark-patch' },
    ],
  };
  const search = createRecallSearch({
    pageSize: 2,
    fetchSearchPage: async ({ query, offset = 0, limit = 48 }) => {
      const all = server[String(query).trim()] || [];
      const cards = all.slice(offset, offset + limit);
      return { cards, total: all.length, hasMore: offset + cards.length < all.length, nextOffset: offset + cards.length };
    },
    recallLookups: async (query) => recallOrder(query, catalogRecall(query), compactQuery),
  });
  const page = await search({ query: 'dark jolteon', offset: 0, limit: 5, productType: 'card' });
  assert.deepEqual(page.recall, ['dark jolteon', 'dark']);
  assert.deepEqual(page.cards.map((card) => card.id), ['dark-jolteon', 'darkrai-1', 'darkrai-2', 'dark-patch']);
});
