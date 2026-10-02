import { safeAvatarUrl } from './avatar.js';
import { peekHasListingRows, peekSellerListings } from './listings-cache.js';

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
  const username = String(fromApi?.username || sample.sellerUsername || handle || '')
    .trim()
    .replace(/^@/, '');
  const displayName = String(fromApi?.displayName || sample.sellerDisplayName || sample.sellerName || username || handle)
    .trim();
  return {
    listings,
    total: Number(cached.total ?? listings.length) || 0,
    unique: Number(cached.unique ?? 0) || 0,
    seller: {
      uid: fromApi?.uid || sample.sellerUid || '',
      username,
      displayName: displayName && !displayName.includes('@') ? displayName : username,
      photoUrl: safeAvatarUrl(fromApi?.photoUrl),
    },
  };
}
