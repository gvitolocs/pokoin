'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, _test } = require('./news-comments');

function fakeFirestore() {
  const docs = new Map();
  let next = 1;
  const users = new Map([['u1', { username: 'ashketchum' }]]);
  const api = {
    docs,
    collection(name) {
      if (name === 'users') {
        return { doc: (id) => ({ get: async () => ({ exists: users.has(id), data: () => users.get(id) }) }) };
      }
      return {
        add: async (record) => { const id = `c${next++}`; docs.set(id, { ...record }); return { id }; },
        where: (field, op, value) => ({
          limit: () => ({
            get: async () => ({
              docs: [...docs.entries()].filter(([, data]) => data[field] === value).map(([id, data]) => ({ id, data: () => data })),
            }),
          }),
        }),
      };
    },
  };
  return api;
}

function response() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return res;
}

function setup({ allowed = true } = {}) {
  const db = fakeFirestore();
  const handler = createHandler({
    firestore: () => db,
    verify: async (req) => {
      if (req.headers?.authorization === 'Bearer good') return { uid: 'u1' };
      if (req.headers?.authorization === 'Bearer other') return { uid: 'u2', name: 'Misty' };
      throw new Error('bad token');
    },
    limit: async () => ({ allowed, retryAfterSec: 600 }),
    now: () => new Date('2026-10-05T12:00:00Z'),
  });
  return { db, handler };
}

const ARTICLE = { articleId: 'art_story-abc_en', articlePath: '/news/delta-reign-prerelease-promos-revealed' };

test('posting requires a Pokoin sign-in', async () => {
  const { handler } = setup();
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { ...ARTICLE, body: 'Nice promos' } }, res);
  assert.equal(res.statusCode, 401);
});

test('a new comment is stored as pending with the profile username and is not public yet', async () => {
  const { db, handler } = setup();
  const res = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { ...ARTICLE, body: '  Love the Espeon promo!  ' } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.comment.status, 'pending');
  const stored = [...db.docs.values()][0];
  assert.equal(stored.status, 'pending');
  assert.equal(stored.authorName, 'ashketchum');
  assert.equal(stored.body, 'Love the Espeon promo!');

  const anon = response();
  await handler({ method: 'GET', headers: {}, query: { articleId: ARTICLE.articleId } }, anon);
  assert.equal(anon.body.count, 0, 'pending comments are invisible to readers');
  assert.match(anon.headers['cache-control'], /public/);

  const own = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer good' }, query: { articleId: ARTICLE.articleId } }, own);
  assert.equal(own.body.mine.length, 1, 'the author sees their own pending comment');
  assert.equal(own.headers['cache-control'], 'private, no-store');

  const someoneElse = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer other' }, query: { articleId: ARTICLE.articleId } }, someoneElse);
  assert.equal(someoneElse.body.mine.length, 0);
});

test('only visible comments are listed, oldest first', async () => {
  const { db, handler } = setup();
  db.docs.set('a', { articleId: ARTICLE.articleId, status: 'visible', authorName: 'B', body: 'second', createdAt: '2026-10-05T11:00:00Z' });
  db.docs.set('b', { articleId: ARTICLE.articleId, status: 'visible', authorName: 'A', body: 'first', createdAt: '2026-10-05T10:00:00Z' });
  db.docs.set('c', { articleId: ARTICLE.articleId, status: 'rejected', authorName: 'S', body: 'spam', createdAt: '2026-10-05T09:00:00Z' });
  db.docs.set('d', { articleId: 'art_other_en', status: 'visible', authorName: 'X', body: 'elsewhere', createdAt: '2026-10-05T09:00:00Z' });
  const res = response();
  await handler({ method: 'GET', headers: {}, query: { articleId: ARTICLE.articleId } }, res);
  assert.deepEqual(res.body.comments.map((comment) => comment.body), ['first', 'second']);
  assert.equal(JSON.stringify(res.body).includes('spam'), false);
  assert.equal('uid' in res.body.comments[0], false, 'uids are never exposed');
});

test('validation: unknown article, empty or overlong body, rate limit', async () => {
  const { handler } = setup();
  const bad = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { articleId: 'x', articlePath: '/news/x', body: 'hi there' } }, bad);
  assert.equal(bad.statusCode, 400);
  const empty = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { ...ARTICLE, body: ' ' } }, empty);
  assert.equal(empty.statusCode, 400);
  const long = response();
  await handler({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { ...ARTICLE, body: 'a'.repeat(1501) } }, long);
  assert.equal(long.statusCode, 400);
  const limited = setup({ allowed: false });
  const slow = response();
  await limited.handler({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { ...ARTICLE, body: 'hello again' } }, slow);
  assert.equal(slow.statusCode, 429);
  assert.equal(slow.headers['retry-after'], '600');
});

test('game article paths are accepted; other paths are not', () => {
  assert.ok(_test.ARTICLE_PATH_RE.test('/one-piece/news/op-14-leaders-revealed'));
  assert.ok(_test.ARTICLE_PATH_RE.test('/news/delta-reign-prerelease-promos-revealed'));
  assert.ok(!_test.ARTICLE_PATH_RE.test('/marketplace/en/cards/1'));
  assert.ok(!_test.ARTICLE_PATH_RE.test('https://evil.example/news/x'));
  assert.equal(_test.cleanBody('a\u0000b\r\n\n\n\nc'), 'ab\n\nc');
});
