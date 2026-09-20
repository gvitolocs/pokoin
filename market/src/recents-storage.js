import { mergeDeskCard, normalizeRecentCardIds, realPublicCardId, rewriteCanonicalCardPath } from './card-stub.js';
import { game as currentGame } from './game.js';
import { tilePricePkn } from './pkn.js';

/** Unscoped legacy keys — ignored once game-scoped keys are in use. */
export const RECENT_KEY = 'pokoin.recentCardIds';
export const RECENT_TILES_KEY = 'pokoin.recentCardTiles';
export const SESSION_TILES_KEY = 'pokoin.recentCardTiles.session';
export const RECENT_MAX = 24;

const memoryTiles = {};

function asId(value) {
  return realPublicCardId(String(value || '').trim());
}

function resolveGameId(gameId) {
  const id = String(gameId || currentGame().id || 'pokemon').trim() || 'pokemon';
  return id;
}

export function recentIdsKey(gameId) {
  return `${RECENT_KEY}.${resolveGameId(gameId)}`;
}

export function recentTilesKey(gameId) {
  return `${RECENT_TILES_KEY}.${resolveGameId(gameId)}`;
}

export function sessionTilesKey(gameId) {
  return `${SESSION_TILES_KEY}.${resolveGameId(gameId)}`;
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

export function writeLocalIds(ids, gameId) {
  const store = localStore();
  const resolved = resolveGameId(gameId);
  writeJson(store, recentIdsKey(resolved), JSON.stringify((ids || []).slice(0, RECENT_MAX)));
}

function legacyTileIds(store, gameId) {
  // Only the game-scoped tile map. Unscoped pokoin.recentCardTiles may mix TCGs.
  try {
    const parsed = JSON.parse(store?.getItem(recentTilesKey(gameId)) || 'null');
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

export function readRecentCardIds(gameId) {
  const resolved = resolveGameId(gameId);
  const store = localStore();
  try {
    // Game-scoped key only. Unscoped pokoin.recentCardIds is ambiguous mixed history.
    const raw = store?.getItem(recentIdsKey(resolved));
    const parsed = JSON.parse(raw || '[]');
    const listed = Array.isArray(parsed) ? parsed : [];
    const ids = normalizeRecentCardIds(
      listed.length ? listed : legacyTileIds(store, resolved),
      RECENT_MAX,
    );
    if (ids.join(',') !== listed.map((id) => String(id || '')).join(',')) {
      writeLocalIds(ids, resolved);
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
    vt: String(card?.vt || ''),
  };
}

function readStoredTileMap(gameId) {
  const resolved = resolveGameId(gameId);
  const scoped = {
    ...parseTileMap(localStore()?.getItem(recentTilesKey(resolved))),
    ...parseTileMap(sessionStore()?.getItem(sessionTilesKey(resolved))),
  };
  const gameMemory = memoryTiles[resolved] || {};
  return { ...scoped, ...gameMemory };
}

export function writeTileMap(map, ids = null, gameId) {
  const resolved = resolveGameId(gameId);
  const keepIds = (ids || readRecentCardIds(resolved)).slice(0, RECENT_MAX);
  if (!memoryTiles[resolved]) {
    memoryTiles[resolved] = {};
  }
  const keep = {};
  for (const id of keepIds) {
    if (map[id]) {
      keep[id] = map[id];
      memoryTiles[resolved][id] = map[id];
    }
  }
  const payload = JSON.stringify(keep);
  writeJson(sessionStore(), sessionTilesKey(resolved), payload);
  writeJson(localStore(), recentTilesKey(resolved), payload);
}

export function clearRecentTileMemory(gameId) {
  const resolved = gameId == null ? null : resolveGameId(gameId);
  if (resolved) {
    delete memoryTiles[resolved];
    return;
  }
  for (const key of Object.keys(memoryTiles)) {
    delete memoryTiles[key];
  }
}

export function rememberTiles(cards, gameId) {
  if (!cards?.length) {
    return;
  }
  const resolved = resolveGameId(gameId);
  const map = readStoredTileMap(resolved);
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
  writeTileMap(map, readRecentCardIds(resolved), resolved);
}

export function peekRecentTile(cardId, gameId) {
  const id = asId(cardId);
  if (!/^\d+$/.test(id)) {
    return null;
  }
  return readStoredTileMap(gameId)[id] || null;
}

export function readRecentTiles(gameId) {
  const resolved = resolveGameId(gameId);
  const map = readStoredTileMap(resolved);
  return readRecentCardIds(resolved).map((id) => map[id]).filter((card) => card && String(card.name || '').trim());
}

export function rememberRecentTiles(cards, gameId) {
  rememberTiles(cards, gameId);
}

export function rememberLocalCardId(cardOrId, gameId) {
  const resolved = resolveGameId(gameId);
  const card = cardOrId && typeof cardOrId === 'object' ? cardOrId : null;
  const id = asId(card?.id || card?.card_id || card?.cardId || cardOrId);
  if (!/^\d+$/.test(id)) {
    return [];
  }
  const next = mergeRecentIds([id], readRecentCardIds(resolved));
  writeLocalIds(next, resolved);
  if (card) {
    rememberTiles([card], resolved);
    writeTileMap(readStoredTileMap(resolved), next, resolved);
  }
  return next;
}
