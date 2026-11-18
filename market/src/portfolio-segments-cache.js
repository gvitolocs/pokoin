import { normalizeSegments } from './portfolio-segments.js';

// The history cache keeps normalized days only, so the segment split of each
// day does not survive it. This side cache holds the raw answer's segments —
// memory for the SPA's lifetime, one per-user copy in localStorage so a reload
// paints the table at once instead of waiting on the network.
const entries = new Map();
const listeners = new Map();

const STORAGE_PREFIX = 'pokoin.portfolioSegments.v1';
/** A copy older than this is not worth painting. */
const STORED_MAX_AGE_MS = 30 * 86400000;

function keyFor(uid) {
  return String(uid || '').trim();
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

/** A payload this module wrote, or null: anything else is another build's. */
function readStoredModel(id) {
  const store = localStore();
  if (!store || !id) return null;
  try {
    const parsed = JSON.parse(store.getItem(storageKey(id)) || 'null');
    const model = parsed?.model;
    if (!parsed || !Array.isArray(model?.defs) || !model.defs.length) return null;
    if (!Array.isArray(model.days) || !model.days.length) return null;
    if (model.days.some((row) => typeof row?.date !== 'string')) return null;
    if (Date.now() - (Number(parsed.savedAt) || 0) > STORED_MAX_AGE_MS) return null;
    return model;
  } catch {
    return null;
  }
}

function writeStoredModel(id, model) {
  const store = localStore();
  if (!store || !id) return;
  const payload = JSON.stringify({ savedAt: Date.now(), model });
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

function emit(id, model) {
  for (const listener of [...(listeners.get(id) || [])]) listener(model);
}

/**
 * Keep the segment split of one raw portfolio-history answer. A null model (an
 * old server, junk) stores nothing and clears nothing: a painted table keeps
 * its last known rows.
 */
export function rememberSegments(uid, data) {
  const key = keyFor(uid);
  const model = normalizeSegments(data);
  if (!key || !model) return null;
  entries.set(key, model);
  writeStoredModel(key, model);
  emit(key, model);
  return model;
}

/** The model for this user: memory, else a stored copy younger than 30 days. */
export function peekSegments(uid) {
  const key = keyFor(uid);
  if (!key) return null;
  if (entries.has(key)) return entries.get(key);
  const stored = readStoredModel(key);
  if (stored) entries.set(key, stored);
  return stored;
}

/** Hear every model remembered after the one already painted. */
export function subscribeSegments(uid, listener) {
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

/** Forget one user's segments: memory and the persisted copy. */
export function forgetSegments(uid) {
  const key = keyFor(uid);
  if (!key) return;
  entries.delete(key);
  listeners.delete(key);
  const store = localStore();
  if (!store) return;
  try {
    store.removeItem(storageKey(key));
  } catch {
    /* nothing persisted */
  }
}

export function resetSegmentsCacheForTests() {
  entries.clear();
  listeners.clear();
}
