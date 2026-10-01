import assert from 'node:assert/strict';
import test from 'node:test';
import { explainQuery } from './search-score.js';
import {
  isLiveStub,
  liveSuggestGroups,
  rememberSuggestGroups,
  resetSuggestLive,
  stubPrinting,
} from './suggest-live.js';

const single = (id, name, set, number, fields = {}) => ({
  id, name, set, number, nationality: 'western',
  itemKind: 'single', productType: 'card', ...fields,
});

function groupsOf(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.name)) {
      groups.set(row.name, { name: row.name, printings: [] });
    }
    groups.get(row.name).printings.push(row);
  }
  return [...groups.values()];
}

function remember(rows) {
  resetSuggestLive();
  rememberSuggestGroups(groupsOf(rows));
}

const rowsFor = (query, options = {}) => liveSuggestGroups(query, {
  kind: 'singles', ...options,
}).groups.flatMap((group) => group.printings);
const idsFor = (query, options) => rowsFor(query, options).map((row) => row.id);
const score = (query, row, options) => explainQuery(query, row, options).score;

// Card identities and collector numbers model real catalog printings; ids are
// fixture-local. Keep the reported regular Mewtwo as well as both EX rarities.
const mewtwo = [
  single('mewtwo-base', 'Mewtwo', 'Base Set', '10/102'),
  single('mewtwo-ex-nd', 'Mewtwo ex', 'Next Destinies', '54/99'),
  single('mewtwo-evol', 'Mewtwo', 'Evolutions', '51/108'),
  single('mewtwo-ex-evol', 'Mewtwo ex', 'Evolutions', '52/108'),
  single('mewtwo-ex-fa', 'Mewtwo ex', 'Evolutions', '103/108'),
  single('switch-evol', 'Switch', 'Evolutions', '88/108'),
  single('exeggutor-evol', 'Exeggutor', 'Evolutions', '109/108'),
  single('potion-evol', 'Potion', 'Evolutions', '83/108'),
];

test('name + set balances typo and exact spelling without any card-specific rule', () => {
  const cases = [
    {
      queries: ['mewtwo evol', 'mewtow evol', 'evol mewtow'],
      rows: mewtwo,
      full: 'mewtwo-evol', mechanic: 'mewtwo-ex-evol',
      nameOnly: 'mewtwo-base', contextOnly: 'switch-evol',
    },
    {
      queries: ['charizard evol', 'charziard evol', 'evol charziard'],
      rows: [
        single('charizard-base', 'Charizard', 'Base Set', '4/102'),
        single('charizard-evol', 'Charizard', 'Evolutions', '11/108'),
        single('charizard-ex-evol', 'Charizard ex', 'Evolutions', '12/108'),
        single('switch-evol', 'Switch', 'Evolutions', '88/108'),
      ],
      full: 'charizard-evol', mechanic: 'charizard-ex-evol',
      nameOnly: 'charizard-base', contextOnly: 'switch-evol',
    },
    {
      queries: ['palkia plas', 'palkai plas', 'plas palkai'],
      rows: [
        single('palkia-col', 'Palkia', 'Call of Legends', '11/95'),
        single('palkia-plasma', 'Palkia', 'Plasma Blast', '40/101'),
        single('palkia-ex-plasma', 'Palkia ex', 'Plasma Blast', '66/101'),
        single('switch-plasma', 'Energy Switch', 'Plasma Storm', '112/135'),
      ],
      full: 'palkia-plasma', mechanic: 'palkia-ex-plasma',
      nameOnly: 'palkia-col', contextOnly: 'switch-plasma',
    },
  ];
  for (const entry of cases) {
    remember(entry.rows);
    for (const query of entry.queries) {
      const ids = idsFor(query);
      assert.equal(ids[0], entry.full, query);
      assert.ok(ids.indexOf(entry.full) < ids.indexOf(entry.mechanic), query);
      assert.ok(ids.includes(entry.nameOnly), query + ' keeps the name-only reading');
      assert.ok(ids.includes(entry.contextOnly), query + ' keeps contextual fallback');
      assert.ok(ids.indexOf(entry.nameOnly) < ids.indexOf(entry.contextOnly),
        query + ' ranks a plausible name typo over a broad set prefix');
      assert.ok(score(query, entry.rows.find((row) => row.id === entry.nameOnly))
        > score(query, entry.rows.find((row) => row.id === entry.contextOnly)),
      query + ' also calibrates each printing independently of its name group');
    }
  }
});

test('regular and EX printings from the set all precede other-set name matches', () => {
  remember(mewtwo);
  for (const query of ['mewtwo evol', 'mewtow evol']) {
    assert.deepEqual(new Set(idsFor(query).slice(0, 3)), new Set([
      'mewtwo-evol', 'mewtwo-ex-evol', 'mewtwo-ex-fa',
    ]), query);
  }
});

test('typing the mechanic promotes it; metadata cannot erase an untyped name word', () => {
  remember(mewtwo);
  assert.equal(idsFor('mewtow evol')[0], 'mewtwo-evol');
  const typed = idsFor('mewtow ex evol');
  assert.ok(typed.indexOf('mewtwo-ex-evol') < typed.indexOf('mewtwo-evol'));
  assert.ok(typed.indexOf('mewtwo-ex-fa') < typed.indexOf('mewtwo-evol'));

  const regular = single('charizard', 'Charizard', 'Base Set', '4/102', {
    artist: 'Mitsuhiro Arita', rarity: 'Holo Rare',
  });
  const longer = single('dark-charizard', 'Dark Charizard', 'Team Rocket', '4/82', {
    artist: 'Mitsuhiro Arita', rarity: 'Holo Rare',
  });
  for (const query of ['charizard', 'charizard arita', 'charizard holo', 'charizard 4']) {
    assert.ok(score(query, regular) > score(query, longer), query);
  }
  for (const query of ['mewtwo evol', 'mewtwo mewtwo evol', 'mewtwo mewtow evol']) {
    assert.ok(score(query, mewtwo[2]) > score(query, mewtwo[3]),
      query + ' cannot count the same matched name word twice');
  }
});

test('mixed rarity, illustrator, and collector queries lead with complete readings', () => {
  const cases = [
    {
      query: 'charziard holo', leading: 'charizard-holo',
      rows: [
        single('charizard-holo', 'Charizard', 'Evolutions', '11/108', { rarity: 'Holo Rare' }),
        single('charizard-name', 'Charizard', 'Expedition Base Set', '40/165', { rarity: 'Rare' }),
        single('chansey-holo', 'Chansey', 'Base Set', '3/102', { rarity: 'Holo Rare' }),
      ],
    },
    {
      query: 'pikahcu komiya', leading: 'pikachu-komiya',
      rows: [
        single('pikachu-komiya', 'Pikachu', 'Legendary Treasures', 'RC7/RC25', { artist: 'Tomokazu Komiya' }),
        single('pikachu-name', 'Pikachu', 'Base Set', '58/102', { artist: 'Mitsuhiro Arita' }),
        single('garchomp-komiya', 'Garchomp', 'Ultra Prism', '99/156', { artist: 'Tomokazu Komiya' }),
      ],
    },
    {
      query: 'shiledon 061', leading: 'shieldon-number',
      rows: [
        single('shieldon-number', 'Shieldon', 'Mysterious Treasures', '61/123'),
        single('shieldon-name', 'Shieldon', 'Ultra Prism', '84/156'),
        single('poliwhirl-number', 'Poliwhirl', 'Base Set', '38/102'),
        single('machop-number', 'Machop', 'Evolutions', '61/108'),
      ],
    },
  ];
  for (const entry of cases) {
    remember(entry.rows);
    assert.equal(idsFor(entry.query)[0], entry.leading, entry.query);
    assert.equal(explainQuery(entry.query, entry.rows[0]).coverage, 2, entry.query);
  }
});

test('set aliases and compound names retain the coverage-first interpretation', () => {
  const rows = [
    single('palkia-col', 'Palkia', 'Call of Legends', '11/95'),
    single('palkia-ge', 'Palkia', 'Great Encounters', '26/106'),
    single('palkia-legend', 'Palkia & Dialga LEGEND', 'Triumphant', '101/102'),
    single('dialga', 'Dialga', 'Stellar Crown', '127/142'),
    single('lugia-col', 'Lugia', 'Call of Legends', '15/95'),
  ];
  remember(rows);
  assert.equal(idsFor('palkai sl')[0], 'palkia-col');
  assert.equal(idsFor('palkia legen')[0], 'palkia-legend');
  assert.equal(idsFor('pakia dialga legend')[0], 'palkia-legend');
});

test('a weaker sibling cannot jump ahead of a stronger printing in another group', () => {
  remember(mewtwo);
  const ids = idsFor('mewtow evol');
  assert.ok(ids.indexOf('mewtwo-ex-evol') < ids.indexOf('mewtwo-base'));
  assert.ok(ids.indexOf('mewtwo-base') < ids.indexOf('mewtwo-ex-nd'),
    'the two-token EX hit does not drag its other-set sibling above regular Mewtwo');
  const ranked = rowsFor('mewtow evol');
  for (let index = 1; index < ranked.length; index += 1) {
    assert.ok(score('mewtow evol', ranked[index - 1]) >= score('mewtow evol', ranked[index]),
      ranked[index - 1].id + ' must not precede a stronger ' + ranked[index].id);
  }
});

test('cache arrival, group order, row order and duplicate hydration do not change ranking', () => {
  const permutations = [
    mewtwo,
    [...mewtwo].reverse(),
    [...mewtwo.slice(3), ...mewtwo.slice(0, 3)],
  ];
  let expected;
  for (const rows of permutations) {
    resetSuggestLive();
    for (const row of rows) {
      rememberSuggestGroups(groupsOf([row]));
    }
    rememberSuggestGroups(groupsOf([...rows].reverse()));
    const actual = idsFor('mewtow evol');
    expected ||= actual;
    assert.deepEqual(actual, expected);
  }
});

test('warming an unrelated set cannot insert context-only cards above name matches', () => {
  remember(mewtwo.filter((row) => row.name.startsWith('Mewtwo')));
  const before = idsFor('mewtow evol');
  rememberSuggestGroups(groupsOf(mewtwo.filter((row) => !row.name.startsWith('Mewtwo'))));
  const after = idsFor('mewtow evol');
  assert.deepEqual(after.slice(0, before.length), before);
});

test('top 20 contains unique real eligible printings after scope and print filters', () => {
  // The same card can be hydrated under multiple regional/catalog cache keys.
  const eligible = Array.from({ length: 24 }, (_, index) => single(
    'eligible-' + String(index).padStart(2, '0'), 'Mewtwo', 'Evolutions', '51/108',
  ));
  remember(eligible);
  rememberSuggestGroups([
    { name: 'catalog:duplicate', printings: [...eligible].reverse() },
    { name: 'Mewtwo', printings: [
      stubPrinting('Mewtwo'),
      single('jp', 'Mewtwo', 'Expansion Pack 20th Anniversary', '49/87', { nationality: 'japanese' }),
      single('jumbo', 'Mewtwo', 'Evolutions', '51/108', { productType: 'jumbo', itemKind: 'product' }),
    ] },
    { name: 'Mewtwo ex Box', printings: [
      single('sealed', 'Mewtwo ex Box', 'Evolutions', '', { itemKind: 'product', productType: 'product' }),
    ] },
  ]);
  for (const query of ['mewtwo', 'mewtow evol']) {
    const rows = rowsFor(query, { printLang: 'western' });
    assert.equal(rows.length, 20, query + ' fills from the globally ranked eligible cards');
    assert.equal(new Set(rows.map((row) => row.id)).size, 20, query);
    assert.ok(rows.every((row) => row.id.startsWith('eligible-') && !isLiveStub(row)), query);
  }
  const product = idsFor('mewtow evol', { kind: 'product', printLang: 'western' });
  assert.deepEqual(new Set(product), new Set(['jumbo', 'sealed']));
  assert.deepEqual(idsFor('mewtow evol', { kind: 'users' }), []);
  assert.deepEqual(idsFor('mewtow evol', { printLang: 'japanese' }), ['jp']);
});

test('selected title language uses the same specificity rule and ignores stale translations', () => {
  const regular = single('de-regular', 'Mewtwo', 'Evolutions', '51/108', {
    localized_name: 'Mewtu', localized_set: 'Evolution', search_lang: 'de',
  });
  const mechanic = single('de-ex', 'Mewtwo ex', 'Evolutions', '52/108', {
    localized_name: 'Mewtu ex', localized_set: 'Evolution', search_lang: 'de',
  });
  remember([regular, mechanic]);
  assert.equal(idsFor('mewtu evolution', { searchLang: 'de' })[0], 'de-regular');
  assert.ok(score('mewtu evolution', regular, { lang: 'de' })
    > score('mewtu evolution', mechanic, { lang: 'de' }));
  const stale = { ...regular, localized_name: 'Glurak', search_lang: 'it' };
  assert.equal(explainQuery('glurak', stale, { lang: 'de' }).coverage, 0);
});
