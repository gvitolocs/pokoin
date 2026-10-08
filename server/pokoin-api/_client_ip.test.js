'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_TRUSTED_PROXIES,
  applyTrustedClientIp,
  clientIp,
  isTrusted,
  normalizeIp,
  parseTrustedProxies,
  resolveClientIp,
} = require('./_client_ip.js');

function req(remoteAddress, headers = {}) {
  return { headers, socket: { remoteAddress } };
}

const savedTrusted = process.env.POKOIN_TRUSTED_PROXY_CIDRS;
test.afterEach(() => {
  if (savedTrusted === undefined) delete process.env.POKOIN_TRUSTED_PROXY_CIDRS;
  else process.env.POKOIN_TRUSTED_PROXY_CIDRS = savedTrusted;
});

test('genuine Cloudflare request: cf-connecting-ip wins over client XFF', () => {
  const result = resolveClientIp(req('127.0.0.1', {
    'cf-connecting-ip': '203.0.113.7',
    'x-forwarded-for': '6.6.6.6, 203.0.113.7',
  }));
  assert.deepEqual(result, { ip: '203.0.113.7', source: 'cf-connecting-ip', peer: '127.0.0.1', trustedPeer: true });
});

test('trusted edge without cf-connecting-ip falls back to x-forwarded-for', () => {
  const result = resolveClientIp(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.2' }));
  assert.equal(result.ip, '198.51.100.2');
  assert.equal(result.source, 'x-forwarded-for');
});

test('IPv4-mapped loopback peer normalizes to 127.0.0.1', () => {
  const result = resolveClientIp(req('::ffff:127.0.0.1'));
  assert.deepEqual(result, { ip: '127.0.0.1', source: 'peer', peer: '127.0.0.1', trustedPeer: true });
});

test('direct LAN request with spoofed proxy headers is ignored', () => {
  const result = resolveClientIp(req('192.168.178.99', {
    'cf-connecting-ip': '1.2.3.4',
    'x-forwarded-for': '1.2.3.4',
  }));
  assert.deepEqual(result, { ip: '192.168.178.99', source: 'peer', peer: '192.168.178.99', trustedPeer: false });
});

test('malformed cf-connecting-ip values are ignored', () => {
  const cases = [
    { 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' },
    { 'cf-connecting-ip': ['1.2.3.4', '5.6.7.8'] },
    { 'cf-connecting-ip': 'not-an-ip' },
  ];
  for (const headers of cases) {
    const result = resolveClientIp(req('127.0.0.1', headers));
    assert.equal(result.ip, '127.0.0.1', JSON.stringify(headers));
    assert.equal(result.source, 'peer', JSON.stringify(headers));
  }
});

test('x-forwarded-for walks right to left, skipping trusted proxies', () => {
  const garbage = resolveClientIp(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, garbage' }));
  assert.equal(garbage.ip, '127.0.0.1');
  assert.equal(garbage.source, 'peer');

  const good = resolveClientIp(req('127.0.0.1', { 'x-forwarded-for': 'garbage, 1.2.3.4' }));
  assert.equal(good.ip, '1.2.3.4');
  assert.equal(good.source, 'x-forwarded-for');

  const long = resolveClientIp(req('127.0.0.1', { 'x-forwarded-for': Array.from({ length: 21 }, (_, i) => `10.9.${i}.1`).join(', ') }));
  assert.equal(long.ip, '127.0.0.1');
  assert.equal(long.source, 'peer');

  const skip = resolveClientIp(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 127.0.0.1' }));
  assert.equal(skip.ip, '1.2.3.4');
  assert.equal(skip.source, 'x-forwarded-for');
});

test('POKOIN_TRUSTED_PROXY_CIDRS extends the trusted peer set', () => {
  process.env.POKOIN_TRUSTED_PROXY_CIDRS = '10.42.0.0/16';
  const inside = resolveClientIp(req('10.42.0.84', { 'cf-connecting-ip': '203.0.113.9' }));
  assert.equal(inside.ip, '203.0.113.9');
  assert.equal(inside.source, 'cf-connecting-ip');
  const outside = resolveClientIp(req('10.43.1.1', { 'cf-connecting-ip': '203.0.113.9' }));
  assert.equal(outside.ip, '10.43.1.1');
  assert.equal(outside.source, 'peer');
  assert.equal(outside.trustedPeer, false);
});

test('IPv6 headers are normalized: case, brackets, zone, v4-mapped', () => {
  const upper = resolveClientIp(req('127.0.0.1', { 'cf-connecting-ip': '2001:DB8::1' }));
  assert.equal(upper.ip, '2001:db8::1');
  assert.equal(normalizeIp('[2001:db8::2]'), '2001:db8::2');
  assert.equal(normalizeIp('2001:db8::3%eth0'), '2001:db8::3');
  assert.equal(normalizeIp('::FFFF:1.2.3.4'), '1.2.3.4');
});

test('parseTrustedProxies accepts CIDRs and bare IPs, rejects garbage', () => {
  assert.throws(() => parseTrustedProxies('nope'), /invalid trusted proxy entry: nope/);
  const list = parseTrustedProxies('10.0.0.0/8, 192.168.1.1, ::1');
  assert.equal(isTrusted('10.1.2.3', list), true);
  assert.equal(isTrusted('11.0.0.1', list), false);
  assert.equal(isTrusted('192.168.1.1', list), true);
  assert.equal(isTrusted('192.168.1.2', list), false);
  assert.equal(isTrusted('::1', list), true);
  assert.equal(isTrusted('', list), false);
  assert.equal(DEFAULT_TRUSTED_PROXIES, '127.0.0.1/32,::1/128');
});

test('normalizeIp rejects ports and junk', () => {
  assert.equal(normalizeIp('1.2.3.4:80'), '');
  assert.equal(normalizeIp('1.2.3'), '');
  assert.equal(normalizeIp('  9.9.9.9  '), '9.9.9.9');
  assert.equal(normalizeIp(''), '');
});

test('applyTrustedClientIp rewrites every proxy header (any case) and stamps req', () => {
  const r = req('127.0.0.1', {
    'X-Forwarded-For': '6.6.6.6, 1.1.1.1',
    'CF-Connecting-IP': '203.0.113.9',
    'X-Real-IP': '5.5.5.5',
    'true-client-ip': '4.4.4.4',
    'X-Client-IP': '3.3.3.3',
    'x-pokoin-game': 'one_piece',
  });
  const result = applyTrustedClientIp(r);
  assert.equal(result.ip, '203.0.113.9');
  assert.equal(r.headers['cf-connecting-ip'], '203.0.113.9');
  assert.equal(r.headers['x-forwarded-for'], '203.0.113.9');
  assert.equal(r.headers['x-real-ip'], '203.0.113.9');
  assert.equal(r.headers['x-pokoin-client-ip'], '203.0.113.9');
  assert.equal(r.headers['X-Forwarded-For'], undefined);
  assert.equal(r.headers['CF-Connecting-IP'], undefined);
  assert.equal(r.headers['X-Real-IP'], undefined);
  assert.equal(r.headers['true-client-ip'], undefined);
  assert.equal(r.headers['X-Client-IP'], undefined);
  assert.equal(r.headers['x-pokoin-game'], 'one_piece');
  assert.equal(r.pokoinClientIp, '203.0.113.9');
  assert.equal(r.pokoinClientIpSource, 'cf-connecting-ip');
  assert.equal(clientIp(r), '203.0.113.9');
});

test('clientIp falls back to resolution when req.pokoinClientIp is missing', () => {
  assert.equal(clientIp(req('192.168.0.5')), '192.168.0.5');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' }, pokoinClientIp: '' }), '10.0.0.1');
  const r = { headers: {}, socket: { remoteAddress: '10.0.0.1' }, pokoinClientIp: '9.9.9.9' };
  assert.equal(clientIp(r), '9.9.9.9');
});
