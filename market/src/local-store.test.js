import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureLocalStore,
  evictionPlan,
  LOCAL_STORE_CAP_BYTES,
  localGet,
  localPut,
  localStats,
  localTrim,
  localWipe,
  resetLocalStoreForTests,
} from './local-store.js';

test('the store is capped at about 40 MB', () => {
  assert.equal(LOCAL_STORE_CAP_BYTES, 40 * 1024 * 1024);
});

test('eviction drops least recently used rows until under 80% of the cap', () => {
  const rows = [
    { url: 'a', bytes: 40, usedAt: 3 },
    { url: 'b', bytes: 40, usedAt: 1 },
    { url: 'c', bytes: 40, usedAt: 2 },
    { url: 'd', bytes: 40, usedAt: 4 },
  ];
  assert.deepEqual(evictionPlan(rows, 200), []);
  assert.deepEqual(evictionPlan(rows, 150), ['b']);
  assert.deepEqual(evictionPlan(rows, 100), ['b', 'c']);
  assert.deepEqual(evictionPlan(rows, 10), ['b', 'c', 'a', 'd']);
});

test('without IndexedDB every call fails open', async () => {
  resetLocalStoreForTests();
  configureLocalStore({ dictionaryVersion: '1' });
  assert.equal(globalThis.indexedDB, undefined);
  assert.equal(await localGet('https://api.pokoin.com/api/dictionary'), null);
  assert.equal(await localPut('https://api.pokoin.com/api/dictionary', '{}'), false);
  assert.equal(await localTrim(), 0);
  await localWipe();
  assert.deepEqual(await localStats(), { rows: 0, bytes: 0, available: false });
});

test('a throwing or hung indexedDB is a miss, not an error', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  try {
    resetLocalStoreForTests();
    configureLocalStore({ dictionaryVersion: '1' });
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() { throw new Error('SecurityError: storage is blocked in this frame'); },
    });
    assert.equal(await localGet('u'), null);

    resetLocalStoreForTests();
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: { open: () => ({}) }, // never fires success, error or blocked
    });
    const started = Date.now();
    assert.equal(await localGet('u'), null);
    assert.ok(Date.now() - started < 5000);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else delete globalThis.indexedDB;
    resetLocalStoreForTests();
  }
});
