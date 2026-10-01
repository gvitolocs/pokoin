import assert from 'node:assert/strict';
import test from 'node:test';
import REDDIT_TYPOS from './data/reddit-pokemon-typos.js';
import {
  NAME_POOL,
  compactQuery,
  fetchSuggestRanked,
  maxDistance,
  prefixEditDistance,
} from './suggest-rank.js';
import { resolveSuggestQuery } from './suggest-resolve.js';
import {
  isLiveStub,
  liveSuggestGroups,
  rememberSuggestGroups,
  resetSuggestLive,
} from './suggest-live.js';
import { rowPrintBucket } from './print-filter.js';

function payload(rows) {
  const grouped = new Map();
  for (const [id, name, set, number, nationality] of rows) {
    if (!grouped.has(name)) grouped.set(name, { name, printings: [] });
    grouped.get(name).printings.push({
      id, name, set, number, nationality, productType: 'card', itemKind: 'single',
    });
  }
  return { groups: [...grouped.values()], count: rows.length };
}

const rowsOf = (groups) => groups.flatMap((group) => group.printings);
const paint = (query, printLang = 'all') => rowsOf(liveSuggestGroups(query, {
  kind: 'singles', printLang, searchLang: 'en',
}).groups);

// Minimal public card records captured from api.pokoin.com on 2026-10-01.
// The server Western facet returned 3 rows while the same unfiltered source
// hydrated many more cards with current, authoritative Western nationality.
const RAW_ALL = payload([
  ["240568","Dialga","Burger King DP Promos 2008","Burger King Promo | 16/106","western"],
  ["240566","Dialga","Theme Deck & Blisters Exclusives","Cosmos Holo | Theme Deck 16/106","western"],
  ["332700","Dialga","Evolving Skies","Holo Rare | 112/203","western"],
  ["300900","Dialga","Vivid Voltage","Holo Rare | 121/185","western"],
  ["245070","Dialga","Lost Thunder","Holo Rare | 127/214","western"],
  ["224610","Dialga","Call of Legends","Holo Rare | 3/95","western"],
  ["449336","Dialga","Towering Perfection","Rare | 041/067","japanese"],
  ["449572","Dialga","Legendary Heartbeat","Rare | 052/076","japanese"],
  ["239942","Diglett","Generations","038/083","western"],
  ["263768","Diglett","XY","058/146","western"],
  ["316564","Diglett","Chilling Reign","076/198","western"],
  ["290368","Diglett","Darkness Ablaze","084/189","western"],
  ["261150","Diglett","Unbroken Bonds","085/214","western"],
  ["237516","Diglett","Expedition Base Set","106/165","western"],
  ["237876","Diglett","Fates Collide","36/124","western"],
  ["222388","Diglett","Base Set","47/102","western"],
  ["229590","Diglett","EX Crystal Guardians","50/100","western"],
  ["255320","Diglett","Skyridge","50/144","western"],
  ["258938","Diglett","Team Rocket","52/82","western"],
  ["236818","Diglett","Evolutions","55/108","western"],
]);

const DIALGA_ALL = payload([
  ["813528","Dialga","30th Celebration","103","western"],
  ["484536","Dialga","Play! Pokémon Prize Pack Series","112/203","western"],
  ["403516","Dialga","Celebrations","201758","western"],
  ["240568","Dialga","Burger King DP Promos 2008","Burger King Promo | 16/106","western"],
  ["677418","Dialga","Theme Deck & Blisters Exclusives","Cosmos Holo | 112/203","western"],
  ["240566","Dialga","Theme Deck & Blisters Exclusives","Cosmos Holo | Theme Deck 16/106","western"],
  ["264270","Dialga","XY Black Star Promos","Holo Promo | XY77","western"],
  ["703194","Dialga","Mega Evolution","Holo Rare | 095/132","western"],
  ["332700","Dialga","Evolving Skies","Holo Rare | 112/203","western"],
  ["300900","Dialga","Vivid Voltage","Holo Rare | 121/185","western"],
  ["245070","Dialga","Lost Thunder","Holo Rare | 127/214","western"],
  ["224610","Dialga","Call of Legends","Holo Rare | 3/95","western"],
  ["530032","Dialga","Theme Deck & Blisters Exclusives","Non-Holo Theme Deck | 121/185","western"],
  ["612408","Dialga","Surging Sparks","Rare | 135/191","western"],
  ["224984","Dialga","Call of Legends","Shiny Rare | SL2","western"],
  ["563450","Dialga","L-P Promo","074/L-P","japanese"],
  ["826212","Dialga","30th Celebration Simplified Chinese","082","chinese"],
  ["824858","Dialga","30th Celebration JP","082/103","japanese"],
  ["342770","Dialga","25th Anniversary Collection","171385","japanese"],
  ["728336","Dialga","MEGA Start Deck 100 Battle Collection","502/742","japanese"],
]);

const DIGLETT_ALL = payload([
  ["239942","Diglett","Generations","038/083","western"],
  ["522216","Diglett","151","050/165","western"],
  ["263768","Diglett","XY","058/146","western"],
  ["316564","Diglett","Chilling Reign","076/198","western"],
  ["290368","Diglett","Darkness Ablaze","084/189","western"],
  ["261150","Diglett","Unbroken Bonds","085/214","western"],
  ["511576","Diglett","Obsidian Flames","103/197","western"],
  ["237516","Diglett","Expedition Base Set","106/165","western"],
  ["237876","Diglett","Fates Collide","36/124","western"],
  ["222388","Diglett","Base Set","47/102","western"],
  ["229590","Diglett","EX Crystal Guardians","50/100","western"],
  ["255320","Diglett","Skyridge","50/144","western"],
  ["258938","Diglett","Team Rocket","52/82","western"],
  ["236818","Diglett","Evolutions","55/108","western"],
  ["259972","Diglett","Triumphant","61/102","western"],
  ["232142","Diglett","EX FireRed & LeafGreen","61/112","western"],
  ["222640","Diglett","Base Set 2","71/130","western"],
  ["258398","Diglett","Sword & Shield","92/202","western"],
  ["268372","Diglett","Base Set Shadowless","Shadowless | 47/102","western"],
  ["589272","Diglett","Zygarde EX Perfect Battle Deck","001/019","japanese"],
]);

const RAW_WESTERN = payload([
  ["813528","Dialga","30th Celebration","103","western"],
  ["741476","Team Rocket's Diglett","Ascended Heroes","100/217","western"],
  ["742046","Team Rocket's Diglett","Ascended Heroes - Ball & Rocket Reverse Holo","Rocket Reverse Holo | 100/217","western"],
]);

async function hydrateCold(query, fetchSuggest, printLang = 'all') {
  resetSuggestLive();
  assert.deepEqual(paint(query, printLang), [], 'the query starts without warm candidates');
  const result = await fetchSuggestRanked(query, {
    fetchSuggest,
    fetchSearch: async () => ({ cards: [], total: null }),
    limit: 20,
    lang: 'en',
    printLang,
    kind: 'singles',
    resolved: resolveSuggestQuery(query),
  });
  // This is the same uncapped candidate union remembered by Chrome and the
  // reusable live-suggest hook, followed by the actual popup code.
  rememberSuggestGroups(result.hydrated || result.groups, { searchLang: 'en' });
  return paint(query, printLang);
}

test('cold typo retrieval keeps the complete candidate source before Western filtering', async () => {
  const calls = [];
  const source = async (query, options) => {
    calls.push({ query, printLang: options.printLang });
    const key = compactQuery(query);
    const filtered = options.printLang === 'western';
    if (key === 'diagl') return filtered ? RAW_WESTERN : RAW_ALL;
    if (key === 'dialga') return filtered
      ? payload(rowsOf(RAW_WESTERN.groups).filter((row) => row.name === 'Dialga')
        .map((row) => [row.id, row.name, row.set, row.number, row.nationality]))
      : DIALGA_ALL;
    if (key === 'diglett') return filtered
      ? payload(rowsOf(RAW_WESTERN.groups).filter((row) => row.name !== 'Dialga')
        .map((row) => [row.id, row.name, row.set, row.number, row.nationality]))
      : DIGLETT_ALL;
    return { groups: [], count: 0 };
  };
  const rows = await hydrateCold('diagl', source, 'western');
  assert.equal(rows.length, 20, 'known eligible printings must not collapse to the three stale-index hits');
  assert.equal(rows[0].name, 'Dialga');
  assert.equal(new Set(rows.map((row) => row.id)).size, 20);
  assert.ok(rows.every((row) => rowPrintBucket(row) === 'western' && !isLiveStub(row)));
  assert.ok(calls.some((call) => compactQuery(call.query) === 'dialga'),
    'the locally corrected canonical name is hydrated from a cold start');
  assert.ok(calls.every((call) => call.printLang === 'all'),
    'candidate-source requests cannot discard cards using incomplete index facets');

  const canonicalWestern = rowsOf(DIALGA_ALL.groups)
    .filter((row) => row.nationality === 'western');
  const ids = new Set(rows.map((row) => row.id));
  assert.ok(canonicalWestern.every((row) => ids.has(row.id)),
    'the hydrated Western Dialga cards survive into the popup');
});

test('All and Western are distinct popup universes over the same cold candidate source', async () => {
  const observed = new Map();
  for (const printLang of ['all', 'western']) {
    const rows = await hydrateCold('diagl', async (query, options) => {
      assert.equal(options.printLang, 'all');
      return compactQuery(query) === 'diagl' ? RAW_ALL : DIALGA_ALL;
    }, printLang);
    observed.set(printLang, rows);
    assert.equal(rows.length, 20, printLang);
    assert.equal(rows[0].name, 'Dialga', printLang);
  }
  assert.ok(observed.get('all').some((row) => rowPrintBucket(row) !== 'western'));
  assert.ok(observed.get('western').every((row) => rowPrintBucket(row) === 'western'));
});

test('Western chooses twenty same-name printings from beyond the old twenty-row response', async () => {
  const full = payload(Array.from({ length: 170 }, (_, i) => [
    String(850000 + i), 'Dialga', i < 150 ? 'Base Set' : 'Towering Perfection',
    `${i + 1}/200`, i < 150 ? 'western' : 'japanese',
  ]));
  const rows = await hydrateCold('diagl', async (query, options) => {
    assert.equal(options.printLang, 'all');
    assert.equal(options.hydrate, true);
    assert.equal(options.limit, 1000);
    return compactQuery(query) === 'dialga' ? full : { groups: [], count: 0 };
  }, 'western');
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => row.name === 'Dialga' && row.nationality === 'western'));
});

test('an accepted name correction keeps its printing variants ahead of competing species', async () => {
  const full = payload([
    ...Array.from({ length: 15 }, (_, i) => [String(860000 + i), 'Dialga', 'Base Set', `${i + 1}/102`, 'western']),
    ...Array.from({ length: 20 }, (_, i) => [String(861000 + i), 'Dialga', 'Towering Perfection', `${i + 1}/67`, 'japanese']),
    ...Array.from({ length: 9 }, (_, i) => [String(862000 + i), 'Dialga Lv.68', 'Great Encounters', `${i + 1}/106`, 'western']),
    ...Array.from({ length: 20 }, (_, i) => [String(863000 + i), 'Diglett', 'Base Set', `${i + 1}/102`, 'western']),
  ]);
  const rows = await hydrateCold('diagl', async () => full, 'western');
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => /^Dialga(?: |$)/.test(row.name)),
    'a competing typo name cannot displace variants of the locally corrected identity');
  assert.ok(rows.some((row) => row.name === 'Dialga Lv.68'), 'basic level-suffix printings remain real candidates');
});

test('cold three-token queries hydrate actual local-name anchors with a missing raw search result', async () => {
  for (const [query, name] of [['ex ex mewtow', 'Mewtwo ex'], ['arita bhlbsur ir', 'Bulbasaur'],
    ['evol dwrknessener holo', 'Darkness Energy']]) {
    const rows = await hydrateCold(query, async (lookup, options) => {
      assert.equal(options.printLang, 'all');
      return compactQuery(lookup) === compactQuery(name) ? payload(Array.from({ length: 30 }, (_, i) => [
        String(870000 + i), name, 'Evolutions', `${i + 1}/108`, 'western',
      ])) : { groups: [], count: 0 };
    }, 'western');
    assert.equal(rows.length, 20, query);
    assert.ok(rows.every((row) => row.name === name), query);
  }
});

test('mixed set and mechanic queries retain every name reading until printing scoring', async () => {
  const source = payload(['Mewtwo', 'Mewtwo EX', 'Mewtwo GX'].flatMap((name, form) =>
    Array.from({ length: 30 }, (_, i) => [String(880000 + form * 100 + i), name,
      'Evolutions', `${i + 1}/108`, 'western'])));
  const fetched = await fetchSuggestRanked('mewtow evol ex', {
    fetchSuggest: async () => source,
    fetchSearch: async () => ({ cards: [], total: null }),
    kind: 'singles', lang: 'en', printLang: 'western', limit: 20,
  });
  assert.equal(rowsOf(fetched.hydrated).length, 90,
    'a legacy name lock must not erase candidate readings before the shared scorer');
  resetSuggestLive();
  rememberSuggestGroups(fetched.hydrated, { searchLang: 'en' });
  const rows = paint('mewtow evol ex', 'western');
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => row.name === 'Mewtwo EX'));
});

// The documented 2pikabench corrupts a whole compact identity. Multiword
// identities must remain reachable as words disappear; the recovery cannot
// stop at rankNames while the hydrated rows vanish before popup paint.
const BENCH = [
  ['oriruo', 'Oricorio'],
  ['dwrknessener', 'Darkness Energy'],
  ['dclops', 'Dusclops'],
  ['bhlbsur', 'Bulbasaur'],
  ['zjnniasresve', "Zinnia's Resolve"],
  ['rnofvotlity', 'Urn of Vitality'],
  ['xuknoi', 'Dusknoir'],
  ['quikbkl', 'Quick Ball'],
  ['entavrel', 'Tentacruel'],
  ['ombusln', 'Combusken'],
];

function catalogSource(name, calls, numberOfCards = 20) {
  // Identity-only printing records isolate corpus recall from artwork,
  // collector and expansion sorting; each numeric fixture id is distinct.
  const cards = payload(Array.from({ length: numberOfCards }, (_, index) => [
    String(900000 + index), name, '', '', 'western',
  ]));
  return async (query, options) => {
    calls.push({ query, printLang: options.printLang });
    // Model the real asymmetry: Meili's raw typo floor cannot find these cards;
    // the local catalog's corrected identity retrieves all their printings.
    return compactQuery(query) === compactQuery(name) && options.printLang === 'all'
      ? cards : { groups: [], count: 0 };
  };
}

async function assertColdRecovery(query, name, printLang, capacity = 20) {
  const calls = [];
  const rows = await hydrateCold(query, catalogSource(name, calls, capacity), printLang);
  assert.equal(rows.length, capacity, query + ' retrieves and paints the available cards');
  assert.equal(rows[0].name, name, query);
  assert.ok(rows.every((row) => row.name === name && !isLiveStub(row)), query);
  assert.equal(new Set(rows.map((row) => row.id)).size, capacity, query);
  assert.ok(calls.some((call) => compactQuery(call.query) === compactQuery(name)),
    query + ' must hydrate the corrected identity, not just rank it locally');
  assert.ok(calls.every((call) => call.printLang === 'all'),
    query + ' keeps candidate hydration independent of the print chip');
}

test('documented 2pikabench survives cold fetch → cache → popup under All and Western', async (t) => {
  for (const printLang of ['all', 'western']) {
    for (const [query, name] of BENCH) {
      await t.test(printLang + ': ' + query + ' → ' + name, async () => {
        await assertColdRecovery(query, name, printLang, name === 'Urn of Vitality' ? 12 : 20);
      });
    }
  }
});

test('documented Reddit A-tier recovery survives the full cold popup path', async (t) => {
  const available = new Set(NAME_POOL.map((row) => row.compact));
  // Same supported corpus boundary as the existing Reddit rank test: keep
  // official localized-name guards and the documented fuzzy distance cap.
  const corpus = REDDIT_TYPOS.filter((row) => row.tier === 'A' && !row.guard
    && available.has(compactQuery(row.name))
    && prefixEditDistance(compactQuery(row.typo), compactQuery(row.name))
      <= maxDistance(compactQuery(row.typo).length) + 1e-9);
  assert.ok(corpus.length > 30, 'the test must exercise the corpus, not a few chosen typos');
  for (const row of corpus) {
    await t.test(row.typo + ' → ' + row.name, async () => {
      await assertColdRecovery(row.typo, row.name, 'all');
    });
  }
});
