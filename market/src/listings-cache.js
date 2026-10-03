/** In-memory native listings cache. Empty `[]` is still a hit — callers that
 * need a live shop after POST must `invalidate` + `fresh` fetch.
 *
 * Seller first-page keys (`handle::l100::…`) also mirror into sessionStorage so
 * a hard reload / chat → profile navigation can seed without waiting on SQL.
 * Pi Redis also caches unfiltered seller-shop browse pages; this module is
 * the browser L1 (memory + sessionStorage) in front of that API cache. */

const listingsCache = new Map();
const listingsInflight = new Map();
const listingsEpoch = new Map();
const sellerListingsCache = new Map();

const SELLER_SHOP_STORAGE = 'pokoin.seller.shop.v1';
const SELLER_SHOP_STORAGE_MAX = 6;

function rememberMap(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

function isSellerShopPageKey(key) {
  return String(key || '').includes('::');
}

function readSellerShopStorage() {
  if (typeof sessionStorage === 'undefined') return {};
  try {
    const data = JSON.parse(sessionStorage.getItem(SELLER_SHOP_STORAGE) || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeSellerShopStorage(bag) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(SELLER_SHOP_STORAGE, JSON.stringify(bag));
  } catch {
    /* private mode / quota */
  }
}

function persistSellerShopPage(key, data) {
  if (!isSellerShopPageKey(key) || !Array.isArray(data?.listings) || !data.listings.length) {
    return;
  }
  const bag = readSellerShopStorage();
  delete bag[key];
  bag[key] = data;
  const keys = Object.keys(bag);
  while (keys.length > SELLER_SHOP_STORAGE_MAX) {
    delete bag[keys.shift()];
  }
  writeSellerShopStorage(bag);
}

function restoreSellerShopPage(key) {
  if (!isSellerShopPageKey(key)) return null;
  const row = readSellerShopStorage()[key];
  return row && Array.isArray(row.listings) && row.listings.length ? row : null;
}

export function sellerCacheKey(username, opts = {}) {
  const handle = String(username || '').trim().toLowerCase();
  if (!handle) return '';
  const limit = Number(opts.limit);
  const offset = Number(opts.offset) || 0;
  const q = String(opts.q || opts.query || '').trim().toLowerCase();
  const condition = String(opts.condition || '').trim().toLowerCase();
  const language = String(opts.language || '').trim().toLowerCase();
  const sort = String(opts.sort || '').trim().toLowerCase();
  const game = String(opts.game || '').trim().toLowerCase();
  const rarity = String(opts.rarity || '').trim().toLowerCase();
  const reverse = opts.reverse === true || opts.reverse === 1 || opts.reverse === '1' ? '1' : '';
  const firstEdition = opts.firstEdition === true || opts.firstEdition === 1 || opts.firstEdition === '1' ? '1' : '';
  // Bare username key remains valid for legacy fetchSellerByUsername callers.
  if (
    !Number.isFinite(limit) &&
    !offset &&
    !q &&
    !condition &&
    !language &&
    !sort &&
    !game &&
    !rarity &&
    !reverse &&
    !firstEdition
  ) {
    return handle;
  }
  return [
    handle,
    Number.isFinite(limit) ? `l${limit}` : 'l',
    `o${offset}`,
    `q${q}`,
    `c${condition}`,
    `lang${language}`,
    `s${sort}`,
    `g${game}`,
    `r${rarity}`,
    `rev${reverse}`,
    `fe${firstEdition}`,
  ].join('::');
}

export function peekSellerListings(username, opts) {
  const key = sellerCacheKey(username, opts);
  if (!key) return null;
  const hit = sellerListingsCache.get(key);
  if (hit) return hit;
  const stored = restoreSellerShopPage(key);
  if (!stored) return null;
  rememberMap(sellerListingsCache, key, stored, 48);
  return stored;
}

export function rememberSellerListings(username, data, opts) {
  const key = sellerCacheKey(username, opts);
  if (!key) {
    return data;
  }
  rememberMap(sellerListingsCache, key, data, 48);
  persistSellerShopPage(key, data);
  return data;
}

export function peekListings(cardId) {
  return listingsCache.get(String(cardId || '')) || null;
}

export function peekHasListingRows(listed) {
  return Array.isArray(listed?.listings) && listed.listings.length > 0;
}

export function invalidateListings(cardId) {
  const id = String(cardId || '');
  listingsCache.delete(id);
  listingsInflight.delete(id);
  listingsEpoch.set(id, (listingsEpoch.get(id) || 0) + 1);
}

export function listingsFetchEpoch(cardId) {
  return listingsEpoch.get(String(cardId || '')) || 0;
}

export function listingsInflightFor(cardId) {
  return listingsInflight.get(String(cardId || '')) || null;
}

export function setListingsInflight(cardId, pending) {
  listingsInflight.set(String(cardId || ''), pending);
}

export function clearListingsInflight(cardId) {
  listingsInflight.delete(String(cardId || ''));
}

export function rememberListings(cardId, data, epochAtStart) {
  const id = String(cardId || '');
  if ((listingsEpoch.get(id) || 0) !== epochAtStart) {
    return listingsCache.get(id) || data;
  }
  rememberMap(listingsCache, id, data, 24);
  return data;
}

export function mergeListingRows(rows, created) {
  if (!created) {
    return [...(rows || [])];
  }
  const next = rows || [];
  if (created.remove) {
    const drop = String(created.id || '');
    return next.filter((row) => String(row.id) !== drop);
  }
  const replaceId = created.replaceId ? String(created.replaceId) : '';
  if (created.id) {
    return [created, ...next.filter((row) => {
      const id = String(row.id);
      return id !== String(created.id) && id !== replaceId;
    })];
  }
  return [created, ...next];
}

export function mergeCreatedListing(payload, created) {
  if (!payload) {
    return payload;
  }
  return { ...payload, offers: mergeListingRows(payload.offers, created) };
}

export function rememberCreatedListing(cardId, created) {
  if (!created) {
    return;
  }
  const id = String(cardId || '');
  const current = listingsCache.get(id);
  rememberMap(listingsCache, id, {
    ...(current || {}),
    listings: mergeListingRows(current?.listings, created),
  }, 24);
}

export function dropListing(cardId, listingId) {
  const id = String(cardId || '');
  const drop = String(listingId || '');
  const current = listingsCache.get(id);
  if (!current || !drop) {
    return;
  }
  rememberMap(listingsCache, id, {
    ...current,
    listings: (current.listings || []).filter((row) => String(row.id) !== drop),
  }, 24);
}

export function omitListings(payload, listingIds) {
  if (!payload) {
    return payload;
  }
  const drop = new Set((listingIds || []).map((id) => String(id)));
  return {
    ...payload,
    offers: (payload.offers || []).filter((row) => !drop.has(String(row.id))),
  };
}

/** Drop the in-memory seller Map only — sessionStorage stays (reload within tab). */
export function clearSellerListingsMemoryForTests() {
  sellerListingsCache.clear();
}

export function resetListingsCacheForTests() {
  listingsCache.clear();
  listingsInflight.clear();
  listingsEpoch.clear();
  sellerListingsCache.clear();
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.removeItem(SELLER_SHOP_STORAGE); } catch { /* ignore */ }
  }
}
