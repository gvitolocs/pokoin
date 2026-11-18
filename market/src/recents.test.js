import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECENT_KEY,
  RECENT_MAX,
  RECENT_TILES_KEY,
  clearLegacyUnscopedRecents,
  clearRecentTileMemory,
  forgetLocalCardId,
  peekRecentTile,
  readRecentCardIds,
  readRecentTiles,
  recentIdsKey,
  recentTilesKey,
  rememberLocalCardId,
  replaceLocalRecentIds,
  writeLocalIds,
} from './recents-storage.js';

function memoryStorage(start = {}, { failWrites } = {}) {
  const data = { ...start };
  let remainingFails = failWrites || 0;
  return {
    get length() {
      return Object.keys(data).length;
    },
    key(index) {
      return Object.keys(data)[index] || null;
    },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      if (remainingFails > 0) {
        remainingFails -= 1;
        const error = new Error("Failed to execute 'setItem' on 'Storage': quota");
        error.name = 'QuotaExceededError';
        throw error;
      }
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

test('quota on recents drops desk caches and still saves ids and compact tiles', () => {
  clearRecentTileMemory();
  const local = memoryStorage({
    [recentTilesKey('pokemon')]: '{"504094":{"id":"504094","name":"Victini","gridImageUrl":"x"}}',
    'pokoin.cardPage.v1.en:1': '{"card":{"id":"1"}}',
    'pokoin.cardSales.v12.1': '{"series":[]}',
  }, { failWrites: 1 });
  globalThis.localStorage = local;
  globalThis.sessionStorage = memoryStorage();
  rememberLocalCardId('504094', 'pokemon');
  assert.deepEqual(readRecentCardIds('pokemon'), ['504094']);
  assert.equal(JSON.parse(local.getItem(recentTilesKey('pokemon')) || '{}')['504094'].name, 'Victini');
  assert.equal(local.getItem('pokoin.cardPage.v1.en:1'), null);
});

test('legacy unscoped tile dump does not seed any game history', () => {
  clearRecentTileMemory();
  const local = memoryStorage({
    [RECENT_TILES_KEY]: JSON.stringify({
      504094: { id: '504094', name: 'Victini', gridImageUrl: 'x' },
      790994: { id: '790994', name: 'Charizard', gridImageUrl: 'y' },
    }),
    [RECENT_KEY]: JSON.stringify(['504094', '790994']),
  });
  globalThis.localStorage = local;
  globalThis.sessionStorage = memoryStorage();
  assert.deepEqual(readRecentCardIds('pokemon'), []);
  assert.deepEqual(readRecentCardIds('riftbound'), []);
  assert.deepEqual(readRecentTiles('pokemon'), []);
});

test('compact tiles persist in localStorage for the next visit', () => {
  clearRecentTileMemory();
  const local = memoryStorage();
  const session = memoryStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  rememberLocalCardId({
    id: '504094',
    name: 'Victini',
    set: 'BW Promos',
    number: 'BW-P 234',
    gridImageUrl: '/card-images/504094_victini.jpg',
  }, 'pokemon');
  assert.deepEqual(JSON.parse(local.getItem(recentIdsKey('pokemon')) || '[]'), ['504094']);
  assert.equal(JSON.parse(local.getItem(recentTilesKey('pokemon')) || '{}')['504094'].name, 'Victini');
  assert.equal(JSON.parse(session.getItem(`pokoin.recentCardTiles.session.pokemon`) || '{}')['504094'].name, 'Victini');
  clearRecentTileMemory('pokemon');
  globalThis.sessionStorage = memoryStorage();
  assert.equal(readRecentTiles('pokemon')[0].name, 'Victini');
  assert.equal(peekRecentTile('504094', 'pokemon').name, 'Victini');
});

test('pokemon and riftbound local histories stay isolated', () => {
  clearRecentTileMemory();
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  rememberLocalCardId({ id: '504094', name: 'Victini', gridImageUrl: 'x' }, 'pokemon');
  rememberLocalCardId({ id: '723286', name: 'Ahri', gridImageUrl: 'y' }, 'riftbound');
  rememberLocalCardId({ id: '111', name: 'Luffy', gridImageUrl: 'z' }, 'one_piece');

  assert.deepEqual(readRecentCardIds('pokemon'), ['504094']);
  assert.deepEqual(readRecentCardIds('riftbound'), ['723286']);
  assert.deepEqual(readRecentCardIds('one_piece'), ['111']);
  assert.equal(readRecentTiles('riftbound')[0].name, 'Ahri');
  assert.equal(peekRecentTile('504094', 'riftbound'), null);
  assert.equal(peekRecentTile('723286', 'pokemon'), null);
});

test('re-viewing a card moves it to the front without duplicates', () => {
  clearRecentTileMemory();
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  writeLocalIds(['111', '222', '333'], 'riftbound');
  rememberLocalCardId('222', 'riftbound');
  assert.deepEqual(readRecentCardIds('riftbound'), ['222', '111', '333']);
});

test('history stays capped at RECENT_MAX per game', () => {
  clearRecentTileMemory();
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  const ids = Array.from({ length: RECENT_MAX }, (_, i) => String(1000 + i));
  writeLocalIds(ids, 'one_piece');
  rememberLocalCardId('999999', 'one_piece');
  const next = readRecentCardIds('one_piece');
  assert.equal(next.length, RECENT_MAX);
  assert.equal(next[0], '999999');
  assert.ok(!next.includes('1023'));
});

test('unscoped legacy keys are cleared and never seed game history', () => {
  clearRecentTileMemory();
  globalThis.localStorage = memoryStorage({
    [RECENT_KEY]: JSON.stringify(['504094', '790994']),
    [RECENT_TILES_KEY]: JSON.stringify({
      504094: { id: '504094', name: 'Victini', gridImageUrl: 'x' },
    }),
  });
  globalThis.sessionStorage = memoryStorage();
  assert.deepEqual(readRecentCardIds('riftbound'), []);
  assert.deepEqual(readRecentTiles('riftbound'), []);
  assert.deepEqual(readRecentCardIds('pokemon'), []);
  assert.deepEqual(readRecentTiles('pokemon'), []);
});

test('forgetLocalCardId removes a wrong-game id from scoped history', () => {
  clearRecentTileMemory();
  clearLegacyUnscopedRecents();
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  rememberLocalCardId({ id: '816620', name: 'Charlotte Smoothie', set: 'OP-17', gridImageUrl: 'x' }, 'riftbound');
  rememberLocalCardId({ id: '723286', name: 'Ahri', gridImageUrl: 'y' }, 'riftbound');
  forgetLocalCardId('816620', 'riftbound');
  assert.deepEqual(readRecentCardIds('riftbound'), ['723286']);
  assert.equal(peekRecentTile('816620', 'riftbound'), null);
});

test('every card opened reaches the account, oldest first, even two within 250 ms', async () => {
  const { setBearerProvider } = await import('./auth-bearer.js');
  const { rememberCardId, resetRecentWritesForTests } = await import('./recents.js');
  clearRecentTileMemory();
  resetRecentWritesForTests();
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    posted.push([init.method, JSON.parse(init.body || '{}').cardId]);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  setBearerProvider(async () => 'token');
  try {
    rememberCardId('504094', 'pokemon');
    rememberCardId('790994', 'pokemon');
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.deepEqual(posted, [['POST', '504094'], ['POST', '790994']]);
  } finally {
    globalThis.fetch = realFetch;
    setBearerProvider(null);
    resetRecentWritesForTests();
  }
});

test('an account sync keeps the cards whose write is still on its way', async () => {
  const { setBearerProvider } = await import('./auth-bearer.js');
  const { rememberCardId, resetRecentWritesForTests, syncRemoteRecentCardIds } = await import('./recents.js');
  clearRecentTileMemory();
  resetRecentWritesForTests();
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    if ((init.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ cardIds: ['111', '222'] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  setBearerProvider(async () => 'token');
  try {
    rememberCardId('333', 'pokemon');
    // The account answers before this device's POST went out: 333 stays first.
    assert.deepEqual(await syncRemoteRecentCardIds('pokemon'), ['333', '111', '222']);
    assert.deepEqual(readRecentCardIds('pokemon'), ['333', '111', '222']);
    // Once sent, the account's list is authoritative again.
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.deepEqual(await syncRemoteRecentCardIds('pokemon'), ['111', '222']);
  } finally {
    globalThis.fetch = realFetch;
    setBearerProvider(null);
    resetRecentWritesForTests();
  }
});
