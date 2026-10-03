'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.resolve(__dirname, 'marketplace-recommendations.js');

function loadModule(stubs = {}) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request) {
    if (request === './_marketplace_db') {
      return { marketplaceQuery: stubs.query || (async () => ({ rows: [] })) };
    }
    if (request === './_firebase') {
      return {
        getFirebaseAdmin: () => ({ firestore: () => ({ collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }) }) }),
        requestHeader: (req, name) => req.headers?.[name] || '',
        verifyBearerToken: stubs.verify || (async () => { throw new Error('no token'); }),
      };
    }
    if (request === './_marketplace_game') {
      return {
        normalizeGame: (value) => String(value || 'pokemon'),
        parseGameFromRequest: (req) => req.headers?.['x-pokoin-game'] || 'pokemon',
        runWithGame: async (_game, fn) => fn(),
      };
    }
    if (request === './_marketplace_react_card') {
      return {
        setCorsHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*'),
        toReactCard: (row) => ({ id: row.card_id, name: row.name, price: row.lowest_price_pkn, canonicalPath: row.canonical_path }),
      };
    }
    if (request === './_rate_limit') {
      return { limitBestEffort: async () => ({ allowed: true }) };
    }
    if (request === './_seller_profile_cache') {
      return { getPublicSellerProfiles: async () => new Map() };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
    delete require.cache[TARGET];
  }
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

const card = (id, over = {}) => ({
  card_id: String(id),
  name: 'Pikachu',
  set_name: 'Base Set',
  artist: 'Mitsuhiro Arita',
  pokedex_num: 25,
  version: `v${id}`,
  min_price: 100,
  hot_7d: 1,
  hot_24h: 1,
  canonical_path: `/marketplace/en/cards/${id}/x`,
  ...over,
});

function poolOf(cards) {
  return { cards, byId: new Map(cards.map((row) => [row.card_id, row])) };
}

const listing = (id, cardId, over = {}) => ({
  id,
  card_id: String(cardId),
  seller_uid: 'seller-a',
  seller_name: 'Rotation',
  seller_country: 'IT',
  condition: 'NM',
  language: 'en',
  price_pkn: 80,
  quantity_available: 2,
  ...over,
});

test('rails carry live offers, skip seen cards and label the seller parcel', async () => {
  const { _test } = loadModule();
  const pool = poolOf([
    card(1, { name: 'Medicham ex', pokedex_num: 308, artist: 'PLANETA' }),
    card(2, { name: 'Medicham', pokedex_num: 308, artist: 'Other', hot_7d: 9 }),
    card(3, { name: 'Ralts', pokedex_num: 280, artist: 'PLANETA' }),
    card(4, { name: 'Togepi', pokedex_num: 175, artist: 'Sekio', hot_24h: 40 }),
    card(5, { name: 'Pidove', pokedex_num: 519, artist: 'Sekio' }),
  ]);
  const rails = await _test.recommend({
    uid: 'u1',
    cartIds: ['1'],
    sellerUids: ['seller-a'],
    listingIds: ['cart-line'],
    recentIds: ['4'],
    watchIds: [],
    bought: [{ cardId: '5', purchasedAt: 1 }],
  }, {
    loadPool: async () => pool,
    readCards: async () => [],
    readSellerListings: async () => [listing('cart-line', 1), listing('p2', 2, { price_pkn: 30 }), listing('p3', 3)],
    readCoCarted: async () => new Map([['3', 2]]),
    readOffers: async (ids) => new Map(ids.map((id) => [id, [listing(`o${id}`, id)]])),
    sellerProfiles: async () => new Map([['seller-a', { username: 'redshakkio', displayName: 'RotationMotionTCG', acceptsPkn: true }]]),
  });
  const byId = Object.fromEntries(rails.map((rail) => [rail.id, rail]));
  assert.deepEqual(byId.buy_again.items.map((item) => item.card.id), ['5']);
  assert.equal(byId['parcel:seller-a'].title, 'More from redshakkio');
  assert.deepEqual(byId['parcel:seller-a'].items.map((item) => item.offer.id), ['p2', 'p3']);
  assert.equal(byId['parcel:seller-a'].items[0].offer.sellerUsername, 'redshakkio');
  // Cards used by an earlier rail are not repeated further down.
  assert.equal(byId.also_carted, undefined);
  assert.equal(byId.inspired, undefined);
  for (const rail of rails) {
    for (const item of rail.items) {
      assert.notEqual(item.card.id, '1', `${rail.id} must not recommend a card already in the cart`);
    }
  }
  assert.equal(byId.recent.items[0].card.id, '4');
  assert.equal(byId.recent.items[0].offer.id, 'o4');
});

test('signals merge the account with the browser, cart first', () => {
  const { _test } = loadModule();
  const url = new URL('https://api.pokoin.com/api/marketplace-recommendations?cart=9,8&recent=7&watch=6&sellers=s2&listings=L9');
  const signals = _test.signalsFrom(url, {
    cart: { items: [{ cardId: '1', sellerUid: 's1', listingId: 'L1' }], saved: [{ cardId: '2' }] },
    recent: ['3'],
    watch: ['4'],
    bought: [{ cardId: '5' }],
  }, 'u1');
  assert.deepEqual(signals.cartIds, ['9', '8', '1', '2']);
  assert.deepEqual(signals.sellerUids, ['s2', 's1']);
  assert.deepEqual(signals.listingIds, ['L9', 'L1']);
  assert.deepEqual(signals.recentIds, ['3', '7']);
  assert.deepEqual(signals.watchIds, ['6', '4']);
});

test('other storefronts get no rails yet', async () => {
  const handler = loadModule();
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/marketplace-recommendations', headers: { 'x-pokoin-game': 'one_piece' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rails, []);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('a signed-out visitor still gets trending, privately', async () => {
  const rows = [card(1, { hot_24h: 5 }), card(2, { hot_24h: 9 })];
  const handler = loadModule({
    query: async (sql) => {
      if (/with listed as/.test(sql)) return { rows };
      return { rows: [] };
    },
  });
  handler._test.resetPool();
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/marketplace-recommendations', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.signedIn, false);
  assert.equal(res.body.personalized, false);
  assert.equal(res.body.rails[0].id, 'trending');
  assert.deepEqual(res.body.rails[0].items.map((item) => item.card.id), ['2', '1']);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('only GET and OPTIONS', async () => {
  const handler = loadModule();
  const res = mockRes();
  await handler({ method: 'POST', url: '/', headers: {} }, res);
  assert.equal(res.statusCode, 405);
  const pre = mockRes();
  await handler({ method: 'OPTIONS', url: '/', headers: {} }, pre);
  assert.equal(pre.statusCode, 204);
});

test('seller emails never leave the API', async () => {
  const { _test } = loadModule();
  assert.equal(_test.publicName('redshakkio@gmail.com'), '');
  assert.equal(_test.publicName('RotationMotionTCG'), 'RotationMotionTCG');
  const offer = _test.offerJson(listing('x', 1, { seller_name: 'someone@example.com' }), null);
  assert.equal(offer.sellerName, '');
  assert.equal(offer.sellerDisplayName, '');
  const pool = poolOf([card(1, { name: 'Medicham ex', pokedex_num: 308 }), card(2, { name: 'Medicham', pokedex_num: 308 })]);
  const rails = await _test.recommend({
    uid: '', cartIds: ['1'], sellerUids: ['seller-a'], listingIds: [], recentIds: [], watchIds: [], bought: [],
  }, {
    loadPool: async () => pool,
    readCards: async () => [],
    readSellerListings: async () => [listing('p2', 2, { seller_name: 'seller@mail.example' })],
    readCoCarted: async () => new Map(),
    readOffers: async () => new Map(),
    sellerProfiles: async () => new Map(),
  });
  const parcel = rails.find((rail) => rail.kind === 'parcel');
  assert.equal(parcel.title, 'More from this seller');
  assert.equal(JSON.stringify(rails).includes('@'), false);
});

