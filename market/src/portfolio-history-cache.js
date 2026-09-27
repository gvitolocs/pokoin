import { normalizeHistoryDay } from './portfolio-history.js';

// One history request per signed-in user for the lifetime of the SPA. The
// dashboard and its nav preview share this cache, so opening the hover card
// never starts another authenticated request or paints a different last day.
const entries = new Map();
const inflight = new Map();

function keyFor(uid) {
  return String(uid || '').trim();
}

function normalizedDays(data) {
  const rows = Array.isArray(data) ? data : data?.days;
  return (rows || []).map((row) => normalizeHistoryDay(row)).filter(Boolean);
}

export function peekPortfolioHistory(uid) {
  const key = keyFor(uid);
  return key && entries.has(key) ? entries.get(key) : null;
}

export function loadPortfolioHistory(uid, fetcher) {
  const key = keyFor(uid);
  if (!key) return Promise.resolve([]);
  if (entries.has(key)) return Promise.resolve(entries.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const request = Promise.resolve()
    .then(fetcher)
    .then((data) => {
      const days = normalizedDays(data);
      entries.set(key, days);
      inflight.delete(key);
      return days;
    }, (error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, request);
  return request;
}

export function resetPortfolioHistoryCacheForTests() {
  entries.clear();
  inflight.clear();
}
