import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECENT_KEY,
  RECENT_TILES_KEY,
  SESSION_TILES_KEY,
  clearRecentTileMemory,
  peekRecentTile,
  readRecentCardIds,
  readRecentTiles,
  rememberLocalCardId,
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
  const local = memoryStorage({
    [RECENT_TILES_KEY]: '{"504094":{"id":"504094","name":"Victini","gridImageUrl":"x"}}',
    'pokoin.cardPage.v1.en:1': '{"card":{"id":"1"}}',
    'pokoin.cardSales.v12.1': '{"series":[]}',
  }, { failWrites: 1 });
  globalThis.localStorage = local;
  globalThis.sessionStorage = memoryStorage();
  rememberLocalCardId('504094');
  assert.deepEqual(readRecentCardIds(), ['504094']);
  assert.equal(JSON.parse(local.getItem(RECENT_TILES_KEY) || '{}')['504094'].name, 'Victini');
  assert.equal(local.getItem('pokoin.cardPage.v1.en:1'), null);
});

test('legacy tile dump becomes ids and keeps compact tiles', () => {
  const local = memoryStorage({
    [RECENT_TILES_KEY]: JSON.stringify({
      504094: { id: '504094', name: 'Victini', gridImageUrl: 'x' },
      790994: { id: '790994', name: 'Charizard', gridImageUrl: 'y' },
    }),
  });
  const session = memoryStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  assert.deepEqual(readRecentCardIds(), ['504094', '790994']);
  assert.deepEqual(JSON.parse(local.getItem(RECENT_KEY) || '[]'), ['504094', '790994']);
  assert.equal(JSON.parse(local.getItem(RECENT_TILES_KEY) || '{}')['504094'].name, 'Victini');
  assert.equal(readRecentTiles()[0].name, 'Victini');
});

test('compact tiles persist in localStorage for the next visit', () => {
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
  });
  assert.deepEqual(JSON.parse(local.getItem(RECENT_KEY) || '[]'), ['504094']);
  assert.equal(JSON.parse(local.getItem(RECENT_TILES_KEY) || '{}')['504094'].name, 'Victini');
  assert.equal(JSON.parse(session.getItem(SESSION_TILES_KEY) || '{}')['504094'].name, 'Victini');
  clearRecentTileMemory();
  globalThis.sessionStorage = memoryStorage();
  assert.equal(readRecentTiles()[0].name, 'Victini');
  assert.equal(peekRecentTile('504094').name, 'Victini');
});
