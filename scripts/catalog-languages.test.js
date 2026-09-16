const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cardNameRowsForCatalog,
  compactText,
  expansionRowsForCatalog,
  foreignNameDictionary,
  indexSets,
  isPrintedRarityKey,
  majorityVote,
  matchEnglishName,
  matchExpansion,
  nameDictionaryFromLanguageDumps,
  printedRarityFromVersion,
  rarityMatchKey,
  rarityRowsForCatalog,
  translationsFromForeignNames,
  uiLanguageFromPokemontcg,
  uiLanguageFromTcgdex,
} = require('./catalog-languages');

test('TCGDex and pokemontcg language codes map onto the title-language set', () => {
  assert.equal(uiLanguageFromTcgdex('ja'), 'jp');
  assert.equal(uiLanguageFromTcgdex('zh-cn'), 'zh');
  assert.equal(uiLanguageFromTcgdex('zh-tw'), 'zht');
  assert.equal(uiLanguageFromTcgdex('pt-br'), 'pt');
  assert.equal(uiLanguageFromPokemontcg('French'), 'fr');
  assert.equal(uiLanguageFromPokemontcg('Chinese (Simplified)'), 'zh');
  assert.equal(uiLanguageFromPokemontcg('Chinese Traditional'), 'zht');
});

test('name dictionary joins language dumps on card id and matches our English names', () => {
  const dict = nameDictionaryFromLanguageDumps([
    { id: 'base1-4', name: 'Charizard' },
    { id: 'sv3pt5-6', name: 'Charizard ex' },
    { id: 'xy1-1', name: 'Venusaur-EX' },
  ], [
    { id: 'base1-4', name: 'Dracaufeu' },
    { id: 'sv3pt5-6', name: 'Dracaufeu-ex' },
    { id: 'xy1-1', name: 'Florizarre-EX' },
  ], 'tcgdex');

  assert.equal(matchEnglishName('Charizard', dict).localizedName, 'Dracaufeu');
  assert.equal(matchEnglishName('Charizard ex', dict).localizedName, 'Dracaufeu-ex');
  assert.equal(matchEnglishName('Charizard-ex', dict).localizedName, 'Dracaufeu-ex');
  assert.equal(matchEnglishName('Venusaur EX', dict).localizedName, 'Florizarre-EX');
  assert.equal(matchEnglishName('Mewtwo', dict), null);
});

test('majority vote skips a tied translation instead of guessing', () => {
  assert.equal(majorityVote(['Dracaufeu', 'Dracaufeu', 'Salamèche']).name, 'Dracaufeu');
  assert.equal(majorityVote(['A', 'B']).tied, true);
});

test('pokemontcg foreignNames become a language dictionary keyed by English name', () => {
  const card = {
    id: 'base1-4',
    name: 'Charizard',
    rarity: 'Rare Holo',
    foreignNames: [
      { language: 'French', name: 'Dracaufeu', rarity: 'Rare Holo' },
      { language: 'German', name: 'Glurak' },
      { language: 'Italian', name: 'Charizard' },
    ],
  };
  assert.equal(translationsFromForeignNames(card).length, 3);
  const french = foreignNameDictionary([card], 'fr');
  assert.equal(french.get(compactText('Charizard')).localizedName, 'Dracaufeu');
});

test('catalog card rows keep English identity and fill other langs from the dump', () => {
  const french = nameDictionaryFromLanguageDumps(
    [{ id: 'base1-4', name: 'Charizard' }],
    [{ id: 'base1-4', name: 'Dracaufeu' }],
  );
  const rows = cardNameRowsForCatalog(['Charizard', 'Missingno'], [['fr', french]]);
  assert.deepEqual(
    rows.filter((row) => row.name === 'Charizard').map((row) => [row.language, row.localizedName, row.source]),
    [
      ['en', 'Charizard', 'identity'],
      ['fr', 'Dracaufeu', 'tcgdex'],
    ],
  );
  assert.deepEqual(
    rows.filter((row) => row.name === 'Missingno').map((row) => row.language),
    ['en'],
  );
});

test('printed rarity comes from the version pipe, not marketplace_cards.rarity=Card', () => {
  assert.equal(printedRarityFromVersion('Holo Rare | 4/102'), 'Holo Rare');
  assert.equal(printedRarityFromVersion('Card'), '');
  assert.equal(rarityMatchKey('Rare Holo'), rarityMatchKey('Holo Rare'));
  const tcgdex = new Set([rarityMatchKey('Holo Rare'), rarityMatchKey('Illustration rare')]);
  assert.equal(isPrintedRarityKey('Holo Rare', tcgdex), true);
  assert.equal(isPrintedRarityKey('Illustration Rare', tcgdex), true);
  assert.equal(isPrintedRarityKey('CSV10C', tcgdex), false);
  assert.equal(isPrintedRarityKey('CS1a', tcgdex), false);
  assert.equal(isPrintedRarityKey('WCD 2009', tcgdex), false);
  assert.equal(isPrintedRarityKey('Empty Tin', tcgdex), false);
  assert.equal(isPrintedRarityKey('Poké Ball Reverse Holo', tcgdex), true);
});

test('rarity rows translate via TCGDex English rarity, keyed by our printed label', () => {
  const localized = new Map([
    ['fr', new Map([['Holo Rare', 'Holographique Rare'], ['Illustration rare', 'Rare illustration']])],
  ]);
  const rows = rarityRowsForCatalog(
    ['Holo Rare', 'Illustration Rare', 'CSV10C'],
    ['Holo Rare', 'Illustration rare'],
    localized,
  );
  assert.deepEqual(
    rows.map((row) => [row.rarity, row.language, row.localizedName]),
    [
      ['Holo Rare', 'en', 'Holo Rare'],
      ['Holo Rare', 'fr', 'Holographique Rare'],
      ['Illustration Rare', 'en', 'Illustration Rare'],
      ['Illustration Rare', 'fr', 'Rare illustration'],
    ],
  );
});

test('expansions match official_id first, then English set name', () => {
  const sets = indexSets([
    { id: 'base1', name: 'Base Set' },
    { id: 'sv03.5', name: '151' },
    { id: 'sv01', name: 'Scarlet & Violet' },
    { id: 'S8a', name: '25th Anniversary Collection' },
  ]);
  assert.equal(matchExpansion({ officialId: 'sv3pt5', name: '151' }, sets).set.id, 'sv03.5');
  assert.equal(matchExpansion({ officialId: 'sv1', name: 'Scarlet & Violet' }, sets).set.id, 'sv01');
  assert.equal(matchExpansion({ officialId: '', name: 'Base Set' }, sets).set.id, 'base1');
  assert.equal(matchExpansion({ officialId: 'S8a', name: '25th Anniversary Edition' }, sets).set.id, 'S8a');
  assert.equal(matchExpansion({ officialId: '', name: 'Not A Set' }, sets).set, null);

  const french = indexSets([{ id: 'sv03.5', name: '151' }, { id: 'base1', name: 'Set de Base' }]);
  const rows = expansionRowsForCatalog(
    [{ expansionId: 1472, name: 'Base Set', officialId: 'base1' }],
    sets,
    [['fr', french]],
  );
  assert.deepEqual(
    rows.map((row) => [row.language, row.localizedName, row.sourceId]),
    [
      ['en', 'Base Set', ''],
      ['fr', 'Set de Base', 'base1'],
    ],
  );
});

test('PokeAPI species CSV fills JP/KO/ZH when TCGDex card ids do not overlap', () => {
  const { parsePokeApiSpeciesCsv, translateNameWithSpecies, cardNameRowsForCatalog } = require('./catalog-languages');
  const species = parsePokeApiSpeciesCsv([
    'pokemon_species_id,local_language_id,name,genus',
    '6,9,Charizard,Flame Pokémon',
    '6,11,リザードン,かえんポケモン',
    '6,3,리자몽,화염포켓몬',
    '6,12,喷火龙,火焰宝可梦',
    '6,4,噴火龍,火焰寶可夢',
    '6,5,Dracaufeu,Pokémon Flamme',
  ].join('\n'));
  assert.equal(translateNameWithSpecies('Charizard', species, 'jp'), 'リザードン');
  assert.equal(translateNameWithSpecies('Charizard ex', species, 'jp'), 'リザードン ex');
  assert.equal(translateNameWithSpecies('Charizard VSTAR', species, 'ko'), '리자몽 VSTAR');
  assert.equal(translateNameWithSpecies('Dark Charizard', species, 'jp'), '');
  const french = nameDictionaryFromLanguageDumps(
    [{ id: 'base1-4', name: 'Charizard' }],
    [{ id: 'base1-4', name: 'Dracaufeu' }],
  );
  const rows = cardNameRowsForCatalog(['Charizard', 'Charizard ex'], [['fr', french], ['jp', new Map()]], species);
  assert.equal(rows.find((row) => row.name === 'Charizard' && row.language === 'fr').source, 'tcgdex');
  assert.equal(rows.find((row) => row.name === 'Charizard' && row.language === 'jp').localizedName, 'リザードン');
  assert.equal(rows.find((row) => row.name === 'Charizard ex' && row.language === 'jp').localizedName, 'リザードン ex');
});
