/**
 * The last answers of recently opened card desks, per game + card (public
 * data), so a desk reload paints its panels as they were and the live reads
 * only patch what changed:
 * - listings (`pokoin.deskListings.v1`): Best Deal, the Vault and the Shop;
 *   the live read reconciles rows by id, so nothing moves unless a listing did.
 * - version rows (`pokoin.deskVersions.v1`): the rarity select under the scan,
 *   which otherwise waits for the name snapshot and swaps in after the label.
 * Each: { [game:cardId]: { rows, at } }, newest last, at most 24 desks and
 * ~600 KB, painted for 3 days.
 */
const MAX_DESKS = 24;
const MAX_CHARS = 600_000;
const KEEP_MS = 3 * 24 * 60 * 60_000;

function storage(store) {
  if (store) return store;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

const deskKey = (gameId, cardId) => `${String(gameId || 'pokemon')}:${String(cardId || '')}`;

function deskStore(key) {
  function readAll(store) {
    try {
      const saved = JSON.parse(storage(store)?.getItem(key) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  }
  /** `{ rows, at }` for this desk, or null. An empty `rows` is a real answer. */
  function read(gameId, cardId, { store, now = Date.now() } = {}) {
    if (!cardId) return null;
    const hit = readAll(store)[deskKey(gameId, cardId)];
    if (!hit || !Array.isArray(hit.rows) || !(now - Number(hit.at || 0) < KEEP_MS)) return null;
    return hit;
  }
  function write(gameId, cardId, rows, { store, now = Date.now() } = {}) {
    if (!cardId || !Array.isArray(rows)) return;
    const all = readAll(store);
    const id = deskKey(gameId, cardId);
    delete all[id];
    all[id] = { rows, at: now };
    let keys = Object.keys(all);
    while (keys.length > MAX_DESKS) delete all[keys.shift()];
    let text = JSON.stringify(all);
    while (text.length > MAX_CHARS && keys.length > 1) {
      delete all[keys.shift()];
      keys = Object.keys(all);
      text = JSON.stringify(all);
    }
    try {
      storage(store)?.setItem(key, text);
    } catch {
      /* quota / private mode */
    }
  }
  return { read, write };
}

const listings = deskStore('pokoin.deskListings.v1');
const versions = deskStore('pokoin.deskVersions.v1');

export const readDeskListings = listings.read;
export const writeDeskListings = listings.write;
export const readDeskVersions = versions.read;
export const writeDeskVersions = versions.write;
