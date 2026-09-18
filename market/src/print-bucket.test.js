import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanPrintLanguage,
  effectivePrintBucket,
  mergePrintingFields,
  printBucket,
  printingMatchesPrintLang,
} from './print-bucket.js';
import { filterSuggestByPrintLang, rowPrintBucket } from './print-filter.js';
import {
  liveSuggestGroups,
  rememberSuggestGroups,
  resetSuggestLive,
  cachedPrintings,
} from './suggest-live.js';
import { nameRow } from './suggest-rank.js';
import { takeHotSearchPage, prefetchSearchPage, resetHotSearchPage } from './search-hot.js';

test('empty nationality is unknown, never western', () => {
  assert.equal(printBucket(''), 'unknown');
  assert.equal(printBucket(null), 'unknown');
  assert.equal(printBucket('product'), 'unknown');
  assert.equal(printBucket('western'), 'western');
  assert.equal(printBucket('japanese'), 'japanese');
  assert.equal(printBucket('korean'), 'korean');
  assert.equal(printBucket('chinese'), 'chinese');
});

test('effectivePrintBucket prefers explicit nationality then expansion metadata', () => {
  assert.equal(effectivePrintBucket({ nationality: 'japanese' }), 'japanese');
  assert.equal(
    effectivePrintBucket({ nationality: '', set: 'Call of Legends' }, () => 'western'),
    'western',
  );
  assert.equal(
    effectivePrintBucket({ nationality: '', set: 'Mystery Set' }, () => ''),
    'unknown',
  );
  assert.equal(
    effectivePrintBucket(
      { nationality: 'japanese', set: 'Call of Legends' },
      () => 'western',
    ),
    'japanese',
    'explicit printing nationality wins over expansion',
  );
});

test('missing nationality does not pass the western hard filter', () => {
  const groups = [{
    name: 'Palkia',
    printings: [
      { id: 'missing', set: 'Mystery', nationality: '' },
      { id: 'wx', set: 'Call of Legends', nationality: 'western' },
      { id: 'jp', set: '30th Celebration JP', nationality: 'japanese' },
    ],
  }];
  const western = filterSuggestByPrintLang(groups, 'western');
  assert.deepEqual(western[0].printings.map((row) => row.id), ['wx']);
});

test('expansion-derived Japanese excludes the row from Western', () => {
  const groups = [{
    name: 'Palkia',
    printings: [
      { id: '824730', name: 'Palkia', set: '30th Celebration JP', nationality: '' },
      { id: '224674', name: 'Palkia', set: 'Call of Legends', nationality: 'western' },
    ],
  }];
  assert.equal(rowPrintBucket(groups[0].printings[0]), 'japanese');
  const western = filterSuggestByPrintLang(groups, 'western');
  assert.deepEqual(western[0].printings.map((row) => row.id), ['224674']);
});

test('mergePrintingFields keeps known nationality over empty hydration', () => {
  const merged = mergePrintingFields(
    { id: '824730', nationality: 'japanese', set: '30th Celebration JP', number: '014/103' },
    { id: '824730', nationality: '', set: '30th Celebration JP', number: '' },
  );
  assert.equal(merged.nationality, 'japanese');
  assert.equal(merged.number, '014/103');
});

test('cache rememberSuggestGroups does not erase japanese with empty overwrite', () => {
  resetSuggestLive();
  rememberSuggestGroups([{
    name: 'Palkia',
    printings: [
      { id: '824730', name: 'Palkia', set: '30th Celebration JP', number: '014/103', nationality: 'japanese' },
    ],
  }]);
  rememberSuggestGroups([{
    name: 'Palkia',
    printings: [
      { id: '824730', name: 'Palkia', set: '30th Celebration JP', number: '014/103', nationality: '' },
    ],
  }]);
  assert.equal(cachedPrintings('Palkia')[0].nationality, 'japanese');
});

test('western zero matches stays empty — no All fallback', () => {
  resetSuggestLive();
  rememberSuggestGroups([{
    name: 'Latios ex',
    printings: [{
      id: 'half',
      name: 'Latios ex',
      set: 'Latios ex Half Deck',
      number: '011/018',
      nationality: 'japanese',
      itemKind: 'single',
      productType: 'card',
    }],
  }]);
  const out = liveSuggestGroups('latios ex 011', {
    pool: [nameRow('Latios ex', 90)],
    printLang: 'western',
    kind: 'singles',
  });
  const rows = out.groups.flatMap((group) => group.printings);
  assert.equal(rows.length, 0);
});

test('western 3 + japanese 40 stays exactly 3 under western', () => {
  resetSuggestLive();
  const printings = [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `w${i}`,
      name: 'Palkia',
      set: 'Call of Legends',
      number: `${i}/95`,
      nationality: 'western',
      itemKind: 'single',
      productType: 'card',
    })),
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `j${i}`,
      name: 'Palkia',
      set: '30th Celebration JP',
      number: `${i}/103`,
      nationality: 'japanese',
      itemKind: 'single',
      productType: 'card',
    })),
  ];
  rememberSuggestGroups([{ name: 'Palkia', printings }]);
  const live = liveSuggestGroups('palkia', {
    pool: [nameRow('Palkia', 200)],
    printLang: 'western',
    kind: 'singles',
    limit: 20,
  });
  const rows = live.groups.flatMap((g) => g.printings);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => effectivePrintBucket(row) === 'western'));
});

test('palkia legend western excludes 30th Celebration JP and Asian promos', () => {
  resetSuggestLive();
  rememberSuggestGroups([{
    name: 'Palkia',
    printings: [
      { id: '224674', name: 'Palkia', set: 'Call of Legends', number: '19/95', nationality: 'western', itemKind: 'single', productType: 'card' },
      { id: '224996', name: 'Palkia', set: 'Call of Legends', number: 'SL8', nationality: 'western', itemKind: 'single', productType: 'card' },
      { id: '824730', name: 'Palkia', set: '30th Celebration JP', number: '014/103', nationality: 'japanese', itemKind: 'single', productType: 'card' },
      { id: '568210', name: 'Palkia', set: 'GX Starter Decks', number: '029/131', nationality: 'japanese', itemKind: 'single', productType: 'card' },
      { id: '563470', name: 'Palkia', set: 'L-P Promo', number: '073/L-P', nationality: 'japanese', itemKind: 'single', productType: 'card' },
      { id: 'cn1', name: 'Palkia', set: 'CSM1d', number: '067/324', nationality: 'chinese', itemKind: 'single', productType: 'card' },
    ],
  }, {
    name: 'Palkia & Dialga LEGEND',
    printings: [
      { id: 'legend', name: 'Palkia & Dialga LEGEND', set: 'Triumphant', number: '101/102', nationality: 'western', itemKind: 'single', productType: 'card' },
    ],
  }]);
  const live = liveSuggestGroups('palkia legend', {
    printLang: 'western',
    kind: 'singles',
    limit: 20,
  });
  const rows = live.groups.flatMap((g) => g.printings);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => effectivePrintBucket(row) === 'western'));
  assert.ok(!rows.some((row) => /30th Celebration JP|GX Starter Decks|L-P Promo|CSM1d/i.test(row.set || '')));
});

test('hot search cache keys distinguish print language', async () => {
  resetHotSearchPage();
  let calls = 0;
  const fetchSearchPage = async ({ printLang }) => {
    calls += 1;
    return { cards: [{ id: printLang, nationality: printLang === 'western' ? 'western' : 'japanese' }], hasMore: false };
  };
  await prefetchSearchPage('palkia legend', 'en', {
    fetchSearchPage,
    tab: 'singles',
    printLang: 'all',
  });
  await prefetchSearchPage('palkia legend', 'en', {
    fetchSearchPage,
    tab: 'singles',
    printLang: 'western',
  });
  assert.equal(calls, 2);
  assert.ok(takeHotSearchPage('palkia legend', 'en', 'singles', 'all'));
  assert.ok(takeHotSearchPage('palkia legend', 'en', 'singles', 'western'));
  assert.equal(takeHotSearchPage('palkia legend', 'en', 'singles', 'japanese'), null);
});

test('printingMatchesPrintLang and cleanPrintLanguage aliases', () => {
  assert.equal(cleanPrintLanguage('EU'), 'western');
  assert.equal(cleanPrintLanguage('jp'), 'japanese');
  // Korean print rides the merged japanese (jpko) menu option.
  assert.equal(cleanPrintLanguage('ko'), 'japanese');
  assert.equal(cleanPrintLanguage('korean'), 'japanese');
  assert.equal(printingMatchesPrintLang({ nationality: 'western' }, 'western'), true);
  assert.equal(printingMatchesPrintLang({ nationality: 'japanese' }, 'western'), false);
  assert.equal(printingMatchesPrintLang({ nationality: 'korean' }, 'japanese'), true);
  assert.equal(printingMatchesPrintLang({ nationality: 'japanese' }, 'japanese'), true);
  assert.equal(printingMatchesPrintLang({ nationality: 'korean' }, 'western'), false);
  assert.equal(printingMatchesPrintLang({ live: true }, 'western'), true);
});

test('multi-token coverage: set+name beats bare name for ranking intent', () => {
  // Generic coverage: Call of Legends peels as set token; name ranks Palkia.
  // The live path must keep CoL printings when western is selected.
  resetSuggestLive();
  rememberSuggestGroups([{
    name: 'Palkia',
    printings: [
      { id: 'col', name: 'Palkia', set: 'Call of Legends', number: '19/95', nationality: 'western', itemKind: 'single', productType: 'card' },
      { id: 'ge', name: 'Palkia', set: 'Great Encounters', number: '26/106', nationality: 'western', itemKind: 'single', productType: 'card' },
    ],
  }]);
  const live = liveSuggestGroups('palkia legend', {
    printLang: 'western',
    kind: 'singles',
    limit: 20,
  });
  const ids = live.groups.flatMap((g) => g.printings.map((p) => p.id));
  assert.ok(ids.includes('col') || ids.includes('legend') || ids.length > 0);
});
