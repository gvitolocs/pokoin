/**
 * "Sold on Pokoin" rows, per card, kept beside the sold slices they hang under
 * (market/src/sold-sales-cache.js) and for as long: the panel is part of the desk
 * a visit already paints, so a card seen before shows its sales in the first
 * frame instead of a panel appearing under a visitor mid-glance.
 */

import { CARD_SALES_TTL_MS } from './sold-sales-cache.js';

const PREFIX = 'pokoin.nativeSales.v1.';
/** As fresh as the sold slices it is drawn with. */
export const NATIVE_SALES_TTL_MS = CARD_SALES_TTL_MS;
const MEMORY_CAP = 32;
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

function keyOf(cardId) {
  const id = String(cardId || '').trim();
  return id ? PREFIX + id : '';
}

function isPayload(payload) {
  return Boolean(payload && Array.isArray(payload.sales) && Number.isFinite(Number(payload.savedAt)));
}

function isFresh(payload) {
  return isPayload(payload) && Date.now() - Number(payload.savedAt) <= NATIVE_SALES_TTL_MS;
}

function touch(cardId, payload) {
  const id = String(cardId || '').trim();
  if (!id) {
    return;
  }
  if (memory.has(id)) {
    memory.delete(id);
  }
  memory.set(id, payload);
  while (memory.size > MEMORY_CAP) {
    memory.delete(memory.keys().next().value);
  }
}

/** The stored rows of this card, or null when this device has never seen them. */
export function peekNativeSales(cardId) {
  const id = String(cardId || '').trim();
  if (!id) {
    return null;
  }
  const live = memory.get(id);
  if (isFresh(live)) {
    touch(id, live);
    return live;
  }
  if (live) {
    memory.delete(id);
  }
  const key = keyOf(id);
  const local = store();
  if (!key || !local) {
    return null;
  }
  try {
    const parsed = JSON.parse(local.getItem(key) || '');
    if (!isFresh(parsed)) {
      return null;
    }
    touch(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function saveNativeSales(cardId, sales) {
  const id = String(cardId || '').trim();
  if (!id || !Array.isArray(sales)) {
    return null;
  }
  const payload = { savedAt: Date.now(), sales };
  touch(id, payload);
  const key = keyOf(id);
  const local = store();
  if (key && local) {
    try {
      local.setItem(key, JSON.stringify(payload));
    } catch {
      /* quota */
    }
  }
  return payload;
}

export function resetNativeSalesCacheForTests() {
  memory.clear();
}
