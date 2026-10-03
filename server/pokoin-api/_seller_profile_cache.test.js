'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const { createFirestore } = require('./_firestore_fake');

const TARGET = path.join(__dirname, '_seller_profile_cache.js');

function fakeRedis() {
  const fake = { store: new Map(), sets: [], dels: [], down: false };
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
  fake.del = async (key) => {
    fake.dels.push(key);
    if (fake.down) return 0;
    return fake.store.delete(key) ? 1 : 0;
  };
  return fake;
}

/** Run `run` with the cache module loaded: ./_redis_cache and ../server/_firebase stubbed. */
async function withProfileCache(run, { seedUsers = {} } = {}) {
  const redisCache = fakeRedis();
  const { admin } = createFirestore(seedUsers);
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_redis_cache') return redisCache;
    if (request === '../server/_firebase') return { getFirebaseAdmin: () => admin };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const cache = require(TARGET);
    await run({ cache, redisCache });
  } finally {
    Module._load = originalLoad;
    delete require.cache[TARGET];
  }
}

test('cache miss loads from Firestore, populates Redis with the 6h TTL, and second read skips Firestore', async () => {
  await withProfileCache(async ({ cache, redisCache }) => {
    let loaderCalls = 0;
    const loadProfiles = async (uids) => {
      loaderCalls += 1;
      return new Map(uids.map((uid) => [uid, { displayName: 'Alice', username: 'alice', acceptsPkn: true }]));
    };
    const first = await cache.getPublicSellerProfiles(['uid-1'], { loadProfiles });
    assert.equal(first.get('uid-1').displayName, 'Alice');
    assert.equal(loaderCalls, 1);
    const writes = redisCache.sets.filter((set) => set.key === 'pokoin:seller:v1:uid-1:profile');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ttlSeconds, cache.PUBLIC_PROFILE_TTL_SEC);
    assert.equal(cache.PUBLIC_PROFILE_TTL_SEC, 6 * 60 * 60);

    const second = await cache.getPublicSellerProfiles(['uid-1'], { loadProfiles });
    assert.equal(second.get('uid-1').displayName, 'Alice');
    assert.equal(loaderCalls, 1, 'second read must be served from the cache');
  });
});

test('partial cache: only the missing uids go to the durable loader', async () => {
  await withProfileCache(async ({ cache }) => {
    const seenUids = [];
    const loadProfiles = async (uids) => {
      seenUids.push(...uids);
      return new Map(uids.map((uid) => [uid, { displayName: `Name-${uid}`, username: '', acceptsPkn: true }]));
    };
    await cache.getPublicSellerProfiles(['uid-1', 'uid-2'], { loadProfiles });
    seenUids.length = 0;
    await cache.getPublicSellerProfiles(['uid-1', 'uid-2', 'uid-3'], { loadProfiles });
    assert.deepEqual(seenUids, ['uid-3']);
  });
});

test('Redis down degrades to Firestore without failing the read', async () => {
  await withProfileCache(async ({ cache, redisCache }) => {
    redisCache.down = true;
    let loaderCalls = 0;
    const profiles = await cache.getPublicSellerProfiles(['uid-1'], {
      loadProfiles: async (uids) => {
        loaderCalls += 1;
        return new Map(uids.map((uid) => [uid, { displayName: 'Bob', username: 'bob', acceptsPkn: false }]));
      },
    });
    assert.equal(loaderCalls, 1);
    assert.equal(profiles.get('uid-1').acceptsPkn, false);
  });
});

test('a malformed cached profile is ignored and recomputed', async () => {
  await withProfileCache(async ({ cache, redisCache }) => {
    redisCache.store.set('pokoin:seller:v1:uid-1:profile', 'garbage');
    let loaderCalls = 0;
    await cache.getPublicSellerProfiles(['uid-1'], {
      loadProfiles: async (uids) => {
        loaderCalls += 1;
        return new Map(uids.map((uid) => [uid, { displayName: 'Cara', username: '', acceptsPkn: true }]));
      },
    });
    assert.equal(loaderCalls, 1);
  });
});

test('invalidateSellerProfile deletes the profile key and each known slug key', async () => {
  await withProfileCache(async ({ cache, redisCache }) => {
    await cache.rememberSellerUidByName('alice', { uid: 'uid-1', displayName: 'Alice' });
    await cache.invalidateSellerProfile('uid-1', { usernames: ['alice'] });
    assert.ok(redisCache.dels.includes('pokoin:seller:v1:uid-1:profile'));
    assert.ok(redisCache.dels.includes(cache.slugKey('alice')));
    assert.equal(await cache.readSellerUidByName('alice'), null, 'slug must be gone after invalidation');
  });
});

test('slug cache: remember → read hits, unknown name reads null, redis down falls through', async () => {
  await withProfileCache(async ({ cache, redisCache }) => {
    await cache.rememberSellerUidByName('alice', { uid: 'uid-1', displayName: 'Alice' });
    assert.deepEqual(await cache.readSellerUidByName('alice'), { uid: 'uid-1', displayName: 'Alice' });
    assert.deepEqual(await cache.readSellerUidByName('ALICE'), { uid: 'uid-1', displayName: 'Alice' }, 'lookup normalizes case');
    assert.equal(await cache.readSellerUidByName('nobody'), null);

    redisCache.down = true;
    assert.equal(await cache.readSellerUidByName('alice'), null, 'down Redis reads as unknown');
    await cache.rememberSellerUidByName('alice', { uid: 'uid-9', displayName: '' });
    assert.equal(redisCache.store.get(cache.slugKey('alice')).uid, 'uid-1', 'failed write must not corrupt the slug');
  });
});

test('a cached slug with a malformed uid is rejected', async () => {
  await withProfileCache(async ({ cache, redisCache }) => {
    redisCache.store.set(cache.slugKey('evil'), { uid: '../escape', displayName: 'x' });
    assert.equal(await cache.readSellerUidByName('evil'), null);
  });
});

test('default loader reads Firestore users and applies acceptsPkn !== false semantics', async () => {
  await withProfileCache(async ({ cache }) => {
    const profiles = await cache.getPublicSellerProfiles(['uid-1', 'uid-2', 'uid-missing']);
    assert.deepEqual(profiles.get('uid-1'), { displayName: 'Dave', username: 'dave', acceptsPkn: true });
    assert.equal(profiles.get('uid-2').acceptsPkn, true, 'missing acceptsPkn defaults to true');
    assert.equal(profiles.has('uid-missing'), false, 'missing docs are not cached');
  }, {
    seedUsers: {
      users: {
        'uid-1': { displayName: 'Dave', username: 'dave', acceptsPkn: true },
        'uid-2': { displayName: 'Eve', usernameLower: 'eve' },
      },
    },
  });
});
