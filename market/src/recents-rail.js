/**
 * The Recently seen rail, kept ready while the visitor browses.
 *
 * The marketplace paints the rail in its first frame from the stored tiles
 * (recents-storage.js, D00002U). This module keeps that stored copy current in
 * the background, so the first frame is already the right one:
 *
 * - At idle on any page (App) and after each card desk: refetch the rail's
 *   tiles that are missing, and all of them once the copy is older than
 *   RECENT_RAIL_FRESH_MS, with a last-median price for unlisted cards; then
 *   warm the first rail thumbnails into the thumb LRU (suggest-images.js,
 *   D00001Y) so the tiles paint with their scans.
 * - Signed in, at idle: the account's ids from other devices (at most once a
 *   minute, shared with the marketplace page).
 *
 * The marketplace page refreshes behind its first paint with the same calls
 * and keeps the painted order (`stableRecentIds`): a refresh patches tiles in
 * place and appends new ones, never reorders or drops one. Every step is
 * single-flight, low priority, skipped on Save-Data / 2g, and fails quietly.
 */
import { fetchCardTiles, fillMissingLastMedianPrices, imageSrc } from './api.js';
import { game as currentGame } from './game.js';
import { cdnFetchUrl, rasterSiblings } from './image-urls.js';
import { tileHasName } from './lists.js';
import { tilePricePkn } from './pkn.js';
import {
  peekRecentTile,
  readRecentCardIds,
  readRecentTiles,
  rememberRecentTiles,
  syncRemoteRecentCardIds,
} from './recents.js';
import { preloadSuggestThumbs } from './suggest-images.js';

/** Tiles the marketplace rail shows. */
export const RECENT_RAIL_SHOWN = 20;
/** A stored rail older than this is refetched in the background. */
export const RECENT_RAIL_FRESH_MS = 10 * 60 * 1000;
/** Rail thumbnails warmed ahead of the visit: the marketplace's first screen. */
export const RECENT_RAIL_THUMBS = 10;
const ACCOUNT_FRESH_MS = 60 * 1000;
const FRESH_KEY = 'pokoin.recentRailAt';

function resolveGameId(gameId) {
  return String(gameId || currentGame().id || 'pokemon').trim() || 'pokemon';
}

function localStore() {
  try {
    const local = globalThis.localStorage;
    return local && typeof local.getItem === 'function' ? local : null;
  } catch {
    return null;
  }
}

/** True on Save-Data or a 2g connection (lib/prefetch-queue.js prefetchBlocked). */
function connectionBlocked() {
  const connection = typeof navigator === 'undefined' ? null : navigator.connection;
  return Boolean(connection?.saveData) || /(^|-)2g$/.test(String(connection?.effectiveType || ''));
}

/**
 * The rail order after a refresh: the painted ids where they are, then ids new
 * to the rail at its end. A refresh never reorders or drops a tile on screen;
 * the stored list (newest first) orders the next visit.
 */
export function stableRecentIds(painted, next) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(painted || []), ...(next || [])]) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * A refetched tile over the one already stored or painted: its price and stock
 * move, its identity and scan stay. A desk visit stores the card page's
 * richer fields (its `_homepage.webp` thumb); the lighter tiles read would
 * swap the scan under a painted tile. Without a new price the old one stays.
 */
export function refreshTile(prev, next) {
  if (!tileHasName(prev)) return next;
  const price = tilePricePkn(next);
  return {
    ...prev,
    ...(price != null ? { price, lowest_price_pkn: price } : {}),
    medianSoldEur: next?.medianSoldEur ?? next?.median_sold_eur ?? prev.medianSoldEur ?? null,
    isMarketAvailable: Boolean(next?.isMarketAvailable || next?.inStock),
    inStock: Boolean(next?.inStock || next?.isMarketAvailable),
  };
}

/** The scan URL a rail CardTile asks for first (CardArt: the first raster sibling of imageSrc 'grid'). */
export function railThumbUrl(card) {
  if (!card) return '';
  return rasterSiblings(imageSrc(card, 'grid'), { full: false }).map(cdnFetchUrl).find(Boolean) || '';
}

/** The first `limit` rail thumbnails into the thumb LRU, in rail order. Returns the URLs. */
export function warmRecentThumbs(cards, limit = RECENT_RAIL_THUMBS, preload = preloadSuggestThumbs) {
  const urls = [...new Set((cards || []).slice(0, limit).map(railThumbUrl).filter(Boolean))];
  if (urls.length) preload(urls);
  return urls;
}

/** When the stored rail tiles were last refetched in full (ms, 0 = never). */
export function recentRailRefreshedAt(gameId) {
  try {
    return Number(localStore()?.getItem(`${FRESH_KEY}.${resolveGameId(gameId)}`)) || 0;
  } catch {
    return 0;
  }
}

function markRecentRailFresh(gameId, at) {
  try {
    localStore()?.setItem(`${FRESH_KEY}.${resolveGameId(gameId)}`, String(at));
  } catch {
    /* quota / private mode: the next warm-up refetches */
  }
}

const tileFlights = new Map();

/**
 * Refetch the stored rail tiles: the ones missing always, every one once the
 * copy is older than RECENT_RAIL_FRESH_MS (or `force`). Unlisted cards get
 * their last-median price. Resolves to true when the stored copy changed.
 * `deps` swaps the network reads (tests).
 */
export function refreshRecentTiles({ gameId, force = false, now = Date.now(), deps = {} } = {}) {
  const resolved = resolveGameId(gameId);
  const running = tileFlights.get(resolved);
  if (running) return running;
  const fetchTiles = deps.fetchTiles || fetchCardTiles;
  const fillPrices = deps.fillPrices || fillMissingLastMedianPrices;
  const flight = (async () => {
    const ids = readRecentCardIds(resolved).slice(0, RECENT_RAIL_SHOWN);
    if (!ids.length) return false;
    const before = readRecentTiles(resolved);
    const named = new Set(before.map((tile) => String(tile.id)));
    const stale = force || now - recentRailRefreshedAt(resolved) > RECENT_RAIL_FRESH_MS;
    const wanted = stale ? ids : ids.filter((id) => !named.has(id));
    if (!wanted.length) return false;
    const tiles = await fetchTiles(wanted, { priority: 'low' }).catch(() => []);
    if (!tiles?.length) return false;
    const priced = await fillPrices(tiles).catch(() => tiles);
    const stored = new Map(before.map((tile) => [String(tile.id), tile]));
    rememberRecentTiles(priced.map((tile) => refreshTile(stored.get(String(tile.id)), tile)), resolved);
    if (stale) markRecentRailFresh(resolved, now);
    return JSON.stringify(readRecentTiles(resolved)) !== JSON.stringify(before);
  })().catch(() => false).finally(() => tileFlights.delete(resolved));
  tileFlights.set(resolved, flight);
  return flight;
}

const accountFlights = new Map();
const accountSyncedAt = new Map();

/**
 * The signed-in account's ids (other devices) into the stored list, at most
 * once a minute unless `force`. Resolves to the stored ids.
 */
export function syncRecentAccount({ gameId, force = false, sync = syncRemoteRecentCardIds } = {}) {
  const resolved = resolveGameId(gameId);
  const running = accountFlights.get(resolved);
  if (running) return running;
  if (!force && Date.now() - (accountSyncedAt.get(resolved) || 0) < ACCOUNT_FRESH_MS) {
    return Promise.resolve(readRecentCardIds(resolved));
  }
  const flight = Promise.resolve()
    .then(() => sync(resolved))
    .then((ids) => {
      accountSyncedAt.set(resolved, Date.now());
      return ids || readRecentCardIds(resolved);
    })
    .catch(() => readRecentCardIds(resolved))
    .finally(() => accountFlights.delete(resolved));
  accountFlights.set(resolved, flight);
  return flight;
}

/**
 * Background warm-up while the visitor browses: the account's ids (signed in),
 * stale or missing tiles, then the first rail thumbnails. Resolves to true
 * when the stored tiles changed.
 */
export async function warmRecentsRail({ gameId, account = false } = {}) {
  if (connectionBlocked()) return false;
  if (account) await syncRecentAccount({ gameId });
  const changed = await refreshRecentTiles({ gameId });
  warmRecentThumbs(readRecentTiles(gameId));
  return changed;
}

/** A card desk just stored its card as the newest recent: warm its rail thumb now. */
export function warmRecentCard(card, gameId) {
  if (connectionBlocked()) return;
  const id = card?.id || card?.card_id;
  warmRecentThumbs([peekRecentTile(id, gameId) || card], 1);
}

/** Tests only: forget running flights and sync times. */
export function resetRecentRailForTests() {
  tileFlights.clear();
  accountFlights.clear();
  accountSyncedAt.clear();
}
