#!/usr/bin/env bash
# Observe bounded executions of the actual JavaScript, then check them with TLC.
set -euo pipefail
readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_DIR="${SEARCH_RANKING_SOURCE_ROOT:-${ROOT_DIR}}"
readonly TOOLCHAIN="/home/nez/deepseek-harness-local/formal/orchestra-tlc/toolchain"
readonly JAVA_BIN="${TOOLCHAIN}/jre/usr/lib/jvm/java-17-openjdk-amd64/bin/java"
readonly TLC_JAR="${TOOLCHAIN}/tla2tools.jar"
readonly TLC_SHA256="9732eea90bdc7432e618184e4bee78700460e83e988238a80151dfd6507cfa0c"
readonly TIMEOUT_SECONDS="${SEARCH_RANKING_TLC_TIMEOUT_SECONDS:-300}"
[[ -x "${JAVA_BIN}" && -r "${TLC_JAR}" ]] || { echo "pinned TLC toolchain missing" >&2; exit 2; }
[[ "$(sha256sum "${TLC_JAR}" | cut -d ' ' -f 1)" == "${TLC_SHA256}" ]] || { echo "TLC jar checksum mismatch" >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js missing" >&2; exit 2; }
readonly RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pokoin-search-ranking-tlc.XXXXXX")"
trap 'rm -rf "${RUN_DIR}"' EXIT
cp "${ROOT_DIR}"/specs/SearchRanking*.tla "${ROOT_DIR}"/specs/SearchRanking*.cfg "${RUN_DIR}/"

SEARCH_RANKING_SOURCE_ROOT="${SOURCE_DIR}" SEARCH_RANKING_RUN_DIR="${RUN_DIR}" node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const sourceRoot = process.env.SEARCH_RANKING_SOURCE_ROOT;
const moduleAt = (path) => import(pathToFileURL(resolve(sourceRoot, path)).href);
const scoring = await moduleAt('market/src/search-score.js');
const ranking = await moduleAt('market/src/suggest-rank.js');
const live = await moduleAt('market/src/suggest-live.js');
// TLC integers are signed 32-bit; three coverage units exceed that range
// at six decimal places. Five places retain ample fixture score precision.
const integerScore = (value) => Math.round(value * 100_000);
// The invariant oracle observes identical immutable fixture rows repeatedly.
// Memoize those scorer observations, never the popup executions themselves.
const scoreCache = new WeakMap();
function evaluate(query, printing) {
  if (!scoreCache.has(printing)) scoreCache.set(printing, new Map());
  const byQuery = scoreCache.get(printing);
  if (!byQuery.has(query)) byQuery.set(query, scoring.scoreEntry(
    scoring.tokenizeQuery(query).tokens, scoring.docFromPrinting(printing), ['en'],
  ));
  return byQuery.get(query);
}
const card = (id, name, set, extra = {}) => ({
  id, name, set, set_name: set, prior: 1, nationality: 'western',
  product_type: 'card', item_kind: 'single', ...extra,
});
const scoredRow = (query, printing) => {
  const result = evaluate(query, printing);
  return {
    id: String(printing.id), score: integerScore(result.score), coverage: result.coverage,
    eligible: result.coverage > 0 && !live.isLiveStub(printing)
      && printing.product_type === 'card' && printing.item_kind === 'single'
      && !ranking.hasRivalMechanic(printing.name, ranking.typedModifiers(query).mods),
  };
};
function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i += 1) {
    for (const tail of permutations([...items.slice(0, i), ...items.slice(i + 1)])) {
      yield [items[i], ...tail];
    }
  }
}
const group = (name, printings) => ({ name, printings });
const primary = [
  group('Mewtwo', [card('101', 'Mewtwo', 'Evolutions'), card('102', 'Mewtwo', 'Base Set'), card('101', 'Mewtwo', 'Evolutions')]),
  group('Mewtwo ex', [card('201', 'Mewtwo ex', 'Evolutions'), card('202', 'Mewtwo ex', 'Scarlet & Violet')]),
  group('Switch', [card('301', 'Switch', 'Evolutions')]),
  group('Mewtwo Evolutions Booster Box', [card('401', 'Mewtwo Evolutions Booster Box', 'Evolutions', { product_type: 'sealed', item_kind: 'product' })]),
  group('Mewtwo V', [card('live:mewtwo-v', 'Mewtwo V', 'Evolutions', { live: true })]),
  group('Blastoise', [card('501', 'Blastoise', 'Aquapolis')]),
];
const scenarios = [
  { label: 'typo-set', query: 'mewtow evol', groups: primary, caps: [0, 1, 4, 20] },
  { label: 'another-typo-set', query: 'charziard base', groups: [
    group('Charizard', [card('601', 'Charizard', 'Base Set'), card('602', 'Charizard', 'Evolutions')]),
    group('Charizard ex', [card('603', 'Charizard ex', 'Base Set')]),
    group('Switch', [card('604', 'Switch', 'Base Set')]),
  ], caps: [1, 4, 20] },
  { label: 'compound-and-context', query: 'pakia legend', groups: [
    group('Palkia', [card('701', 'Palkia', 'Call of Legends'), card('702', 'Palkia', 'Diamond & Pearl')]),
    group('Palkia & Dialga LEGEND', [card('703', 'Palkia & Dialga LEGEND', 'Triumphant')]),
    group('Switch', [card('704', 'Switch', 'Call of Legends')]),
  ], caps: [1, 4, 20] },
  { label: 'name-rarity', query: 'eevee illu', groups: [
    group('Eevee', [card('801', 'Eevee', 'Twilight Masquerade', { rarity: 'Illustration Rare' }), card('802', 'Eevee', 'Base Set', { rarity: 'Common' })]),
    group('Eevee ex', [card('803', 'Eevee ex', 'Prismatic Evolutions', { rarity: 'Special Illustration Rare' })]),
    group('Charizard', [card('804', 'Charizard', 'Obsidian Flames', { rarity: 'Illustration Rare' })]),
  ], caps: [1, 4, 20] },
  { label: 'name-artist', query: 'sugimori pika', groups: [
    group('Pikachu', [card('901', 'Pikachu', 'Base Set', { artist: 'Ken Sugimori' }), card('902', 'Pikachu', 'Evolutions', { artist: 'Mitsuhiro Arita' })]),
    group('Pikachu ex', [card('903', 'Pikachu ex', 'Scarlet & Violet', { artist: 'Ken Sugimori' })]),
    group('Switch', [card('904', 'Switch', 'Base Set', { artist: 'Ken Sugimori' })]),
  ], caps: [1, 4, 20] },
  { label: 'name-collector', query: '025 pikachu', groups: [
    group('Pikachu', [card('1001', 'Pikachu', 'Base Set', { number: '25/102' }), card('1002', 'Pikachu', 'Evolutions', { number: '35/108' })]),
    group('Pikachu ex', [card('1003', 'Pikachu ex', 'Scarlet & Violet', { number: '025/198' })]),
    group('Switch', [card('1004', 'Switch', 'Base Set', { number: '25/102' })]),
  ], caps: [1, 4, 20] },
];
// Early set context is deliberately separate from literal EX/GX/V tokens.
const earlyPrefixScenarios = [];
for (const [speciesIndex, name, typed] of [[0, 'Mewtwo', 'mewtow'], [1, 'Charizard', 'charziard']]) {
  for (const prefix of ['e', 'ev', 'evo', 'evol']) {
    const id = (suffix) => `early-${speciesIndex}-${prefix}-${suffix}`;
    const scenario = { label: `early-${speciesIndex}-${prefix}`, query: `${typed} ${prefix}`,
      name, typed, prefix, caps: [1, 4, 20], groups: [
        group(name, [card(id('base'), name, 'Evolutions'), card(id('other'), name, 'Base Set')]),
        group(`${name} EX`, [card(id('ex'), `${name} EX`, 'Evolutions'), card(id('ex-other'), `${name} EX`, 'Scarlet & Violet')]),
        group(`${name} GX`, [card(id('gx'), `${name} GX`, 'Evolutions')]),
        group('Switch', [card(id('metadata'), 'Switch', 'Evolutions')]),
      ] };
    earlyPrefixScenarios.push(scenario);
    scenarios.push(scenario);
  }
}
const mechanicScenarios = [];
for (const [mechanic, rival] of [['ex', 'GX'], ['gx', 'V'], ['v', 'EX']]) {
  const suffix = mechanic.toUpperCase();
  const scenario = { label: `literal-${mechanic}`, query: `mewtow ${mechanic}`,
    mechanic, caps: [1, 4, 20], groups: [
      group('Mewtwo', [card(`literal-${mechanic}-base`, 'Mewtwo', 'Evolutions')]),
      group(`Mewtwo ${suffix}`, [card(`literal-${mechanic}-match`, `Mewtwo ${suffix}`, 'Scarlet & Violet')]),
      group(`Mewtwo ${rival}`, [card(`literal-${mechanic}-rival`, `Mewtwo ${rival}`, 'Evolutions')]),
    ] };
  mechanicScenarios.push(scenario);
  scenarios.push(scenario);
}
function mergedGroups(groups) {
  const map = new Map();
  for (const item of groups) {
    const key = ranking.compactQuery(item.name);
    const prev = map.get(key) || { name: item.name, printings: new Map() };
    for (const row of item.printings) {
      if (!live.isLiveStub(row)) prev.printings.set(String(row.id), row);
    }
    map.set(key, prev);
  }
  return [...map.values()].map((item) => ({ name: item.name, printings: [...item.printings.values()] }));
}
function oldGroupFill(query, groups, cap) {
  const scored = mergedGroups(groups).map((item) => ({
    name: item.name, rows: item.printings.map((printing) => ({ printing, result: evaluate(query, printing) }))
      .sort((a, b) => b.result.score - a.result.score),
  })).filter((item) => item.rows[0]?.result.coverage > 0);
  scored.sort((a, b) => b.rows[0].result.score - a.rows[0].result.score || a.name.localeCompare(b.name));
  const ids = [];
  const used = new Set();
  for (const item of scored) {
    for (const row of item.rows) {
      const id = String(row.printing.id);
      if (ids.length < cap && scoredRow(query, row.printing).eligible && !used.has(id)) {
        ids.push(id); used.add(id);
      }
    }
  }
  return ids;
}
function observe(query, groups, cap) {
  live.resetSuggestLive();
  for (const item of groups) live.rememberSuggestGroups([item], { searchLang: 'en' });
  const result = live.liveSuggestGroups(query, {
    rank: memoizedNameRank, limit: cap, preferPerGroup: 1,
    printLang: 'all', searchLang: 'en', kind: 'singles',
  });
  return result.groups.flatMap((item) => item.printings.map((printing) => String(printing.id || printing.card_id)));
}
const nameRankCache = new Map();
function memoizedNameRank(query, pool) {
  if (!nameRankCache.has(query)) nameRankCache.set(query, ranking.rankNames(query, pool));
  return nameRankCache.get(query);
}
const cases = [];
for (const scenario of scenarios) {
  const rows = [...new Map(scenario.groups.flatMap((item) => item.printings)
    .map((printing) => [String(printing.id), scoredRow(scenario.query, printing)])).values()];
  const references = new Map(scenario.caps.map((cap) => [cap, observe(scenario.query, scenario.groups, cap)]));
  let permutationIndex = 0;
  for (const ordered of permutations(scenario.groups)) {
    for (const reversed of [false, true]) {
      const groups = ordered.map((item) => ({ ...item, printings: reversed ? [...item.printings].reverse() : item.printings }));
      for (const cap of scenario.caps) {
        cases.push({ label: `${scenario.label}:${permutationIndex}:${Number(reversed)}:${cap}`,
          rows, cap, actual: observe(scenario.query, groups, cap),
          legacy: oldGroupFill(scenario.query, groups, cap), reference: references.get(cap) });
      }
    }
    permutationIndex += 1;
  }
}
// Exhaustive ordered three-component model: four typo names times EVERY
// ordered pair from eight context tokens, including repeats and all six
// permutations. These are actual popup executions, not parser shape checks.
const tripleContexts = ['e', 'evol', 'base', 'ex', 'gx', 'holo', 'arita', '51', 'ir'];
let tripleExecutions = 0;
for (const [name, typo] of [['Mewtwo', 'mewtow'], ['Charizard', 'charziard'],
  ['Darkness Energy', 'dwrknessener'], ['Bulbasaur', 'bhlbsur']]) {
  const tripleGroups = [
    group(name, [card('t-base', name, 'Evolutions', { number: '51/108', artist: 'Mitsuhiro Arita', rarity: 'Holo Rare' }),
      card('t-other', name, 'Base Set', { number: '10/102', artist: 'Ken Sugimori', rarity: 'Rare' })]),
    group(`${name} EX`, [card('t-ex', `${name} EX`, 'Evolutions', { number: '51/108', artist: 'Mitsuhiro Arita', rarity: 'Illustration Rare' })]),
    group(`${name} GX`, [card('t-gx', `${name} GX`, 'Base Set', { number: '51/108', artist: 'Ken Sugimori', rarity: 'Holo Rare' })]),
    group('Switch', [card('t-context', 'Switch', 'Evolutions', { number: '51/108', artist: 'Mitsuhiro Arita', rarity: 'Holo Rare' })]),
  ];
  for (const first of tripleContexts) for (const second of tripleContexts) {
    for (const parts of permutations([typo, first, second])) {
      const query = parts.join(' ');
      const rows = tripleGroups.flatMap((g) => g.printings).map((p) => scoredRow(query, p));
      const reference = observe(query, tripleGroups, 20);
      for (const reversed of [false, true]) {
        const sources = reversed ? [...tripleGroups].reverse().map((g) => ({ ...g, printings: [...g.printings].reverse() })) : tripleGroups;
        cases.push({ label: `triple-${tripleExecutions++}:${query}:${reversed}`, rows, cap: 20,
          actual: observe(query, sources, 20), legacy: oldGroupFill(query, sources, 20), reference });
      }
    }
  }
}
if (tripleExecutions !== 3888) throw new Error(`three-component model shrank: ${tripleExecutions}`);
function oldPenaltyScore(query, printing) {
  const result = evaluate(query, printing);
  const words = scoring.nameTokens(printing.name);
  const nameHits = new Set(result.perToken.filter((row) => row.via.startsWith('name-'))
    .map((row) => row.matchedToken).filter(Boolean));
  const correctedExtra = Math.max(0, words.length - nameHits.size);
  const previousExtra = Math.max(0, words.length - result.coverage);
  return integerScore(result.score + (correctedExtra - previousExtra)
    * scoring.EXTRA_TOKEN_PENALTY * scoring.QUALITY_UNIT);
}
const probePairs = [
  ['mewtow evol', 'Mewtwo', 'Mewtwo ex', 'Evolutions', 'Base Set'],
  ['charziard base', 'Charizard', 'Charizard ex', 'Base Set', 'Evolutions'],
];
const probes = probePairs.map(([query, name, extraName, set, otherSet], index) => {
  const base = card(`probe-${index}-base`, name, set);
  const extra = card(`probe-${index}-extra`, extraName, set);
  const typo = card(`probe-${index}-typo`, name, otherSet);
  const metadata = card(`probe-${index}-metadata`, 'Switch', set);
  const full = evaluate(query, extra);
  const partial = evaluate(query, typo);
  const meta = evaluate(query, metadata);
  return { label: query, fullCoverage: full.coverage, partialCoverage: partial.coverage,
    fullScore: integerScore(full.score), partialScore: integerScore(partial.score),
    typoCoverage: partial.coverage, metadataCoverage: meta.coverage,
    typoScore: integerScore(partial.score), metadataScore: integerScore(meta.score),
    baseScore: integerScore(evaluate(query, base).score), extraScore: integerScore(full.score),
    oldBaseScore: oldPenaltyScore(query, base), oldExtraScore: oldPenaltyScore(query, extra) };
});
const earlyProbes = earlyPrefixScenarios.map((scenario) => {
  const base = scenario.groups[0].printings[0];
  const partial = scenario.groups[0].printings[1];
  const extra = scenario.groups[1].printings[0];
  const metadata = scenario.groups[3].printings[0];
  const fullResult = evaluate(scenario.query, base);
  const partialResult = evaluate(scenario.query, partial);
  const metadataResult = evaluate(scenario.query, metadata);
  const evidence = fullResult.perToken[1];
  const extraResult = evaluate(scenario.query, extra);
  const selected = observe(scenario.query, scenario.groups, 20);
  return { label: scenario.query, prefixLength: scenario.prefix.length,
    coverage: fullResult.coverage, partialCoverage: partialResult.coverage,
    metadataCoverage: metadataResult.coverage,
    score: integerScore(fullResult.score), partialScore: integerScore(partialResult.score),
    extraScore: integerScore(extraResult.score),
    nameCompletionExpected: scenario.prefix === 'e',
    nameCompletion: extraResult.perToken[1].via === 'name-prefix',
    prefixQuality: integerScore(evidence.quality), prefixIsSet: evidence.via.startsWith('set-'),
    mechanicCount: ranking.typedModifiers(scenario.query).mods.length,
    exEligible: selected.includes(String(extra.id)),
  };
});
const bareProbes = ['e', 'ev'].map((query) => {
  const result = evaluate(query, card(`bare-${query}`, 'Switch', 'Evolutions'));
  return { label: query, coverage: result.coverage, noSetEvidence: result.perToken[0].via === 'none' };
});
const mechanicProbes = mechanicScenarios.map((scenario) => {
  const ordinary = evaluate(scenario.query, scenario.groups[0].printings[0]);
  const match = evaluate(scenario.query, scenario.groups[1].printings[0]);
  const rival = evaluate(scenario.query, scenario.groups[2].printings[0]);
  const mods = ranking.typedModifiers(scenario.query).mods;
  const selected = observe(scenario.query, scenario.groups, 20);
  return { label: scenario.query, ordinaryCoverage: ordinary.coverage,
    matchingCoverage: match.coverage, rivalCoverage: rival.coverage,
    matchingScore: integerScore(match.score), ordinaryScore: integerScore(ordinary.score),
    literalEvidence: match.perToken[1].via === 'name-exact',
    exactModifier: mods.length === 1 && mods[0] === scenario.mechanic,
    matchingEligible: selected.includes(String(scenario.groups[1].printings[0].id)),
    rivalExcluded: !selected.includes(String(scenario.groups[2].printings[0].id)),
  };
});
// Cold retrieval exercises the actual API adapter, compact local NAME_POOL,
// canonical-name fan-out, cache and popup over a server-shaped boundary.
// Execute the real adapter with injected transport, avoiding unrelated JSX
// authentication imports in the browser's api.js (as expansion-api.test does).
const apiSource = await readFile(resolve(sourceRoot, 'market/src/api.js'), 'utf8');
const adapterStart = apiSource.indexOf('export function fetchSuggest(');
const adapterEnd = apiSource.indexOf('const SEARCH_WARMUP_TTL_MS', adapterStart);
if (adapterStart < 0 || adapterEnd < adapterStart) throw new Error('suggest API adapter missing');
const fetchSuggest = new Function('getJson', 'getSearchLang',
  apiSource.slice(adapterStart, adapterEnd).replace('export function', 'function') + '\nreturn fetchSuggest;')(
  async (url, options) => (await globalThis.fetch(url, options)).json(), () => 'en',
);
const originalFetch = globalThis.fetch;
// Exercise the browser's existing worker partition/merge path with the actual
// rankNames function. Cache deterministic chunk observations by the complete
// pool fingerprint so exhaustive repeated component orders remain practical.
const chunkRankCache = new Map();
function memoizedRankChunk(query, pool) {
  const key = ranking.compactQuery(query) + ':'
    + createHash('sha256').update(JSON.stringify(pool)).digest('hex');
  if (!chunkRankCache.has(key)) chunkRankCache.set(key, ranking.rankNames(query, pool));
  return chunkRankCache.get(key);
}
const coldProbes = [];
for (const [query, name] of [
  ['diagl', 'Dialga'], ['dawe', 'Dawn'], ['talflamd', 'Talonflame'],
  ['oriruo', 'Oricorio'], ['dwrknessener', 'Darkness Energy'], ['dclops', 'Dusclops'],
  ['bhlbsur', 'Bulbasaur'], ['zjnniasresve', "Zinnia's Resolve"],
  ['rnofvotlity', 'Urn of Vitality'], ['xuknoi', 'Dusknoir'],
  ['quikbkl', 'Quick Ball'], ['entavrel', 'Tentacruel'], ['ombusln', 'Combusken'],
]) {
  for (const printLang of ['all', 'western']) for (const reversed of [false, true]) {
    const requests = [];
    const printings = Array.from({ length: 30 }, (_, i) => card(`cold-${i}`, name, '', {
      nationality: i === 29 ? 'unknown' : (i >= 15 && i < 20) || i === 28 ? 'japanese' : 'western',
    }));
    globalThis.fetch = async (url) => {
      const params = new URL(url, 'https://pokoin.com').searchParams;
      requests.push(params);
      let rows = ranking.compactQuery(params.get('q')) === ranking.compactQuery(name) ? printings : [];
      // Exact witnesses for the two former pre-ranking losses.
      if (params.get('print_language') === 'western') rows = rows.slice(0, 1);
      if (params.get('hydrate') !== '1') rows = rows.slice(0, 20);
      if (reversed) rows = [...rows].reverse();
      return new Response(JSON.stringify({ groups: rows.length ? [group(name, rows)] : [], count: printings.length }));
    };
    live.resetSuggestLive();
    const result = await ranking.fetchSuggestRanked(query, {
      fetchSuggest, kind: 'singles', lang: 'en', printLang, limit: 20,
      concurrency: 4, mapChunk: memoizedRankChunk,
    });
    live.rememberSuggestGroups(result.hydrated, { searchLang: 'en' });
    const rows = live.liveSuggestGroups(query, { printLang, kind: 'singles', rank: memoizedNameRank })
      .groups.flatMap((g) => g.printings);
    coldProbes.push({ label: `${query}:${printLang}:${reversed}`, retrieved: result.hydrated.flatMap((g) => g.printings).length,
      shown: rows.length, firstCorrect: rows[0]?.name === name,
      onlyCorrect: rows.every((p) => p.name === name), unique: new Set(rows.map((p) => p.id)).size === rows.length,
      printEligible: rows.every((p) => printLang === 'all' || p.nationality === 'western'),
      correctedRequested: requests.some((p) => ranking.compactQuery(p.get('q')) === ranking.compactQuery(name)),
      wideUnfiltered: requests.every((p) => p.get('print_language') === 'all' && p.get('hydrate') === '1' && p.get('limit') === '1000'),
    });
  }
}
globalThis.fetch = originalFetch;
// The same complete three-component vocabulary also starts with an empty
// cache and empty raw full-text search. Only a canonical local-name lookup
// yields printings. This checks retrieval rather than assuming warm fixtures.
const coldTripleProbes = [];
for (const [name, typo] of [['Mewtwo', 'mewtow'], ['Charizard', 'charziard'],
  ['Darkness Energy', 'dwrknessener'], ['Bulbasaur', 'bhlbsur']]) {
  const source = ['', ' EX', ' GX'].flatMap((suffix, form) => Array.from({ length: 30 }, (_, i) =>
    card(`cold-triple-${form}-${i}`, `${name}${suffix}`, i % 2 ? 'Base Set' : 'Evolutions', {
      number: i % 2 ? '10/102' : '51/108',
      artist: i % 2 ? 'Ken Sugimori' : 'Mitsuhiro Arita',
      rarity: i % 2 ? 'Holo Rare' : 'Illustration Rare',
      nationality: i === 29 ? 'unknown' : (i >= 15 && i < 20) || i === 28 ? 'japanese' : 'western',
    })));
  for (const first of tripleContexts) for (const second of tripleContexts) {
    for (const parts of permutations([typo, first, second])) {
      const query = parts.join(' ');
      for (const printLang of ['all', 'western']) {
        const requests = [];
        globalThis.fetch = async (url) => {
          const params = new URL(url, 'https://pokoin.com').searchParams;
          requests.push(params);
          const key = ranking.compactQuery(params.get('q'));
          let rows = ['', 'ex', 'gx'].some((suffix) => key === ranking.compactQuery(name) + suffix) ? source : [];
          if (params.get('print_language') === 'western') rows = rows.slice(0, 1);
          if (params.get('hydrate') !== '1') rows = rows.slice(0, 20);
          if (printLang === 'western') rows = [...rows].reverse();
          const groups = [...new Set(rows.map((p) => p.name))].map((n) => group(n, rows.filter((p) => p.name === n)));
          return new Response(JSON.stringify({ groups, count: source.length }));
        };
        live.resetSuggestLive();
        const hydrated = await ranking.fetchSuggestRanked(query, {
          fetchSuggest, fetchSearch: async () => ({ cards: [], total: null }),
          kind: 'singles', lang: 'en', printLang, limit: 20,
          concurrency: 4, mapChunk: memoizedRankChunk,
        });
        live.rememberSuggestGroups(hydrated.hydrated, { searchLang: 'en' });
        const rows = live.liveSuggestGroups(query, { printLang, kind: 'singles', rank: memoizedNameRank })
          .groups.flatMap((g) => g.printings);
        // Fixture catalog evidence: both declared expansions are Western.
        // Unknown printing nationality therefore resolves to Western; known
        // Japanese nationality stays Japanese. Do not mirror the runtime
        // print-filter implementation to compute this independent oracle.
        const fixtureWestern = (p) => p.nationality === 'western'
          || (p.nationality === 'unknown' && ['Base Set', 'Evolutions'].includes(p.set));
        const eligible = source.filter((p) => (printLang === 'all' || fixtureWestern(p))
          && scoredRow(query, p).eligible);
        const scores = new Map(source.map((p) => [p.id, evaluate(query, p).score]));
        const selected = new Set(rows.map((p) => p.id));
        const omitted = eligible.filter((p) => !selected.has(p.id));
        coldTripleProbes.push({ label: `${query}:${printLang}`,
          retrieved: hydrated.hydrated.flatMap((g) => g.printings).length,
          shown: rows.length, unique: selected.size === rows.length,
          nameCorrect: rows.every((p) => p.name === name || p.name === `${name} EX` || p.name === `${name} GX`),
          eligible: rows.every((p) => eligible.some((e) => e.id === p.id)),
          descending: rows.every((p, i) => i === 0 || scores.get(rows[i - 1].id) >= scores.get(p.id)),
          topScores: rows.every((p) => omitted.every((o) => scores.get(p.id) >= scores.get(o.id))),
          canonicalRequested: requests.some((p) => ranking.compactQuery(p.get('q')) === ranking.compactQuery(name)),
          wideUnfiltered: requests.every((p) => p.get('print_language') === 'all' && p.get('hydrate') === '1' && p.get('limit') === '1000'),
        });
      }
    }
  }
  console.log(`SEARCH_RANKING_COLD_TRIPLE_PROGRESS name=${name} executions=${coldTripleProbes.length}`);
}
globalThis.fetch = originalFetch;
if (coldTripleProbes.length !== 3888) throw new Error(`cold three-component model shrank: ${coldTripleProbes.length}`);
const failedColdTriples = coldTripleProbes.filter((p) => p.retrieved !== 90 || p.shown !== 20
  || !p.unique || !p.nameCorrect || !p.eligible || !p.descending || !p.topScores
  || !p.canonicalRequested || !p.wideUnfiltered);
console.log(`SEARCH_RANKING_COLD_TRIPLE_FAILURES count=${failedColdTriples.length}`);
for (const probe of failedColdTriples.slice(0,12)) console.log(`SEARCH_RANKING_COLD_TRIPLE_FAILURE ${JSON.stringify(probe)}`);
function tla(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`noninteger TLC fixture: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `<<${value.map(tla).join(', ')}>>`;
  return `[${Object.entries(value).map(([key, item]) => `${key} |-> ${key === 'rows' ? `{${item.map(tla).join(', ')}}` : tla(item)}`).join(', ')}]`;
}
const fixtureText = [
  '---------------------- MODULE SearchRankingFixtures ----------------------',
  'EXTENDS Integers',
  `Cases == {\n${cases.map((item) => `  ${tla(item)}`).join(',\n')}\n}`,
  `ScoreProbes == {${probes.map(tla).join(', ')}}`,
  `EarlyPrefixProbes == {${earlyProbes.map(tla).join(', ')}}`,
  `BarePrefixProbes == {${bareProbes.map(tla).join(', ')}}`,
  `MechanicProbes == {${mechanicProbes.map(tla).join(', ')}}`,
  `ColdProbes == {${coldProbes.map(tla).join(', ')}}`,
  `ColdTripleProbes == {${coldTripleProbes.map(tla).join(', ')}}`,
  '=============================================================================', '',
].join('\n');
await writeFile(resolve(process.env.SEARCH_RANKING_RUN_DIR, 'SearchRankingFixtures.tla'), fixtureText);
console.log(`SEARCH_RANKING_FIXTURES scenarios=${scenarios.length} executions=${cases.length} three_component_executions=${tripleExecutions} probes=${probes.length} early_prefix_probes=${earlyProbes.length} bare_prefix_probes=${bareProbes.length} mechanic_probes=${mechanicProbes.length}`);
console.log(`SEARCH_RANKING_COLD_PROBES executions=${coldProbes.length}`);
console.log(`SEARCH_RANKING_COLD_TRIPLE_PROBES executions=${coldTripleProbes.length}`);
for (const probe of probes) console.log(`SEARCH_RANKING_PROBE ${JSON.stringify(probe)}`);
for (const probe of earlyProbes) console.log(`SEARCH_RANKING_EARLY_PREFIX_PROBE ${JSON.stringify(probe)}`);
for (const probe of bareProbes) console.log(`SEARCH_RANKING_BARE_PREFIX_PROBE ${JSON.stringify(probe)}`);
for (const probe of mechanicProbes) console.log(`SEARCH_RANKING_MECHANIC_PROBE ${JSON.stringify(probe)}`);
JS

run_check() {
  local cfg="$1" expected="$2" rc=0
  printf 'SEARCH_RANKING_CHECK_BEGIN config=%s expected_rc=%s\n' "${cfg}" "${expected}"
  (cd "${RUN_DIR}" && timeout --foreground "${TIMEOUT_SECONDS}" "${JAVA_BIN}" -XX:+UseParallelGC \
    -cp "${TLC_JAR}" tlc2.TLC -config "${cfg}.cfg" -workers auto \
    -metadir "${RUN_DIR}/states/${cfg}" SearchRanking.tla) >"${RUN_DIR}/${cfg}.log" 2>&1 || rc=$?
  tail -n 160 "${RUN_DIR}/${cfg}.log"
  printf 'SEARCH_RANKING_CHECK_END config=%s rc=%s\n' "${cfg}" "${rc}"
  if [[ "${rc}" != "${expected}" ]]; then
    printf 'unexpected TLC result for %s: wanted %s, got %s\n' "${cfg}" "${expected}" "${rc}" >&2
    return 1
  fi
}
failed=0
run_check SearchRanking 0 || failed=1
run_check SearchRanking-old-extra-tokens 12 || failed=1
run_check SearchRanking-old-group-fill 12 || failed=1
exit "${failed}"
