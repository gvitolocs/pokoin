import assert from 'node:assert/strict';
import test from 'node:test';
import * as scoring from './search-score.js';
import { typedModifiers } from './suggest-rank.js';
import {
  liveSuggestGroups,
  rememberSuggestGroups,
  resetSuggestLive,
} from './suggest-live.js';

const printing = (id, name, set, number = '') => ({
  id, name, set, number, nationality: 'western',
  itemKind: 'single', productType: 'card',
});

function remember(rows) {
  resetSuggestLive();
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.name)) {
      groups.set(row.name, { name: row.name, printings: [] });
    }
    groups.get(row.name).printings.push(row);
  }
  rememberSuggestGroups([...groups.values()]);
}

const popupRows = (query) => liveSuggestGroups(query, { kind: 'singles' })
  .groups.flatMap((group) => group.printings);
const explain = (query, row) => scoring.explainQuery(query, row);

const matrix = [
  {
    name: 'Mewtwo', typo: 'mewtow', prefixes: ['e', 'ev', 'evo', 'evol'],
    rows: [
      printing('base', 'Mewtwo', 'Base Set', '10/102'),
      printing('target', 'Mewtwo', 'Evolutions', '51/108'),
      printing('ambiguous', 'Mewtwo', 'Expedition Base Set', '56/165'),
      printing('mechanic', 'Mewtwo ex', 'Evolutions', '52/108'),
      printing('full-art', 'Mewtwo ex', 'Evolutions', '103/108'),
      printing('context-only', 'Switch', 'Evolutions', '88/108'),
      printing('other-context', 'Exeggutor', 'Evolutions', '109/108'),
    ],
  },
  {
    name: 'Charizard', typo: 'charziard', prefixes: ['e', 'ev', 'evo', 'evol'],
    rows: [
      printing('base', 'Charizard', 'Base Set', '4/102'),
      printing('target', 'Charizard', 'Evolutions', '11/108'),
      printing('ambiguous', 'Charizard', 'Expedition Base Set', '40/165'),
      printing('mechanic', 'Charizard ex', 'Evolutions', '12/108'),
      printing('context-only', 'Switch', 'Evolutions', '88/108'),
    ],
  },
  {
    name: 'Palkia', typo: 'palkai', prefixes: ['p', 'pl', 'pla', 'plas'],
    rows: [
      printing('base', 'Palkia', 'Great Encounters', '26/106'),
      printing('target', 'Palkia', 'Plasma Blast', '40/101'),
      printing('mechanic', 'Palkia ex', 'Plasma Blast', '66/101'),
      printing('context-only', 'Energy Switch', 'Plasma Storm', '112/135'),
    ],
  },
  {
    name: 'Pikachu', typo: 'pikahcu', prefixes: ['b', 'ba', 'bas', 'base'],
    rows: [
      printing('base', 'Pikachu', 'Evolutions', '35/108'),
      printing('target', 'Pikachu', 'Base Set', '58/102'),
      printing('ambiguous', 'Pikachu', 'Brilliant Stars', '50/172'),
      printing('context-only', 'Switch', 'Base Set', '95/102'),
    ],
  },
];

test('trailing set prefixes rank the printing from the first contextual letter', () => {
  for (const entry of matrix) {
    remember(entry.rows);
    const target = entry.rows.find((row) => row.id === 'target');
    const base = entry.rows.find((row) => row.id === 'base');
    for (const name of [entry.name, entry.typo]) {
      for (const prefix of entry.prefixes) {
        const query = name + ' ' + prefix;
        const rows = popupRows(query);
        const ids = rows.map((row) => row.id);
        assert.ok(ids.includes('target'), query + ' keeps the regular printing');
        assert.ok(ids.indexOf('target') < 2, query + ' brings it among the first results');
        assert.ok(explain(query, target).score > explain(query, base).score,
          query + ' uses set evidence rather than alphabetical cache tie-breaking');
        assert.ok(ids.indexOf('target') < ids.indexOf('base'), query);

        // A cached set match cannot make a card with an unrelated name lead.
        const firstContext = rows.findIndex((row) => row.id.includes('context'));
        if (firstContext >= 0) {
          assert.ok(firstContext > ids.indexOf('base'), query);
        }
      }
    }
  }
});

test('one- and two-letter context adds quality without claiming a whole token match', () => {
  for (const entry of matrix) {
    const target = entry.rows.find((row) => row.id === 'target');
    for (const name of [entry.name, entry.typo]) {
      const nameOnly = explain(name, target);
      for (const prefix of entry.prefixes.filter((word) => word.length <= 2)) {
        const contextual = explain(name + ' ' + prefix, target);
        assert.equal(contextual.coverage, nameOnly.coverage, name + ' ' + prefix);
        assert.ok(contextual.quality > nameOnly.quality, name + ' ' + prefix);
      }
      for (const prefix of entry.prefixes.filter((word) => word.length >= 3)) {
        assert.equal(explain(name + ' ' + prefix, target).coverage, 2,
          'completed contextual evidence still uses normal token coverage');
      }
    }
  }
});

test('ambiguous early prefixes keep competing sets and do not amplify metadata-only rows', () => {
  const entry = matrix[0];
  remember(entry.rows);
  for (const name of ['mewtwo', 'mewtow']) {
    assert.deepEqual(new Set(popupRows(name + ' e').slice(0, 2).map((row) => row.id)),
      new Set(['target', 'ambiguous']), name + ' e matches Evolutions and Expedition');
    assert.equal(popupRows(name + ' ev')[0].id, 'target',
      name + ' ev narrows the prefix using the same score');

    const unrelated = entry.rows.find((row) => row.id === 'context-only');
    for (const prefix of ['e', 'ev']) {
      const actual = explain(name + ' ' + prefix, unrelated);
      assert.equal(actual.coverage, 0);
      assert.equal(actual.score, explain(name, unrelated).score,
        'an unrelated set card gets no early-context boost');
      assert.ok(!popupRows(name + ' ' + prefix).some((row) => row.id === unrelated.id));
    }
  }
});

test('early prefix quality does not stand in for missing name evidence or expand a mechanic', () => {
  const regular = matrix[0].rows.find((row) => row.id === 'target');
  const mechanic = printing('ex', 'Mewtwo ex', 'Next Destinies', '54/99');
  for (const query of ['e', 'ev']) {
    assert.equal(explain(query, regular).coverage, 0);
    assert.equal(explain(query, regular).quality, explain('', regular).quality);
    assert.equal(explain(query, mechanic).coverage, 0,
      query + ' does not turn into EX name evidence');
  }
  for (const row of [regular, printing('base', 'Mewtwo', 'Base Set', '10/102')]) {
    assert.equal(explain('e mewtwo', row).score, explain('mewtwo', row).score,
      'early contextual quality is for an unfinished trailing word');
  }
});

test('EX printings remain eligible while the trailing set prefix grows through ev', () => {
  remember(matrix[0].rows);
  for (const name of ['mewtwo', 'mewtow']) {
    for (const prefix of ['e', 'ev', 'evo', 'evol']) {
      const ids = popupRows(name + ' ' + prefix).map((row) => row.id);
      assert.ok(ids.includes('mechanic'), name + ' ' + prefix + ' retains regular EX');
      assert.ok(ids.includes('full-art'), name + ' ' + prefix + ' retains full-art EX');
      assert.ok(ids.indexOf('target') < ids.indexOf('mechanic'),
        'the untyped mechanic still carries its normal specificity penalty');
    }
  }
});

test('short mechanic words remain exact and cannot become contextual prefixes', () => {
  const cases = [
    ['mewtwo ex', 'Mewtwo ex', 'Next Destinies', 'Mewtwo', 'Expedition Base Set'],
    ['pikachu gx', 'Pikachu GX', 'SM Black Star Promos', 'Pikachu', 'Gym Challenge'],
    ['pikachu v', 'Pikachu V', 'Vivid Voltage', 'Pikachu VMAX', 'Vivid Voltage'],
  ];
  for (const [query, exactName, exactSet, otherName, otherSet] of cases) {
    const exact = explain(query, printing('exact', exactName, exactSet));
    const other = explain(query, printing('other', otherName, otherSet));
    assert.equal(exact.perToken.at(-1).via, 'name-exact', query);
    assert.equal(other.perToken.at(-1).via, 'none',
      query + ' never prefix-expands a mechanic into a name or expansion');
    assert.ok(exact.score > other.score, query);
  }
});

test('mechanic suffix recognition respects typed word boundaries and joined legacy queries', () => {
  for (const query of ['mewtwo ev', 'mewtow ev', 'pikachu sv']) {
    assert.deepEqual(typedModifiers(query).mods, [], query + ' is not the V mechanic');
  }
  for (const [query, modifier] of [
    ['mewtwo ex', 'ex'], ['pikachu gx', 'gx'], ['pikachu v', 'v'],
    ['pikachugx', 'gx'], ['mewtwoex', 'ex'],
  ]) {
    assert.deepEqual(typedModifiers(query).mods, [modifier], query);
  }
});

test('early set-prefix hydration resolves a canonical anchor using catalog evidence', () => {
  assert.equal(typeof scoring.earlySetPrefixName, 'function');
  const helper = scoring.earlySetPrefixName;
  for (const [query, name] of [
    ['mewtwo e', 'Mewtwo'],
    ['mewtow ev', 'Mewtwo'],
    ['mewtwo evo', 'Mewtwo'],
    ['charziard e', 'Charizard'],
    ['chariz ev', 'Charizard'],
    ['palkai pl', 'Palkia'],
    ['pikahcu bas', 'Pikachu'],
    ['Palkia & Dialga LEGEND e', 'Palkia & Dialga LEGEND'],
  ]) {
    assert.equal(helper(query), name, query);
  }
});

test('early hydration requires both a plausible name and a genuine unfinished set prefix', () => {
  assert.equal(typeof scoring.earlySetPrefixName, 'function');
  for (const query of [
    '', 'e', 'ev', 'evo', 'mewtwo', 'mewtwo evol', 'mewtwo zzz',
    'definitelynotacardname e', 'mewtwo nonsense e',
    'mewtwo ex', 'pikachu gx', 'pikachu v', 'e mewtwo',
  ]) {
    assert.equal(scoring.earlySetPrefixName(query), '', query);
  }
});

test('short prefix ranking stays stable when cached printings arrive in reverse order', () => {
  const rows = matrix[0].rows;
  const expected = new Map();
  for (const query of ['mewtwo e', 'mewtwo ev', 'mewtwo evo', 'mewtow ev']) {
    remember(rows);
    expected.set(query, popupRows(query).map((row) => row.id));
    remember([...rows].reverse());
    assert.deepEqual(popupRows(query).map((row) => row.id), expected.get(query), query);
  }
});
