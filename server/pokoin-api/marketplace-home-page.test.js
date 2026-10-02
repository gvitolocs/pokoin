'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.join(__dirname, 'marketplace-home-page.js');

/** In-memory Valkey double that records every setJson TTL. */
function fakeValkey() {
  const fake = { store: new Map(), sets: [] };
  fake.getJson = async (key) => (fake.store.has(key) ? fake.store.get(key) : null);
  fake.setJson = async (key, value, ttlSeconds) => {
    fake.sets.push({ key, value, ttlSeconds });
    fake.store.set(key, value);
    return true;
  };
  return fake;
}

/**
 * Load the handler with the Pi-only helpers stubbed. `Module._load` stays
 * patched for the duration of `run(webhook)` because the rails module is
 * lazily required inside defaultLoadHomeSnapshot. `_marketplace_game` is
 * stubbed with the same key-prefix contract as the real module (deploy-time
 * tests run without node_modules, so tests never require real deps).
 */
async function withHomeHandler(run, { railsCardCount = 0, game = 'pokemon' } = {}) {
  const valkey = fakeValkey();
  const calls = { newest: 0, hot: 0, readRails: 0 };
  let currentGame = game;
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_valkey') return valkey;
    if (request === './_marketplace_game') {
      return {
        parseGameFromRequest: () => currentGame,
        isPokemonGame: (value) => (value ?? currentGame) === 'pokemon',
        valkeyKey: (base) => (currentGame === 'pokemon' ? String(base || '') : `game:${currentGame}:${base}`),
        runWithGame: (nextGame, fn) => {
          const previous = currentGame;
          currentGame = nextGame;
          return Promise.resolve().then(fn).finally(() => { currentGame = previous; });
        },
      };
    }
    if (request === './_marketplace_react_card') {
      return {
        toReactCards: (rows) => (rows || []).map((row) => ({ id: String(row.card_id) })),
        parseLimit: (value, fallback) => fallback,
        setCorsHeaders() {},
        jsonOk(res, body) { res.body = body; },
        withTimeout: (fn, _ms, fallback) => Promise.resolve().then(fn).catch(() => fallback),
      };
    }
    if (request === './_marketplace_home_recent') {
      return { mergeRecentIntoHome: (snapshot) => snapshot, recentIdsFromUrl: () => [] };
    }
    if (request === './_marketplace_react_sql') {
      return {
        readNewestEnglishCards: async () => { calls.newest += 1; return []; },
        readHotCards: async () => { calls.hot += 1; return []; },
        readCanonicalPaths: async () => new Map(),
        readCheapestMap: async () => ({ byCardId: new Map(), byBlueprint: new Map() }),
        applyCanonicalAndCheapest: (rows) => rows,
        readCandidatesByCardIds: async () => [],
      };
    }
    if (request === './_public_error') {
      return { publicErrorBody: () => ({ error: 'failed' }), publicErrorStatus: () => 500 };
    }
    if (request === './_marketplace_rails') {
      return {
        readRails: async () => { calls.readRails += 1; return railsCardCount > 0 ? [{ rail: true }] : []; },
        assembleHomeVector: () => ({
          cards: Array.from({ length: railsCardCount }, (_, index) => ({ id: `rail-${index}` })),
          fromRails: true,
        }),
        HOME_RAILS: [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const handler = require(TARGET);
    await run({ handler, valkey, calls });
  } finally {
    Module._load = originalLoad;
    delete require.cache[TARGET];
  }
}

test('a cached non-empty snapshot is served without touching SQL or rails', async () => {
  await withHomeHandler(async ({ handler, valkey, calls }) => {
    valkey.store.set('home:react', { cards: [{ id: '1' }], sections: {} });
    const snapshot = await handler._test.defaultLoadHomeSnapshot({ limit: 36 });
    assert.deepEqual(snapshot.cards, [{ id: '1' }]);
    assert.equal(calls.newest, 0);
    assert.equal(calls.readRails, 0);
  });
});

test('a cached EMPTY snapshot is a valid hit (no SQL fallback per request)', async () => {
  await withHomeHandler(async ({ handler, valkey, calls }) => {
    valkey.store.set('home:react', { cards: [], sections: {} });
    const snapshot = await handler._test.defaultLoadHomeSnapshot({ limit: 36 });
    assert.deepEqual(snapshot.cards, []);
    assert.equal(calls.newest, 0, 'empty snapshot must not re-run the SQL fallback');
    assert.equal(calls.readRails, 0);
  });
});

test('a malformed cache payload is treated as a miss and recomputed', async () => {
  await withHomeHandler(async ({ handler, valkey, calls }) => {
    valkey.store.set('home:react', 'garbage');
    const snapshot = await handler._test.defaultLoadHomeSnapshot({ limit: 36 });
    assert.equal(Array.isArray(snapshot.cards), true);
    assert.equal(calls.newest, 1, 'malformed value must fall through to SQL');
  });
});

test('a pokemon miss falls through empty rails to SQL and writes one snapshot with the normalized 20s TTL', async () => {
  await withHomeHandler(async ({ handler, valkey, calls }) => {
    const snapshot = await handler._test.defaultLoadHomeSnapshot({ limit: 36 });
    assert.equal(calls.readRails, 1);
    assert.equal(snapshot.fromRails, undefined, 'an empty rails vector falls through to SQL');
    assert.equal(calls.newest > 0, true);
    const writes = valkey.sets.filter((set) => set.key === 'home:react');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ttlSeconds, 20, 'every game writes the same 20s TTL');
  });
});

test('an accepted rails vector is cached with the same 20s TTL', async () => {
  await withHomeHandler(async ({ handler, valkey, calls }) => {
    const snapshot = await handler._test.defaultLoadHomeSnapshot({ limit: 36 });
    assert.equal(snapshot.fromRails, true);
    assert.equal(calls.newest, 0, 'accepted rails vector skips the SQL fallback');
    const writes = valkey.sets.filter((set) => set.key === 'home:react');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ttlSeconds, 20);
  }, { railsCardCount: 3 });
});

test('satellite games skip rails and write the same 20s TTL on the game-scoped key (no 60s branch)', async () => {
  await withHomeHandler(async ({ handler, valkey, calls }) => {
    const snapshot = await handler._test.defaultLoadHomeSnapshot({ limit: 36 });
    assert.equal(Array.isArray(snapshot.cards), true);
    assert.equal(calls.readRails, 0, 'satellite games skip the pokemon rails');
    const writes = valkey.sets.filter((set) => set.key === 'game:magic:home:react');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ttlSeconds, 20);
  }, { game: 'magic' });
});

test('an empty SQL result is cached so a catalog hiccup does not become one uncached query per request', async () => {
  await withHomeHandler(async ({ handler, valkey }) => {
    const snapshot = await handler._test.defaultLoadHomeSnapshot({ limit: 36 });
    assert.deepEqual(snapshot.cards, []);
    const writes = valkey.sets.filter((set) => set.key === 'home:react');
    assert.equal(writes.length, 1, 'empty snapshot must still be written');
    assert.equal(writes[0].value.cards.length, 0);
    assert.equal(writes[0].ttlSeconds, 20);
  });
});
