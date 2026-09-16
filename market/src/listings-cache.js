/** In-memory native listings cache. Empty `[]` is still a hit — callers that
 * need a live shop after POST must `invalidate` + `fresh` fetch. */

const listingsCache = new Map();
const listingsInflight = new Map();
const listingsEpoch = new Map();
const sellerListingsCache = new Map();

function rememberMap(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

export function sellerCacheKey(username) {
  return String(username || '').trim().toLowerCase();
}

export function peekSellerListings(username) {
  return sellerListingsCache.get(sellerCacheKey(username)) || null;
}

export function rememberSellerListings(username, data) {
  const key = sellerCacheKey(username);
  if (!key) {
    return data;
  }
  rememberMap(sellerListingsCache, key, data, 24);
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
  if (created.id) {
    return [created, ...next.filter((row) => String(row.id) !== String(created.id))];
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

export function resetListingsCacheForTests() {
  listingsCache.clear();
  listingsInflight.clear();
  listingsEpoch.clear();
  sellerListingsCache.clear();
}
