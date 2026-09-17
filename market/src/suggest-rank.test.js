import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  NAME_POOL,
  absorbNames,
  capSuggestGroups,
  compactQuery,
  extraSuggestQueries,
  fetchSuggestRanked,
  fillSuggestGroups,
  isSetOnlyQuery,
  maxDistance,
  mergeSuggestGroups,
  orderSuggestGroups,
  parseTypedQuery,
  pikabenchCards,
  prefixEditDistance,
  printingMatchesArtFilter,
  printingMatchesNumberFilter,
  printingMatchesRarityFilter,
  printingMatchesSetFilter,
  printingPrintRank,
  rankNames,
  rankNamesParallel,
  rankPrefixTrace,
  rankedSuggestLookups,
  resolveSearchQuery,
  runTwoPikabench,
  formatTwoPikabenchReport,
  setAwareSearchLookups,
  typedMeiliQuery,
  hasRivalMechanic,
} from './suggest-rank.js';
import REDDIT_TYPOS from './data/reddit-pokemon-typos.js';

const FIXTURE = [
  { display: 'Pikachu', prior: 321 },
  { display: 'Pikachu V', prior: 27 },
  { display: 'Piplup', prior: 30 },
  { display: 'Onix', prior: 53 },
  { display: 'Oddish', prior: 44 },
  { display: 'Oricorio', prior: 36 },
  { display: 'Oinkologne', prior: 11 },
  { display: 'Oshawott', prior: 30 },
  { display: 'Dawn', prior: 2 },
  { display: 'Dawn Stadium', prior: 2 },
  { display: 'Darkrai', prior: 30 },
  { display: 'Charizard', prior: 70 },
  { display: 'Potion', prior: 110 },
].map((row) => ({ ...row, compact: compactQuery(row.display) }));

function names(ranked) {
  return ranked.map((row) => row.display);
}

function rankOf(ranked, display) {
  return names(ranked).indexOf(display);
}

test('compactQuery folds punctuation', () => {
  assert.equal(compactQuery('Poké Ball'), 'pokeball');
  assert.equal(compactQuery('ニンフィア'), 'ニンフィア');
});

test('one letter keeps keyboard typos and rejects far letters', () => {
  assert.equal(maxDistance(1), 0.5);
  assert.equal(prefixEditDistance('o', 'onix'), 0);
  assert.equal(prefixEditDistance('o', 'pikachu'), 0.5);
  assert.ok(prefixEditDistance('x', 'pikachu') > 0.5);
});

test('o ranks exact O names first and still keeps Pikachu ready', () => {
  const ranked = rankNames('o', FIXTURE);
  assert.ok(rankOf(ranked, 'Onix') >= 0);
  assert.ok(rankOf(ranked, 'Onix') < rankOf(ranked, 'Pikachu'));
  assert.ok(rankOf(ranked, 'Oddish') < rankOf(ranked, 'Pikachu'));
  assert.ok(rankOf(ranked, 'Pikachu') >= 0);
  assert.equal(rankOf(ranked, 'Charizard'), -1);
});

test('oi keeps Pikachu ready without beating exact-prefix Oinkologne', () => {
  const onO = rankNames('o', FIXTURE);
  const onOi = rankNames('oi', FIXTURE);
  assert.ok(rankOf(onOi, 'Pikachu') >= 0);
  assert.ok(rankOf(onOi, 'Pikachu') < rankOf(onO, 'Pikachu'));
  assert.ok(rankOf(onOi, 'Oinkologne') < rankOf(onOi, 'Pikachu'));
  assert.equal(rankOf(onOi, 'Onix'), -1);
});

test('pi keeps base Pikachu ahead of Pikachu V', () => {
  const ranked = rankNames('pi', FIXTURE);
  assert.equal(ranked[0].display, 'Pikachu');
  assert.ok(rankOf(ranked, 'Pikachu') < rankOf(ranked, 'Pikachu V'));
});

test('pikahc gx ranks Pikachu GX above base Pikachu', () => {
  const ranked = rankNames('pikahc gx');
  assert.equal(ranked[0].display, 'Pikachu GX');
  assert.ok(rankOf(ranked, 'Pikachu GX') < rankOf(ranked, 'Pikachu'));
  assert.equal(rankNames('miikyu ex')[0].display, 'Mimikyu ex');
  const gx = ranked.find((row) => row.display === 'Pikachu GX');
  const base = ranked.find((row) => row.display === 'Pikachu');
  assert.ok(gx.score > base.score);
  assert.ok(gx.score / base.score > 2);
});

test('four letters allow one far typo: dawe → Dawn', () => {
  assert.equal(prefixEditDistance('dawe', 'dawn'), 1);
  const ranked = rankNames('dawe', FIXTURE);
  assert.equal(ranked[0].display, 'Dawn');
  assert.ok(rankOf(ranked, 'Dawn') < rankOf(ranked, 'Darkrai') || rankOf(ranked, 'Darkrai') === -1);
});

test('production pool still ranks the live misspellings', () => {
  assert.ok(NAME_POOL.some((row) => row.compact === 'pikachu'));
  assert.ok(NAME_POOL.some((row) => row.compact === 'dawn'));
  const oi = rankNames('oi');
  const dawe = rankNames('dawe');
  const talflamd = rankNames('talflamd');
  assert.equal(oi[0].display, 'Oinkologne');
  assert.ok(oi.some((row) => row.display === 'Pikachu'));
  assert.equal(dawe[0].display, 'Dawn');
  assert.equal(talflamd[0].display, 'Talonflame');
  assert.equal(resolveSearchQuery('talflamd', talflamd), 'Talonflame');
});

test('seven letters allow two skipped letters plus an adjacent key', () => {
  assert.equal(prefixEditDistance('talflamd', 'talonflame'), 2.5);
  assert.ok(maxDistance(8) >= 2.5);
  assert.ok(maxDistance(6) >= 2.5);
  assert.ok(maxDistance(5) < 2.5);
});

test('2pikabench: 10 two-insert keyboard typos recover as one bench', async () => {
  const report = await runTwoPikabench();
  assert.equal(report.name, '2pikabench');
  assert.equal(report.count, 10);
  assert.equal(report.recovered, 10);
  assert.ok(report.rankMs > 0);
  assert.equal(report.searchMs, null);
  const misses = report.cases.filter((row) => !row.ok).map((row) => (
    `${row.query} → ${row.got || '∅'} (want ${row.display})`
  ));
  assert.equal(misses.join('\n'), '');
  console.log(formatTwoPikabenchReport(report));
});

test('2pikabench records search_ms for the typeahead fetch', async () => {
  const report = await runTwoPikabench({
    fetchSuggest: async (query) => ({
      count: 20,
      groups: [{ name: query, printings: [{ id: query, name: query }] }],
    }),
  });
  assert.equal(report.count, 10);
  assert.ok(report.searchMs >= 0);
  assert.ok(report.cases.every((row) => row.searchMs != null && row.searchMs >= 0));
});

test('extra lookups skip names Meili already prefixes', () => {
  assert.deepEqual(extraSuggestQueries('oi', rankNames('oi', FIXTURE), 1), ['Pikachu']);
  assert.deepEqual(extraSuggestQueries('o', rankNames('o', FIXTURE), 1), []);
  assert.deepEqual(extraSuggestQueries('pi', rankNames('pi', FIXTURE)), []);
});

test('singles extra lookups skip theme decks and chests', () => {
  const extras = extraSuggestQueries('arceus platinum', rankNames('arceus platinum'), 8, 'singles');
  assert.ok(!extras.some((name) => /theme deck|chest|poster|coin|booster/i.test(name)));
});

test('singles extra lookups skip Paldean Fates Collections and League Battle decks', () => {
  const extras = extraSuggestQueries('charizard', rankNames('charizard'), 20, 'singles');
  assert.ok(!extras.some((name) => /collections|league battle|dice set/i.test(name)));
});

test('Enter expands a typo but keeps a real prefix', () => {
  assert.equal(resolveSearchQuery('dawe', rankNames('dawe', FIXTURE)), 'Dawn');
  assert.equal(resolveSearchQuery('oi', rankNames('oi', FIXTURE)), 'oi');
  assert.equal(resolveSearchQuery('pi', rankNames('pi', FIXTURE)), 'pi');
  assert.equal(resolveSearchQuery('o', rankNames('o', FIXTURE)), 'o');
});

test('merged suggest groups follow name probability', () => {
  const merged = mergeSuggestGroups([
    [{ name: 'Oinkologne', printings: [{ id: '1' }] }],
    [{ name: 'Pikachu', printings: [{ id: '2' }, { id: '1' }] }],
  ]);
  const ordered = orderSuggestGroups(merged, rankNames('oi', FIXTURE));
  assert.deepEqual(ordered.map((group) => group.name), ['Oinkologne', 'Pikachu']);
  assert.deepEqual(ordered[0].printings.map((row) => row.id), ['1']);
});

test('popup prefers four printings per name then fills to 20', () => {
  const groups = fillSuggestGroups([
    { name: 'A', printings: Array.from({ length: 15 }, (_, i) => ({ id: `a${i}` })) },
    { name: 'B', printings: Array.from({ length: 15 }, (_, i) => ({ id: `b${i}` })) },
  ]);
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids.length, 20);
  assert.deepEqual(ids.slice(0, 4), ['a0', 'a1', 'a2', 'a3']);
  assert.deepEqual(ids.slice(4, 8), ['b0', 'b1', 'b2', 'b3']);
});

test('fill never paints live name stubs', () => {
  const groups = fillSuggestGroups([
    { name: 'Mimikyu', printings: [{ id: '1', name: 'Mimikyu', itemKind: 'single' }] },
    { name: 'Mimikyu V', printings: [{ id: 'live:mimikyuv', name: 'Mimikyu V', live: true, item_kind: 'single' }] },
    { name: 'Mimikyu ex', printings: [{ id: 'live:mimikyuex', name: 'Mimikyu ex', live: true, item_kind: 'single' }] },
  ], 20, 4, null, 'singles');
  assert.deepEqual(groups.map((group) => group.name), ['Mimikyu']);
});

test('fetchSuggestRanked asks Meili for the typed query and extra names', async () => {
  const calls = [];
  const result = await fetchSuggestRanked('oi', {
    pool: FIXTURE,
    extraLimit: 1,
    fetchSuggest: async (query) => {
      calls.push(query);
      if (query === 'oi') {
        return { count: 3, groups: [{ name: 'Oinkologne', printings: [{ id: 'oink' }] }] };
      }
      return { count: 49, groups: [{ name: 'Pikachu', printings: [{ id: 'pika' }] }] };
    },
  });
  assert.deepEqual(calls, ['oi', 'Pikachu']);
  assert.equal(result.resolvedQuery, 'oi');
  assert.ok(result.groups[0].name === 'Oinkologne');
  assert.ok(Array.isArray(result.hydrated));
  assert.ok(result.hydrated.length >= result.groups.length);
});

test('fetchSuggestRanked asks Meili during a slow rank worker', async () => {
  let suggestAt = 0;
  const started = Date.now();
  const result = await fetchSuggestRanked('Palkia & Dialga Legend', {
    extraLimit: 0,
    concurrency: 2,
    mapChunk: async (query, chunk) => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return rankNames(query, chunk);
    },
    fetchSuggest: async () => {
      if (!suggestAt) {
        suggestAt = Date.now() - started;
      }
      return {
        count: 2,
        groups: [{
          name: 'Palkia & Dialga LEGEND',
          printings: [{ id: 'legend', name: 'Palkia & Dialga LEGEND', number: '101/102' }],
        }],
      };
    },
  });
  assert.ok(suggestAt < 80, `Meili waited ${suggestAt}ms on rank`);
  assert.equal(result.groups[0].name, 'Palkia & Dialga LEGEND');
});

test('live Meili names join the pool without replacing priors', () => {
  const next = absorbNames(FIXTURE, [{ name: 'Omanyte' }, { name: 'Pikachu' }]);
  assert.equal(next.find((row) => row.compact === 'pikachu').prior, 321);
  assert.equal(next.find((row) => row.compact === 'omanyte').prior, 8);
});

test('Chrome ranks from one character and opens the popup at three', () => {
  const chrome = readFileSync(new URL('./components/Chrome.jsx', import.meta.url), 'utf8');
  assert.match(chrome, /fetchSuggestRanked/);
  assert.match(chrome, /liveSuggestGroups/);
  assert.match(chrome, /printLang/);
  assert.match(chrome, /suggestLiveReady/);
  assert.match(chrome, /fetchSearch,/);
  assert.match(chrome, /mapChunk: rankChunkOnWorker/);
  assert.match(chrome, /kind: searchTabRef\.current/);
  assert.match(chrome, /catalogIntent/);
  assert.match(chrome, /fetchArtist/);
  assert.match(chrome, /liveTick/);
  assert.match(chrome, /SearchTabs/);
  assert.match(chrome, /searchTab/);
  assert.equal(chrome.includes('setGroups(liveSuggestGroups'), false);
  assert.equal(chrome.includes('suggest-pending'), false);
  assert.equal(chrome.includes('term.length < 2'), false);
});

test('hgss energy peels the set code and keeps the name', () => {
  for (const query of ['hgss energy', 'energy hgss', 'HGSS Energy']) {
    const parsed = parseTypedQuery(query);
    assert.equal(compactQuery(parsed.nameQuery), 'energy', query);
    assert.deepEqual(parsed.eras, ['HeartGold & SoulSilver'], query);
    assert.equal(resolveSearchQuery(query, rankNames(query, FIXTURE)), query);
  }
  const leftoverG = parseTypedQuery('g energy');
  assert.equal(leftoverG.nameQuery, 'g energy');
  assert.equal(leftoverG.setTokens.length, 0);
  assert.equal(parseTypedQuery('pikachu').setTokens.length, 0);
  const arceusPlatinum = parseTypedQuery('arceus platinum');
  assert.equal(compactQuery(arceusPlatinum.nameQuery), 'arceus');
  assert.deepEqual(arceusPlatinum.eras, ['Platinum']);
  assert.ok(setAwareSearchLookups(parseTypedQuery('hgss energy')).some((row) => /heartgold/i.test(row)));
});

test('hgss energy fill keeps HeartGold energies, not Aquapolis Switch', () => {
  const parsed = parseTypedQuery('hgss energy');
  const groups = fillSuggestGroups([
    {
      name: 'Energy Switch',
      printings: [
        { id: 'aq', name: 'Energy Switch', set: 'Aquapolis', number: '120/147' },
        { id: 'hgss', name: 'Energy Switch', set: 'HeartGold & SoulSilver', number: '091/123' },
      ],
    },
    {
      name: 'Fire Energy',
      printings: [{ id: 'fire', name: 'Fire Energy', set: 'HeartGold & SoulSilver', number: '116/123' }],
    },
  ], 20, 4, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('hgss'));
  assert.ok(ids.includes('fire'));
  assert.ok(!ids.includes('aq'));
});

test('palkai sl peels Call of Legends and keeps Palkia, not LV.X', () => {
  const parsed = parseTypedQuery('palkai sl');
  assert.equal(compactQuery(parsed.nameQuery), 'palkai');
  assert.ok(parsed.setTokens.some((token) => token.compact === 'sl'));
  assert.ok(parsed.eras.includes('Call of Legends'));
  assert.equal(printingMatchesSetFilter({
    name: 'Palkia',
    set: 'Call of Legends',
    number: '11/95',
  }, parsed), true);
  assert.equal(printingMatchesSetFilter({
    name: 'Palkia LV.X',
    set: 'Great Encounters',
    number: '106/106',
  }, parsed), false);
  const groups = fillSuggestGroups([
    {
      name: 'Palkia LV.X',
      printings: [{ id: 'lvx', name: 'Palkia LV.X', set: 'Great Encounters', number: '106/106' }],
    },
    {
      name: 'Palkia',
      printings: [
        { id: 'col', name: 'Palkia', set: 'Call of Legends', number: '11/95' },
        { id: 'ge', name: 'Palkia', set: 'Great Encounters', number: '26/106' },
      ],
    },
    {
      name: 'Palkia & Dialga LEGEND',
      printings: [{
        id: 'jumbo',
        name: 'Palkia & Dialga LEGEND',
        number: 'Jumbo Oversized',
        set: 'Triumphant',
      }],
    },
  ], 20, 4, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids[0], 'col');
  assert.ok(ids.includes('ge'));
  assert.ok(!ids.includes('jumbo'));
});

test('palkia legen peels Call of Legends and still fills the Palkia name pool', () => {
  const parsed = parseTypedQuery('palkia legen');
  assert.equal(compactQuery(parsed.nameQuery), 'palkia');
  assert.ok(parsed.setTokens.some((token) => token.compact === 'legen'));
  assert.ok(parsed.eras.includes('Call of Legends'));
  const printings = [
    { id: 'col', name: 'Palkia', set: 'Call of Legends', number: '11/95' },
    ...Array.from({ length: 24 }, (_, index) => ({
      id: `p${index}`,
      name: 'Palkia',
      set: 'Great Encounters',
      number: `${index + 1}/106`,
    })),
  ];
  const groups = fillSuggestGroups([
    { name: 'Palkia Premium Box', printings: [{ id: 'box', name: 'Palkia Premium Box', itemKind: 'product' }] },
    { name: 'Palkia', printings },
    {
      name: 'Charizard',
      printings: [{
        id: 'jumbo',
        name: 'Charizard',
        number: '017',
        rarity: 'Jumbo Oversized',
        set: 'XY Black Star Promos',
      }],
    },
  ], 20, 4, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids[0], 'col');
  assert.equal(ids.length, 20);
  assert.ok(!ids.includes('box'));
  assert.ok(!ids.includes('jumbo'));
});

test('sylveon ex il peels illustration and keeps the ex name', () => {
  const parsed = parseTypedQuery('sylveon ex il');
  assert.equal(parsed.nameQuery, 'sylveon ex');
  assert.equal(parsed.artTokens[0]?.art, 'illustration');
  assert.equal(parseTypedQuery('miikyu ex').nameQuery, 'miikyu ex');
  assert.equal(printingMatchesArtFilter({
    name: 'Sylveon ex',
    rarity: 'Special Illustration Rare',
    number: '086/131',
  }, parsed), true);
  assert.equal(printingMatchesArtFilter({
    name: 'Sylveon ex',
    rarity: 'Double Rare',
    number: '033/131',
  }, parsed), false);
});

test('eevee i and eevee ill peel illustration shorthand like il', () => {
  for (const query of ['eevee i', 'eevee ill']) {
    const parsed = parseTypedQuery(query);
    assert.equal(parsed.nameQuery, 'eevee');
    assert.equal(parsed.artTokens[0]?.art, 'illustration');
    assert.equal(printingMatchesArtFilter({
      name: 'Eevee',
      rarity: 'Special Illustration Rare',
      number: '167/131',
    }, parsed), true);
    assert.equal(printingMatchesArtFilter({
      name: 'Eevee',
      rarity: 'Rare',
      number: '123/151',
    }, parsed), false);
  }
  assert.equal(parseTypedQuery('eevee').artTokens.length, 0);
});

test('cynthia secret rare peels rarity; 119/156 is a collector query', () => {
  const rarity = parseTypedQuery('cynthia secret rare');
  assert.equal(compactQuery(rarity.nameQuery), 'cynthia');
  assert.equal(rarity.rarityTokens[0]?.rarity, 'secret');
  const number = parseTypedQuery('119/156');
  assert.equal(number.numberTokens[0]?.n, 119);
  assert.equal(number.numberTokens[0]?.d, 156);
  assert.equal(number.nameQuery, '');
});

test('Sh1 is a letter-prefix collector, not the name Shinx', () => {
  const parsed = parseTypedQuery('Sh1');
  assert.equal(parsed.nameQuery, '');
  assert.equal(parsed.numberTokens[0]?.code, 'sh');
  assert.equal(parsed.numberTokens[0]?.n, 1);
  assert.equal(parseTypedQuery('shi').numberTokens.length, 0);
  assert.equal(compactQuery(parseTypedQuery('shi').nameQuery), 'shi');
  const sh12 = parseTypedQuery('SH12');
  assert.equal(sh12.numberTokens[0]?.code, 'sh');
  assert.equal(sh12.numberTokens[0]?.n, 12);
  const sh1 = parsed;
  assert.equal(printingMatchesNumberFilter({ name: 'Drifloon Lv.16', number: 'Holo Rare | SH1' }, sh1), true);
  assert.equal(printingMatchesNumberFilter({ name: 'Bagon', number: 'SH10 | Holo Rare' }, sh1), true);
  assert.equal(printingMatchesNumberFilter({ name: 'Ponyta', number: 'SH11' }, sh1), true);
  assert.equal(printingMatchesNumberFilter({ name: 'Shinx', number: 'SH12' }, sh1), true);
  assert.equal(printingMatchesNumberFilter({ name: 'Shinx', number: 'SH4' }, sh1), false);
  assert.equal(printingMatchesNumberFilter({ name: 'Shinx', number: 'LV.11' }, sh1), false);
  assert.equal(printingMatchesNumberFilter({ name: 'Potion', number: '061/073' }, sh1), false);
  assert.equal(printingMatchesNumberFilter({ name: 'Shinx', number: 'SH12' }, sh12), true);
  assert.equal(printingMatchesNumberFilter({ name: 'Drifloon Lv.16', number: 'Holo Rare | SH1' }, sh12), false);
  assert.equal(resolveSearchQuery('Sh1', rankNames('Sh1')), 'Sh1');
  assert.equal(typedMeiliQuery('Sh1'), 'Sh1');
  assert.equal(rankedSuggestLookups(rankNames('Sh1'), 3)[0], 'Shinx');
  assert.ok(rankedSuggestLookups(rankNames('Sh1'), 8).includes('Shuppet'));
  assert.equal(printingPrintRank({ nationality: 'western' }, 'western'), 0);
  assert.equal(printingPrintRank({ nationality: 'japanese' }, 'western'), 2);
});

test('bare SH1 fill keeps collector hits first then fills toward 20', () => {
  const parsed = parseTypedQuery('Sh1');
  const groups = fillSuggestGroups([
    {
      name: 'Shinx',
      printings: [
        { id: 'lv', name: 'Shinx', number: 'LV.11', set: 'Perfect Order' },
        { id: 'sh12', name: 'Shinx', number: 'SH12', set: 'Platinum Arceus' },
        ...Array.from({ length: 18 }, (_, i) => ({ id: `sx${i}`, name: 'Shinx', number: `${i}/99` })),
      ],
    },
    { name: 'Drifloon Lv.16', printings: [{ id: 'drift', name: 'Drifloon Lv.16', number: 'Holo Rare | SH1', set: 'Stormfront' }] },
    { name: 'Bagon', printings: [{ id: 'bagon', name: 'Bagon', number: 'SH10 | Holo Rare', set: 'Platinum Arceus' }] },
    { name: 'Shuppet', printings: [{ id: 'pup', name: 'Shuppet', number: '068/146', set: 'XY' }] },
  ], 20, 4, parsed);
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids.length, 20);
  // Scored order: Drifloon carries the exact SH1 code, Bagon SH10 is closer
  // than Shinx SH12; all collector hits still rank before the Shinx fill.
  assert.deepEqual(ids.slice(0, 3), ['drift', 'bagon', 'sh12']);
  assert.ok(ids.includes('lv'));
  assert.ok(ids.includes('pup'));
});

test('fetchSuggestRanked hydrates Sh1 as SH collector codes, not Shinx', async () => {
  const calls = [];
  const result = await fetchSuggestRanked('Sh1', {
    extraLimit: 0,
    fetchSuggest: async (query) => {
      calls.push(query);
      return {
        count: 4,
        groups: [{
          name: 'Shinx',
          printings: [
            { id: 'sh12', name: 'Shinx', number: 'SH12', set: 'Platinum Arceus' },
            { id: 'lv', name: 'Shinx', number: 'LV.11', set: 'Perfect Order' },
          ],
        }, {
          name: 'Drifloon Lv.16',
          printings: [{ id: 'drift', name: 'Drifloon Lv.16', number: 'Holo Rare | SH1', set: 'Stormfront' }],
        }, {
          name: 'Bagon',
          printings: [{ id: 'bagon', name: 'Bagon', number: 'SH10 | Holo Rare', set: 'Platinum Arceus' }],
        }, {
          name: 'Ponyta',
          printings: [{ id: 'pony', name: 'Ponyta', number: 'SH11', set: 'Platinum Arceus' }],
        }],
      };
    },
  });
  assert.deepEqual(calls, ['Sh1']);
  assert.equal(result.resolvedQuery, 'Sh1');
  const ids = result.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.deepEqual(ids.slice(0, 4).sort(), ['bagon', 'drift', 'pony', 'sh12']);
  assert.ok(ids.includes('lv'));
});

test('fetchSuggestRanked fills Sh1 toward 20 from name typos and western print', async () => {
  const calls = [];
  const result = await fetchSuggestRanked('Sh1', {
    extraLimit: 2,
    printLang: 'western',
    fetchSuggest: async (query) => {
      calls.push(query);
      if (compactQuery(query) === 'sh1') {
        return {
          count: 4,
          groups: [{
            name: 'Drifloon Lv.16',
            printings: [{
              id: 'drift',
              name: 'Drifloon Lv.16',
              number: 'Holo Rare | SH1',
              nationality: 'western',
            }],
          }],
        };
      }
      if (query === 'Shinx') {
        return {
          count: 40,
          groups: [{
            name: 'Shinx',
            printings: [
              { id: 'jp', name: 'Shinx', number: '012/100', nationality: 'japanese' },
              { id: 'wx', name: 'Shinx', number: 'LV.11', nationality: 'western' },
              { id: 'sh12', name: 'Shinx', number: 'SH12', nationality: 'western' },
              ...Array.from({ length: 20 }, (_, i) => ({
                id: `wx${i}`,
                name: 'Shinx',
                number: `${i}/99`,
                nationality: 'western',
              })),
            ],
          }],
        };
      }
      return {
        count: 12,
        groups: [{
          name: query,
          printings: Array.from({ length: 12 }, (_, i) => ({
            id: `${query}-${i}`,
            name: query,
            number: `${i}/100`,
            nationality: i === 0 ? 'japanese' : 'western',
          })),
        }],
      };
    },
  });
  assert.ok(calls.includes('Sh1'));
  assert.ok(calls.includes('Shinx'));
  const rows = result.groups.flatMap((group) => group.printings);
  assert.equal(rows.length, 20);
  assert.ok(rows.some((row) => row.id === 'drift'));
  assert.ok(rows.some((row) => row.id === 'sh12'));
  assert.ok(rows.some((row) => row.name && row.name !== 'Drifloon Lv.16'));
  const shinx = result.groups.find((group) => group.name === 'Shinx');
  assert.ok(shinx);
  assert.equal(shinx.printings[0].id, 'sh12');
  assert.equal(printingPrintRank(shinx.printings[0], 'western'), 0);
});

test('061 shieldon peels the collector and keeps the name', () => {
  for (const query of ['061 shieldon', 'shieldon 061', '061/106 shieldon']) {
    const parsed = parseTypedQuery(query);
    assert.equal(compactQuery(parsed.nameQuery), 'shieldon', query);
    assert.equal(parsed.numberTokens[0]?.n, 61, query);
  }
  const parsed = parseTypedQuery('061 shieldon');
  assert.equal(printingMatchesNumberFilter({
    name: 'Shieldon',
    number: '061/106',
  }, parsed), true);
  assert.equal(printingMatchesNumberFilter({
    name: 'Potion',
    number: '061/073',
  }, parsed), true);
  assert.equal(printingMatchesNumberFilter({
    name: 'Shieldon',
    number: '110/123',
  }, parsed), false);
  const set151 = parseTypedQuery('151 pikachu');
  assert.equal(compactQuery(set151.nameQuery), 'pikachu');
  assert.equal(set151.numberTokens.length, 0);
  assert.ok(set151.setTokens.some((token) => token.compact === '151'));
  const shieldSet = parseTypedQuery('shield pikachu');
  assert.equal(compactQuery(shieldSet.nameQuery), 'pikachu');
  assert.ok(shieldSet.setTokens.some((token) => token.compact === 'shield'));
  assert.equal(parseTypedQuery('shieldon').setTokens.length, 0);
  assert.equal(resolveSearchQuery('061 shieldon', rankNames('061 shieldon')), '061 shieldon');
  assert.equal(compactQuery(typedMeiliQuery('061 shieldon')), 'shieldon');
});

test('fetchSuggestRanked ranks Shieldon for 061 shieldon, not Potion 061', async () => {
  const calls = [];
  const result = await fetchSuggestRanked('061 shieldon', {
    extraLimit: 0,
    fetchSuggest: async (query) => {
      calls.push(query);
      return {
        count: 313,
        groups: [{
          name: 'Potion',
          printings: [{ id: 'potion', name: 'Potion', number: '061/073', set: "Champion's Path" }],
        }, {
          name: 'Onix',
          printings: [{ id: 'onix', name: 'Onix', number: '061/082', set: 'Flight of Legends' }],
        }, {
          name: 'Shieldon',
          printings: [
            { id: 'other', name: 'Shieldon', number: '110/123', set: 'Mysterious Treasures' },
            { id: 'hit', name: 'Shieldon', number: '061/106', set: 'Great Encounters' },
          ],
        }],
      };
    },
  });
  assert.ok(calls.every((query) => !/\b061\b/.test(query)));
  assert.ok(calls.some((query) => /shieldon/i.test(query)));
  assert.equal(result.groups[0]?.name, 'Shieldon');
  assert.equal(result.groups[0]?.printings[0]?.id, 'hit');
  assert.ok(!result.groups.some((group) => group.name === 'Potion'));
  assert.ok(!result.groups.some((group) => group.name === 'Onix'));
});

test('fetchSuggestRanked puts Sylveon ex full art first for il', async () => {
  const calls = [];
  const result = await fetchSuggestRanked('sylveon ex il', {
    extraLimit: 0,
    fetchSuggest: async (query) => {
      calls.push(query);
      return {
        count: 3,
        groups: [{
          name: 'Sylveon ex',
          printings: [
            { id: 'rr', name: 'Sylveon ex', rarity: 'Double Rare', number: '033/131' },
            { id: 'sir', name: 'Sylveon ex', rarity: 'Special Illustration Rare', number: '086/131' },
            { id: 'box', name: 'Sylveon Collection', productType: 'product', itemKind: 'product' },
          ],
        }, {
          name: 'Sylveon',
          printings: [
            { id: 'base', name: 'Sylveon', rarity: 'Common', number: '022/064' },
          ],
        }],
      };
    },
  });
  assert.ok(calls.every((query) => !/\bil\b/i.test(query)));
  assert.ok(calls.some((query) => /sylveon ex/i.test(query)));
  const ex = result.groups.find((group) => group.name === 'Sylveon ex');
  assert.equal(ex?.printings[0]?.id, 'sir');
  assert.ok(!result.groups.some((group) => group.printings.some((row) => row.id === 'box')));
});

test('HGSS energy printings match the era, not Neo Energy Ark', () => {
  const parsed = parseTypedQuery('energy hgss');
  assert.equal(printingMatchesSetFilter({
    name: 'Lightning Energy',
    set: 'HeartGold & SoulSilver',
  }, parsed), true);
  assert.equal(printingMatchesSetFilter({
    name: 'Fire Energy',
    set: 'Unleashed',
  }, parsed), true);
  assert.equal(printingMatchesSetFilter({
    name: 'Energy Ark',
    set: 'Neo Discovery',
  }, parsed), false);
});

test('fetchSuggestRanked hydrates hgss energy from search, not suggest Meili', async () => {
  const suggestCalls = [];
  const searchCalls = [];
  const result = await fetchSuggestRanked('hgss energy', {
    pool: FIXTURE,
    fetchSuggest: async (query) => {
      suggestCalls.push(query);
      return { count: 5, groups: [{ name: 'HGSS Series Collection', printings: [{ id: 'pack' }] }] };
    },
    fetchSearch: async ({ query }) => {
      searchCalls.push(query);
      return {
        cards: [
          { id: 'switch', name: 'Energy Switch', set: 'HeartGold & SoulSilver', number: '091/123' },
          { id: 'fire', name: 'Fire Energy', set: 'HeartGold & SoulSilver', number: '116/123' },
          { id: 'ark', name: 'Energy Ark', set: 'Neo Discovery', number: '75/75' },
          { id: 'poster', name: 'HGSS Poster Pack: Ho-Oh Poster Pack', set: 'HGSS Poster Pack', productType: 'product', itemKind: 'product' },
        ],
      };
    },
  });
  assert.deepEqual(suggestCalls, []);
  assert.ok(searchCalls.length > 0);
  assert.ok(searchCalls.every((query) => query.toLowerCase().includes('energy')));
  assert.equal(result.resolvedQuery, 'hgss energy');
  assert.ok(result.groups.some((group) => group.name === 'Fire Energy'));
  assert.equal(result.groups.find((group) => group.name === 'Fire Energy')?.printings[0].id, 'fire');
  assert.ok(!result.groups.some((group) => group.name === 'Energy Ark'));
  assert.ok(!result.groups.some((group) => /Poster Pack/.test(group.name)));
  assert.equal(result.groups[0].name, 'Fire Energy');
});

test('adjacent transpose recovers elafon as Leafeon', () => {
  assert.equal(prefixEditDistance('elafon', 'leafeon'), 1.5);
  assert.ok(maxDistance(6) >= 1.5);
  assert.equal(rankNames('elafon')[0].display, 'Leafeon');
});

test('glaceon plasma peels Plasma expansions without finishing the title', () => {
  for (const query of ['glaceon plasma', 'plasma glaceon', 'glaceon plas']) {
    const parsed = parseTypedQuery(query);
    assert.equal(compactQuery(parsed.nameQuery), 'glaceon', query);
    assert.ok(parsed.setTokens.some((token) => token.prefix && token.compact.startsWith('plas')), query);
    assert.equal(parsed.eras.length, 0, query);
    assert.equal(printingMatchesSetFilter({
      name: 'Glaceon',
      set: 'Plasma Storm',
    }, parsed), true, query);
    assert.equal(printingMatchesSetFilter({
      name: 'Glaceon',
      set: 'Plasma Freeze',
    }, parsed), true, query);
    assert.equal(printingMatchesSetFilter({
      name: 'Glaceon VMAX',
      set: 'Evolving Skies',
    }, parsed), false, query);
    assert.equal(printingMatchesSetFilter({
      name: 'Glaceon',
      set: 'Dark Explorers',
    }, parsed), false, query);
    assert.equal(printingMatchesSetFilter({
      name: 'Glaceon',
      set: 'Team Plasma Battle Gift Set',
    }, parsed), false, query);
    assert.ok(setAwareSearchLookups(parsed).some((row) => /plasma storm/i.test(row)), query);
  }
  const short = parseTypedQuery('glaceon pla');
  assert.equal(compactQuery(short.nameQuery), 'glaceonpla');
  assert.equal(short.setTokens.length, 0);
  const vmax = parseTypedQuery('glaceon vmax');
  assert.equal(compactQuery(vmax.nameQuery), 'glaceonvmax');
  assert.equal(vmax.setTokens.length, 0);
  const energy = parseTypedQuery('plasma energy');
  assert.equal(energy.setTokens.length, 0);
  assert.match(compactQuery(energy.nameQuery || 'plasma energy'), /plasmaenergy/);
});

test('glaceon plasma fill keeps Plasma first then fills 20 from the name pool', () => {
  const parsed = parseTypedQuery('glaceon plasma');
  const printings = [
    { id: 'freeze', name: 'Glaceon', set: 'Plasma Freeze', number: '23/116' },
    { id: 'skies', name: 'Glaceon VMAX', set: 'Evolving Skies', number: '209/203' },
    ...Array.from({ length: 24 }, (_, index) => ({
      id: `g${index}`,
      name: 'Glaceon',
      set: 'Twilight Masquerade',
      number: String(index + 1),
    })),
  ];
  const groups = fillSuggestGroups([
    { name: 'Glaceon VMAX', printings: [printings[1]] },
    { name: 'Glaceon', printings: [printings[0], ...printings.slice(2)] },
  ], 20, 20, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids[0], 'freeze');
  assert.equal(ids.length, 20);
  assert.ok(ids.includes('skies') || ids.some((id) => id.startsWith('g')));
});

test('fetchSuggestRanked ranks Plasma Glaceon first then fills 20 from the name pool', async () => {
  const searchCalls = [];
  const glaceonPrintings = [
    { id: 'freeze', name: 'Glaceon', set: 'Plasma Freeze', number: '23/116' },
    { id: 'skies', name: 'Glaceon VMAX', set: 'Evolving Skies', number: '209/203' },
    { id: 'holiday', name: 'Glaceon VMAX', set: 'Holiday Calendar', number: '041' },
    ...Array.from({ length: 18 }, (_, i) => ({
      id: `g${i}`,
      name: 'Glaceon',
      set: 'Twilight Masquerade',
      number: String(i + 1),
    })),
  ];
  const result = await fetchSuggestRanked('glaceon plasma', {
    fetchSuggest: async (query) => {
      if (/glaceon/i.test(query)) {
        return {
          count: 80,
          groups: [
            {
              name: 'Glaceon',
              printings: glaceonPrintings.filter((row) => row.name === 'Glaceon'),
            },
            {
              name: 'Glaceon VMAX',
              printings: glaceonPrintings.filter((row) => row.name === 'Glaceon VMAX'),
            },
          ],
        };
      }
      return { count: 0, groups: [] };
    },
    fetchSearch: async ({ query }) => {
      searchCalls.push(query);
      return {
        cards: [
          { id: 'freeze', name: 'Glaceon', set: 'Plasma Freeze', number: '23/116' },
          { id: 'flareon-freeze', name: 'Flareon', set: 'Plasma Freeze', number: '12/116' },
        ],
      };
    },
  });
  assert.ok(searchCalls.length > 0);
  assert.ok(searchCalls.every((query) => /glaceon/i.test(query)));
  assert.ok(searchCalls.some((query) => /plasma/i.test(query)));
  const rows = result.groups.flatMap((group) => group.printings);
  assert.equal(rows[0].id, 'freeze');
  assert.equal(rows.length, 20);
  assert.ok(rows.some((row) => row.id === 'skies' || row.id === 'holiday' || String(row.id).startsWith('g')));
  assert.ok(!rows.some((row) => row.id === 'flareon-freeze'));
});

test('expedition is Expedition Base Set cards, not Expedition Uniform', () => {
  const parsed = parseTypedQuery('expedition');
  assert.equal(parsed.nameQuery, '');
  assert.equal(isSetOnlyQuery(parsed), true);
  assert.ok(parsed.setTokens.some((token) => token.prefix && token.compact === 'expedition'));
  assert.ok(parsed.setTokens.some((token) => (
    (token.setNames || []).some((name) => /expedition base set/i.test(name))
  )));
  assert.equal(parsed.eras.length, 0);
  assert.equal(parsed.setTokens[0]?.slug, 'expedition-base-set');
  assert.equal(printingMatchesSetFilter({
    name: 'Alakazam',
    set: 'Expedition Base Set',
  }, parsed), true);
  assert.equal(printingMatchesSetFilter({
    name: 'Expedition Uniform',
    set: 'Chilling Reign',
  }, parsed), false);
  assert.equal(parseTypedQuery('ex').setTokens.length, 0);
  assert.equal(parseTypedQuery('plasma').setTokens.length, 0);
  assert.equal(parseTypedQuery('expedition uniform').setTokens.length, 0);
  const named = parseTypedQuery('expedition pikachu');
  assert.equal(compactQuery(named.nameQuery), 'pikachu');
  assert.ok(named.setTokens.length > 0);
  const lookups = setAwareSearchLookups(parsed);
  assert.ok(lookups.some((row) => /expedition/i.test(row)));
  assert.ok(lookups.every((row) => !/glaceon/i.test(row)));
});

test('expedition fill keeps 20 Expedition Base Set singles', () => {
  const parsed = parseTypedQuery('expedition');
  const expedition = Array.from({ length: 24 }, (_, index) => ({
    id: `ex${index}`,
    name: `Expedition ${index + 1}`,
    set: 'Expedition Base Set',
    number: `${index + 1}/165`,
  }));
  const groups = fillSuggestGroups([
    {
      name: 'Expedition Uniform',
      printings: [{
        id: 'uniform',
        name: 'Expedition Uniform',
        set: 'Chilling Reign',
        number: '137/198',
      }],
    },
    ...expedition.map((row) => ({ name: row.name, printings: [row] })),
  ], 20, 1, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids.length, 20);
  assert.ok(!ids.includes('uniform'));
  assert.ok(ids.every((id) => String(id).startsWith('ex')));
});

test('fetchSuggestRanked fills 20 Expedition Base Set cards, not Uniform', async () => {
  const searchCalls = [];
  const suggestCalls = [];
  const expedition = Array.from({ length: 24 }, (_, index) => ({
    id: `ex${index}`,
    name: index === 0 ? 'Alakazam' : `Expedition Mon ${index}`,
    set: 'Expedition Base Set',
    number: `${index + 1}/165`,
    product_type: 'card',
    item_kind: 'single',
  }));
  const result = await fetchSuggestRanked('expedition', {
    fetchSuggest: async (query) => {
      suggestCalls.push(query);
      return {
        count: 38,
        groups: [{
          name: 'Expedition Uniform',
          printings: [{
            id: 'uniform',
            name: 'Expedition Uniform',
            set: 'Chilling Reign',
            number: '137/198',
          }],
        }],
      };
    },
    fetchSearch: async ({ query }) => {
      searchCalls.push(query);
      return {
        cards: [
          ...expedition,
          {
            id: 'uniform',
            name: 'Expedition Uniform',
            set: 'Chilling Reign',
            number: '137/198',
          },
        ],
      };
    },
  });
  assert.equal(suggestCalls.length, 0);
  assert.ok(searchCalls.length > 0);
  assert.ok(searchCalls.some((query) => /expedition/i.test(query)));
  const rows = result.groups.flatMap((group) => group.printings);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].name, 'Alakazam');
  assert.ok(rows.every((row) => row.set === 'Expedition Base Set'));
  assert.ok(!rows.some((row) => row.id === 'uniform'));
  assert.ok(result.count >= 20);
});

test('elafon geenration peels Generations and keeps the name', () => {
  const parsed = parseTypedQuery('elafon geenration');
  assert.equal(compactQuery(parsed.nameQuery), 'elafon');
  assert.ok(parsed.setTokens.some((token) => token.compact === 'generations'));
  assert.ok(parsed.eras.includes('XY'));
  assert.ok(setAwareSearchLookups(parsed).some((row) => /leafeon/i.test(row) && /generation/i.test(row)));
});

test('flareon call of legendsd peels the set phrase and keeps Flareon', () => {
  for (const query of ['flareon call of legendsd', 'call of legendsd flareon', 'palkai call of', 'call of palkai']) {
    const parsed = parseTypedQuery(query);
    assert.match(compactQuery(parsed.nameQuery), /^(flareon|palkai)$/, query);
    assert.ok(parsed.setTokens.some((token) => token.compact === 'calloflegends'), query);
    assert.ok(parsed.eras.includes('Call of Legends'), query);
  }
  const short = parseTypedQuery('call of cynthia');
  assert.equal(compactQuery(short.nameQuery), 'cynthia');
  assert.ok(short.setTokens.some((token) => token.compact === 'calloflegends'));
});

test('fetchSuggestRanked fills 20 Leafeon printings with Generations first', async () => {
  const suggestCalls = [];
  const leafeonPrintings = [
    { id: 'prism', name: 'Leafeon', set: 'Prismatic Evolutions', number: '11' },
    { id: 'gen', name: 'Leafeon', set: 'Generations', number: 'RC8' },
    ...Array.from({ length: 18 }, (_, i) => ({
      id: `l${i}`,
      name: 'Leafeon',
      set: 'Twilight Masquerade',
      number: String(i + 1),
    })),
  ];
  const result = await fetchSuggestRanked('elafon geenration', {
    fetchSuggest: async (query) => {
      suggestCalls.push(query);
      if (/leafeon/i.test(query)) {
        return { count: 20, groups: [{ name: 'Leafeon', printings: leafeonPrintings }] };
      }
      return { count: 0, groups: [] };
    },
    fetchSearch: async ({ query }) => {
      if (/generation/i.test(query) && /leafeon/i.test(query)) {
        return { cards: [{ id: 'gen', name: 'Leafeon', set: 'Generations', number: 'RC8' }] };
      }
      return { cards: [] };
    },
  });
  assert.ok(suggestCalls.some((query) => /leafeon/i.test(query)));
  const leafeon = result.groups.find((group) => group.name === 'Leafeon');
  assert.ok(leafeon);
  assert.equal(leafeon.printings[0].set, 'Generations');
  assert.equal(result.groups.reduce((n, group) => n + group.printings.length, 0), 20);
});

test('rankNamesParallel maps chunks across cores', async () => {
  const seen = [];
  const ranked = await rankNamesParallel('oi', FIXTURE, {
    concurrency: 4,
    mapChunk: (query, chunk) => {
      seen.push(chunk.length);
      return rankNames(query, chunk);
    },
  });
  assert.equal(ranked[0].display, 'Oinkologne');
  assert.ok(seen.length >= 2);
});

test('blueprint pool has Mimikyu and Mimikyu ex as whole names', () => {
  assert.ok(NAME_POOL.some((row) => row.compact === 'mimikyu'));
  assert.ok(NAME_POOL.some((row) => row.compact === 'mimikyuex'));
});

test('miikyu ex grows letter-by-letter onto Mimikyu ex', () => {
  const steps = rankPrefixTrace('miikyu ex');
  const at = Object.fromEntries(steps.map((row) => [row.query, row.hit]));
  assert.equal(at.miikyu, 'Mimikyu');
  assert.equal(at['miikyu e'], 'Mimikyu ex');
  assert.equal(steps.at(-1).hit, 'Mimikyu ex');
  assert.equal(resolveSearchQuery('miikyu ex', rankNames('miikyu ex')), 'Mimikyu ex');
});

test('pikachu stays the base card as letters are added', () => {
  const steps = rankPrefixTrace('pikachu');
  assert.ok(steps.every((row) => row.hit === 'Pikachu'));
  const ranked = rankNames('pikachu');
  const exRank = rankOf(ranked, 'Pikachu ex');
  const vRank = rankOf(ranked, 'Pikachu V');
  assert.ok(exRank === -1 || rankOf(ranked, 'Pikachu') < exRank);
  assert.ok(vRank === -1 || rankOf(ranked, 'Pikachu') < vRank);
});

test('Reddit A-tier typos recover the species without exact aliases', () => {
  const misses = [];
  for (const row of REDDIT_TYPOS) {
    if (row.tier !== 'A' || row.guard) {
      continue;
    }
    const want = compactQuery(row.name);
    if (!NAME_POOL.some((name) => name.compact === want)) {
      continue;
    }
    const typed = compactQuery(row.typo);
    if (prefixEditDistance(typed, want) > maxDistance(typed.length) + 1e-9) {
      continue;
    }
    const hit = compactQuery(rankNames(row.typo)[0]?.display);
    if (hit !== want) {
      misses.push(`${row.typo} → ${row.name} (got ${hit || '∅'})`);
    }
  }
  assert.equal(misses.join('\n'), '');
});

test('fetchSuggestRanked hydrates Mimikyu ex from the whole query', async () => {
  const calls = [];
  const result = await fetchSuggestRanked('miikyu ex', {
    extraLimit: 2,
    fetchSuggest: async (query) => {
      calls.push(query);
      if (/mimikyu ex/i.test(query)) {
        return {
          count: 10,
          groups: [{
            name: 'Mimikyu ex',
            printings: Array.from({ length: 10 }, (_, i) => ({ id: `ex${i}`, name: 'Mimikyu ex' })),
          }],
        };
      }
      if (/mimikyu/i.test(query)) {
        return {
          count: 61,
          groups: [{
            name: 'Mimikyu',
            printings: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: 'Mimikyu' })),
          }],
        };
      }
      return { count: 0, groups: [] };
    },
  });
  assert.ok(calls.some((query) => /mimikyu ex/i.test(query)));
  assert.equal(result.groups[0]?.name, 'Mimikyu ex');
  assert.equal(result.resolvedQuery, 'Mimikyu ex');
});

test('keldeo ex ranks EX above GX and does not extra-hydrate GX', () => {
  const ranked = rankNames('keldeo ex');
  assert.ok(rankOf(ranked, 'Keldeo EX') >= 0);
  assert.ok(rankOf(ranked, 'Keldeo EX') < rankOf(ranked, 'Keldeo GX'));
  assert.equal(hasRivalMechanic('Keldeo GX', ['ex']), true);
  assert.equal(hasRivalMechanic('Keldeo EX', ['ex']), false);
  assert.equal(hasRivalMechanic('Keldeo', ['ex']), false);
  assert.equal(hasRivalMechanic('Mega Charizard X ex', ['mega']), false);
  assert.equal(hasRivalMechanic('Charizard VMAX', ['v']), true);
  const extras = extraSuggestQueries('keldeo ex', ranked, 20, 'singles');
  assert.ok(!extras.some((name) => /\bgx\b/i.test(name)));
});

test('keldeo ex fill keeps White Flare with other EX and skips GX', () => {
  const parsed = parseTypedQuery('keldeo ex');
  const groups = fillSuggestGroups([
    {
      name: 'Keldeo EX',
      printings: [
        { id: 'bc', name: 'Keldeo EX', set: 'Boundaries Crossed', number: '49/149', itemKind: 'single' },
        { id: 'wf', name: 'Keldeo ex', set: 'White Flare', number: '159/086', itemKind: 'single' },
        { id: 'lt', name: 'Keldeo EX', set: 'Legendary Treasures', number: '45/113', itemKind: 'single' },
      ],
    },
    {
      name: 'Keldeo GX',
      printings: [
        { id: 'gx', name: 'Keldeo GX', set: 'Unified Minds', number: '47/236', itemKind: 'single' },
      ],
    },
  ], 20, 4, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.deepEqual(ids, ['bc', 'wf', 'lt']);
});

test('fetchSuggestRanked keldeo ex does not fill GX', async () => {
  const result = await fetchSuggestRanked('keldeo ex', {
    extraLimit: 8,
    kind: 'singles',
    fetchSuggest: async (query) => {
      if (/\bgx\b/i.test(query)) {
        return {
          count: 9,
          groups: [{
            name: 'Keldeo GX',
            printings: [{
              id: 'gx',
              name: 'Keldeo GX',
              set: 'Unified Minds',
              number: '47/236',
              itemKind: 'single',
            }],
          }],
        };
      }
      return {
        count: 7,
        groups: [{
          name: 'Keldeo EX',
          printings: [
            {
              id: 'bc',
              name: 'Keldeo EX',
              set: 'Boundaries Crossed',
              number: '49/149',
              itemKind: 'single',
            },
            {
              id: 'wf',
              name: 'Keldeo ex',
              set: 'White Flare',
              number: '159/086',
              itemKind: 'single',
            },
          ],
        }],
      };
    },
  });
  const ids = result.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('wf'));
  assert.ok(ids.includes('bc'));
  assert.ok(!ids.includes('gx'));
});

test('eevee i peels illustration shorthand yet keeps the Eevee name pool, never an Eevee Heroes set peel', () => {
  const parsed = parseTypedQuery('eevee i');
  assert.deepEqual(parsed.setTokens, []);
  assert.equal(parsed.nameQuery, 'eevee');
  assert.equal(parsed.artTokens[0]?.art, 'illustration');
  const top = rankNames('eevee i')[0];
  assert.equal(top.display, 'Eevee');
  assert.equal(top.withinCap, true);
  assert.equal(resolveSearchQuery('eevee i', rankNames('eevee i')), 'Eevee');
});

test('eevee i scores illustration rows first, then fills toward 20 from the ranked pool', async () => {
  // Real API shape: q=eevee returns only the plain blueprint's printings
  // (rarity Card, bare numbers). The SIR rows live under q=eevee ex.
  const commons = Array.from({ length: 20 }, (_, i) => ({
    id: `eevee-${i}`,
    name: 'Eevee',
    set: 'Hidden Fates',
    rarity: 'Card',
    number: `04${i}/068`,
    card_number: `04${i}/068`,
    nationality: 'western',
  }));
  const playmat = [{
    id: 'eevee-playmat',
    name: 'Eevee Prismatic Playmat',
    rarity: 'Card',
    number: '',
    productType: 'product',
    itemKind: 'merchandise',
  }];
  const sirs = [
    ['eevee-ex-sir-1', 'Special Illustration Rare | 167/131', 'Prismatic Evolutions'],
    ['eevee-ex-sir-2', 'Special Illustration Rare | 223/187', 'Terastal Festival ex'],
    ['eevee-ex-sir-3', 'Special Illustration Rare | 224/187', 'Terastal Festival ex'],
  ].map(([id, cardNumber, set]) => ({
    id,
    name: 'Eevee ex',
    set,
    rarity: 'Card',
    number: cardNumber,
    card_number: cardNumber,
    nationality: 'western',
  }));
  const lookups = [];
  const result = await fetchSuggestRanked('eevee i', {
    printLang: 'all',
    kind: 'singles',
    fetchSuggest: async (query) => {
      lookups.push(query);
      const compact = compactQuery(query);
      if (compact === 'eevee') {
        return { count: 480, groups: [{ name: 'Eevee', printings: [...commons, ...playmat] }] };
      }
      if (compact === 'eeveeex') {
        return { count: 60, groups: [{ name: 'Eevee ex', printings: sirs }] };
      }
      return { count: 0, groups: [] };
    },
  });
  assert.ok(lookups.some((query) => compactQuery(query) === 'eeveeex'),
    'variant name must be fetched for the art-peeled query');
  const rows = result.groups.flatMap((group) => group.printings);
  assert.equal(rows.length, 20, 'the list fills toward 20 from the pool');
  assert.deepEqual(rows.slice(0, 3).map((row) => row.id), [
    'eevee-ex-sir-1',
    'eevee-ex-sir-2',
    'eevee-ex-sir-3',
  ], 'token-matching illustration rows score first');
  assert.ok(rows.every((row) => row.id !== 'eevee-playmat'),
    'products never fill the singles tab');
  assert.ok(result.groups.every((group, index) => (
    index === 0 || result.groups[index - 1].name !== group.name
  )), 'a name never renders as two adjacent popup blocks');
  assert.equal(result.resolvedQuery, 'Eevee');
});

test('umbreon ur ranks Ultra Rare rows first and fills toward 20 from the ranked pool', async () => {
  // Real API shape: q=umbreon mixes plain printings with a couple of
  // labeled rows; stronger UR rows hide in the variant groups.
  const plain = Array.from({ length: 18 }, (_, i) => ({
    id: `umbreon-${i}`,
    name: 'Umbreon',
    set: 'Astral Radiance',
    rarity: 'Card',
    number: `09${i}/189`,
    card_number: `09${i}/189`,
    nationality: 'western',
  }));
  const urInGroup = {
    id: 'umbreon-ur-group',
    name: 'Umbreon',
    set: 'Evolving Skies',
    rarity: 'Card',
    number: 'Ultra Rare | 095/203',
    card_number: 'Ultra Rare | 095/203',
    nationality: 'western',
  };
  const vmaxUrs = [
    ['umbreon-vmax-ur', 'Ultra Rare | 095/203', 'Evolving Skies'],
    ['umbreon-vmax-sir', 'Special Illustration Rare | 215/203', 'Evolving Skies'],
  ].map(([id, cardNumber, set]) => ({
    id,
    name: 'Umbreon VMAX',
    set,
    rarity: 'Card',
    number: cardNumber,
    card_number: cardNumber,
    nationality: 'western',
  }));
  const lookups = [];
  const result = await fetchSuggestRanked('umbreon ur', {
    printLang: 'all',
    kind: 'singles',
    fetchSuggest: async (query) => {
      lookups.push(query);
      const compact = compactQuery(query);
      if (compact === 'umbreon') {
        return { count: 90, groups: [{ name: 'Umbreon', printings: [urInGroup, ...plain] }] };
      }
      if (compact === 'umbreonvmax') {
        return { count: 40, groups: [{ name: 'Umbreon VMAX', printings: vmaxUrs }] };
      }
      return { count: 0, groups: [] };
    },
  });
  assert.ok(lookups.some((query) => compactQuery(query) === 'umbreonvmax'),
    'variant names must be fetched for the rarity-peeled query');
  const rows = result.groups.flatMap((group) => group.printings);
  assert.equal(rows.length, 20, 'the list fills toward 20 from the pool');
  assert.deepEqual(rows.slice(0, 2).map((row) => row.id), [
    'umbreon-ur-group',
    'umbreon-vmax-ur',
  ], 'token-matching Ultra Rare rows score first, pool order ties');
  assert.ok(rows.some((row) => row.id === 'umbreon-0'),
    'plain printings still follow the token rows instead of vanishing');
  const sirIndex = rows.findIndex((row) => row.id === 'umbreon-vmax-sir');
  assert.ok(sirIndex === -1 || sirIndex > rows.findIndex((row) => row.id === 'umbreon-vmax-ur'),
    'the SIR row does not outrank the Ultra Rare rows on an ur query');
  assert.ok(result.groups.every((group, index) => (
    index === 0 || result.groups[index - 1].name !== group.name
  )), 'a name never renders as two adjacent popup blocks');
});

test('eevee v i has no illustration rows yet still fills the pool instead of an empty popup', async () => {
  const plain = Array.from({ length: 20 }, (_, i) => ({
    id: `eevee-v-${i}`,
    name: 'Eevee V',
    set: 'Evolving Skies',
    rarity: 'Card',
    number: `06${i}/203`,
    card_number: `06${i}/203`,
    nationality: 'western',
  }));
  const result = await fetchSuggestRanked('eevee v i', {
    printLang: 'all',
    kind: 'singles',
    fetchSuggest: async (query) => (
      compactQuery(query).startsWith('eeveev')
        ? { count: 21, groups: [{ name: 'Eevee V', printings: plain }] }
        : { count: 0, groups: [] }
    ),
  });
  const rows = result.groups.flatMap((group) => group.printings);
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => row.name === 'Eevee V'));
});

test('sylveon ex il surfaces ex illustration rows and never ranks rival GX/V', async () => {
  const group = (name, rows) => ({ name, printings: rows });
  const mk = ([id, cardNumber]) => ({
    id,
    name: 'Sylveon',
    set: 'Evolving Skies',
    rarity: 'Card',
    number: cardNumber,
    card_number: cardNumber,
    nationality: 'western',
  });
  const result = await fetchSuggestRanked('sylveon ex il', {
    printLang: 'all',
    kind: 'singles',
    fetchSuggest: async () => ({
      count: 5,
      groups: [
        group('Sylveon', [
          mk(['syl-plain-088', 'Rare | 088/149']),
          mk(['syl-plain-090', 'Rare | 090/149']),
        ]),
        group('Sylveon ex', [
          mk(['syl-ex-033', 'Double Rare | 033/131']),
          mk(['syl-ex-sir', 'Special Illustration Rare | 086/131']),
        ]),
        group('Sylveon GX', [mk(['syl-gx-092', 'Ultra Rare | 092/145'])]),
        group('Sylveon V', [mk(['syl-v-074', 'Ultra Rare | 074/203'])]),
      ],
    }),
  });
  const flat = result.groups.flatMap((group) => group.printings);
  assert.equal(flat[0]?.id, 'syl-ex-sir', 'illustration ex rows score first');
  const ids = flat.map((row) => row.id);
  assert.ok(!ids.includes('syl-gx-092'), 'rival GX is not ranked into an ex query');
  assert.ok(!ids.includes('syl-v-074'), 'rival V is not ranked into an ex query');
  assert.ok(ids.includes('syl-ex-033'), 'weaker ex printings still fill');
  assert.ok(ids.includes('syl-plain-088'), 'the base name still fills after the mechanic');
});

test('art shorthand tokens peel only with a name: bare i, ill, illu stay name queries', () => {
  for (const query of ['i', 'ill', 'illu', 'illust', 'illustra']) {
    const parsed = parseTypedQuery(query);
    assert.equal(parsed.artTokens.length, 0, `${query} must not peel`);
  }
  for (const query of ['eevee i', 'eevee il', 'eevee ill', 'eevee illu', 'eevee illus', 'eevee illust', 'eevee illustra', 'eevee illustration']) {
    const parsed = parseTypedQuery(query);
    assert.equal(parsed.nameQuery, 'eevee');
    assert.equal(parsed.artTokens[0]?.art, 'illustration');
    assert.deepEqual(parsed.setTokens, [], 'Eevee Heroes must never peel as a set');
  }
});

test('version-rarity slang tokens score through the rarity system: eevee ur, sr, hr, rh', () => {
  for (const [query, rarity] of [
    ['eevee ur', 'ultra'],
    ['eevee sr', 'secret'],
    ['eevee hr', 'hyper'],
    ['eevee rh', 'reverse'],
  ]) {
    const parsed = parseTypedQuery(query);
    assert.equal(parsed.nameQuery, 'eevee', query);
    assert.equal(parsed.rarityTokens[0]?.rarity, rarity, query);
    assert.deepEqual(parsed.artTokens, [], query);
  }
  for (const query of ['ur', 'sr', 'hr', 'rh']) {
    assert.equal(parseTypedQuery(query).rarityTokens.length, 0, `${query} must not peel`);
  }
  assert.equal(parseTypedQuery('umbreon ur').nameQuery, 'umbreon');
  assert.equal(parseTypedQuery('charizard ur').rarityTokens[0]?.rarity, 'ultra');
  assert.equal(printingMatchesRarityFilter({
    rarity: 'Card',
    number: 'Ultra Rare | 095/203',
  }, parseTypedQuery('eevee ur')), true);
  assert.equal(printingMatchesRarityFilter({
    rarity: 'Card',
    number: '049/068',
  }, parseTypedQuery('eevee ur')), false);
  assert.equal(printingMatchesRarityFilter({
    rarity: 'Card',
    number: 'Rainbow Secret Rare | 214/203',
  }, parseTypedQuery('eevee sr')), true);
  assert.equal(printingMatchesRarityFilter({
    rarity: 'Card',
    number: 'Hyper Rare | 089/066',
  }, parseTypedQuery('eevee hr')), true);
  assert.equal(printingMatchesRarityFilter({
    rarity: 'Card',
    number: 'Reverse Holo | 049/068',
  }, parseTypedQuery('eevee rh')), true);
});



test('latios ex 011 fills closest printings when no cached row carries 011', () => {
  const parsed = parseTypedQuery('latios ex 011');
  const groups = fillSuggestGroups([
    {
      name: 'Latios EX',
      printings: [
        { id: 'rs', name: 'Latios EX', set: 'Roaring Skies', number: '58/108' },
        { id: 'pf', name: 'Latios EX', set: 'Plasma Freeze', number: '86/116' },
      ],
    },
  ], 20, 4, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('rs'), 'closest misses fill the popup instead of no-match');
  assert.ok(ids.includes('pf'));
});

test('latios ex 011 keeps the 011 printing ahead of number misses', () => {
  const parsed = parseTypedQuery('latios ex 011');
  const groups = fillSuggestGroups([
    {
      name: 'Latios ex',
      printings: [
        { id: 'exd', name: 'Latios ex', set: 'EX Dragon', number: '94/97' },
        { id: 'half', name: 'Latios ex', set: 'Latios ex Half Deck', number: '011/018' },
      ],
    },
  ], 20, 4, parsed, 'singles');
  const ids = groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids[0], 'half', 'the typed collector number leads');
  assert.ok(ids.includes('exd'), 'number misses still fill behind the match');
});
