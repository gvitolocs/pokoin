/**
 * Progressive typeahead pool.
 *
 * The popup paints from whatever candidates are already here. A newer
 * keystroke filters that set in the same turn, then a generation-scoped
 * chunk stream refines it. There is no semantic ceiling of 1,000. Fetching
 * stops when the visible list is filled, the engine is exhausted, or the
 * safety budget is hit — a broad prefix does not download the catalog.
 *
 * Transport is offset + limit. Meilisearch pages that way. Redis Search
 * should not re-run a deep OFFSET: FT.AGGREGATE … WITHCURSOR COUNT <chunk>
 * then FT.CURSOR READ. The suggest handler can map that cursor onto this
 * same { offset, nextOffset, exhaustive } contract. The UI never sees which
 * engine produced the chunk.
 */

import { filterSuggestByPrintLang } from './locale.js';
import {
  compactQuery,
  fillSuggestGroups,
  isBareCollectorQuery,
  isModifierWord,
  isNumberAwareQuery,
  isSetOnlyQuery,
  orderSuggestGroups,
  parseTypedQuery,
  rankNames,
} from './suggest-rank.js';

/** First page. Measured on production Meili (read-only): 50 ~11 ms, 100 ~14 ms, 250 ~25 ms, 500 ~43 ms. */
export const FIRST_CHUNK = 50;
/** Later pages trade a little latency for recall after the list is already painted. */
export const FOLLOW_CHUNK = 100;
/** Transport safety stop. Not a relevance ceiling. */
export const SAFETY_BUDGET = 2000;
export const MAX_CHUNKS = 8;
export const VISIBLE_NEED = 20;

export function chunkSize(chunkIndex) {
  return chunkIndex === 0 ? FIRST_CHUNK : FOLLOW_CHUNK;
}

export function queryMode(query) {
  const parsed = parseTypedQuery(query);
  if (isBareCollectorQuery(parsed) || isNumberAwareQuery(parsed)) return 'collector';
  if (isSetOnlyQuery(parsed)) return 'set';
  return 'name';
}

/**
 * What Redis is asked for.
 *
 * The ~10k name catalog is already local. The first name token is matched
 * there, including a neighbor key and a swapped pair of letters. Redis then
 * loads that name's printings. Later words stay on the client and rank those
 * cards; they are not AND-ed into the request, which used to exhaust the
 * pool at a handful of hits and leave the popup empty.
 *
 * When the typed string is longer than that stem (`pikachu gx`, `reshiram
 * charizard`), also recall the full query: Meili's bare-species page often
 * omits Tag Team / compound printings (`pikachu` has no Zekrom; `palkia`
 * happens to include LEGEND), while the full string returns them.
 */
export function catalogRecall(query, { limit = 6 } = {}) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const parsed = parseTypedQuery(raw);
  if (isBareCollectorQuery(parsed) || isSetOnlyQuery(parsed)) return [raw];
  const words = String(parsed.nameQuery || raw).trim().split(/\s+/).filter(Boolean);
  const token = words.find((word) => !isModifierWord(word)) || words[0] || raw;
  const ranked = rankNames(token);
  const accepted = ranked.filter((row) => row.withinCap !== false);
  const stem = String(token).trim();
  const full = words.length >= 2 && compactQuery(raw) !== compactQuery(stem) ? raw : '';
  if (accepted.some((row) => row.distance === 0)) {
    return full ? [stem, full] : [stem];
  }
  const names = [];
  const seen = new Set();
  for (const row of accepted) {
    const display = String(row.display || '').trim();
    const key = compactQuery(display);
    if (!display || seen.has(key)) continue;
    seen.add(key);
    names.push(display);
    if (names.length >= Math.max(1, Number(limit) || 1)) break;
  }
  if (!names.length) names.push(stem);
  if (full && !names.some((name) => compactQuery(name) === compactQuery(full))) {
    names.push(full);
  }
  return names;
}

export function buildScope({ lang = 'en', printLang = 'all', kind = 'singles', game = 'pokemon', query = '' } = {}) {
  return {
    lang: String(lang || 'en').toLowerCase(),
    printLang: String(printLang || 'all').toLowerCase(),
    kind: String(kind || 'singles').toLowerCase(),
    game: String(game || 'pokemon').toLowerCase(),
    mode: queryMode(query),
  };
}

export function scopeKey(scope) {
  if (!scope) return '';
  return [scope.lang, scope.printLang, scope.kind, scope.game, scope.mode].join('\0');
}

/**
 * Why a previous pool must be dropped.
 *
 * Reset (do not filter the old rows):
 * - empty query
 * - language, print chip, singles/product, or game changed
 * - collector-number mode (bare n/m, or a name plus n/m)
 * - the compact stem diverged (`pika` → `char`)
 *
 * Keep and filter locally:
 * - the next compact extends the previous one (`pika` → `pikac`)
 * - backspace along that stem
 * - a one-character set-title false positive on the same stem
 *   (`chariza` is a name, `charizar` is briefly set-only). Collector mode
 *   still resets.
 */
export function reuseDecision(previousQuery, nextQuery, previousScope, nextScope) {
  const prev = String(previousQuery || '').trim();
  const next = String(nextQuery || '').trim();
  if (!prev || !next) return { action: 'reset', reason: 'empty' };
  const from = compactQuery(prev);
  const to = compactQuery(next);
  if (scopeKey(previousScope) !== scopeKey(nextScope)) {
    const reason = scopeMismatch(previousScope, nextScope) || 'scope';
    const collector = previousScope?.mode === 'collector' || nextScope?.mode === 'collector';
    if (reason === 'mode' && !collector && from && to) {
      if (to.startsWith(from)) return { action: 'narrow', reason: 'prefix-extension' };
      if (from.startsWith(to)) return { action: 'broaden', reason: 'prefix-backspace' };
    }
    return { action: 'reset', reason };
  }
  if (!from || !to) return { action: 'reset', reason: 'empty-compact' };
  if (from === to) return { action: 'same', reason: 'same-query' };
  if (to.startsWith(from)) return { action: 'narrow', reason: 'prefix-extension' };
  if (from.startsWith(to)) return { action: 'broaden', reason: 'prefix-backspace' };
  return { action: 'reset', reason: 'query-diverged' };
}

export function scopeMismatch(previousScope, nextScope) {
  if (!previousScope || !nextScope) return 'scope';
  if (previousScope.lang !== nextScope.lang) return 'language';
  if (previousScope.printLang !== nextScope.printLang) return 'print-language';
  if (previousScope.kind !== nextScope.kind) return 'kind';
  if (previousScope.game !== nextScope.game) return 'game';
  if (previousScope.mode !== nextScope.mode) return 'mode';
  return '';
}

export function createGenerationClock() {
  let generation = 0;
  return {
    next() {
      generation += 1;
      return generation;
    },
    current() {
      return generation;
    },
  };
}

export function prepareCandidate(row = {}) {
  const name = String(row.name || '').trim();
  const number = String(row.collector_number || row.card_number || row.number || '');
  const setName = String(row.set_name || row.set || '');
  const id = String(row.id || row.card_id || '');
  return {
    ...row,
    id,
    name,
    _id: id,
    _compact: compactQuery(name),
    _number: compactQuery(number),
    _set: compactQuery(setName),
  };
}

export function candidateMatches(row, query) {
  const q = compactQuery(query);
  if (!q || !row) return false;
  const compact = row._compact || compactQuery(row.name);
  const number = row._number || compactQuery(row.collector_number || row.card_number || row.number);
  const setName = row._set || compactQuery(row.set_name || row.set);
  if (compact.startsWith(q) || compact.includes(q)) return true;
  if (number && number.includes(q)) return true;
  if (setName && (setName.startsWith(q) || setName.includes(q))) return true;
  return false;
}

export function filterCandidates(rows, query) {
  const q = compactQuery(query);
  if (!q) return [];
  const out = [];
  for (const row of rows || []) {
    if (candidateMatches(row, q)) out.push(row);
  }
  return out;
}

/** Cheap order used before the name-pool group rank. Exact compact, then prefix, then shorter name. */
export function rankCandidates(rows, query) {
  const q = compactQuery(query);
  return filterCandidates(rows, q).sort((left, right) => {
    const leftRank = left._compact === q ? 0 : (left._compact || '').startsWith(q) ? 1 : 2;
    const rightRank = right._compact === q ? 0 : (right._compact || '').startsWith(q) ? 1 : 2;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const lengthDelta = (left._compact || '').length - (right._compact || '').length;
    if (lengthDelta) return lengthDelta;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

export function groupCandidates(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    let group = byName.get(name);
    if (!group) {
      group = { name, printings: [] };
      byName.set(name, group);
    }
    const id = String(row._id || row.id || row.card_id || '');
    if (id && group.printings.some((printing) => String(printing.id || printing.card_id) === id)) {
      continue;
    }
    group.printings.push(row);
  }
  return [...byName.values()];
}

export function candidatesFromSuggestPayload(payload) {
  const out = [];
  const seen = new Set();
  for (const group of payload?.groups || []) {
    for (const printing of group.printings || []) {
      const prepared = prepareCandidate({ ...printing, name: printing.name || group.name });
      if (!prepared._id || seen.has(prepared._id)) continue;
      seen.add(prepared._id);
      out.push(prepared);
    }
  }
  return out;
}

export function mergeCandidates(existing, incoming) {
  const byId = new Map();
  for (const row of existing || []) {
    const prepared = row._id ? row : prepareCandidate(row);
    if (prepared._id) byId.set(prepared._id, prepared);
  }
  let added = 0;
  for (const row of incoming || []) {
    const prepared = row._id ? row : prepareCandidate(row);
    if (!prepared._id) continue;
    if (!byId.has(prepared._id)) added += 1;
    byId.set(prepared._id, prepared);
  }
  return { rows: [...byId.values()], added };
}

export function emptyPool() {
  return {
    rows: [],
    query: '',
    scope: null,
    generation: 0,
    transferred: 0,
    stale: 0,
    cancelled: 0,
  };
}

/**
 * Rows the current keystroke may paint from.
 * Narrow and backspace keep the local rows. A scope or stem change paints
 * from an empty set so the previous query cannot linger.
 */
const EMPTY_ROWS = [];

export function paintSource(pool, query, scope) {
  const decision = reuseDecision(pool?.query, query, pool?.scope, scope);
  if (!pool?.query) return { decision, rows: pool?.rows || EMPTY_ROWS };
  if (decision.action === 'reset') return { decision, rows: EMPTY_ROWS };
  return { decision, rows: pool.rows || EMPTY_ROWS };
}

export function consumePage(pool, generation, payload) {
  if (!pool || pool.generation !== generation) {
    if (pool) pool.stale += 1;
    return { applied: false, reason: 'stale', added: 0 };
  }
  const incoming = candidatesFromSuggestPayload(payload);
  const merged = mergeCandidates(pool.rows, incoming);
  pool.rows = merged.rows;
  pool.transferred += incoming.length;
  return { applied: true, reason: 'merged', added: merged.added, incoming: incoming.length };
}

export function visibleCount(groups) {
  let count = 0;
  for (const group of groups || []) count += (group.printings || []).length;
  return count;
}

export function shouldContinue({
  compactLength = 0,
  fetched = 0,
  chunkHits = 0,
  estimatedTotal = 0,
  chunks = 0,
  exhaustive = false,
  visibleRows = 0,
} = {}) {
  if (exhaustive || chunkHits === 0) return false;
  if (estimatedTotal > 0 && fetched >= estimatedTotal) return false;
  if (fetched >= SAFETY_BUDGET) return false;
  if (chunks >= MAX_CHUNKS) return false;
  // "p" / "pi" prefetch a single page. The popup is still closed.
  if (compactLength <= 2) return false;
  // A specific query that already fills the popup stops. Recall of the
  // first pages is enough; the next keystroke narrows locally.
  if (visibleRows >= VISIBLE_NEED && compactLength >= 5) return false;
  if (visibleRows >= VISIBLE_NEED && chunks >= 2) return false;
  return true;
}

/** Name order from the candidates already in hand. Does not scan the name catalog. */
export function cheapNameRank(rows, query) {
  const q = compactQuery(query);
  const names = [];
  const seen = new Set();
  for (const row of rows || []) {
    const name = String(row.name || '').trim();
    const compact = row._compact || compactQuery(name);
    if (!name || seen.has(compact)) continue;
    seen.add(compact);
    names.push({ display: name, compact });
  }
  return names.map((row, index) => {
    const exact = row.compact === q ? 3 : row.compact.startsWith(q) ? 2 : 1;
    return {
      ...row,
      score: exact * 1000 - row.compact.length - index / 1000,
    };
  });
}

/**
 * Synchronous projection. `ranked` is an optional name-pool result applied
 * after paint; omitting it keeps this on the candidate set only.
 */
export function projectPoolGroups(query, rows, {
  limit = VISIBLE_NEED,
  kind = '',
  printLang = 'all',
  ranked = null,
  order = orderSuggestGroups,
  fill = fillSuggestGroups,
  parse = parseTypedQuery,
} = {}) {
  if (!rows || !rows.length) return null;
  const matched = rankCandidates(rows, query);
  if (!matched.length) return [];
  const parsed = parse(query);
  const nameRank = ranked && ranked.length ? ranked : cheapNameRank(matched, query);
  let groups = order(groupCandidates(matched), nameRank, parsed);
  groups = filterSuggestByPrintLang(groups, printLang);
  const filled = fill(groups, limit, 4, parsed, kind);
  // A mid-stem set-title prefix (`charizar` → Charizard SP Half Deck) must
  // not blank the cards already filtered in. The network query still runs.
  if (filled.length || !isSetOnlyQuery(parsed)) return filled;
  const asName = { ...parsed, setTokens: [], nameQuery: query, raw: query };
  return fill(groups, limit, 4, asName, kind);
}
