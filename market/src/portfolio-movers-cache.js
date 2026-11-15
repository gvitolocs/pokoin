import { normalizeMovers } from './portfolio-movers.js';

// One movers request per (user, window) for the lifetime of the SPA. The
// window only changes when the chart preset changes, so flipping Gainers ↔
// Losers never re-hits the API.
const entries = new Map();
const inflight = new Map();

function emptyMovers() {
  return { days: null, gainers: [], losers: [] };
}

function keyFor(uid, days) {
  const id = String(uid || '').trim();
  return id ? `${id}|${String(days ?? '').trim()}` : '';
}

export function peekPortfolioMovers(uid, days) {
  const key = keyFor(uid, days);
  return key && entries.has(key) ? entries.get(key) : null;
}

export function loadPortfolioMovers(uid, days, fetcher) {
  const key = keyFor(uid, days);
  if (!key) return Promise.resolve(emptyMovers());
  if (entries.has(key)) return Promise.resolve(entries.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const request = Promise.resolve()
    .then(fetcher)
    .then((data) => {
      const payload = normalizeMovers(data);
      entries.set(key, payload);
      inflight.delete(key);
      return payload;
    }, (error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, request);
  return request;
}

export function resetPortfolioMoversCacheForTests() {
  entries.clear();
  inflight.clear();
}
