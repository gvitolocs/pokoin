/**
 * PIPELINE BLOCK: hot search page (SPA)
 * -------------------------------------
 * After typeahead returns, prefetch GET /api/marketplace-search-page for the
 * same q+lang+tab so Enter paints the grid from memory. The API also keeps the
 * Meili ID pool hot (`_suggest_hot_query.js`); this block is the client half.
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
  count,
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
    if (count != null) {
      existing.count = Number(count) || existing.count || 0;
    }
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
      row.at = Date.now();
    }
    return data;
  }).catch((error) => {
    if (error?.name === 'AbortError') {
      return null;
    }
    const row = cache.get(key);
    if (row && row.promise === promise) {
      cache.delete(key);
    }
    throw error;
  });
  cache.set(key, {
    at: Date.now(),
    data: null,
    promise,
    count: Number(count) || 0,
  });
  return promise;
}
