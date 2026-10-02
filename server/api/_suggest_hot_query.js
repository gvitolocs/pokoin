'use strict';

/**
 * PIPELINE BLOCK: hot suggest query
 * ---------------------------------
 * Slot: immediately after Meili suggest hits return, before grouping.
 * Search-page offset 0 reads the same card IDs so Enter does not pay for a
 * second Meili round-trip. SQL identity hydrate still runs.
 *
 * Why: typeahead already searched Meili (up to 96 hits, name + number). The
 * popup only returns 20 rows. Enter → /marketplace/search should keep that
 * query hot and paint the rest of the pool.
 *
 * This is process memory on pokoin-oracle-api (one container). Do **not**
 * put per-keystroke blobs in Valkey (homepage snapshot lives there).
 *
 * Revert (any one is enough):
 *   1. SUGGEST_HOT_QUERY=0
 *   2. Delete rememberHotSuggestQuery() in marketplace-suggest.js
 *      and takeHotSuggestCandidates() in marketplace-search-candidates.js
 *   3. Delete this file
 *
 * Offset > 0 always falls through to live Meili so Load more does not mix
 * two rankings. SPA prefetch (pokoin-web `search-hot.js`) is a separate
 * client block with its own revert.
 */

const TTL_MS = 60 * 1000;
const MAX_KEYS = 64;

function cleanSearchTerm(value) {
  return String(value || '').trim().slice(0, 80);
}

function cleanLanguage(value) {
  const language = String(value || 'en').trim().toLowerCase();
  if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) {
    return language;
  }
  return 'en';
}

function hotKey(query, language, printLanguage) {
  // Print filter participates in identity: an 'all' hot page must never be
  // served as a western/japanese/korean/chinese result set.
  const print = String(printLanguage || 'all').trim().toLowerCase();
  return `${cleanLanguage(language)}\0${cleanSearchTerm(query)}\0${print}`;
}

function suggestHotQueryEnabled() {
  const raw = String(process.env.SUGGEST_HOT_QUERY ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

const store = new Map();

function pruneHotSuggestQuery(now = Date.now()) {
  for (const [key, row] of store) {
    if (!row || now - row.at > TTL_MS) {
      store.delete(key);
    }
  }
  while (store.size > MAX_KEYS) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

function rememberHotSuggestQuery(query, language, hits, estimatedTotalHits, printLanguage) {
  if (!suggestHotQueryEnabled()) {
    return;
  }
  const q = cleanSearchTerm(query);
  if (!q) {
    return;
  }
  const ids = [];
  const seen = new Set();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const id = String(hit?.card_id || hit?.id || '').trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) {
    return;
  }
  pruneHotSuggestQuery();
  const key = hotKey(q, language, printLanguage);
  if (store.has(key)) {
    store.delete(key);
  }
  store.set(key, {
    at: Date.now(),
    ids,
    estimatedTotalHits: Number(estimatedTotalHits || ids.length) || ids.length,
  });
}

/**
 * First search-page paint only (offset === 0). Returns Meili-shaped
 * candidates or null to fall through to meiliMarketplaceCandidates.
 */
function takeHotSuggestCandidates(query, language, limit, offset = 0, printLanguage) {
  if (!suggestHotQueryEnabled()) {
    return null;
  }
  if (Number(offset) !== 0) {
    return null;
  }
  const row = store.get(hotKey(query, language, printLanguage));
  if (!row) {
    return null;
  }
  if (Date.now() - row.at > TTL_MS) {
    store.delete(hotKey(query, language, printLanguage));
    return null;
  }
  const pageSize = Math.min(Math.max(Math.trunc(Number(limit) || 48), 1), 1000);
  const slice = row.ids.slice(0, pageSize);
  if (!slice.length) {
    return null;
  }
  return slice.map((card_id, index) => ({
    card_id,
    meili_rank: 1,
    meili_position: index + 1,
    hot_suggest: true,
  }));
}

function resetHotSuggestQuery() {
  store.clear();
}

module.exports = {
  TTL_MS,
  suggestHotQueryEnabled,
  rememberHotSuggestQuery,
  takeHotSuggestCandidates,
  resetHotSuggestQuery,
};
