import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exactSetAlias, isSetBadgeAlias, parseTypedQuery } from './suggest-rank.js';
import { paintCatalogGroups, rememberSuggestGroups, resetSuggestLive } from './suggest-live.js';

// Real `/api/marketplace-suggest?q=Espeon&hydrate=1` groups (2026-11-07, Pi API),
// trimmed to the fields the engine reads. The JP 30th Celebration Premium Deck Set
// rows come back with nationality "unknown" (leftover import, see
// scripts/sql/20261107_classify_unknown_expansions.sql); the SPA's bundled
// expansion nationality still knows the set is Japanese.
const ESPEON = JSON.parse(readFileSync(new URL('./test-fixtures/espeon-suggest.json', import.meta.url), 'utf8'));
const ESPEON_SIR_3CPD = '825090';

function popupIds(query, printLang = 'all') {
  resetSuggestLive();
  rememberSuggestGroups(structuredClone(ESPEON), { searchLang: 'en' });
  return paintCatalogGroups(query, { printLang, searchLang: 'en', kind: '', limit: 20 })
    .flatMap((group) => group.printings.map((printing) => String(printing.id)));
}

test('the set chip badge is an exact set alias', () => {
  assert.deepEqual(exactSetAlias('3CPD')?.setNames, ['30th Celebration Premium Deck Set']);
  assert.deepEqual(exactSetAlias('3csc')?.setNames, ['30th Celebration Simplified Chinese']);
  const parsed = parseTypedQuery('Espeon 3CPD');
  assert.equal(parsed.nameQuery, 'Espeon');
  assert.deepEqual(parsed.setTokens.map((token) => token.setNames), [['30th Celebration Premium Deck Set']]);
});

test('badges never take over collector numbers, card names or shorthand', () => {
  assert.equal(isSetBadgeAlias('3c'), false, '3c stays collector 3c');
  assert.equal(isSetBadgeAlias('sv4'), false, 'sv4 stays a coded collector');
  assert.equal(isSetBadgeAlias('mew'), false, 'letters-only badge stays a name');
  assert.equal(isSetBadgeAlias('3cpd'), true);
  assert.equal(parseTypedQuery('pikachu 3c').numberTokens.length, 1);
  assert.equal(parseTypedQuery('mew ex').setTokens.length, 0);
});

for (const printLang of ['all', 'japanese']) {
  for (const query of ['Espeon ex 30th', 'Espeon ex illustration', 'Espeon ex illu', 'espeon ex sir', 'Espeon 3CPD']) {
    test(`"${query}" lists Espeon ex 043 SIR (3CPD) on the first screen, print=${printLang}`, () => {
      const rank = popupIds(query, printLang).indexOf(ESPEON_SIR_3CPD);
      assert.ok(rank >= 0 && rank < 5, `rank ${rank}`);
    });
  }
}
