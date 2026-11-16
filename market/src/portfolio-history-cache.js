import { normalizeHistoryDay, utcDayKey } from './portfolio-history.js';

// One history request per signed-in user for the lifetime of the SPA. The
// dashboard and its nav preview share this cache, so opening the hover card
// never starts another authenticated request or paints a different last day.
//
// The days are also kept per user in localStorage, so a reload or a second tab
// paints the last known series at once instead of waiting on the network. The
// API answers from its own stored series and recomputes behind that reply, so a
// fresh answer can still end before today; the follow-ups below pick up the
// newer day quietly.
const entries = new Map();
const inflight = new Map();
const listeners = new Map();
const chains = new Map();
// Bumped by a sign-out so an in-flight reply does not re-persist a copy the
// user asked to forget.
const epochs = new Map();

const STORAGE_PREFIX = 'pokoin.portfolioHistory.v1';
/** A copy older than this is not worth painting. */
const STORED_MAX_AGE_MS = 30 * 86400000;
/** Two quiet retries at most while the series still ends before today. */
const FOLLOWUP_DELAYS_MS = [5000, 10000];

function keyFor(uid) {
  return String(uid || '').trim();
}

function epochFor(uid) {
  return Number(epochs.get(uid)) || 0;
}

function normalizedDays(data) {
  const rows = Array.isArray(data) ? data : data?.days;
  return (rows || []).map((row) => normalizeHistoryDay(row)).filter(Boolean);
}

function localStore() {
  try {
    const local = globalThis.localStorage;
    if (local && typeof local.getItem === 'function') {
      return local;
    }
  } catch {
    /* private mode */
  }
  return null;
}

function storageKey(id) {
  return `${STORAGE_PREFIX}.${id}`;
}

function readStoredDays(id) {
  const store = localStore();
  if (!store || !id) return null;
  try {
    const parsed = JSON.parse(store.getItem(storageKey(id)) || 'null');
    if (!parsed || !Array.isArray(parsed.days) || !parsed.days.length) return null;
    // Days this module wrote always carry their UTC date key; anything else is
    // a payload from a different build.
    if (parsed.days.some((row) => typeof row?.date !== 'string')) return null;
    if (Date.now() - (Number(parsed.savedAt) || 0) > STORED_MAX_AGE_MS) return null;
    const days = normalizedDays(parsed.days);
    return days.length ? days : null;
  } catch {
    return null;
  }
}

function writeStoredDays(id, days) {
  const store = localStore();
  if (!store || !id) return;
  const payload = JSON.stringify({ savedAt: Date.now(), days });
  try {
    store.setItem(storageKey(id), payload);
  } catch {
    try {
      store.removeItem(storageKey(id));
      store.setItem(storageKey(id), payload);
    } catch {
      /* full or private: this session still has the memory copy */
    }
  }
}

function remember(id, days) {
  entries.set(id, days);
  writeStoredDays(id, days);
}

/** The stored series ends before today, so a recomputed one may exist. */
function isStale(days) {
  const last = days?.length ? days[days.length - 1].date : '';
  return Boolean(last) && last < utcDayKey();
}

function emit(id, days) {
  for (const listener of [...(listeners.get(id) || [])]) listener(days);
}

function cancelFollowUp(id) {
  const chain = chains.get(id);
  if (!chain) return;
  chains.delete(id);
  if (chain.timer == null) return;
  try {
    chain.clear(chain.timer);
  } catch {
    /* the timer already ran */
  }
  chain.timer = null;
}

function queueFollowUp(id, fetcher, chain) {
  const delay = FOLLOWUP_DELAYS_MS[chain.attempt];
  if (delay == null) {
    chains.delete(id);
    return;
  }
  chain.attempt += 1;
  chain.timer = chain.schedule(() => {
    chain.timer = null;
    runFollowUp(id, fetcher, chain);
  }, delay);
  // A browser keeps counting; a Node host (tests, SSR) must not wait on a
  // retry it never renders.
  chain.timer?.unref?.();
}

function runFollowUp(id, fetcher, chain) {
  Promise.resolve().then(fetcher).then((data) => {
    if (chains.get(id) !== chain) return;
    const days = normalizedDays(data);
    // An empty answer is not a newer one; it would blank a painted graph.
    if (!days.length) {
      chains.delete(id);
      return;
    }
    remember(id, days);
    emit(id, days);
    if (isStale(days)) queueFollowUp(id, fetcher, chain);
    else chains.delete(id);
  }, () => {
    if (chains.get(id) === chain) chains.delete(id);
  });
}

export function peekPortfolioHistory(uid) {
  const key = keyFor(uid);
  if (!key) return null;
  if (entries.has(key)) return entries.get(key);
  return readStoredDays(key);
}

export function loadPortfolioHistory(uid, fetcher, options = {}) {
  const key = keyFor(uid);
  if (!key) return Promise.resolve([]);
  if (entries.has(key)) return Promise.resolve(entries.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const epoch = epochFor(key);
  const schedule = options.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clear = options.clearTimeout || ((timer) => globalThis.clearTimeout(timer));
  const request = Promise.resolve()
    .then(fetcher)
    .then((data) => {
      const days = normalizedDays(data);
      inflight.delete(key);
      // A sign-out while this was in flight: answer it, forget it.
      if (epochFor(key) === epoch) {
        remember(key, days);
        if (days.length && isStale(days)) {
          const chain = { attempt: 0, timer: null, schedule, clear };
          chains.set(key, chain);
          queueFollowUp(key, fetcher, chain);
        }
      }
      return days;
    }, (error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, request);
  return request;
}

/** Hear every series that arrives after the one `loadPortfolioHistory` resolved. */
export function subscribePortfolioHistory(uid, listener) {
  const key = keyFor(uid);
  if (!key || typeof listener !== 'function') return () => {};
  const subscribers = listeners.get(key) || new Set();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    const still = listeners.get(key);
    if (!still) return;
    still.delete(listener);
    if (!still.size) listeners.delete(key);
  };
}

/** Forget one user's series: memory, the persisted copy and any follow-up. */
export function clearPortfolioHistory(uid) {
  const key = keyFor(uid);
  if (!key) return;
  epochs.set(key, epochFor(key) + 1);
  cancelFollowUp(key);
  entries.delete(key);
  inflight.delete(key);
  listeners.delete(key);
  const store = localStore();
  if (!store) return;
  try {
    store.removeItem(storageKey(key));
  } catch {
    /* nothing persisted */
  }
}

export function resetPortfolioHistoryCacheForTests() {
  for (const id of [...chains.keys()]) cancelFollowUp(id);
  entries.clear();
  inflight.clear();
  listeners.clear();
  epochs.clear();
}
