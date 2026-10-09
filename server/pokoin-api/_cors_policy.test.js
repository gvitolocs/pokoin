'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  PRODUCTION_ORIGINS,
  SATELLITE_HOSTS,
  allowedOrigins,
  applyCorsHeaders,
  corsHeaders,
  isPreflight,
  mergeCorsIntoHeaders,
} = require('./_cors_policy.js');

function req(headers = {}) {
  return { method: 'GET', headers };
}

const DEV = { NODE_ENV: 'development' };
const PROD = { NODE_ENV: 'production' };

test('allowed origin is echoed with credentials', () => {
  const headers = corsHeaders(req({ origin: 'https://pokoin.com' }), PROD);
  assert.equal(headers['access-control-allow-origin'], 'https://pokoin.com');
  assert.equal(headers['access-control-allow-credentials'], 'true');
  assert.equal(headers.vary, 'Origin');
  assert.equal(headers['access-control-allow-methods'], 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  assert.equal(headers['access-control-max-age'], '86400');
});

test('disallowed origin gets * and no credentials, never echoed', () => {
  const headers = corsHeaders(req({ origin: 'https://evil.example' }), PROD);
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-allow-credentials'], undefined);
});

test('lookalike and http origins are not allowed', () => {
  for (const origin of ['https://pokoin.com.evil.example', 'https://evilpokoin.com', 'http://pokoin.com']) {
    const headers = corsHeaders(req({ origin }), PROD);
    assert.equal(headers['access-control-allow-origin'], '*', origin);
    assert.equal(headers['access-control-allow-credentials'], undefined, origin);
  }
});

test('localhost is dev-only: never allowed in production', () => {
  assert.equal(corsHeaders(req({ origin: 'http://localhost:5173' }), PROD)['access-control-allow-origin'], '*');
  assert.equal(corsHeaders(req({ origin: 'https://localhost:5173' }), PROD)['access-control-allow-origin'], '*');
  const dev = corsHeaders(req({ origin: 'http://localhost:5173' }), DEV);
  assert.equal(dev['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(dev['access-control-allow-credentials'], 'true');
});

test('POKOIN_CORS_EXTRA_ORIGINS adds valid origins only', () => {
  const env = { NODE_ENV: 'production', POKOIN_CORS_EXTRA_ORIGINS: 'https://staging.example, not-a-url' };
  assert.equal(corsHeaders(req({ origin: 'https://staging.example' }), env)['access-control-allow-origin'], 'https://staging.example');
  assert.equal(corsHeaders(req({ origin: 'https://not-a-url' }), env)['access-control-allow-origin'], '*');
  // A URL with a path normalizes to its origin.
  const slash = { NODE_ENV: 'production', POKOIN_CORS_EXTRA_ORIGINS: 'https://other.example/' };
  assert.equal(corsHeaders(req({ origin: 'https://other.example' }), slash)['access-control-allow-origin'], 'https://other.example');
});

test('Origin null and missing origin get *', () => {
  assert.equal(corsHeaders(req({ origin: 'null' }), PROD)['access-control-allow-origin'], '*');
  assert.equal(corsHeaders(req({}), PROD)['access-control-allow-origin'], '*');
  assert.equal(corsHeaders(req({}), PROD)['access-control-allow-credentials'], undefined);
});

test('allow-headers keeps valid tokens, drops the rest', () => {
  const headers = corsHeaders(req({ 'access-control-request-headers': 'authorization, bad header, x-pokoin-game' }), PROD);
  assert.equal(headers['access-control-allow-headers'], 'authorization,x-pokoin-game');
  const defaults = corsHeaders(req({}), PROD);
  assert.equal(defaults['access-control-allow-headers'], 'authorization,content-type,accept,x-pokoin-game,x-pokoin-host');
  const flood = corsHeaders(req({ 'access-control-request-headers': Array.from({ length: 40 }, (_, i) => `h${i}`).join(',') }), PROD);
  assert.equal(flood['access-control-allow-headers'].split(',').length, 32);
});

test('applyCorsHeaders replaces handler-set CORS headers on the response', () => {
  const res = {
    set: new Map(),
    setHeader(name, value) { this.set.set(name.toLowerCase(), value); },
    removeHeader(name) { this.set.delete(name.toLowerCase()); },
  };
  res.setHeader('access-control-allow-origin', 'https://evil.example');
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('vary', 'Accept-Encoding');
  const out = applyCorsHeaders(res, req({ origin: 'https://pokoin.com' }), PROD);
  assert.equal(out['access-control-allow-origin'], 'https://pokoin.com');
  assert.equal(res.set.get('access-control-allow-origin'), 'https://pokoin.com');
  assert.equal(res.set.get('access-control-allow-credentials'), 'true');
  assert.equal(res.set.get('vary'), 'Origin');
  const open = {
    set: new Map(),
    setHeader(name, value) { this.set.set(name.toLowerCase(), value); },
    removeHeader(name) { this.set.delete(name.toLowerCase()); },
  };
  applyCorsHeaders(open, req({ origin: 'https://evil.example' }), PROD);
  assert.equal(open.set.get('access-control-allow-origin'), '*');
  assert.equal(open.set.get('access-control-allow-credentials'), undefined);
});

test('mergeCorsIntoHeaders makes the policy authoritative over handler headers', () => {
  const merged = mergeCorsIntoHeaders({
    'Access-Control-Allow-Origin': '*',
    'access-control-allow-credentials': 'true',
    Vary: 'Accept-Encoding',
    'content-type': 'application/json',
  }, req({ origin: 'https://pokoin.com' }), PROD);
  assert.equal(merged['content-type'], 'application/json');
  assert.equal(merged['Access-Control-Allow-Origin'], undefined);
  assert.equal(merged['access-control-allow-credentials'], 'true');
  assert.equal(merged.Vary, undefined);
  assert.equal(merged.vary, 'Origin, Accept-Encoding');
  assert.equal(merged['access-control-allow-origin'], 'https://pokoin.com');
  const passthrough = mergeCorsIntoHeaders(null, req({}), PROD);
  assert.equal(passthrough['access-control-allow-origin'], '*');
});

test('isPreflight is OPTIONS only', () => {
  assert.equal(isPreflight({ method: 'OPTIONS' }), true);
  assert.equal(isPreflight({ method: 'GET' }), false);
  assert.equal(isPreflight(null), false);
});

test('every satellite host in _cardtrader_game_ingest.js is a production origin (drift guard)', () => {
  const text = fs.readFileSync(path.join(__dirname, '_cardtrader_game_ingest.js'), 'utf8');
  const hosts = [...text.matchAll(/'([a-z0-9-]+\.pokoin\.com)'/g)].map((match) => match[1]);
  assert.ok(hosts.length >= 16, `expected satellite hosts in _cardtrader_game_ingest.js, got ${hosts.length}`);
  const origins = new Set(PRODUCTION_ORIGINS);
  for (const host of new Set(hosts)) {
    assert.ok(origins.has(`https://${host}`), `missing https://${host} in PRODUCTION_ORIGINS`);
  }
  for (const host of SATELLITE_HOSTS) {
    assert.ok(origins.has(`https://${host}.pokoin.com`), `missing https://${host}.pokoin.com`);
  }
  assert.ok(Array.isArray(PRODUCTION_ORIGINS) && Object.isFrozen(PRODUCTION_ORIGINS));
});

test('allowedOrigins returns a Set of production plus dev origins', () => {
  const prod = allowedOrigins(PROD);
  assert.ok(prod.has('https://pokoin.com'));
  assert.ok(!prod.has('http://localhost:5173'));
  const dev = allowedOrigins(DEV);
  assert.ok(dev.has('http://localhost:5173'));
  assert.ok(dev.has('http://localhost:4173'));
  assert.ok(dev.has('http://127.0.0.1:5173'));
});

test('unset NODE_ENV is production: localhost is never echoed or credentialed', () => {
  const h = corsHeaders({ headers: { origin: 'http://localhost:5173' } }, {});
  assert.equal(h['access-control-allow-origin'], '*');
  assert.equal(h['access-control-allow-credentials'], undefined);
});
