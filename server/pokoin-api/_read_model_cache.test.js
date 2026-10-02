'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

process.env.POKOIN_READ_CACHE = '1';

const valkey = require('./_valkey');
const cache = require('./_read_model_cache');

function listen(store) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length) {
          const parsed = valkey._test.parseOne(buf);
          if (!parsed) return;
          buf = buf.slice(parsed.used);
          const cmd = parsed.value || [];
          const op = String(cmd[0] || '').toUpperCase();
          if (op === 'GET') {
            const value = store.get(cmd[1]);
            if (value == null) socket.write('$-1\r\n');
            else socket.write(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
          } else if (op === 'SETEX') {
            store.set(cmd[1], cmd[3]);
            socket.write('+OK\r\n');
          } else if (op === 'INCR') {
            const next = String(Number(store.get(cmd[1]) || 0) + 1);
            store.set(cmd[1], next);
            socket.write(`:${next}\r\n`);
          } else {
            socket.write('+OK\r\n');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('card and bounded search models hit Valkey and a generation bump misses', async () => {
  const store = new Map();
  const server = await listen(store);
  valkey.configure({ host: '127.0.0.1', port: server.address().port, timeoutMs: 300 });
  try {
    assert.equal(cache.cardPageKey({ cardId: '1', liveOffers: true }), '');
    assert.equal(cache.searchPageKey({ query: 'a' }), '');
    assert.equal(cache.searchPageKey({ query: 'x'.repeat(80) }), '');
    assert.ok(cache.searchPageKey({ query: 'charizard', limit: 24, offset: 0 }));

    let builds = 0;
    const first = await cache.loadCardPage({ cardId: '693360', lang: 'en' }, async () => {
      builds += 1;
      return { card: { id: '693360' } };
    });
    const second = await cache.loadCardPage({ cardId: '693360', lang: 'en' }, async () => {
      builds += 1;
      return { card: { id: 'rebuilt' } };
    });
    assert.equal(first.source, 'postgres');
    assert.equal(second.source, 'valkey');
    assert.equal(second.payload.card.id, '693360');
    assert.equal(builds, 1);

    await cache.invalidateCard('pokemon', '693360');
    const third = await cache.loadCardPage({ cardId: '693360', lang: 'en' }, async () => {
      builds += 1;
      return { card: { id: 'fresh' } };
    });
    assert.equal(third.source, 'postgres');
    assert.equal(third.payload.card.id, 'fresh');
    assert.equal(builds, 2);

    const key = cache.cardPageKey({ cardId: '1', lang: 'en' });
    const leader = cache.beginFlight(key);
    const follower = cache.beginFlight(key);
    assert.equal(leader.leader, true);
    assert.equal(follower.leader, false);
    leader.finish({ card: { id: '1' } });
    assert.deepEqual(await follower.wait, { card: { id: '1' } });
  } finally {
    valkey._test.resetConnection();
    await new Promise((resolve) => server.close(resolve));
  }
});
