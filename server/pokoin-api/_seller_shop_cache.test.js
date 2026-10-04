'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

process.env.POKOIN_READ_CACHE = '1';

const redisCache = require('./_redis_cache');
const cache = require('./_seller_shop_cache');

function listen(store) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length) {
          const parsed = redisCache._test.parseOne(buf);
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

test('seller shop key skips filtered and book requests', () => {
  assert.ok(cache.sellerShopKey({
    sellerUid: 'uid-1', limit: 100, offset: 0, sort: 'price-asc',
  }).startsWith('pokoin:marketplace:v1:seller-shop-ct2:'));
  assert.equal(cache.sellerShopKey({
    sellerUid: 'uid-1', limit: 100, q: 'charizard',
  }), '');
  assert.equal(cache.sellerShopKey({
    sellerUid: 'uid-1', limit: 100, book: true,
  }), '');
});

test('seller shop hit/miss/invalidate and concurrent coalesce', async () => {
  const store = new Map();
  const server = await listen(store);
  redisCache.configure({ host: '127.0.0.1', port: server.address().port, timeoutMs: 300 });
  try {
    let builds = 0;
    const parts = { sellerUid: 'uid-1', game: 'pokemon', limit: 100, offset: 0, sort: 'price-asc' };
    const load = async () => {
      builds += 1;
      return { listings: [{ id: `L${builds}` }], total: 1, unique: 1 };
    };
    const [a, b] = await Promise.all([
      cache.loadSellerShop(parts, load),
      cache.loadSellerShop(parts, load),
    ]);
    assert.equal(builds, 1, 'stampede must coalesce to one load');
    assert.equal(a.source, 'postgres');
    assert.equal(b.source, 'postgres');

    const warm = await cache.loadSellerShop(parts, load);
    assert.equal(warm.source, 'redis');
    assert.equal(warm.payload.listings[0].id, 'L1');
    assert.equal(builds, 1);

    await cache.invalidateSellerShop('uid-1');
    const fresh = await cache.loadSellerShop(parts, load);
    assert.equal(fresh.source, 'postgres');
    assert.equal(fresh.payload.listings[0].id, 'L2');
    assert.equal(builds, 2);
  } finally {
    redisCache._test.resetConnection();
    await new Promise((resolve) => server.close(resolve));
  }
});
