'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, _test } = require('./news-stats');

function response() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return res;
}

const PROFILES = new Map([
  ['admin1', { role: 'admin' }],
  ['reader1', { username: 'misty' }],
]);

function fakeFirestore() {
  return {
    collection: () => ({ doc: (id) => ({ get: async () => ({ data: () => PROFILES.get(id) }) }) }),
  };
}

const ROWS = {
  articles: [
    { article_id: 'art_a', article_path: '/news/a', impressions: '200', clicks: '20', views: '50', readers: '40' },
    { article_id: 'art_b', article_path: '/news/b', impressions: '0', clicks: '0', views: '80', readers: '70' },
  ],
  depth: [{ article_id: 'art_a', d25: '40', d50: '30', d75: '20', d100: '10' }],
  time: [{ article_id: 'art_a', median_seconds: 62.5, p75_seconds: 120, quick_exits: '5', timed: '25' }],
  daily: [{ day: '2026-10-07', views: '130', clicks: '20', impressions: '200' }],
  positions: [{ position: 1, impressions: '100', clicks: '15' }],
  overall: [{ median_seconds: 48 }],
};

function setup() {
  const calls = [];
  const handler = createHandler({
    firestore: fakeFirestore,
    verify: async (req) => {
      const token = String(req.headers?.authorization || '').replace('Bearer ', '');
      if (PROFILES.has(token)) return { uid: token };
      throw new Error('bad token');
    },
    query: async (sql, params) => {
      calls.push(params);
      const key = Object.keys(_test.SQL).find((name) => _test.SQL[name] === sql);
      return { rows: ROWS[key] };
    },
    now: () => new Date('2026-10-08T12:00:00Z'),
  });
  return { calls, handler };
}

test('signed-out callers get 401', async () => {
  const { handler } = setup();
  const res = response();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['cache-control'], 'private, no-store');
});

test('signed-in non-admins get 403 and no data', async () => {
  const { calls, handler } = setup();
  const res = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer reader1' }, query: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('admins get merged per-article stats', async () => {
  const { calls, handler } = setup();
  const res = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin1' }, query: { days: '7' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.deepEqual(calls[0], [7]);
  const body = res.body;
  assert.equal(body.days, 7);
  assert.deepEqual(body.articles.map((row) => row.articleId), ['art_b', 'art_a'], 'sorted by views');
  const a = body.articles.find((row) => row.articleId === 'art_a');
  assert.equal(a.ctr, 0.1);
  assert.deepEqual(a.depth, { 25: 0.8, 50: 0.6, 75: 0.4, 100: 0.2 });
  assert.equal(a.medianSeconds, 63);
  assert.equal(a.quickExitShare, 0.2);
  const b = body.articles.find((row) => row.articleId === 'art_b');
  assert.equal(b.ctr, null);
  assert.equal(b.medianSeconds, null);
  assert.deepEqual(body.totals, { impressions: 200, clicks: 20, views: 130, readers: 110, ctr: 0.1, medianSeconds: 48 });
  assert.deepEqual(body.positions, [{ position: 1, impressions: 100, clicks: 15, ctr: 0.15 }]);
  assert.equal(body.daily[0].day, '2026-10-07');
});

test('days outside 1..365 fall back to 30', () => {
  assert.equal(_test.cleanDays('0'), 30);
  assert.equal(_test.cleanDays('400'), 30);
  assert.equal(_test.cleanDays('abc'), 30);
  assert.equal(_test.cleanDays('90'), 90);
});

test('admin also comes from the token claim or a roles list', async () => {
  assert.equal(await _test.callerIsAdmin(fakeFirestore(), { uid: 'x', admin: true }), true);
  const roles = { collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({ roles: 'silver, Admin' }) }) }) }) };
  assert.equal(await _test.callerIsAdmin(roles, { uid: 'y' }), true);
  assert.equal(await _test.callerIsAdmin(fakeFirestore(), { uid: 'reader1' }), false);
});

test('only GET is allowed', async () => {
  const { handler } = setup();
  const res = response();
  await handler({ method: 'POST', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
