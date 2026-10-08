'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, _test } = require('./news-event');

function response() {
  const res = { statusCode: 0, headers: {}, body: null, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => { res.ended = true; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return res;
}

function setup({ allowed = true } = {}) {
  const writes = [];
  const handler = createHandler({
    writeQuery: async (sql, params) => { writes.push({ sql, params }); },
    limit: async () => ({ allowed }),
    now: () => new Date('2026-10-08T12:00:00Z'),
  });
  return { writes, handler };
}

const BASE = { articleId: 'art_story-abc_en', articlePath: '/news/delta-reign-prerelease-promos-revealed', pv: 'abcdEFGH12345678' };
const UA = 'Mozilla/5.0 (Macintosh) Safari/605.1.15';

function request(body, headers = {}) {
  return { method: 'POST', headers: { 'user-agent': UA, 'cf-connecting-ip': '203.0.113.9', ...headers }, body };
}

test('a valid batch answers 204 and writes one multi-row insert', async () => {
  const { writes, handler } = setup();
  const res = response();
  await handler(request({ events: [
    { ...BASE, type: 'impression', source: '/news', position: 3 },
    { ...BASE, type: 'view', source: 'google.com' },
  ] }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /insert into public\.news_events/);
  assert.equal(writes[0].params.length, 18);
  assert.equal(writes[0].params[0], 'impression');
  assert.equal(writes[0].params[6], 3);
  assert.equal(writes[0].params[9], 'view');
  assert.equal(writes[0].params[15], null, 'position is only kept for impression/click');
});

test('a JSON string body (sendBeacon) is parsed', async () => {
  const { writes, handler } = setup();
  const res = response();
  await handler(request(JSON.stringify({ events: [{ ...BASE, type: 'view' }] })), res);
  assert.equal(res.statusCode, 204);
  assert.equal(writes.length, 1);
});

test('bad JSON and all-invalid batches are 400', async () => {
  const { writes, handler } = setup();
  const bad = response();
  await handler(request('{not json'), bad);
  assert.equal(bad.statusCode, 400);
  const invalid = response();
  await handler(request({ events: [{ ...BASE, type: 'hover' }, { ...BASE, type: 'view', articleId: 'nope' }] }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(writes.length, 0);
});

test('invalid events are dropped, depth must be a milestone, seconds are clamped', () => {
  const events = _test.cleanEvents([
    { ...BASE, type: 'read', depth: 30 },
    { ...BASE, type: 'read', depth: 75 },
    { ...BASE, type: 'leave', seconds: 99999, depth: 140 },
    { ...BASE, type: 'leave' },
    { ...BASE, type: 'view', pv: 'x' },
    { ...BASE, type: 'click', articlePath: '/marketplace/x' },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].depth, 75);
  assert.equal(events[1].seconds, 7200);
  assert.equal(events[1].depth, 100);
});

test('batches are capped at 40 events', () => {
  const many = Array.from({ length: 60 }, () => ({ ...BASE, type: 'view' }));
  assert.equal(_test.cleanEvents(many).length, _test.MAX_EVENTS);
});

test('bots and rate-limited visitors get 204 and nothing is written', async () => {
  const bot = setup();
  const botRes = response();
  await bot.handler(request({ events: [{ ...BASE, type: 'view' }] }, { 'user-agent': 'Googlebot/2.1' }), botRes);
  assert.equal(botRes.statusCode, 204);
  assert.equal(bot.writes.length, 0);

  const limited = setup({ allowed: false });
  const limitedRes = response();
  await limited.handler(request({ events: [{ ...BASE, type: 'view' }] }), limitedRes);
  assert.equal(limitedRes.statusCode, 204);
  assert.equal(limited.writes.length, 0);
});

test('only POST is allowed', async () => {
  const { handler } = setup();
  const res = response();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('the visitor hash is stable within a day, changes across days, and hides the ip', () => {
  const a = _test.visitorHash({ ip: '203.0.113.9', ua: UA, day: '2026-10-08', salt: 's' });
  const b = _test.visitorHash({ ip: '203.0.113.9', ua: UA, day: '2026-10-08', salt: 's' });
  const c = _test.visitorHash({ ip: '203.0.113.9', ua: UA, day: '2026-10-09', salt: 's' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 24);
  assert.ok(!a.includes('203'));
});

test('the write stores the hash, never the raw ip', async () => {
  const { writes, handler } = setup();
  await handler(request({ events: [{ ...BASE, type: 'view' }] }), response());
  const visitor = writes[0].params[4];
  assert.match(visitor, /^[0-9a-f]{24}$/);
  assert.ok(!writes[0].params.includes('203.0.113.9'));
});
