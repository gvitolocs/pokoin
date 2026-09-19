const PREFIX = 'pokoin.cardSales.v12.';
export const CARD_SALES_TTL_MS = 15 * 24 * 60 * 60 * 1000;
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
  return Boolean(payload && Array.isArray(payload.slices) && Number.isFinite(Number(payload.savedAt)));
}

function isFresh(payload) {
  return isPayload(payload) && Date.now() - Number(payload.savedAt) <= CARD_SALES_TTL_MS;
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
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
}

export function peekCardSales(cardId) {
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

export function saveCardSales(cardId, slices) {
  const id = String(cardId || '').trim();
  if (!id || !Array.isArray(slices)) {
    return null;
  }
  const payload = { savedAt: Date.now(), slices };
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

export function rememberStaleCardSales(cardId) {
  const id = String(cardId || '').trim();
  if (!id) {
    return null;
  }
  const live = memory.get(id);
  if (isPayload(live)) {
    return live;
  }
  const key = keyOf(id);
  const local = store();
  if (!key || !local) {
    return null;
  }
  try {
    const parsed = JSON.parse(local.getItem(key) || '');
    if (!isPayload(parsed)) {
      return null;
    }
    touch(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function resetCardSalesCacheForTests() {
  memory.clear();
}
