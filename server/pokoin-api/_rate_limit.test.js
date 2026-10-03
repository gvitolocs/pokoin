'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const redisCache = require('./_redis_cache');
const rateLimit = require('./_rate_limit');

const TEST_HOST = process.env.REDIS_CACHE_TEST_HOST || process.env.VALKEY_TEST_HOST || '127.0.0.1';
const TEST_PORT = Number(process.env.REDIS_CACHE_TEST_PORT || process.env.VALKEY_TEST_PORT || 6390);

function restoreServerConfig() {
  redisCache.configure({ host: TEST_HOST, port: TEST_PORT, timeoutMs: 400 });
}

function useDeadRedis() {
  redisCache.configure({ host: '127.0.0.1', port: 1, timeoutMs: 200 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('keys hash the identity and scope into one compact bucket name', () => {
  const bucket = rateLimit.rateLimitBucket('poko-chat', '203.0.113.7');
  assert.match(bucket, /^pokoin:rl:v1:poko-chat:[0-9a-f]{32}$/);
  assert.equal(bucket.includes('203.0.113.7'), false, 'raw IP must never appear in the key');
});

test('redis down: comfort limiter falls back to the bounded local window and still enforces', async () => {
  useDeadRedis();
  rateLimit.resetLocalWindows();
  try {
    const verdicts = [];
    for (let i = 0; i < 3; i += 1) {
      verdicts.push(await rateLimit.limitBestEffort({ scope: 'test-local', identity: '1.1.1.1', limit: 2, windowSeconds: 60 }));
    }
    assert.deepEqual(verdicts.map((v) => v.allowed), [true, true, false]);
    assert.ok(verdicts.every((v) => v.backend === 'local'));
    assert.equal(verdicts[2].retryAfterSec, 60);
  } finally {
    restoreServerConfig();
    rateLimit.resetLocalWindows();
  }
});

test('local fallback table stays bounded under a single-window flood', async () => {
  useDeadRedis();
  rateLimit.resetLocalWindows();
  try {
    for (let i = 0; i < 10_050; i += 1) {
      await rateLimit.limitBestEffort({ scope: 'test-flood', identity: `10.0.${Math.floor(i / 250) % 250}.${i % 250}#${i}`, limit: 1, windowSeconds: 3600 });
    }
    assert.ok(rateLimit.localWindowSize() <= 10_000, `local table must stay bounded, got ${rateLimit.localWindowSize()}`);
  } finally {
    restoreServerConfig();
    rateLimit.resetLocalWindows();
  }
});

test('security limiter: postgres fixed window allows up to the limit then rejects; no local fallback exists', async () => {
  let hits = 0;
  const fakeQuery = async () => {
    hits += 1;
    return { rows: [{ hits }], rowCount: 1 };
  };
  const verdicts = [];
  for (let i = 0; i < 3; i += 1) {
    verdicts.push(await rateLimit.limitSecurityCritical(
      { scope: 'test-secure', identity: '9.9.9.9', limit: 2, windowSeconds: 60 },
      { query: fakeQuery },
    ));
  }
  assert.deepEqual(verdicts.map((v) => v.allowed), [true, true, false]);
  assert.ok(verdicts.every((v) => v.backend === 'postgres'));
  assert.match(rateLimit.rateLimitBucket('test-secure', '9.9.9.9'), /^pokoin:rl:v1:test-secure:[0-9a-f]{32}$/);
});

test('security limiter fails CLOSED when the durable store is unavailable', async () => {
  const verdict = await rateLimit.limitSecurityCritical(
    { scope: 'test-secure-down', identity: '8.8.8.8', limit: 5, windowSeconds: 60 },
    { query: async () => { throw new Error('writer unreachable'); } },
  );
  assert.equal(verdict.allowed, false, 'store failure must reject, not fall back to memory');
  assert.equal(verdict.backend, 'error');

  const malformed = await rateLimit.limitSecurityCritical(
    { scope: 'test-secure-down', identity: '8.8.8.8', limit: 5, windowSeconds: 60 },
    { query: async () => ({ rows: [], rowCount: 0 }) },
  );
  assert.equal(malformed.allowed, false, 'malformed store answer must reject');
});

test('shared comfort limiter: two simulated instances consume ONE shared redis window', async (t) => {
  const ping = await redisCache.command(['PING']);
  if (ping !== 'PONG') return t.skip(`no local test Redis on ${TEST_HOST}:${TEST_PORT}`);
  restoreServerConfig();
  const bucket = rateLimit.rateLimitBucket('test-shared', '7.7.7.7');
  await redisCache.del(bucket);
  const a1 = await rateLimit.limitBestEffort({ scope: 'test-shared', identity: '7.7.7.7', limit: 3, windowSeconds: 60 });
  await redisCache.del(bucket);
  const a2 = await rateLimit.limitBestEffort({ scope: 'test-shared', identity: '7.7.7.7', limit: 3, windowSeconds: 60 });
  const rawAfter = Number(await redisCache.command(['GET', bucket]));
  assert.equal(a2.backend, 'redis');
  assert.equal(rawAfter, a2.count);
  assert.ok(a1.count >= 1);
  await redisCache.del(bucket);
});

test('shared comfort limiter: window expiry restarts the budget', async (t) => {
  const ping = await redisCache.command(['PING']);
  if (ping !== 'PONG') return t.skip('no local test Redis');
  restoreServerConfig();
  const bucket = rateLimit.rateLimitBucket('test-expiry', '6.6.6.6');
  await redisCache.del(bucket);
  const first = await rateLimit.limitBestEffort({ scope: 'test-expiry', identity: '6.6.6.6', limit: 1, windowSeconds: 1 });
  const second = await rateLimit.limitBestEffort({ scope: 'test-expiry', identity: '6.6.6.6', limit: 1, windowSeconds: 1 });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  await sleep(1100);
  const third = await rateLimit.limitBestEffort({ scope: 'test-expiry', identity: '6.6.6.6', limit: 1, windowSeconds: 1 });
  assert.equal(third.allowed, true, 'new window must reset the budget');
  await redisCache.del(bucket);
});
