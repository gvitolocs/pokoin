'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { createFirestore } = require('./_firestore_fake');

const TARGET = path.join(__dirname, 'marketplace-listings.js');
const CACHE = path.join(__dirname, '_seller_profile_cache.js');

// Keep the real listing-to-profile-cache connection. Only external services
// are replaced, so an import/export name mismatch cannot pass this test.
async function withListings(run, { valkeyDown = false, firestoreDown = false } = {}) {
  const stored = new Map();
  const valkey = {
    getJson: async key => valkeyDown ? null : stored.get(key),
    setJson: async (key, value) => { if (!valkeyDown) stored.set(key, value); },
  };
  const { admin } = createFirestore({ users: {
    'seller-1': { displayName: 'Shakkio', username: 'shakkio', acceptsPkn: false, email: 'private@example.com' },
  } });
  const firebase = { getFirebaseAdmin: () => {
    if (firestoreDown) throw new Error('Firestore unavailable');
    return admin;
  } };
  const original = Module._load;
  delete require.cache[TARGET];
  delete require.cache[CACHE];
  Module._load = function load(request, parent, isMain) {
    if (request === './_valkey') return valkey;
    if (request === './_firebase' || request === '../server/_firebase') return firebase;
    if (request === './_marketplace_db') return {};
    if (request === './_firebase_roles') return {};
    if (request === './_seller_comment_filter') return { publicSellerComment: value => value || '' };
    if (request === './_cardtrader_seller_listings') return {};
    if (request === './cardtrader-live-listings') return { _test: { PKNRESERVE_SELLER_USERNAME: 'pknreserve' } };
    return original.call(this, request, parent, isMain);
  };
  try {
    await run({ listings: require(TARGET), stored });
  } finally {
    Module._load = original;
    delete require.cache[TARGET];
    delete require.cache[CACHE];
  }
}

const native = { id: 'listing-1', card_id: '78648', seller_uid: 'seller-1',
  seller_name: 'Pokoin', source: 'pokoin_user_listing', price_pkn: 78,
  quantity_available: 2, condition: 'SP', language: 'IT', status: 'active' };

test('real cache enrichment restores the public seller handle from cold and warm reads', async () => {
  await withListings(async ({ listings, stored }) => {
    for (let read = 0; read < 2; read += 1) {
      const rows = await listings._test.enrichListingRowsWithSellerProfiles([native]);
      const dto = listings._test.listingRow(rows[0]);
      assert.equal(dto.sellerName, 'Shakkio');
      assert.equal(dto.sellerUsername, 'shakkio');
      assert.equal(dto.sellerAcceptsPkn, false);
      assert.equal(dto.pricePkn, 78);
      assert.equal(dto.quantityAvailable, 2);
      assert.ok(!JSON.stringify(dto).includes('private@example.com'));
    }
    assert.equal(stored.get('seller:seller-1:profile').displayName, 'Shakkio');
  });
});

test('Valkey outage still resolves the seller from Firestore', async () => {
  await withListings(async ({ listings }) => {
    const rows = await listings._test.enrichListingRowsWithSellerProfiles([native]);
    assert.equal(listings._test.listingRow(rows[0]).sellerName, 'Shakkio');
  }, { valkeyDown: true });
});

test('missing profiles and Firestore outages preserve listing identity and stock', async () => {
  await withListings(async ({ listings }) => {
    const row = { ...native, seller_uid: 'missing-user', seller_name: 'Known seller' };
    const rows = await listings._test.enrichListingRowsWithSellerProfiles([row]);
    assert.equal(listings._test.listingRow(rows[0]).sellerName, 'Known seller');
  });
  await withListings(async ({ listings }) => {
    const rows = await listings._test.enrichListingRowsWithSellerProfiles([native]);
    assert.deepEqual(rows, [native]);
  }, { firestoreDown: true });
});

test('reserve listings retain their reserve identity', async () => {
  await withListings(async ({ listings, stored }) => {
    const row = { ...native, source: 'pokoin_reserve', reserve_available: true };
    const rows = await listings._test.enrichListingRowsWithSellerProfiles([row]);
    assert.equal(listings._test.listingRow(rows[0]).sellerName, 'pknreserve');
    assert.equal(stored.size, 0);
  });
});
