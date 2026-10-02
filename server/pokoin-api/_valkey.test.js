'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const valkey = require(path.join(__dirname, '_valkey'));

const TEST_HOST = process.env.VALKEY_TEST_HOST || '127.0.0.1';
const TEST_PORT = Number(process.env.VALKEY_TEST_PORT || 6390);
const SLEEP_MS = 1100;

async function testServerReachable() {
  const reply = await valkey.command(['PING']);
  return reply === 'PONG';
}

function restoreServerConfig() {
  valkey.configure({ host: TEST_HOST, port: TEST_PORT, timeoutMs: 400 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One-shot TCP server that accepts, optionally replies with `reply`, and closes. */
function rawServer(reply, { delayMs = 0 } = {}) {
  return new Promise((resolveServer) => {
    const sockets = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('data', () => {
        setTimeout(() => {
          if (reply) socket.write(reply);
          socket.end();
        }, delayMs);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolveServer({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => sockets.forEach((s) => s.destroy(), done()))),
      });
    });
  });
}

// --- Helpers that must behave fail-open without any server ---

test('valkey unavailable: every helper resolves its clean miss/failure value', async () => {
  valkey.configure({ host: '127.0.0.1', port: 1, timeoutMs: 200 });
  try {
    assert.equal(await valkey.getJson('k'), null, 'getJson must resolve null, never reject');
    assert.equal(await valkey.setJson('k', { a: 1 }, 10), false);
    assert.equal(await valkey.del('k'), 0);
    assert.equal(await valkey.incrWindow('k', 10), null);
    assert.equal(await valkey.acquireLock('k', 'owner', 10), false, 'lock failure must read as "not held" (fail-open)');
    assert.equal(await valkey.releaseLock('k', 'owner'), false);
    assert.equal(await valkey.refreshLock('k', 'owner', 10), false);
  } finally {
    restoreServerConfig();
  }
});

test('a hung server resolves by timeout instead of hanging the request', async (t) => {
  const server = await rawServer(null, { delayMs: 5000 });
  valkey.configure({ host: '127.0.0.1', port: server.port, timeoutMs: 80 });
  try {
    const started = Date.now();
    assert.equal(await valkey.getJson('k'), null);
    assert.ok(Date.now() - started < 1000, 'timeout must cap the wait');
  } finally {
    restoreServerConfig();
    await server.close();
  }
});

test('an error reply (-) and a malformed reply both degrade to a miss', async () => {
  const errorServer = await rawServer('-ERR something\r\n');
  valkey.configure({ host: '127.0.0.1', port: errorServer.port, timeoutMs: 400 });
  try {
    assert.equal(await valkey.getJson('k'), null);
  } finally {
    await errorServer.close();
  }

  const malformedServer = await rawServer('not-a-resp-reply\n');
  valkey.configure({ host: '127.0.0.1', port: malformedServer.port, timeoutMs: 400 });
  try {
    assert.equal(await valkey.getJson('k'), null);
  } finally {
    await malformedServer.close();
    restoreServerConfig();
  }
});

// --- Integration against a real test Valkey (skipped when none is running) ---

test('GET miss / SET / GET hit round-trip', async (t) => {
  if (!(await testServerReachable())) return t.skip(`no local test Valkey on ${TEST_HOST}:${TEST_PORT}`);
  valkey.resetStats();
  await valkey.del('test:roundtrip');
  assert.equal(await valkey.getJson('test:roundtrip'), null);
  assert.equal(await valkey.setJson('test:roundtrip', { hello: 'world' }, 60), true);
  assert.deepEqual(await valkey.getJson('test:roundtrip'), { hello: 'world' });
  assert.equal(await valkey.getJson('test:missing'), null);
  const snapshot = valkey.valkeyStats();
  assert.ok(snapshot.getHit >= 1 && snapshot.getMiss >= 1 && snapshot.setOk >= 1);
});

test('SET TTL expires the key', async (t) => {
  if (!(await testServerReachable())) return t.skip('no local test Valkey');
  assert.equal(await valkey.setJson('test:ttl', { a: 1 }, 1), true);
  assert.deepEqual(await valkey.getJson('test:ttl'), { a: 1 });
  await sleep(SLEEP_MS);
  assert.equal(await valkey.getJson('test:ttl'), null, 'expired key must read as a miss');
});

test('DEL removes a key and returns the removed count', async (t) => {
  if (!(await testServerReachable())) return t.skip('no local test Valkey');
  await valkey.setJson('test:del', { a: 1 }, 60);
  assert.equal(await valkey.del('test:del'), 1);
  assert.equal(await valkey.getJson('test:del'), null);
  assert.equal(await valkey.del('test:del'), 0);
});

test('atomic fixed-window counter increments and restarts after the window', async (t) => {
  if (!(await testServerReachable())) return t.skip('no local test Valkey');
  await valkey.del('test:window');
  assert.equal(await valkey.incrWindow('test:window', 1), 1);
  assert.equal(await valkey.incrWindow('test:window', 1), 2);
  assert.equal(await valkey.incrWindow('test:window', 1), 3);
  await sleep(SLEEP_MS);
  assert.equal(await valkey.incrWindow('test:window', 1), 1, 'expired window must restart at 1');
});

test('locks: acquire, deny duplicate, refuse wrong-owner release, release by owner, re-acquire', async (t) => {
  if (!(await testServerReachable())) return t.skip('no local test Valkey');
  const key = 'test:lock';
  await valkey.del(key);
  assert.equal(await valkey.acquireLock(key, 'owner-a', 60), true);
  assert.equal(await valkey.acquireLock(key, 'owner-b', 60), false, 'second owner must be denied while held');
  assert.equal(await valkey.releaseLock(key, 'owner-b'), false, 'wrong owner must not release');
  assert.equal(await valkey.command(['GET', key]), 'owner-a', 'lock value must still be the original owner (raw GET, not JSON)');
  assert.equal(await valkey.releaseLock(key, 'owner-a'), true);
  assert.equal(await valkey.acquireLock(key, 'owner-b', 60), true, 'released lock must be acquirable');
  assert.equal(await valkey.releaseLock(key, 'owner-b'), true);
});

test('locks: expiry frees the lock for another owner', async (t) => {
  if (!(await testServerReachable())) return t.skip('no local test Valkey');
  const key = 'test:lock-expiry';
  await valkey.del(key);
  assert.equal(await valkey.acquireLock(key, 'owner-a', 1), true);
  await sleep(SLEEP_MS);
  assert.equal(await valkey.acquireLock(key, 'owner-b', 60), true, 'expired lock must be acquirable');
  assert.equal(await valkey.releaseLock(key, 'owner-a'), false, 'expired previous owner must not release the new lock');
  assert.equal(await valkey.releaseLock(key, 'owner-b'), true);
});

test('locks: refresh extends only for the current owner', async (t) => {
  if (!(await testServerReachable())) return t.skip('no local test Valkey');
  const key = 'test:lock-refresh';
  await valkey.del(key);
  assert.equal(await valkey.acquireLock(key, 'owner-a', 60), true);
  assert.equal(await valkey.refreshLock(key, 'owner-b', 60), false, 'wrong owner must not refresh');
  assert.equal(await valkey.refreshLock(key, 'owner-a', 60), true);
  assert.equal(await valkey.acquireLock(key, 'owner-b', 60), false, 'refreshed lock must still exclude other owners');
  assert.equal(await valkey.releaseLock(key, 'owner-a'), true);
});
