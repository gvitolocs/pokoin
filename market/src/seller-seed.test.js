import assert from 'node:assert/strict';
import test from 'node:test';
import {
  peekSellerListings,
  rememberSellerListings,
  resetListingsCacheForTests,
} from './listings-cache.js';
import { seedSellerListings, sellerShopSeedOpts } from './seller-seed.js';

test('seed uses full shop cache key, never a one-row location stub', () => {
  resetListingsCacheForTests();
  const handle = 'redshakkio';
  const opts = sellerShopSeedOpts({ pageSize: 100, sort: 'price-asc', game: 'pokemon' });

  // No cache → null (would previously paint location.state.listing)
  assert.equal(seedSellerListings(handle, { pageSize: 100, sort: 'price-asc' }), null);

  // Legacy bare-username cache must not seed the paginated shop
  rememberSellerListings(handle, {
    listings: [{ id: 'stub', sellerName: 'Simone Di Blasi', sellerUsername: handle }],
    total: 1,
    unique: 1,
  });
  assert.equal(seedSellerListings(handle, { pageSize: 100, sort: 'price-asc' }), null);

  // Full first-page shop cache is allowed
  const shop = {
    seller: { uid: 'u1', username: handle, displayName: 'Simone Di Blasi' },
    listings: Array.from({ length: 3 }, (_, i) => ({ id: String(i), sellerUsername: handle })),
    total: 9153,
    unique: 5981,
  };
  rememberSellerListings(handle, shop, opts);
  const seeded = seedSellerListings(handle, { pageSize: 100, sort: 'price-asc' });
  assert.equal(seeded.total, 9153);
  assert.equal(seeded.unique, 5981);
  assert.equal(seeded.listings.length, 3);
  assert.equal(seeded.seller.displayName, 'Simone Di Blasi');
  assert.equal(seeded.seller.username, handle);
  assert.equal(peekSellerListings(handle, opts).total, 9153);
});

test('seed never crosses from another game cache', () => {
  resetListingsCacheForTests();
  const handle = 'redshakkio';
  rememberSellerListings(handle, {
    listings: [{ id: 'pokemon' }],
    total: 1,
    unique: 1,
  }, sellerShopSeedOpts({ game: 'pokemon' }));
  assert.equal(seedSellerListings(handle, { game: 'sorcery' }), null);
});
