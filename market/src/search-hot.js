/**
 * PIPELINE BLOCK: hot search page (SPA)
 * -------------------------------------
 * After typeahead returns, prefetch GET /api/marketplace-search-page for the
 * same q+lang+tab so Enter paints the grid from memory. (The retired Node API
 * also kept a Meili ID pool hot; the Rust search page has no server half.)
 *
 * Revert: stop calling prefetchSearchPage from Chrome.jsx. Search.jsx already
 * falls back to fetchSearch when the cache misses.
 */

import { normalizeSearchTab, searchFetchOptions } from './search-kind.js';

const TTL_MS = 60 * 1000;
const cache = new Map();

function cacheKey(query, lang, tab = 'singles', printLang = 'all') {
  return `${String(lang || 'en').toLowerCase()}\0${normalizeSearchTab(tab)}\0${String(printLang || 'all')}\0${String(query || '').trim()}`;
}

export function resetHotSearchPage() {
  cache.clear();
}

export function takeHotSearchPage(query, lang, tab = 'singles', printLang = 'all') {
  const row = cache.get(cacheKey(query, lang, tab, printLang));
  if (!row) {
    return null;
  }
  if (Date.now() - row.at > TTL_MS) {
    cache.delete(cacheKey(query, lang, tab, printLang));
    return null;
  }
  return row;
}

export function prefetchSearchPage(query, lang, {
  fetchSearchPage,
  signal,
  tab = 'singles',
  printLang = 'all',
} = {}) {
  const q = String(query || '').trim();
  const kind = normalizeSearchTab(tab);
  if (q.length < 2 || typeof fetchSearchPage !== 'function' || kind === 'users') {
    return Promise.resolve(null);
  }
  const print = printLang || 'all';
  const key = cacheKey(q, lang, kind, print);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < TTL_MS && existing.promise) {
    return existing.promise;
  }
  const promise = fetchSearchPage({
    query: q,
    offset: 0,
    limit: 48,
    lang,
    printLang: print,
    signal,
    ...searchFetchOptions(kind),
  }).then((data) => {
    const row = cache.get(key);
    if (row && row.promise === promise) {
      row.data = data;
      // The cached count is the payload's OWN total — the same predicate that
      // produced its rows. Never a suggest-side estimate, and never `0` for a
      // total that has not landed: a count is a number or unknown (PH-05 §5.2).
      const total = Number(data?.total);
      const answered = data?.total !== null && data?.total !== undefined;
      row.count = answered && Number.isFinite(total) ? total : null;
      row.at = Date.now();
    }
    return data;
  }).catch((error) => {
    const row = cache.get(key);
    if (error?.name === 'AbortError') {
      // The answer never landed: drop the row rather than leave it behind with
      // no data for the next caller to mistake for a warm page.
      if (row && row.promise === promise) cache.delete(key);
      return null;
    }
    if (row && row.promise === promise) {
      cache.delete(key);
    }
    throw error;
  });
  cache.set(key, {
    at: Date.now(),
    data: null,
    promise,
    count: null,
  });
  return promise;
}
