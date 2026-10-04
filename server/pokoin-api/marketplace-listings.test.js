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
async function withListings(run, { redisDown = false, firestoreDown = false } = {}) {
  const stored = new Map();
  const redisCache = {
    getJson: async key => redisDown ? null : stored.get(key),
    setJson: async (key, value) => { if (!redisDown) stored.set(key, value); },
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
    if (request === './_redis_cache') return redisCache;
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
    assert.equal(stored.get('pokoin:seller:v1:seller-1:profile').displayName, 'Shakkio');
  });
});

test('Redis outage still resolves the seller from Firestore', async () => {
  await withListings(async ({ listings }) => {
    const rows = await listings._test.enrichListingRowsWithSellerProfiles([native]);
    assert.equal(listings._test.listingRow(rows[0]).sellerName, 'Shakkio');
  }, { redisDown: true });
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

test('card-desk read by cardId keeps mistagged satellite natives (no CT live)', async () => {
  const mistagged = {
    id: '6257a7dc-a82e-4756-8963-f5414933a95b',
    card_id: '801170',
    seller_uid: 'seller-1',
    seller_name: 'RotationMotionTCG',
    marketplace_game: 'pokemon',
    source: 'cardtrader_seller_import',
    price_pkn: 20,
    quantity_available: 1,
    condition: 'NM',
    language: 'EN',
    status: 'active',
    foil_state: 'standard',
    card_name: 'Sanction',
    set_name: 'Vendetta',
    collector_number: '035',
  };
  const queries = [];
  const original = Module._load;
  delete require.cache[TARGET];
  delete require.cache[CACHE];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return {
        marketplaceQuery: async (sql, values) => {
          queries.push({ sql, values });
          if (/marketplace_user_listings/i.test(sql)) {
            return { rows: [mistagged] };
          }
          return { rows: [] };
        },
        marketplaceWriteQuery: async () => ({ rows: [] }),
      };
    }
    if (request === './_firebase' || request === '../server/_firebase') {
      return { getFirebaseAdmin: () => createFirestore({ users: {} }).admin, verifyBearerToken: async () => null };
    }
    if (request === './_firebase_roles') return {};
    if (request === './_seller_comment_filter') return { publicSellerComment: (value) => value || '' };
    if (request === './_cardtrader_seller_listings') return {};
    if (request === './cardtrader-live-listings') {
      return {
        readLiveCardTraderListings: async () => {
          throw new Error('CT live must not run for nativeOnly card desk');
        },
        _test: { PKNRESERVE_SELLER_USERNAME: 'pknreserve' },
      };
    }
    if (request === './_marketplace_game') {
      return {
        normalizeGame: (value) => String(value || 'pokemon').toLowerCase(),
        parseGameFromRequest: () => 'riftbound',
        runWithGame: async (_game, fn) => fn(),
      };
    }
    if (request === './_redis_cache') {
      return { getJson: async () => null, setJson: async () => {} };
    }
    if (request === './_seller_profile_cache') {
      return {
        getPublicSellerProfiles: async () => new Map(),
        readSellerUidByName: async () => null,
        rememberSellerUidByName: async () => {},
      };
    }
    if (request === './_marketplace_cache_invalidate') {
      return { invalidateMarketplaceReads: async () => {} };
    }
    if (request === './_request_timing') {
      return {
        beginRequest: () => ({}),
        finishRequest: () => {},
        timed: async (_name, fn) => fn(),
      };
    }
    if (request === './_outbox') return { commitListingWrite: async () => ({}) };
    if (request === './_sync_engine') return { kickSync: () => {}, start: () => {} };
    if (request === './_listing_inventory') {
      return { DECREMENT_SQL: '', decrementHttpStatus: () => 200 };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const listings = require(TARGET);
    const url = new URL('https://pokoin.com/api/marketplace-listings?cardId=801170&nativeOnly=1&game=riftbound');
    const rows = await listings.readListings(url, null, { marketplaceGame: 'riftbound' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cardId, '801170');
    assert.equal(rows[0].pricePkn, 20);
    const listingSql = queries.find((q) => /marketplace_user_listings/i.test(q.sql));
    assert.ok(listingSql, 'expected listings query');
    assert.match(listingSql.sql, /card_id = \$1/);
    assert.doesNotMatch(listingSql.sql, /marketplace_game/);
    assert.deepEqual(listingSql.values.slice(0, 2), ['801170', 500]);
  } finally {
    Module._load = original;
    delete require.cache[TARGET];
    delete require.cache[CACHE];
  }
});
