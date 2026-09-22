import { peekHasListingRows, peekSellerListings } from './listings-cache.js';

/** Default first-page shop key — must match fetchSellerShop defaults in Seller.jsx. */
export function sellerShopSeedOpts({ pageSize = 100, sort = 'price-asc' } = {}) {
  return {
    limit: pageSize,
    offset: 0,
    q: '',
    condition: '',
    language: '',
    sort,
  };
}

/**
 * First paint seed for the seller shop.
 * Only reuse a full handle-matched shop cache (same key as fetchSellerShop).
 * Never seed from a single navigated `location.state.listing` stub.
 */
export function seedSellerListings(handle, { pageSize = 100, sort = 'price-asc' } = {}) {
  const cached = peekSellerListings(handle, sellerShopSeedOpts({ pageSize, sort }));
  if (!peekHasListingRows(cached)) {
    return null;
  }
  const listings = cached.listings;
  return {
    listings,
    total: Number(cached.total ?? listings.length) || 0,
    unique: Number(cached.unique ?? 0) || 0,
  };
}
