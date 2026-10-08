'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  gameSelectedOutsideUrl,
  markAuthFailure,
  prepareRequest,
  routeManifestEnabled,
} = require('./_http_security.js');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { preflightHandled } = prepareRequest(req, res);
      if (preflightHandled) return;
      const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      switch (pathname) {
        case '/ok':
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('access-control-allow-credentials', 'true');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          break;
        case '/e400':
          res.statusCode = 400;
          res.end('bad request');
          break;
        case '/e401':
          res.statusCode = 401;
          res.end('unauthorized');
          break;
        case '/e403':
          res.statusCode = 403;
          res.end('forbidden');
          break;
        case '/e404':
          res.statusCode = 404;
          res.end('not found');
          break;
        case '/e500':
          res.statusCode = 500;
          res.end('boom');
          break;
        case '/authfail':
          req.pokoinResponse = res;
          markAuthFailure(req);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Internal server error.' }));
          break;
        case '/cacheable':
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('cache-control', 'public, max-age=600');
          res.end(JSON.stringify({ ok: true }));
          break;
        case '/clientip':
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            cf: req.headers['cf-connecting-ip'],
            xff: req.headers['x-forwarded-for'],
          }));
          break;
        default:
          res.statusCode = 404;
          res.end('nope');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function options(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method: 'OPTIONS', headers },
      (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

const GOOD_ORIGIN = 'https://pokoin.com';
const EVIL_ORIGIN = 'https://evil.example';
const STATUSES = [200, 400, 401, 403, 404, 500];

test('routeManifestEnabled is opt-in', () => {
  assert.equal(routeManifestEnabled({}), false);
  assert.equal(routeManifestEnabled({ POKOIN_EXPOSE_ROUTE_MANIFEST: '1' }), true);
  assert.equal(routeManifestEnabled({ POKOIN_EXPOSE_ROUTE_MANIFEST: '0' }), false);
});

test('markAuthFailure is null-safe', () => {
  assert.doesNotThrow(() => markAuthFailure(null));
  const req = {};
  markAuthFailure(req);
  assert.equal(req.pokoinAuthFailure, true);
  const req2 = { pokoinResponse: { a: 1 } };
  markAuthFailure(req2);
  assert.equal(req2.pokoinAuthFailure, true);
  assert.equal(req2.pokoinResponse.pokoinAuthFailure, true);
});

test('prepareRequest wraps writeHead exactly once', () => {
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = {};
  res.writeHead = () => {};
  res.end = () => {};
  res.getHeaders = () => ({});
  res.removeHeader = () => {};
  res.setHeader = () => {};
  prepareRequest(req, res);
  const first = res.writeHead;
  prepareRequest(req, res);
  assert.equal(res.writeHead, first);
});

test('CORS policy on every status, allowed and disallowed origins', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    for (const status of STATUSES) {
      const path = status === 200 ? '/ok' : `/e${status}`;
      const good = await get(port, path, { Origin: GOOD_ORIGIN });
      assert.equal(good.status, status, `${path} good-origin status`);
      assert.equal(good.headers['access-control-allow-origin'], GOOD_ORIGIN, `${path} good-origin ACAO`);
      assert.equal(good.headers['access-control-allow-credentials'], 'true', `${path} good-origin ACAC`);
      assert.ok(String(good.headers.vary).includes('Origin'), `${path} good-origin vary`);

      const evil = await get(port, path, { Origin: EVIL_ORIGIN });
      assert.equal(evil.status, status, `${path} evil-origin status`);
      assert.equal(evil.headers['access-control-allow-origin'], '*', `${path} evil-origin ACAO`);
      assert.equal(evil.headers['access-control-allow-credentials'], undefined, `${path} evil-origin ACAC`);
    }
  } finally {
    server.close();
  }
});

test('auth failure demotes 500 to 401', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const res = await get(port, '/authfail', { Origin: GOOD_ORIGIN });
    assert.equal(res.status, 401);
    assert.equal(res.headers['access-control-allow-origin'], GOOD_ORIGIN);
  } finally {
    server.close();
  }
});

test('OPTIONS preflight is handled without the route handler', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const good = await options(port, '/nope', {
      Origin: GOOD_ORIGIN,
      'Access-Control-Request-Method': 'POST',
    });
    assert.equal(good.status, 204);
    assert.equal(good.body, '');
    assert.equal(good.headers['access-control-allow-origin'], GOOD_ORIGIN);
    assert.equal(good.headers['access-control-allow-credentials'], 'true');

    const evil = await options(port, '/nope', { Origin: EVIL_ORIGIN });
    assert.equal(evil.status, 204);
    assert.equal(evil.headers['access-control-allow-origin'], '*');
    assert.equal(evil.headers['access-control-allow-credentials'], undefined);
  } finally {
    server.close();
  }
});

test('gameSelectedOutsideUrl: header without ?game= is a hit, with ?game= it is not', () => {
  const req = { url: '/api/marketplace-expansion-page?limit=1', headers: { 'x-pokoin-game': 'one_piece' } };
  assert.equal(gameSelectedOutsideUrl(req), true);
  const withGame = { url: '/api/marketplace-expansion-page?game=one_piece', headers: { 'x-pokoin-game': 'one_piece' } };
  assert.equal(gameSelectedOutsideUrl(withGame), false);
  assert.equal(gameSelectedOutsideUrl({ url: '/x', headers: {} }), false);
});

test('gameSelectedOutsideUrl: satellite Origin without ?game= is a hit, main origin is not', () => {
  const satellite = { url: '/api/marketplace-expansion-page', headers: { Origin: 'https://onepiece.pokoin.com' } };
  assert.equal(gameSelectedOutsideUrl(satellite), true);
  const main = { url: '/api/marketplace-expansion-page', headers: { Origin: 'https://pokoin.com' } };
  assert.equal(gameSelectedOutsideUrl(main), false);
});

test('writeHead wrapper: game selected outside the URL forces no-store', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const poisoned = await get(port, '/cacheable', { 'x-pokoin-game': 'one_piece' });
    assert.equal(poisoned.status, 200);
    assert.match(String(poisoned.headers['cache-control']), /private, no-store/);
    assert.match(String(poisoned.headers['cdn-cache-control'] || ''), /no-store/);

    const withGame = await get(port, '/cacheable?game=one_piece', { 'x-pokoin-game': 'one_piece' });
    assert.equal(withGame.status, 200);
    assert.equal(withGame.headers['cache-control'], 'public, max-age=600');
    assert.equal(withGame.headers['cdn-cache-control'], undefined);

    const satellite = await get(port, '/cacheable', { Origin: 'https://onepiece.pokoin.com' });
    assert.match(String(satellite.headers['cache-control']), /no-store/);

    const main = await get(port, '/cacheable', { Origin: 'https://pokoin.com' });
    assert.equal(main.headers['cache-control'], 'public, max-age=600');
  } finally {
    server.close();
  }
});

test('trusted proxy rewrites client IP headers', async () => {
  const saved = process.env.POKOIN_TRUSTED_PROXY_CIDRS;
  const server = await startServer();
  const port = server.address().port;
  try {
    process.env.POKOIN_TRUSTED_PROXY_CIDRS = '10.99.0.0/16';
    const untrusted = await get(port, '/clientip', {
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '1.2.3.4',
    });
    assert.equal(untrusted.status, 200);
    const untrustedBody = JSON.parse(untrusted.body);
    assert.equal(untrustedBody.cf, '127.0.0.1');
    assert.equal(untrustedBody.xff, '127.0.0.1');

    process.env.POKOIN_TRUSTED_PROXY_CIDRS = '127.0.0.1/32';
    const trusted = await get(port, '/clientip', {
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '1.2.3.4',
    });
    assert.equal(trusted.status, 200);
    const trustedBody = JSON.parse(trusted.body);
    assert.equal(trustedBody.cf, '1.2.3.4');
    assert.equal(trustedBody.xff, '1.2.3.4');
  } finally {
    server.close();
    if (saved === undefined) delete process.env.POKOIN_TRUSTED_PROXY_CIDRS;
    else process.env.POKOIN_TRUSTED_PROXY_CIDRS = saved;
  }
});
