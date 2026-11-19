/**
 * The desk's other price sources, per card, window and facet, kept beside
 * the sold slices (market/src/sold-sales-cache.js): a card seen before draws its
 * graph complete at once, instead of the sold line first and the rest a second
 * later. v2 because a `fields=graph` answer holds the series of one facet, so the
 * facet is part of the key — the foil facet, and since PH-C025 the Cardmarket
 * grade floor and language the desk asked for; what v1 left behind is dropped,
 * never read. A key of the default facet is the one without those two, so a
 * window written before them is still read; every other facet writes both words
 * in one form, `.FLOOR-LANGUAGE`, because a key that left one out would be the
 * key of another facet too.
 */

import { CARD_SALES_TTL_MS } from './sold-sales-cache.js';

const PREFIX = 'pokoin.cardPriceHistory.v2.';
/** v1 keys hold an answer of the other facet's series: unreadable, so removed. */
const LEGACY_PREFIX = 'pokoin.cardPriceHistory.v1.';
/** As fresh as the sold slices it is drawn with. */
export const CARD_PRICE_HISTORY_TTL_MS = CARD_SALES_TTL_MS;
const MEMORY_CAP = 32;
/** One copy per card, window and facet: the oldest of these keys goes first. */
const STORE_CAP = 40;
/**
 * The facet the server answers for nobody asked: what a `fields=graph` window
 * of no `cmCondition`/`cmLanguage` holds. A key with no facet in it is exactly
 * this one, so what is already stored is read as the default facet, never lost.
 */
const DEFAULT_CONDITION = 'NM';
const DEFAULT_LANGUAGE = 'EN';
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

function keyOf(cardId, rangeKey, { reverse, condition, language } = {}) {
  const id = String(cardId || '').trim();
  const range = String(rangeKey || '').trim();
  if (!id || !range) {
    return '';
  }
  const [floor, code] = facetOf(condition, language);
  // Every facet but the default writes both parts of one fixed suffix: dropping
  // either one would let floor `PL` of language `EN` and floor `NM` of language
  // `PL` answer from a single cached window.
  const facet = floor === DEFAULT_CONDITION && code === DEFAULT_LANGUAGE ? '' : `.${floor}-${code}`;
  return `${PREFIX}${id}.${range}${reverse === true ? '.r' : ''}${facet}`;
}

/** The key's two facet words, uppercased: an absent one is the default. */
function facetOf(condition, language) {
  return [
    String(condition || DEFAULT_CONDITION).trim().toUpperCase(),
    String(language || DEFAULT_LANGUAGE).trim().toUpperCase(),
  ];
}

/**
 * The facet this window answers for, as the entry itself says: a part it does not
 * carry is not contradicted, since what was stored before the facet travelled is
 * the default one — and a part it does carry must be the one asked for.
 */
function entryFacetMatches(entry, condition, language) {
  const [floor, code] = facetOf(condition, language);
  const stored = (value) => (value == null || value === '' ? null : String(value).trim().toUpperCase());
  const storedFloor = stored(entry.condition);
  const storedCode = stored(entry.language);
  return (storedFloor === null || storedFloor === floor) && (storedCode === null || storedCode === code);
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
function peek(cardId, rangeKey, freshOnly, options = {}) {
  const key = keyOf(cardId, rangeKey, options);
  if (!key) {
    return null;
  }
  const payload = read(key);
  if (!isPayload(payload)) {
    memory.delete(key);
    return null;
  }
  // The key is not enough: an entry that names another facet answers nothing here.
  if (!entryFacetMatches(payload.entry, options.condition, options.language)) {
    return null;
  }
  touch(key, payload);
  if (freshOnly && Date.now() - Number(payload.savedAt) > CARD_PRICE_HISTORY_TTL_MS) {
    return null;
  }
  return payload.entry;
}

/**
 * `{ reverse: true }` is the reverse-holo window: another key, another answer.
 * `{ condition, language }` is the Cardmarket facet of the same read: an answer
 * of another floor or another language is not this window, neither under its key
 * nor under this one, and the default facet keeps the key it always had.
 */
export function peekCardPriceHistory(cardId, rangeKey, options) {
  return peek(cardId, rangeKey, true, options);
}

export function rememberStaleCardPriceHistory(cardId, rangeKey, options) {
  return peek(cardId, rangeKey, false, options);
}

export function saveCardPriceHistory(cardId, rangeKey, entry, options) {
  if (!isEntry(entry)) {
    return null;
  }
  const key = keyOf(cardId, rangeKey, options);
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

/**
 * Remove every v1 window this cache wrote — its key has no facet, so v2 can
 * never read it — and keep only the newest `keep` of this cache's own keys.
 * A key of another cache is left alone either way.
 */
function pruneStoredPriceHistory(keep = STORE_CAP) {
  const local = store();
  if (!local) {
    return 0;
  }
  try {
    const rows = [];
    const legacy = [];
    for (let i = 0; i < local.length; i += 1) {
      const key = local.key(i);
      if (!key) {
        continue;
      }
      if (key.startsWith(LEGACY_PREFIX)) {
        legacy.push(key);
      } else if (key.startsWith(PREFIX)) {
        rows.push([key, savedAtOf(local.getItem(key))]);
      }
    }
    for (const key of legacy) {
      local.removeItem(key);
      memory.delete(key);
    }
    if (rows.length <= keep) {
      return legacy.length;
    }
    rows.sort((a, b) => a[1] - b[1]);
    const drop = rows.slice(0, rows.length - keep);
    for (const [key] of drop) {
      local.removeItem(key);
      memory.delete(key);
    }
    return legacy.length + drop.length;
  } catch {
    return 0;
  }
}

export function resetCardPriceHistoryCacheForTests() {
  memory.clear();
}
