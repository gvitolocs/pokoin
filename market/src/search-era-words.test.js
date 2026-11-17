import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eraPhraseAlias, eraWordAlias } from './suggest-rank.js';
import { tokenizeQuery } from './search-score.js';
import { paintCatalogGroups, rememberSuggestGroups, resetSuggestLive } from './suggest-live.js';
import { matchTcgEra } from './tcg-eras.js';

// Real "Pikachu" printings from the first 750 rows the header search pages in
// (`/api/marketplace-suggest?q=pikachu`, 2026-11-07): the API's first 40 plus up
// to six of every era. Before the fix "pikachu diamond" painted BREAKthrough,
// BW promos and Base Set, as if "diamond" had not been typed.
const PIKACHU = JSON.parse(readFileSync(new URL('./test-fixtures/pikachu-suggest.json', import.meta.url), 'utf8'));

function popupEras(query, printLang = 'western', take = 5) {
  resetSuggestLive();
  rememberSuggestGroups(structuredClone(PIKACHU), { searchLang: 'en' });
  return paintCatalogGroups(query, { printLang, searchLang: 'en', kind: '', limit: 20 })
    .flatMap((group) => group.printings)
    .slice(0, take)
    .map((printing) => matchTcgEra(printing.set));
}

test('era words and codes are set evidence for their block', () => {
  for (const [word, era] of [
    ['diamond', 'Diamond & Pearl'], ['pearl', 'Diamond & Pearl'], ['dp', 'Diamond & Pearl'],
    ['xy', 'XY'], ['bw', 'Black & White'], ['swsh', 'Sword & Shield'], ['scarlet', 'Scarlet & Violet'],
  ]) {
    assert.equal(eraWordAlias(word)?.eraId, era, word);
  }
  assert.equal(eraPhraseAlias('sun', 'moon')?.eraId, 'Sun & Moon');
  assert.equal(eraPhraseAlias('diamond', 'pearl')?.eraId, 'Diamond & Pearl');
});

test('generic era halves stay plain words', () => {
  for (const word of ['sun', 'moon', 'black', 'white']) {
    assert.equal(eraWordAlias(word), null, word);
  }
  const black = tokenizeQuery('black kyurem').tokens[0];
  assert.equal(black.interps.some((interp) => interp.field === 'set'), false);
});

test('"pikachu diamond" leads with every Diamond & Pearl era Pikachu (Western chip)', () => {
  const westernDp = PIKACHU[0].printings.filter((printing) => (
    printing.nationality === 'western' && matchTcgEra(printing.set) === 'Diamond & Pearl'
  )).length;
  assert.ok(westernDp >= 4, `fixture has ${westernDp} western DP Pikachus`);
  assert.deepEqual(popupEras('pikachu diamond', 'western', westernDp), Array(westernDp).fill('Diamond & Pearl'));
});

for (const [query, era] of [
  ['pikachu dp', 'Diamond & Pearl'],
  ['pikachu diamond pearl', 'Diamond & Pearl'],
  ['pikachu sun moon', 'Sun & Moon'],
  ['pikachu xy', 'XY'],
]) {
  test(`"${query}" leads with ${era} era Pikachus`, () => {
    assert.equal(popupEras(query)[0], era);
  });
}
