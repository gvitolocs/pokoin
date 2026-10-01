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
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const sourceRoot = process.env.SEARCH_RANKING_SOURCE_ROOT;
const moduleAt = (path) => import(pathToFileURL(resolve(sourceRoot, path)).href);
const scoring = await moduleAt('market/src/search-score.js');
const ranking = await moduleAt('market/src/suggest-rank.js');
const live = await moduleAt('market/src/suggest-live.js');
const integerScore = (value) => Math.round(value * 1_000_000);
const evaluate = (query, printing) => scoring.scoreEntry(
  scoring.tokenizeQuery(query).tokens, scoring.docFromPrinting(printing), ['en'],
);
const card = (id, name, set, extra = {}) => ({
  id, name, set, set_name: set, prior: 1, nationality: 'western',
  product_type: 'card', item_kind: 'single', ...extra,
});
const scoredRow = (query, printing) => {
  const result = evaluate(query, printing);
  return {
    id: String(printing.id), score: integerScore(result.score), coverage: result.coverage,
    eligible: result.coverage > 0 && !live.isLiveStub(printing)
      && printing.product_type === 'card' && printing.item_kind === 'single',
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
    rank: () => [], pool: [], limit: cap, preferPerGroup: 1,
    printLang: 'all', searchLang: 'en', kind: 'singles',
  });
  return result.groups.flatMap((item) => item.printings.map((printing) => String(printing.id || printing.card_id)));
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
  '=============================================================================', '',
].join('\n');
await writeFile(resolve(process.env.SEARCH_RANKING_RUN_DIR, 'SearchRankingFixtures.tla'), fixtureText);
console.log(`SEARCH_RANKING_FIXTURES scenarios=${scenarios.length} executions=${cases.length} probes=${probes.length}`);
for (const probe of probes) console.log(`SEARCH_RANKING_PROBE ${JSON.stringify(probe)}`);
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
