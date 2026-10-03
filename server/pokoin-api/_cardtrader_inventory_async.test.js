'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.join(__dirname, '_cardtrader_inventory_async.js');

function fakeRedis({ down = false, lockAvailable = true } = {}) {
  const fake = { pings: 0, acquires: [], releases: [] };
  fake.command = async (parts) => {
    if (String(parts[0]).toUpperCase() === 'PING') {
      fake.pings += 1;
      return down ? null : 'PONG';
    }
    return 'OK';
  };
  fake.acquireLock = async (key, owner, ttlSeconds) => {
    fake.acquires.push({ key, owner, ttlSeconds });
    return lockAvailable;
  };
  fake.releaseLock = async (key, owner) => {
    fake.releases.push({ key, owner });
    return true;
  };
  return fake;
}

/**
 * Load the module with the sync engine and Redis stubbed. `reconcile` calls
 * are recorded; a test can hold the first reconcile open via holdOpen.
 */
async function withInventoryAsync(run, { redisCache, holdOpen = false } = {}) {
  const syncCalls = [];
  let releaseReconcile = null;
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_redis_cache') return redisCache;
    if (request === './_cardtrader_inventory_sync') {
      return {
        reconcileCardTraderInventory: async (args) => {
          syncCalls.push(args);
          if (holdOpen) {
            await new Promise((resolve) => { releaseReconcile = resolve; });
          }
          return { ok: true, incomplete: false, summary: { inventory: 1 } };
        },
        recordSellerSync: async () => {},
        readSellerSync: async () => ({}),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const inventoryAsync = require(TARGET);
    await run({ inventoryAsync, syncCalls, finishReconcile: () => releaseReconcile?.({ ok: true }) });
  } finally {
    Module._load = originalLoad;
    delete require.cache[TARGET];
  }
}

function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('starting a sync takes the shared lock and releases it with the same owner when done', async () => {
  const redisCache = fakeRedis();
  await withInventoryAsync(async ({ inventoryAsync, finishReconcile }) => {
    const job = await inventoryAsync.enqueueCardTraderInventorySync({ uid: 'seller-1' });
    assert.equal(job.started, true);
    assert.equal(redisCache.acquires.length, 1);
    assert.match(redisCache.acquires[0].key, /^pokoin:lock:v1:ct-reconcile:seller-1$/);
    assert.equal(redisCache.acquires[0].ttlSeconds, 900);
    finishReconcile();
    await waitFor(() => !inventoryAsync.isInventorySyncRunning('seller-1'));
    await waitFor(() => redisCache.releases.length === 1);
    assert.equal(redisCache.releases[0].key, redisCache.acquires[0].key);
    assert.equal(redisCache.releases[0].owner, redisCache.acquires[0].owner, 'release must use the acquiring owner token');
  }, { redisCache });
});

test('a locally running sync makes a second enqueue a no-op (in-process guard)', async () => {
  const redisCache = fakeRedis();
  await withInventoryAsync(async ({ inventoryAsync, syncCalls, finishReconcile }) => {
    const first = await inventoryAsync.enqueueCardTraderInventorySync({ uid: 'seller-1' });
    const second = await inventoryAsync.enqueueCardTraderInventorySync({ uid: 'seller-1' });
    assert.equal(first.started, true);
    assert.deepEqual(second, { started: false, alreadyRunning: true });
    assert.equal(syncCalls.length, 1);
    finishReconcile();
    await waitFor(() => !inventoryAsync.isInventorySyncRunning('seller-1'));
  }, { redisCache, holdOpen: true });
});

test('a lock held on another instance reports alreadyRunning and does not run the reconcile', async () => {
  const redisCache = fakeRedis({ lockAvailable: false });
  await withInventoryAsync(async ({ inventoryAsync, syncCalls }) => {
    const job = await inventoryAsync.enqueueCardTraderInventorySync({ uid: 'seller-2' });
    assert.deepEqual(job, { started: false, alreadyRunning: true });
    assert.equal(syncCalls.length, 0, 'another instance is reconciling; this one must not duplicate it');
  }, { redisCache });
});

test('redis down degrades to the in-process guard and still starts the sync', async () => {
  const redisCache = fakeRedis({ down: true });
  await withInventoryAsync(async ({ inventoryAsync, syncCalls, finishReconcile }) => {
    const job = await inventoryAsync.enqueueCardTraderInventorySync({ uid: 'seller-3' });
    assert.equal(job.started, true, 'skipping a durable reconcile because Redis is down would be worse than duplicating it');
    assert.equal(redisCache.acquires.length, 0, 'no lock is taken when Redis is unreachable');
    finishReconcile();
    await waitFor(() => !inventoryAsync.isInventorySyncRunning('seller-3'));
    assert.equal(syncCalls.length, 1);
  }, { redisCache });
});

test('acquireReconcileLock reports degradation instead of holding when PING fails', async () => {
  const redisCache = fakeRedis({ down: true });
  await withInventoryAsync(async ({ inventoryAsync }) => {
    const lock = await inventoryAsync.acquireReconcileLock('seller-4');
    assert.equal(lock.degraded, true);
    assert.equal(lock.owner, '', 'a degraded lock has no owner and must never be released');
  }, { redisCache });
});
