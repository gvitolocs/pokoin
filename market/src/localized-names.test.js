import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestLiveReady } from './compact-query.js';
import {
  englishQuery,
  loadLocalizedNames,
  localizedNamesReady,
  resetLocalizedNames,
} from './localized-names.js';
import { paintCatalogGroups, rememberSuggestGroups, resetSuggestLive } from './suggest-live.js';
import { catalogRecall } from './suggest-pool.js';

const LANGS = ['de', 'es', 'fr', 'it', 'jp', 'ko', 'pt', 'zh', 'zht'];

async function loadAll() {
  for (const lang of LANGS) {
    assert.equal(await loadLocalizedNames(lang), true, lang);
  }
}

test('English never loads a table and is never rewritten', async () => {
  resetLocalizedNames();
  assert.equal(localizedNamesReady('en'), true);
  assert.equal(await loadLocalizedNames('en'), true);
  assert.equal(englishQuery('evoli', 'en'), '');
  assert.equal(englishQuery('glurak', 'en'), '');
  // Until the language chunk lands the query is used as typed.
  assert.equal(localizedNamesReady('fr'), false);
  assert.equal(englishQuery('evoli', 'fr'), '');
});

test('localized Pokémon names map to their English identity in every title language', async () => {
  await loadAll();
  const cases = {
    fr: { evoli: 'Eevee', 'évoli': 'Eevee', dracaufeu: 'Charizard', rondoudou: 'Jigglypuff', salameche: 'Charmander' },
    de: { evoli: 'Eevee', glurak: 'Charizard', pummeluff: 'Jigglypuff' },
    it: { 'eevee lucente': 'Radiant Eevee' },
    es: { 'eevee radiante': 'Radiant Eevee' },
    pt: { 'eevee radiante': 'Radiant Eevee' },
    jp: { 'イーブイ': 'Eevee', 'いーぶい': 'Eevee', 'リザードン': 'Charizard', 'プリン': 'Jigglypuff', 'ミュウ': 'Mew' },
    ko: { '이브이': 'Eevee', '리자몽': 'Charizard', '푸린': 'Jigglypuff', '피카츄': 'Pikachu' },
    zh: { '伊布': 'Eevee', '喷火龙': 'Charizard', '胖丁': 'Jigglypuff', '皮卡丘': 'Pikachu' },
    zht: { '伊布': 'Eevee', '噴火龍': 'Charizard', '胖丁': 'Jigglypuff' },
  };
  for (const [lang, rows] of Object.entries(cases)) {
    for (const [typed, english] of Object.entries(rows)) {
      assert.equal(englishQuery(typed, lang), english, `${lang} ${typed}`);
    }
  }
});

test('typing, typos, mechanics and trailing set words keep the localized name', async () => {
  await loadAll();
  assert.equal(englishQuery('evol', 'fr'), 'Eevee');
  assert.equal(englishQuery('dracau', 'fr'), 'Charizard');
  assert.equal(englishQuery('dracofeu', 'fr'), 'Charizard');
  assert.equal(englishQuery('glur', 'de'), 'Charizard');
  assert.equal(englishQuery('イーブ', 'jp'), 'Eevee');
  assert.equal(englishQuery('evoli v', 'fr'), 'Eevee V');
  assert.equal(englishQuery('evoli sir', 'fr'), 'Eevee sir');
  assert.match(englishQuery('dracaufeu ex', 'fr'), /^Charizard ex$/i);
});

test('English names and controls stay as typed under a localized search language', async () => {
  await loadAll();
  for (const lang of LANGS) {
    for (const typed of ['pikachu', 'mew', 'eevee', 'charizard', 'jigglypuff', 'charizard 4/102', 'pikachu vmax']) {
      assert.equal(englishQuery(typed, lang), '', `${lang} ${typed}`);
    }
  }
  // An English prefix keeps English readings first (fr Charbi / Draco lose).
  assert.equal(englishQuery('char', 'fr'), '');
  assert.equal(englishQuery('dra', 'fr'), '');
  assert.equal(englishQuery('golurk', 'de'), '');
  assert.equal(englishQuery('salamence', 'fr'), '');
});

test('catalogRecall asks the index for the English name of a localized query', async () => {
  await loadAll();
  assert.deepEqual(catalogRecall('evoli', { lang: 'fr' }), ['Eevee']);
  assert.deepEqual(catalogRecall('glurak', { lang: 'de' }), ['Charizard']);
  assert.deepEqual(catalogRecall('伊布', { lang: 'zh' }), ['Eevee']);
  assert.notDeepEqual(catalogRecall('glurak', { lang: 'en' }), ['Charizard']);
});

test('popup: French evoli ranks Eevee printings first, not Evolution Incense or Scolipede', async () => {
  await loadAll();
  resetSuggestLive();
  const card = (id, name, set, localized) => ({
    id, name, set, product_type: 'card', item_kind: 'single', ...(localized ? { localized_name: localized } : {}),
  });
  // What the old recall cached for `evoli`: English fuzzy neighbours.
  rememberSuggestGroups([
    { name: 'Evolution Incense', printings: [card('ei1', 'Evolution Incense', 'Sword & Shield', "Encens d'Évolution")] },
    { name: 'Scolipede', printings: [card('sc1', 'Scolipede', 'Black Bolt', 'Brutapode')] },
  ], { searchLang: 'fr' });
  // Eevee as catalog hydration caches it: English rows, no French overlay.
  // Before localized names this painted Evolution Incense, Scolipede, no Eevee.
  rememberSuggestGroups([
    { name: 'Eevee', printings: [card('ev1', 'Eevee', 'Jungle'), card('ev2', 'Eevee', 'Prismatic Evolutions')] },
  ]);
  for (const typed of ['evoli', 'Évoli', 'EVOLI']) {
    const groups = paintCatalogGroups(typed, { searchLang: 'fr', kind: 'singles', limit: 20 });
    assert.equal(groups[0]?.name, 'Eevee', typed);
    const rows = groups.flatMap((group) => group.printings || []).map((row) => row.id);
    assert.deepEqual(rows.slice(0, 2).sort(), ['ev1', 'ev2'], typed);
  }
});

test('popup: localized controls across languages (Charizard, Jigglypuff, Pikachu, Mew)', async () => {
  await loadAll();
  resetSuggestLive();
  const groups = ['Charizard', 'Jigglypuff', 'Pikachu', 'Mew', 'Golurk', 'Eevee'].map((name, index) => ({
    name,
    printings: [{ id: `p${index}`, name, set: 'Base Set', product_type: 'card', item_kind: 'single' }],
  }));
  rememberSuggestGroups(groups);
  const top = (typed, lang) => paintCatalogGroups(typed, { searchLang: lang, kind: 'singles', limit: 20 })[0]?.name;
  assert.equal(top('glurak', 'de'), 'Charizard');
  assert.equal(top('dracaufeu', 'fr'), 'Charizard');
  assert.equal(top('rondoudou', 'fr'), 'Jigglypuff');
  assert.equal(top('pummeluff', 'de'), 'Jigglypuff');
  assert.equal(top('リザードン', 'jp'), 'Charizard');
  assert.equal(top('이브이', 'ko'), 'Eevee');
  assert.equal(top('胖丁', 'zh'), 'Jigglypuff');
  assert.equal(top('pikachu', 'fr'), 'Pikachu');
  assert.equal(top('mew', 'de'), 'Mew');
  assert.equal(top('golurk', 'en'), 'Golurk');
  assert.equal(top('charizard', 'it'), 'Charizard');
});

test('two kanji / hangul / kana open the popup; Latin still needs three', () => {
  assert.equal(suggestLiveReady('伊布'), true);
  assert.equal(suggestLiveReady('胖丁'), true);
  assert.equal(suggestLiveReady('ミュ'), true);
  assert.equal(suggestLiveReady('伊'), false);
  assert.equal(suggestLiveReady('ev'), false);
  assert.equal(suggestLiveReady('evo'), true);
});
