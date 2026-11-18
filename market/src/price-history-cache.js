/**
 * The desk's other price sources, per card and window, kept beside the sold
 * slices (market/src/sold-sales-cache.js): a card seen before draws its graph
 * complete at once, instead of the sold line first and the rest a second later.
 */

import { CARD_SALES_TTL_MS } from './sold-sales-cache.js';

const PREFIX = 'pokoin.cardPriceHistory.v1.';
/** As fresh as the sold slices it is drawn with. */
export const CARD_PRICE_HISTORY_TTL_MS = CARD_SALES_TTL_MS;
const MEMORY_CAP = 32;
/** One copy per card and range window: the oldest of these keys goes first. */
const STORE_CAP = 40;
const memory = new Map();

function store() {
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

function keyOf(cardId, rangeKey) {
  const id = String(cardId || '').trim();
  const range = String(rangeKey || '').trim();
  return id && range ? `${PREFIX}${id}.${range}` : '';
}

/** What the graph needs to draw one window: its own shape, nothing else. */
function isEntry(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && String(entry.range || '')
    && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.from || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.to || ''))
    && entry.history
    && typeof entry.history === 'object',
  );
}

function isPayload(payload) {
  return isEntry(payload?.entry) && Number.isFinite(Number(payload.savedAt));
}

function touch(key, payload) {
  if (memory.has(key)) {
    memory.delete(key);
  }
  memory.set(key, payload);
  while (memory.size > MEMORY_CAP) {
    memory.delete(memory.keys().next().value);
  }
}

function read(key) {
  const live = memory.get(key);
  if (live) {
    return live;
  }
  const local = store();
  if (!local) {
    return null;
  }
  try {
    return JSON.parse(local.getItem(key) || '');
  } catch {
    return null;
  }
}

/** The stored window of this card and range, or null when there is none. */
function peek(cardId, rangeKey, freshOnly) {
  const key = keyOf(cardId, rangeKey);
  if (!key) {
    return null;
  }
  const payload = read(key);
  if (!isPayload(payload)) {
    memory.delete(key);
    return null;
  }
  touch(key, payload);
  if (freshOnly && Date.now() - Number(payload.savedAt) > CARD_PRICE_HISTORY_TTL_MS) {
    return null;
  }
  return payload.entry;
}

export function peekCardPriceHistory(cardId, rangeKey) {
  return peek(cardId, rangeKey, true);
}

export function rememberStaleCardPriceHistory(cardId, rangeKey) {
  return peek(cardId, rangeKey, false);
}

export function saveCardPriceHistory(cardId, rangeKey, entry) {
  if (!isEntry(entry)) {
    return null;
  }
  const key = keyOf(cardId, rangeKey);
  if (!key) {
    return null;
  }
  // savedAt last: the prune below reads it off the end of the string.
  const payload = { entry, savedAt: Date.now() };
  touch(key, payload);
  const local = store();
  if (local) {
    try {
      local.setItem(key, JSON.stringify(payload));
    } catch {
      /* quota */
    }
    pruneStoredPriceHistory(STORE_CAP);
  }
  return entry;
}

function savedAtOf(raw) {
  const match = String(raw || '').slice(-40).match(/"savedAt":(\d+)\}$/);
  return match ? Number(match[1]) : 0;
}

/** Keep only the newest `keep` history windows of this cache's own keys. */
function pruneStoredPriceHistory(keep = STORE_CAP) {
  const local = store();
  if (!local) {
    return 0;
  }
  try {
    const rows = [];
    for (let i = 0; i < local.length; i += 1) {
      const key = local.key(i);
      if (key && key.startsWith(PREFIX)) {
        rows.push([key, savedAtOf(local.getItem(key))]);
      }
    }
    if (rows.length <= keep) {
      return 0;
    }
    rows.sort((a, b) => a[1] - b[1]);
    const drop = rows.slice(0, rows.length - keep);
    for (const [key] of drop) {
      local.removeItem(key);
      memory.delete(key);
    }
    return drop.length;
  } catch {
    return 0;
  }
}

export function resetCardPriceHistoryCacheForTests() {
  memory.clear();
}
