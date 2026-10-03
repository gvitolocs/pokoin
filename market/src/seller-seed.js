import { safeAvatarUrl } from './avatar.js';
import { peekHasListingRows, peekSellerListings } from './listings-cache.js';

const IDENTITY_STORAGE = 'pokoin-seller-identity';
const identities = new Map();

function storedIdentities() {
  if (typeof sessionStorage === 'undefined') return {};
  try {
    const data = JSON.parse(sessionStorage.getItem(IDENTITY_STORAGE) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveIdentities() {
  if (typeof sessionStorage === 'undefined') return;
  const payload = {};
  for (const [key, value] of identities) payload[key] = value;
  try {
    sessionStorage.setItem(IDENTITY_STORAGE, JSON.stringify(payload));
  } catch {
    /* private mode */
  }
}

function identityKey(handle) {
  return String(handle || '').trim().toLowerCase().replace(/^@/, '');
}

/** Name and photo already known from a personal chat, keyed by the profile handle. */
export function rememberSellerIdentity(handle, profile = {}) {
  const key = identityKey(handle);
  if (!key) return null;
  const username = String(profile.username || handle || '').trim().replace(/^@/, '') || key;
  const rawName = String(profile.displayName || '').trim();
  const displayName = rawName && !rawName.includes('@') && rawName.toLowerCase() !== username.toLowerCase()
    ? rawName
    : '';
  const photoUrl = safeAvatarUrl(profile.photoUrl);
  const uid = String(profile.uid || '').trim();
  const prev = identities.get(key) || {};
  const next = {
    uid: uid || prev.uid || '',
    username,
    displayName: displayName || prev.displayName || '',
    photoUrl: photoUrl || prev.photoUrl || '',
  };
  if (!next.uid && !next.displayName && !next.photoUrl) return null;
  identities.set(key, next);
  saveIdentities();
  return next;
}

export function peekSellerIdentity(handle) {
  const key = identityKey(handle);
  if (!key) return null;
  if (!identities.has(key)) {
    const stored = storedIdentities()[key];
    if (stored && typeof stored === 'object') identities.set(key, stored);
  }
  return identities.get(key) || null;
}

/** Header seed when the shop rows are not cached yet. */
export function sellerIdentitySeed(handle) {
  const known = peekSellerIdentity(handle);
  if (!known?.displayName && !known?.photoUrl) return null;
  return {
    uid: known.uid || '',
    username: known.username || identityKey(handle),
    displayName: known.displayName || known.username || identityKey(handle),
    photoUrl: known.photoUrl || '',
  };
}

export function resetSellerIdentityForTests() {
  identities.clear();
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.removeItem(IDENTITY_STORAGE); } catch { /* ignore */ }
  }
}

/**
 * Personal thread only. The chat already has the display name and photo;
 * start the first shop page so the profile opens on those hundred cards.
 */
export function warmSellerFromChat({
  username,
  uid = '',
  displayName = '',
  photoUrl = '',
  game = 'pokemon',
} = {}) {
  const handle = String(username || '').trim().replace(/^@/, '');
  if (!handle || handle.toLowerCase() === 'seller') return;
  rememberSellerIdentity(handle, { uid, username: handle, displayName, photoUrl });
  const opts = sellerShopSeedOpts({ game });
  if (peekSellerListings(handle, opts)) return;
  import('./api.js')
    .then(({ fetchSellerShop }) => fetchSellerShop(handle, { ...opts, sellerUid: uid }))
    .catch(() => {});
}

/** Default first-page shop key — must match fetchSellerShop defaults in Seller.jsx. */
export function sellerShopSeedOpts({ pageSize = 100, sort = 'price-asc', game = 'pokemon' } = {}) {
  return {
    limit: pageSize,
    offset: 0,
    q: '',
    condition: '',
    language: '',
    sort,
    game,
  };
}

/**
 * First paint seed for the seller shop.
 * Only reuse a full handle-matched shop cache (same key as fetchSellerShop).
 * Never seed from a single navigated `location.state.listing` stub.
 */
export function seedSellerListings(handle, { pageSize = 100, sort = 'price-asc', game = 'pokemon' } = {}) {
  const cached = peekSellerListings(handle, sellerShopSeedOpts({ pageSize, sort, game }));
  if (!peekHasListingRows(cached)) {
    return null;
  }
  const listings = cached.listings;
  const fromApi = cached.seller && typeof cached.seller === 'object' ? cached.seller : null;
  const sample = listings[0] || {};
  const known = peekSellerIdentity(handle);
  const username = String(fromApi?.username || sample.sellerUsername || known?.username || handle || '')
    .trim()
    .replace(/^@/, '');
  const rawName = String(fromApi?.displayName || sample.sellerDisplayName || sample.sellerName || '')
    .trim();
  const apiName = rawName && !rawName.includes('@') && rawName.toLowerCase() !== username.toLowerCase()
    ? rawName
    : '';
  return {
    listings,
    total: Number(cached.total ?? listings.length) || 0,
    unique: Number(cached.unique ?? 0) || 0,
    seller: {
      uid: fromApi?.uid || sample.sellerUid || known?.uid || '',
      username,
      displayName: apiName || known?.displayName || username,
      photoUrl: safeAvatarUrl(fromApi?.photoUrl) || known?.photoUrl || '',
    },
  };
}
