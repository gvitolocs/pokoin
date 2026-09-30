/** Desk identity from marketplace-card-page, keyed by public card id. */

const PREFIX = 'pokoin.cardPage.v1.';
export const CARD_PAGE_TTL_MS = 12 * 60 * 60 * 1000;
const MEMORY_CAP = 24;
/** localStorage copies (~20–40 KB each). Uncapped they filled the 5 MB quota,
 * after which every setItem on the site threw — the cart's crashed the app. */
export const CARD_PAGE_STORE_CAP = 40;
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

function keyOf(cardId, lang = 'en') {
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) {
    return '';
  }
  return `${PREFIX}${String(lang || 'en').toLowerCase()}:${id}`;
}

function isPayload(payload) {
  return Boolean(payload?.card && (payload.card.id || payload.card.card_id));
}

function isFresh(payload) {
  return isPayload(payload) && Date.now() - Number(payload.savedAt || 0) <= CARD_PAGE_TTL_MS;
}

function slimPage(data) {
  if (!isPayload(data)) {
    return null;
  }
  const { offers: _offers, ...page } = data;
  return {
    ...page,
    savedAt: Number(data.savedAt) || Date.now(),
  };
}

export function peekStoredCardPage(cardId, { lang = 'en' } = {}) {
  const key = keyOf(cardId, lang);
  if (!key) {
    return null;
  }
  if (memory.has(key)) {
    const hit = memory.get(key);
    return isFresh(hit) ? hit : null;
  }
  const storage = store();
  if (!storage) {
    return null;
  }
  try {
    const parsed = JSON.parse(storage.getItem(key) || 'null');
    if (!isFresh(parsed)) {
      storage.removeItem(key);
      return null;
    }
    memory.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function rememberStoredCardPage(cardId, data, { lang = 'en' } = {}) {
  const key = keyOf(cardId, lang);
  const page = slimPage(data);
  if (!key || !page) {
    return;
  }
  memory.delete(key);
  memory.set(key, page);
  while (memory.size > MEMORY_CAP) {
    memory.delete(memory.keys().next().value);
  }
  const storage = store();
  if (!storage) {
    return;
  }
  const raw = JSON.stringify(page);
  try {
    storage.setItem(key, raw);
  } catch {
    // Quota: drop every stored card page, then try once more.
    pruneStoredCardPages(0);
    try {
      storage.setItem(key, raw);
    } catch {
      return;
    }
  }
  pruneStoredCardPages(CARD_PAGE_STORE_CAP);
}

function savedAtOf(raw) {
  // slimPage puts savedAt last, so it sits at the end of the JSON.
  const match = String(raw || '').slice(-40).match(/"savedAt":(\d+)\}$/);
  return match ? Number(match[1]) : 0;
}

/** Keep only the newest `keep` card pages in localStorage (0 clears them all). */
export function pruneStoredCardPages(keep = CARD_PAGE_STORE_CAP) {
  const storage = store();
  if (!storage) {
    return 0;
  }
  try {
    const rows = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(PREFIX)) {
        rows.push([key, savedAtOf(storage.getItem(key))]);
      }
    }
    if (rows.length <= keep) {
      return 0;
    }
    rows.sort((a, b) => b[1] - a[1]);
    const drop = rows.slice(Math.max(0, keep));
    for (const [key] of drop) {
      storage.removeItem(key);
    }
    return drop.length;
  } catch {
    return 0;
  }
}
