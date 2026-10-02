'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { cacheKey, cachePolicy, chooseApiOrigin, isApiPath, ResponseCache } = require('./pokoin-api-edge.js');

const base = { inFlight: 24, localMax: 24, overflowHealthy: true, overflowOrigin: 'http://nezopt:30880' };

test('only saturated GET/HEAD API calls overflow, and only to a healthy nezopt', () => {
  assert.equal(chooseApiOrigin({ ...base, method: 'GET' }), 'overflow');
  assert.equal(chooseApiOrigin({ ...base, method: 'HEAD' }), 'overflow');
  assert.equal(chooseApiOrigin({ ...base, method: 'POST' }), 'local');
  assert.equal(chooseApiOrigin({ ...base, method: 'GET', inFlight: 23 }), 'local');
  assert.equal(chooseApiOrigin({ ...base, method: 'GET', overflowHealthy: false }), 'local');
  assert.equal(chooseApiOrigin({ ...base, method: 'GET', overflowOrigin: '' }), 'local');
  assert.equal(chooseApiOrigin({ ...base, method: 'GET', pathname: '/api/marketplace-live' }), 'local');
  assert.equal(cacheKey({ method: 'GET', headers: {} }, '/api/marketplace-live', '?cardId=1'), null);
  assert.equal(isApiPath('/api/marketplace-suggest'), true);
  assert.equal(isApiPath('/some-image.webp'), false);
});

function server(name, delayMs, cacheControl = '') {
  const srv = http.createServer((req, res) => {
    srv.hits = (srv.hits || 0) + 1;
    setTimeout(() => {
      const headers = { 'content-type': 'application/json' };
      if (cacheControl) headers['cache-control'] = cacheControl;
      res.writeHead(200, headers);
      res.end(JSON.stringify({ served: name, method: req.method, n: srv.hits }));
    }, delayMs);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

let seq = 0;
function request(port, method = 'GET', pathname = `/api/marketplace-suggest?q=pika${seq += 1}`, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        origin: res.headers['x-pokoin-origin'],
        cache: res.headers['x-pokoin-edge-cache'],
        body: (() => { try { return JSON.parse(body || '{}'); } catch { return { text: body }; } })(),
        robots: res.headers['x-robots-tag'],
      }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the real edge; a taken random port makes it exit, so try another. */
async function startEdge(env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, 'pokoin-api-edge.js')], {
      env: { ...process.env, POKOIN_API_EDGE_PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const started = await new Promise((resolve) => {
      child.stdout.once('data', () => resolve(true));
      child.once('exit', () => resolve(false));
    });
    if (started) return { port, child };
  }
  throw new Error('edge did not start');
}

test('under load the edge spills GETs to nezopt and keeps POSTs on the Pi', async () => {
  const pi = await server('pi', 150);
  const nezopt = await server('nezopt', 5);
  const { port, child } = await startEdge({
    POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}`,
    POKOIN_API_OVERFLOW_ORIGIN: `http://127.0.0.1:${nezopt.address().port}`,
    POKOIN_API_LOCAL_MAX: '4',
    POKOIN_API_OVERFLOW_PROBE_MS: '100',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250)); // first probe
    const burst = await Promise.all(Array.from({ length: 12 }, () => request(port)));
    const byOrigin = burst.reduce((acc, row) => ({ ...acc, [row.origin]: (acc[row.origin] || 0) + 1 }), {});
    assert.equal(byOrigin.pi, 4);
    assert.equal(byOrigin.nezopt, 8);
    assert.ok(burst.every((row) => row.body.served === (row.origin === 'nezopt' ? 'nezopt' : 'pi')));

    const writes = await Promise.all(Array.from({ length: 8 }, () => request(port, 'POST', '/api/marketplace-listings')));
    assert.ok(writes.every((row) => row.origin === 'pi'));

    const quiet = await request(port);
    assert.equal(quiet.origin, 'pi');
  } finally {
    child.kill();
    pi.close();
    nezopt.close();
  }
});

test('nezopt down: everything stays on the Pi', async () => {
  const pi = await server('pi', 80);
  const { port, child } = await startEdge({
    POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}`,
    POKOIN_API_OVERFLOW_ORIGIN: 'http://127.0.0.1:1',
    POKOIN_API_LOCAL_MAX: '2',
    POKOIN_API_OVERFLOW_PROBE_MS: '100',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const burst = await Promise.all(Array.from({ length: 6 }, () => request(port)));
    assert.ok(burst.every((row) => row.origin === 'pi' && row.body.served === 'pi'));
  } finally {
    child.kill();
    pi.close();
  }
});

test('cache policy stores only public, sized, non-personal 200s', () => {
  assert.deepEqual(cachePolicy(200, { 'cache-control': 'public, max-age=10, s-maxage=30, stale-while-revalidate=60' }), { ttl: 30, swr: 60 });
  assert.deepEqual(cachePolicy(200, { 'cache-control': 'public, max-age=60' }), { ttl: 60, swr: 0 });
  assert.deepEqual(cachePolicy(200, { 'cache-control': 'public, s-maxage=86400' }), { ttl: 300, swr: 0 });
  assert.equal(cachePolicy(200, { 'cache-control': 'private, no-store' }), null);
  assert.equal(cachePolicy(200, { 'cache-control': 'public, no-cache, max-age=5' }), null);
  assert.equal(cachePolicy(200, {}), null);
  assert.equal(cachePolicy(404, { 'cache-control': 'public, max-age=60' }), null);
  assert.equal(cachePolicy(200, { 'cache-control': 'public, max-age=60', 'set-cookie': ['a=b'] }), null);
  assert.equal(cachePolicy(200, { 'cache-control': 'public, max-age=60', 'content-type': 'text/event-stream' }), null);

  const anon = { method: 'GET', headers: { 'x-pokoin-game': 'one_piece' } };
  assert.equal(cacheKey(anon, '/api/x', '?a=1'), '/api/x?a=1\none_piece\n');
  assert.equal(cacheKey({ method: 'GET', headers: { authorization: 'Bearer t' } }, '/api/x', ''), null);
  assert.equal(cacheKey({ method: 'GET', headers: { cookie: 'c=1' } }, '/api/x', ''), null);
  assert.equal(cacheKey({ method: 'POST', headers: {} }, '/api/x', ''), null);

  const lru = new ResponseCache(10);
  lru.set('a', { body: Buffer.alloc(4) });
  lru.set('b', { body: Buffer.alloc(4) });
  lru.get('a');
  lru.set('c', { body: Buffer.alloc(4) });
  assert.equal(lru.get('b'), null);
  assert.ok(lru.get('a') && lru.get('c'));
  assert.equal(lru.bytes, 8);
});

test('identical public GETs are built once, then served from the edge', async () => {
  const pi = await server('pi', 150, 'public, max-age=10, s-maxage=30, stale-while-revalidate=60');
  const { port, child } = await startEdge({ POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}` });
  try {
    const path = '/api/marketplace-home?v=rising-month';
    const burst = await Promise.all(Array.from({ length: 10 }, () => request(port, 'GET', path)));
    assert.equal(pi.hits, 1);
    assert.equal(burst.filter((row) => row.cache === 'MISS').length, 1);
    assert.equal(burst.filter((row) => row.cache === 'COALESCED').length, 9);
    assert.ok(burst.every((row) => row.status === 200 && row.body.n === 1));
    const again = await request(port, 'GET', path);
    assert.equal(again.cache, 'HIT');
    assert.equal(pi.hits, 1);
    const personal = await request(port, 'GET', path, { authorization: 'Bearer user' });
    assert.equal(personal.body.n, 2);
    assert.equal(personal.cache, undefined);
  } finally {
    child.kill();
    pi.close();
  }
});

test('expired entries are served stale while one refresh runs', async () => {
  const pi = await server('pi', 50, 'public, s-maxage=1, stale-while-revalidate=30');
  const { port, child } = await startEdge({ POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}` });
  try {
    const path = '/api/marketplace-artist-cards?summaries=1';
    assert.equal((await request(port, 'GET', path)).cache, 'MISS');
    await wait(1100);
    const stale = await Promise.all(Array.from({ length: 5 }, () => request(port, 'GET', path)));
    assert.ok(stale.every((row) => row.cache === 'STALE' && row.body.n === 1));
    await wait(150);
    assert.equal(pi.hits, 2);
    const fresh = await request(port, 'GET', path);
    assert.equal(fresh.cache, 'HIT');
    assert.equal(fresh.body.n, 2);
  } finally {
    child.kill();
    pi.close();
  }
});

test('no-store responses are streamed and never cached', async () => {
  const pi = await server('pi', 20, 'private, no-store');
  const { port, child } = await startEdge({ POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}` });
  try {
    const path = '/api/marketplace-listings?cardId=1&nativeOnly=1';
    const first = await request(port, 'GET', path);
    const second = await request(port, 'GET', path);
    assert.equal(first.cache, 'BYPASS');
    assert.equal(second.body.n, 2);
  } finally {
    child.kill();
    pi.close();
  }
});

test('Pi API down: GETs are answered by nezopt, writes still fail fast', async () => {
  const nezopt = await server('nezopt', 5, 'public, max-age=10');
  const { port, child } = await startEdge({
    POKOIN_API_ORIGIN: 'http://127.0.0.1:1',
    POKOIN_API_OVERFLOW_ORIGIN: `http://127.0.0.1:${nezopt.address().port}`,
    POKOIN_API_OVERFLOW_PROBE_MS: '100',
  });
  try {
    await wait(250);
    const cached = await request(port, 'GET', '/api/marketplace-card-page?cardId=1');
    assert.equal(cached.status, 200);
    assert.equal(cached.origin, 'nezopt');
    const personal = await request(port, 'GET', '/api/marketplace-orders', { authorization: 'Bearer user' });
    assert.equal(personal.status, 200);
    assert.equal(personal.origin, 'nezopt');
    const write = await request(port, 'POST', '/api/marketplace-event');
    assert.equal(write.status, 502);
  } finally {
    child.kill();
    nezopt.close();
  }
});

test('a 404 on one URL does not switch caching off for the whole endpoint', async () => {
  const srv = http.createServer((req, res) => {
    srv.hits = (srv.hits || 0) + 1;
    const missing = req.url.includes('slug=nope');
    res.writeHead(missing ? 404 : 200, {
      'content-type': 'application/json',
      'cache-control': missing ? 'public, max-age=30' : 'public, s-maxage=300',
    });
    res.end(JSON.stringify({ n: srv.hits }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port, child } = await startEdge({ POKOIN_API_ORIGIN: `http://127.0.0.1:${srv.address().port}` });
  try {
    assert.equal((await request(port, 'GET', '/api/marketplace-expansion-page?slug=nope')).status, 404);
    const path = '/api/marketplace-expansion-page?limit=500';
    assert.equal((await request(port, 'GET', path)).cache, 'MISS');
    assert.equal((await request(port, 'GET', path)).cache, 'HIT');
    const before = srv.hits;
    const burst = await Promise.all(Array.from({ length: 5 }, () => request(port, 'GET', '/api/marketplace-expansion-page?slug=new')));
    assert.ok(burst.every((row) => row.status === 200 && ['MISS', 'COALESCED', 'HIT'].includes(row.cache)));
    assert.equal(srv.hits - before, 1);
  } finally {
    child.kill();
    srv.close();
  }
});

test('API responses carry x-robots-tag noindex; CDN responses do not', async () => {
  const pi = await server('pi', 5, 'public, max-age=10, s-maxage=30');
  const cdn = await server('cdn', 5);
  const { port, child } = await startEdge({
    POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}`,
    POKOIN_CDN_ORIGIN: `http://127.0.0.1:${cdn.address().port}`,
  });
  try {
    const path = '/api/marketplace-card-page?v=noindex-check';
    const first = await request(port, 'GET', path);
    assert.equal(first.cache, 'MISS');
    assert.equal(first.robots, 'noindex');
    const hit = await request(port, 'GET', path);
    assert.equal(hit.cache, 'HIT');
    assert.equal(hit.robots, 'noindex');
    const personal = await request(port, 'GET', path, { authorization: 'Bearer user' });
    assert.equal(personal.robots, 'noindex');
    const image = await request(port, 'GET', '/card-images/x.webp');
    assert.equal(image.robots, undefined);
  } finally {
    child.kill();
    pi.close();
    cdn.close();
  }
});
