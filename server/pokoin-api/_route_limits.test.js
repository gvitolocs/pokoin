'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ROUTE_LIMITS, enforceRouteLimits } = require('./_route_limits');

function fakeRes() {
  const res = { headers: {}, written: undefined, statusCode: undefined };
  res.writeHead = function (status, headers) {
    this.statusCode = status;
    if (headers && typeof headers === 'object') Object.assign(this.headers, headers);
    return this;
  };
  res.end = function (body) {
    this.written = body;
  };
  return res;
}

function fakeReq({ method, url, ip = '198.51.100.77' }) {
  return { method, url, pokoinClientIp: ip, headers: { 'cf-connecting-ip': ip } };
}

test('ROUTE_LIMITS covers the three foreign POST routes, frozen', () => {
  assert.equal(ROUTE_LIMITS.length, 3);
  assert.ok(Object.isFrozen(ROUTE_LIMITS));
  for (const entry of ROUTE_LIMITS) {
    assert.equal(entry.method, 'POST');
    assert.ok(entry.scope && entry.limit >= 1 && entry.windowSeconds >= 1);
    assert.ok(Object.isFrozen(entry));
  }
  const byPath = Object.fromEntries(ROUTE_LIMITS.map((e) => [e.path, e]));
  assert.equal(byPath['/api/register-email'].limit, 10);
  assert.equal(byPath['/api/verify-email-signup'].limit, 30);
  assert.equal(byPath['/api/pokoin-assistant'].limit, 20);
});

test('allowed verdict: request passes through untouched', async () => {
  const calls = [];
  const limiter = async (opts) => { calls.push(opts); return { allowed: true, backend: 'postgres', count: 1, retryAfterSec: 0 }; };
  const res = fakeRes();
  const rejected = await enforceRouteLimits(fakeReq({ method: 'POST', url: '/api/register-email?x=1' }), res, { limiter });
  assert.equal(rejected, false);
  assert.equal(res.written, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'register-email-ip');
  assert.equal(calls[0].identity, '198.51.100.77');
});

test('denied verdict: 429 with the rate_limited body', async () => {
  const res = fakeRes();
  const rejected = await enforceRouteLimits(
    fakeReq({ method: 'POST', url: '/api/verify-email-signup/' }),
    res,
    { limiter: async () => ({ allowed: false, backend: 'postgres', count: 31, retryAfterSec: 3600 }) },
  );
  assert.equal(rejected, true);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['retry-after'], '3600');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(res.written), { error: 'Too many requests. Try again later.', code: 'rate_limited' });
});

test('backend error fails closed with the same 429 body', async () => {
  const res = fakeRes();
  const rejected = await enforceRouteLimits(
    fakeReq({ method: 'POST', url: '/api/pokoin-assistant' }),
    res,
    { limiter: async () => ({ allowed: false, backend: 'error', count: null, retryAfterSec: 60 }) },
  );
  assert.equal(rejected, true);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '60');
  assert.deepEqual(JSON.parse(res.written), { error: 'Too many requests. Try again later.', code: 'rate_limited' });
});

test('non-matching path and method are untouched, no limiter call', async () => {
  let called = false;
  const limiter = async () => { called = true; return { allowed: true, backend: 'postgres', count: 1, retryAfterSec: 0 }; };
  for (const { method, url } of [
    { method: 'GET', url: '/api/register-email' },
    { method: 'POST', url: '/api/register-email-verify' },
    { method: 'POST', url: '/api/other' },
    { method: 'POST', url: '/api/register-email/extra' },
  ]) {
    const res = fakeRes();
    const rejected = await enforceRouteLimits(fakeReq({ method, url }), res, { limiter });
    assert.equal(rejected, false, `${method} ${url}`);
    assert.equal(res.written, undefined, `${method} ${url}`);
  }
  assert.equal(called, false);
});

test('query string is ignored when matching', async () => {
  const res = fakeRes();
  const rejected = await enforceRouteLimits(
    fakeReq({ method: 'POST', url: '/api/register-email?next=%2Fmarketplace&a=1' }),
    res,
    { limiter: async () => ({ allowed: false, backend: 'postgres', count: 11, retryAfterSec: 3600 }) },
  );
  assert.equal(rejected, true);
  assert.equal(res.statusCode, 429);
});
