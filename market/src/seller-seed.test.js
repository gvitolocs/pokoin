import assert from 'node:assert/strict';
import test from 'node:test';
import './session-storage-test-polyfill.js';
import {
  clearSellerListingsMemoryForTests,
  peekSellerListings,
  rememberSellerListings,
  resetListingsCacheForTests,
} from './listings-cache.js';
import {
  rememberSellerIdentity,
  resetSellerIdentityForTests,
  seedSellerListings,
  sellerIdentitySeed,
  sellerShopSeedOpts,
} from './seller-seed.js';

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
    seller: {
      uid: 'u1',
      username: handle,
      displayName: 'Simone Di Blasi',
      photoUrl: 'https://pub-example.r2.dev/profile-pictures/u1/a.jpg',
    },
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
  assert.equal(seeded.seller.photoUrl, 'https://pub-example.r2.dev/profile-pictures/u1/a.jpg');
  assert.equal(peekSellerListings(handle, opts).total, 9153);
});

test('chat identity paints the display name before the shop response', () => {
  resetListingsCacheForTests();
  resetSellerIdentityForTests();
  const handle = 'redshakkio';
  assert.equal(sellerIdentitySeed(handle), null);
  rememberSellerIdentity(handle, {
    uid: 'uid-rotation',
    username: handle,
    displayName: 'RotationMotionTCG',
    photoUrl: 'https://cdn.pokoin.com/profile-pictures/uid-rotation/a.jpg',
  });
  const header = sellerIdentitySeed(handle);
  assert.equal(header.displayName, 'RotationMotionTCG');
  assert.equal(header.username, handle);
  assert.equal(header.photoUrl, 'https://cdn.pokoin.com/profile-pictures/uid-rotation/a.jpg');
  assert.equal(seedSellerListings(handle), null);

  rememberSellerListings(handle, {
    seller: { uid: 'uid-rotation', username: handle, displayName: handle, photoUrl: '' },
    listings: [{ id: '1', sellerUsername: handle, sellerDisplayName: handle }],
    total: 100,
    unique: 80,
  }, sellerShopSeedOpts());
  const seeded = seedSellerListings(handle);
  assert.equal(seeded.listings.length, 1);
  assert.equal(seeded.seller.displayName, 'RotationMotionTCG');
  assert.equal(seeded.seller.photoUrl, 'https://cdn.pokoin.com/profile-pictures/uid-rotation/a.jpg');
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

test('seller shop first page survives a memory clear via sessionStorage', () => {
  resetListingsCacheForTests();
  const handle = 'redshakkio';
  const opts = sellerShopSeedOpts({ game: 'pokemon' });
  rememberSellerListings(handle, {
    seller: { uid: 'u1', username: handle, displayName: 'RotationMotionTCG', photoUrl: '' },
    listings: [{ id: '1', sellerUsername: handle }],
    total: 9611,
    unique: 6134,
  }, opts);
  clearSellerListingsMemoryForTests();
  const seeded = seedSellerListings(handle, { game: 'pokemon' });
  assert.equal(seeded.total, 9611);
  assert.equal(seeded.unique, 6134);
  assert.equal(seeded.seller.displayName, 'RotationMotionTCG');
  assert.equal(peekSellerListings(handle, opts).total, 9611);
});
