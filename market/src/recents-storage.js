import { mergeDeskCard, normalizeRecentCardIds, realPublicCardId, rewriteCanonicalCardPath } from './card-stub.js';
import { tilePricePkn } from './pkn.js';

export const RECENT_KEY = 'pokoin.recentCardIds';
export const RECENT_TILES_KEY = 'pokoin.recentCardTiles';
export const SESSION_TILES_KEY = 'pokoin.recentCardTiles.session';
export const RECENT_MAX = 24;

const memoryTiles = {};

function asId(value) {
  return realPublicCardId(String(value || '').trim());
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

function sessionStore() {
  try {
    const session = globalThis.sessionStorage;
    if (session && typeof session.getItem === 'function') {
      return session;
    }
  } catch {
    /* private mode */
  }
  return null;
}

export function dropFatCaches(store) {
  if (!store?.removeItem) {
    return;
  }
  const keys = [];
  try {
    for (let index = 0; index < (store.length || 0); index += 1) {
      const key = store.key(index);
      if (key && (key.startsWith('pokoin.cardPage.') || key.startsWith('pokoin.cardSales.'))) {
        keys.push(key);
      }
    }
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

function writeJson(store, key, payload) {
  if (!store?.setItem) {
    return false;
  }
  try {
    store.setItem(key, payload);
    return true;
  } catch {
    dropFatCaches(store);
    try {
      store.setItem(key, payload);
      return true;
    } catch {
      return false;
    }
  }
}

export function writeLocalIds(ids) {
  const store = localStore();
  writeJson(store, RECENT_KEY, JSON.stringify((ids || []).slice(0, RECENT_MAX)));
}

function legacyTileIds(store) {
  try {
    const parsed = JSON.parse(store?.getItem(RECENT_TILES_KEY) || 'null');
    if (Array.isArray(parsed)) {
      return parsed.map((item) => item?.id || item?.card_id || item);
    }
    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function parseTileMap(raw) {
  const out = {};
  try {
    const parsed = JSON.parse(raw || 'null');
    const entries = Array.isArray(parsed)
      ? parsed.map((card) => [card?.id || card?.card_id, card])
      : Object.entries(parsed && typeof parsed === 'object' ? parsed : {});
    for (const [key, value] of entries) {
      const tile = compactRecentTile(value, key);
      if (tile) {
        out[tile.id] = tile;
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function readRecentCardIds() {
  const store = localStore();
  try {
    const parsed = JSON.parse(store?.getItem(RECENT_KEY) || '[]');
    const listed = Array.isArray(parsed) ? parsed : [];
    const ids = normalizeRecentCardIds(
      listed.length ? listed : legacyTileIds(store),
      RECENT_MAX,
    );
    if (ids.join(',') !== listed.map((id) => String(id || '')).join(',')) {
      writeLocalIds(ids);
    }
    return ids;
  } catch {
    return [];
  }
}

export function mergeRecentIds(...lists) {
  return normalizeRecentCardIds(lists.flatMap((list) => list || []), RECENT_MAX);
}

export function compactRecentTile(card, id = '') {
  const cardId = asId(id || card?.id || card?.card_id || card?.cardId);
  if (!/^\d+$/.test(cardId)) {
    return null;
  }
  const name = String(card?.name || '').trim();
  if (!name) {
    return null;
  }
  const price = tilePricePkn(card);
  const set = String(card?.set || card?.set_name || card?.expansion || '');
  const canonicalPath = rewriteCanonicalCardPath(card?.canonicalPath || card?.canonical_path, cardId);
  return {
    id: cardId,
    card_id: cardId,
    name,
    set,
    set_name: set,
    number: String(card?.number || card?.card_number || card?.publicNumber || ''),
    rarity: String(card?.rarity || ''),
    price,
    lowest_price_pkn: price,
    medianSoldEur: card?.medianSoldEur ?? card?.median_sold_eur ?? null,
    gridImageUrl: card?.gridImageUrl || card?.tileImageUrl || card?.previewImageUrl || card?.imageUrl || '',
    heroImageUrl: card?.heroImageUrl || card?.imageUrl || '',
    imageUrl: card?.imageUrl || card?.heroImageUrl || card?.gridImageUrl || '',
    tileImageUrl: card?.tileImageUrl || card?.homepageImageUrl || card?.gridImageUrl || '',
    homepageImageUrl: card?.homepageImageUrl || card?.tileImageUrl || '',
    canonicalPath,
    canonical_path: canonicalPath,
    itemKind: String(card?.itemKind || 'single'),
    productType: String(card?.productType || 'card'),
    emoji: String(card?.emoji || card?.cardIdentityEmoji || ''),
    artist: String(card?.artist || card?.illustrator || ''),
    illustrator: String(card?.illustrator || card?.artist || ''),
    isMarketAvailable: Boolean(card?.isMarketAvailable || card?.inStock),
    inStock: Boolean(card?.inStock || card?.isMarketAvailable),
  };
}

function readStoredTileMap() {
  const out = {
    ...parseTileMap(localStore()?.getItem(RECENT_TILES_KEY)),
    ...parseTileMap(sessionStore()?.getItem(SESSION_TILES_KEY)),
    ...memoryTiles,
  };
  return out;
}

export function writeTileMap(map, ids = readRecentCardIds()) {
  const keep = {};
  for (const id of ids.slice(0, RECENT_MAX)) {
    if (map[id]) {
      keep[id] = map[id];
      memoryTiles[id] = map[id];
    }
  }
  const payload = JSON.stringify(keep);
  writeJson(sessionStore(), SESSION_TILES_KEY, payload);
  writeJson(localStore(), RECENT_TILES_KEY, payload);
}

export function clearRecentTileMemory() {
  for (const id of Object.keys(memoryTiles)) {
    delete memoryTiles[id];
  }
}

export function rememberTiles(cards) {
  if (!cards?.length) {
    return;
  }
  const map = readStoredTileMap();
  for (const card of cards) {
    const tile = compactRecentTile(card);
    if (!tile) {
      continue;
    }
    const prev = map[tile.id];
    if (prev && !String(tile.name || '').trim()) {
      continue;
    }
    if (prev && tilePricePkn(tile) == null && tilePricePkn(prev) != null) {
      map[tile.id] = mergeDeskCard(prev, {
        ...tile,
        price: prev.price,
        lowest_price_pkn: prev.lowest_price_pkn,
      });
    } else {
      map[tile.id] = prev ? mergeDeskCard(prev, tile) : tile;
    }
  }
  writeTileMap(map);
}

export function peekRecentTile(cardId) {
  const id = asId(cardId);
  if (!/^\d+$/.test(id)) {
    return null;
  }
  return readStoredTileMap()[id] || null;
}

export function readRecentTiles() {
  const map = readStoredTileMap();
  return readRecentCardIds().map((id) => map[id]).filter((card) => card && String(card.name || '').trim());
}

export function rememberRecentTiles(cards) {
  rememberTiles(cards);
}

export function rememberLocalCardId(cardOrId) {
  const card = cardOrId && typeof cardOrId === 'object' ? cardOrId : null;
  const id = asId(card?.id || card?.card_id || card?.cardId || cardOrId);
  if (!/^\d+$/.test(id)) {
    return [];
  }
  const next = mergeRecentIds([id], readRecentCardIds());
  writeLocalIds(next);
  if (card) {
    rememberTiles([card]);
    writeTileMap(readStoredTileMap(), next);
  }
  return next;
}
