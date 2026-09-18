import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIST_PRINT_FLAGS,
  artistPrintRegion,
  cardLanguageQuery,
  defaultCardLanguage,
  filterSuggestByPrintLang,
  flagSrc,
  isSearchLang,
  languagesForNationality,
  printBucket,
  printFlagFromNationality,
  rewriteCatalogLang,
  searchLangFromPath,
} from './locale.js';

test('search langs are the TCG codes used in card URLs', () => {
  assert.equal(isSearchLang('en'), true);
  assert.equal(isSearchLang('zht'), true);
  assert.equal(isSearchLang('jp'), true);
  assert.equal(isSearchLang('EN'), true);
  assert.equal(isSearchLang('ja'), false);
});

test('desk canonical /en/ paths keep the selected title language', () => {
  assert.equal(
    rewriteCatalogLang('/marketplace/en/cards/703382/card-mega-lucario-ex', 'it'),
    '/marketplace/it/cards/703382/card-mega-lucario-ex',
  );
  assert.equal(
    rewriteCatalogLang('/marketplace/it/cards/703382/card-mega-lucario-ex', 'it'),
    '/marketplace/it/cards/703382/card-mega-lucario-ex',
  );
});

test('card and artist paths rewrite the language segment', () => {
  assert.equal(
    rewriteCatalogLang('/marketplace/en/cards/221412/card-pikachu-48-162-breakthrough', 'it'),
    '/marketplace/it/cards/221412/card-pikachu-48-162-breakthrough',
  );
  assert.equal(
    rewriteCatalogLang('/marketplace/en/artists/ken-sugimori', 'jp'),
    '/marketplace/jp/artists/ken-sugimori',
  );
  assert.equal(
    rewriteCatalogLang('/marketplace/en/users/vitologiuseppe17', 'it'),
    '/marketplace/it/users/vitologiuseppe17',
  );
  assert.equal(rewriteCatalogLang('/marketplace', 'it'), '/marketplace');
  assert.equal(rewriteCatalogLang('/marketplace/search?q=pika', 'fr'), '/marketplace/search?q=pika');
});

test('path helper reads catalog language', () => {
  assert.equal(searchLangFromPath('/marketplace/it/cards/1/slug'), 'it');
  assert.equal(searchLangFromPath('/marketplace/zht/artists/x'), 'zht');
  assert.equal(searchLangFromPath('/marketplace/en/users/vitologiuseppe17'), 'en');
  assert.equal(searchLangFromPath('/marketplace/search'), '');
});

test('print flags are JPKO, KO, CN, and EUUS from expansion nationality', () => {
  assert.equal(printFlagFromNationality('japanese').code, 'jpko');
  assert.equal(printFlagFromNationality('chinese').code, 'zh');
  assert.equal(printFlagFromNationality('western').code, 'euus');
  assert.equal(printFlagFromNationality('european').code, 'eu');
  assert.equal(printFlagFromNationality('american').code, 'us');
  assert.equal(printFlagFromNationality('korean').code, 'ko');
  assert.equal(printFlagFromNationality('korean').label, 'Korean print');
  assert.equal(printFlagFromNationality('indonesian').code, 'id');
  assert.equal(printFlagFromNationality('thai').code, 'th');
  assert.equal(printFlagFromNationality('idth').code, 'idth');
  assert.equal(printFlagFromNationality('french').code, 'fr');
  assert.equal(printFlagFromNationality('german').code, 'de');
  assert.equal(printFlagFromNationality('american').code, 'us');
  assert.equal(printFlagFromNationality('product'), null);
  assert.equal(printFlagFromNationality(''), null);
  assert.match(flagSrc('euus'), /flags\/euus\.svg$/);
  assert.match(flagSrc('jpko'), /flags\/jpko\.svg$/);
  assert.match(flagSrc('idth'), /flags\/idth\.svg$/);
  assert.match(flagSrc('fr'), /flags\/fr\.svg$/);
  assert.match(flagSrc('de'), /flags\/de\.svg$/);
  assert.match(flagSrc('eu'), /flags\/eu\.png$/);
  assert.match(flagSrc('us'), /flags\/us\.svg$/);
  assert.match(flagSrc('ko'), /flags\/ko\.svg$/);
  assert.match(flagSrc('jp'), /flags\/jp\.svg$/);
});

test('Japanese expansions only offer Asian card languages', () => {
  assert.deepEqual(
    languagesForNationality('japanese', ['EN', 'IT', 'JP', 'KO']),
    ['JP', 'KO'],
  );
  assert.deepEqual(
    languagesForNationality('korean', ['EN', 'JP']),
    ['JP'],
  );
  assert.deepEqual(
    languagesForNationality('western', ['EN', 'IT', 'JP']),
    ['EN', 'IT', 'JP'],
  );
  assert.deepEqual(
    languagesForNationality('chinese', ['EN', 'ZH']),
    ['EN', 'ZH'],
  );
  assert.equal(defaultCardLanguage('japanese'), 'JP');
  assert.equal(defaultCardLanguage('korean'), 'KO');
  assert.equal(defaultCardLanguage('chinese'), 'ZH');
  assert.equal(defaultCardLanguage('indonesian'), 'ID');
  assert.equal(defaultCardLanguage('idth'), 'ID');
  assert.equal(defaultCardLanguage('french'), 'FR');
  assert.equal(defaultCardLanguage('german'), 'DE');
  assert.equal(cardLanguageQuery('japanese', ['EN', 'JP'], ''), 'JP');
  assert.equal(cardLanguageQuery('japanese', ['EN', 'IT'], ''), 'JP');
  assert.equal(cardLanguageQuery('japanese', ['JP', 'KO'], 'EN'), '');
  assert.equal(cardLanguageQuery('western', ['EN', 'JP'], ''), '');
});

test('print-language buckets match Occidental / Japanese / Korean / Chinese chips', () => {
  assert.equal(printBucket('japanese'), 'japanese');
  assert.equal(printBucket('chinese'), 'chinese');
  assert.equal(printBucket('western'), 'western');
  assert.equal(printBucket('korean'), 'korean');
  assert.equal(printBucket(''), 'unknown');
  assert.equal(artistPrintRegion('korean'), 'japanese');
  assert.equal(artistPrintRegion('japanese'), 'japanese');
  assert.equal(artistPrintRegion('chinese'), 'chinese');
  assert.equal(artistPrintRegion('western'), 'western');
  assert.equal(artistPrintRegion(''), 'unknown');
  assert.deepEqual(ARTIST_PRINT_FLAGS.map((row) => row.flag), ['euus', 'jpko', 'zh', 'id']);
});

test('suggest print-language filter keeps matching nationalities', () => {
  const groups = [
    {
      name: 'Mimikyu',
      printings: [
        { id: '1', nationality: 'japanese' },
        { id: '2', nationality: 'western' },
        { id: '3', nationality: 'chinese' },
        { id: '4', nationality: 'korean' },
      ],
    },
  ];
  assert.equal(filterSuggestByPrintLang(groups, 'all')[0].printings.length, 4);
  // Korean print rides the merged japanese (jpko) option.
  assert.deepEqual(filterSuggestByPrintLang(groups, 'japanese')[0].printings.map((row) => row.id), ['1', '4']);
  assert.deepEqual(filterSuggestByPrintLang(groups, 'western')[0].printings.map((row) => row.id), ['2']);
  assert.deepEqual(filterSuggestByPrintLang(groups, 'chinese')[0].printings.map((row) => row.id), ['3']);
});

test('artist desk print chips are western, Japanese+Korean, Chinese, and Indonesian', () => {
  assert.deepEqual(
    ARTIST_PRINT_FLAGS.map((row) => [row.code, row.flag]),
    [
      ['western', 'euus'],
      ['japanese', 'jpko'],
      ['chinese', 'zh'],
      ['indonesian', 'id'],
    ],
  );
  assert.equal(artistPrintRegion('western'), 'western');
  assert.equal(artistPrintRegion('japanese'), 'japanese');
  assert.equal(artistPrintRegion('korean'), 'japanese');
  assert.equal(artistPrintRegion('chinese'), 'chinese');
  assert.equal(artistPrintRegion('indonesian'), 'indonesian');
  assert.equal(artistPrintRegion('idth'), 'indonesian');
  assert.equal(artistPrintRegion(''), 'unknown');
});

test('print-language filter keeps live name stubs', () => {
  const groups = [{
    name: 'Cynthia',
    printings: [{ id: 'live:cynthia', name: 'Cynthia', live: true }],
  }];
  assert.equal(filterSuggestByPrintLang(groups, 'japanese')[0].printings[0].id, 'live:cynthia');
});

test('HeartGold Collection buckets japanese so the print filter keeps its energies', async () => {
  const { expansionNationality } = await import('./suggest-catalog.js');
  // The catalog set is the Japanese ハートゴールドコレクション (L1): the
  // leftover scans (Flaaffy 032/070, the basic energies) carry Japanese name
  // bars and ©2009 JP layout, and the DB expansion nationality is japanese.
  // It is not the Korean HGSS release.
  assert.equal(expansionNationality('HeartGold Collection'), 'japanese');
  const groups = [{
    name: 'Darkness Energy',
    printings: [
      { id: 'hgss-121', name: 'Darkness Energy', set: 'HeartGold & SoulSilver', nationality: 'western' },
      { id: 'l1-070', name: 'Darkness Energy', set: 'HeartGold Collection', nationality: 'japanese' },
    ],
  }];
  assert.deepEqual(filterSuggestByPrintLang(groups, 'japanese')[0].printings.map((row) => row.id), ['l1-070']);
  assert.equal(filterSuggestByPrintLang(groups, 'western')[0].printings.length, 1);
  assert.equal(filterSuggestByPrintLang(groups, 'all')[0].printings.length, 2);
});
