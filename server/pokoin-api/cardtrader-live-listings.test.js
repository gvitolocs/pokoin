'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.join(__dirname, 'cardtrader-live-listings.js');

/** Load the handler with the Pi-only helpers stubbed for one game. */
function loadFor(game) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') return { marketplaceQuery: async () => ({ rows: [] }) };
    if (request === './_marketplace_game') return { currentGame: () => game, normalizeGame: (g) => g };
    if (request === './_seller_comment_filter') return { publicSellerComment: () => '', sellerCommentFields: () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
  }
}

test('non-Pokemon cards resolve their CardTrader blueprint from the catalog ct_id', async () => {
  const live = loadFor('one_piece');
  const calls = [];
  const mapping = await live.resolveCardTraderBlueprintId({ cardId: '710802' }, async (sql, values) => {
    calls.push(sql);
    return { rows: [{ pokoin_card_id: '710802', cardtrader_blueprint_id: '355401' }] };
  });
  assert.equal(mapping.cardtraderBlueprintId, '355401');
  assert.equal(mapping.mappingSource, 'one_piece_catalog_ct_id');
  assert.match(calls[0], /ct_id/);
  assert.doesNotMatch(calls[0], /cardtrader_pokemon_blueprints/);
});

test('Pokemon resolves through ct_id too (card_id is 2 × blueprint)', async () => {
  const live = loadFor('pokemon');
  const calls = [];
  const mapping = await live.resolveCardTraderBlueprintId({ cardId: '633380' }, async (sql) => {
    calls.push(sql);
    return { rows: [{ pokoin_card_id: '633380', cardtrader_blueprint_id: '316690' }] };
  });
  assert.equal(mapping.cardtraderBlueprintId, '316690');
  assert.match(calls[0], /ct_id/);
});

test('a card without ct_id falls back to the legacy blueprint lookup', async () => {
  const live = loadFor('pokemon');
  const calls = [];
  await live.resolveCardTraderBlueprintId({ cardId: '75481' }, async (sql) => {
    calls.push(sql);
    return { rows: calls.length === 1 ? [] : [{ pokoin_card_id: '75481', cardtrader_blueprint_id: '75481' }] };
  });
  assert.match(calls[1], /cardtrader_pokemon_blueprints/);
});

test('game-specific CardTrader language keys are read', () => {
  const live = loadFor('one_piece');
  assert.equal(live.gameLanguageProperty({ condition: 'Near Mint', onepiece_language: 'jp' }), 'jp');
  assert.equal(live.gameLanguageProperty({ condition: 'Near Mint' }), '');
});

test('an explicit request game wins over the Pokemon request context', async () => {
  const live = loadFor('pokemon');
  const calls = [];
  const mapping = await live.resolveCardTraderBlueprintId({ cardId: '710802', game: 'one_piece' }, async (sql) => {
    calls.push(sql);
    return { rows: [{ pokoin_card_id: '710802', cardtrader_blueprint_id: '355401' }] };
  });
  assert.equal(mapping.cardtraderBlueprintId, '355401');
  assert.match(calls[0], /ct_id/);
});

// --- Shared L2 cache (Redis pokoin:marketplace:v1:ct:live:*) ---

function liveRequest() {
  return { blueprintId: '355401', limit: 20 };
}

function fakeSharedCache({ down = false } = {}) {
  const fake = { sets: [], store: new Map(), down };
  fake.getJson = async (key) => {
    if (fake.down) return null;
    return fake.store.has(key) ? fake.store.get(key) : null;
  };
  fake.setJson = async (key, value, ttlSeconds) => {
    if (fake.down) return false;
    fake.sets.push({ key, value, ttlSeconds });
    fake.store.set(key, value);
    return true;
  };
  return fake;
}

test('the first live-listings read fetches CardTrader and shares the payload with the 60s TTL', async () => {
  const live = loadFor('pokemon');
  const fetchCalls = [];
  const shared = fakeSharedCache();
  const payload = await live.readLiveCardTraderListings(liveRequest(), {
    env: { CARDTRADER_AUTH_TOKEN: 'test-token' },
    fetchProducts: async () => { fetchCalls.push(1); return []; },
    query: async () => ({ rows: [] }),
    sharedCache: () => shared,
    now: () => 1_000_000,
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(payload.cache.ttlSeconds, 60, 'L2 TTL must match the payload TTL');
  assert.equal(shared.sets.length, 1);
  assert.match(shared.sets[0].key, /^pokoin:marketplace:v1:ct:live:cardtrader:355401:/);
  assert.equal(shared.sets[0].ttlSeconds, 60);
  assert.equal(shared.sets[0].value.payload.ok, true);
  assert.equal(shared.sets[0].value.expiresAtMs, 1_060_000);
});

test('a second simulated instance reuses the shared payload without a second CardTrader call', async () => {
  const live = loadFor('pokemon');
  const fetchCalls = [];
  const shared = fakeSharedCache();
  const options = () => ({
    env: { CARDTRADER_AUTH_TOKEN: 'test-token' },
    fetchProducts: async () => { fetchCalls.push(1); return []; },
    query: async () => ({ rows: [] }),
    sharedCache: () => shared,
    now: () => 1_000_000,
  });
  await live.readLiveCardTraderListings(liveRequest(), options());
  live._test.clearLiveListingsCache(); // simulate a different API process (empty L1)
  const second = await live.readLiveCardTraderListings(liveRequest(), options());
  assert.equal(fetchCalls.length, 1, 'the shared L2 hit must prevent a second CardTrader call');
  assert.equal(second.cache.hit, true);
  assert.equal(second.ok, true);
});

test('an in-process L1 hit does not touch the shared cache and keeps one TTL regime', async () => {
  const live = loadFor('pokemon');
  const fetchCalls = [];
  const shared = fakeSharedCache();
  const options = () => ({
    env: { CARDTRADER_AUTH_TOKEN: 'test-token' },
    fetchProducts: async () => { fetchCalls.push(1); return []; },
    query: async () => ({ rows: [] }),
    sharedCache: () => shared,
    now: () => 1_000_000,
  });
  await live.readLiveCardTraderListings(liveRequest(), options());
  const setsAfterFirst = shared.sets.length;
  const l1Hit = await live.readLiveCardTraderListings(liveRequest(), options());
  assert.equal(fetchCalls.length, 1);
  assert.equal(shared.sets.length, setsAfterFirst, 'L1 hit must not rewrite the shared key');
  assert.equal(l1Hit.cache.hit, true);
});

test('redis down: every instance falls back to CardTrader without failing', async () => {
  const live = loadFor('pokemon');
  const fetchCalls = [];
  const shared = fakeSharedCache({ down: true });
  const options = () => ({
    env: { CARDTRADER_AUTH_TOKEN: 'test-token' },
    fetchProducts: async () => { fetchCalls.push(1); return []; },
    query: async () => ({ rows: [] }),
    sharedCache: () => shared,
    now: () => 1_000_000,
  });
  await live.readLiveCardTraderListings(liveRequest(), options());
  live._test.clearLiveListingsCache();
  const second = await live.readLiveCardTraderListings(liveRequest(), options());
  assert.equal(fetchCalls.length, 2, 'with the shared cache down both instances fetch for themselves');
  assert.equal(second.cache.hit, false);
  assert.equal(second.ok, true);
});
