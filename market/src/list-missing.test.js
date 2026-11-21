import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchListSnapshot, listSnapshotUrls, nameListKey, readSnapshotUrls } from './api.js';

// PH-C038 client point 1: `/api/marketplace-list` answers a key it has never
// built with 404 `{"error":"List not built yet.","missing":true}`
// (pokoin-rust/apps/api/src/lists.rs:318). The `&dict=` URL and the plain URL
// name the same kind+key, so after that answer the second request is not a
// retry of a flaky route: it is the same missing key asked twice. Only a
// dictionary failure still falls through, because there the plain URL is a
// different request.
//
// Every case asks its own key: the local-first reader keeps a 200 in memory for
// the whole process, so a repeated key would answer without the network.

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const MISSING = { error: 'List not built yet.', missing: true };

/** A Chromium with RFC 9842 support: `listSnapshotUrls` hands back both URLs. */
function useCompressionDictionary() {
  globalThis.document = {
    head: { appendChild: () => {} },
    createElement: () => ({ relList: { supports: (rel) => rel === 'compression-dictionary' } }),
  };
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => items.set(String(key), String(value)),
    removeItem: (key) => items.delete(String(key)),
  };
}

function stubFetch(answer) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    return answer(href, asked.length);
  };
  return {
    asked,
    restore: () => {
      globalThis.fetch = original;
      delete globalThis.document;
      delete globalThis.localStorage;
    },
  };
}

const dictOf = (urls) => urls.filter((url) => url.includes('&dict='));

test('a dict= answer of missing:true asks the plain URL not at all', async () => {
  const urls = listSnapshotUrls('name', nameListKey('Pikachu'), { supported: true });
  assert.equal(urls.length, 2, 'the dictionary URL first, then the plain one');
  const seen = [];
  await assert.rejects(
    readSnapshotUrls(urls, async (url) => {
      seen.push(url);
      throw Object.assign(new Error(MISSING.error), { status: 404, body: MISSING });
    }),
    'the miss is still the error the caller saw',
  );
  assert.deepEqual(seen, dictOf(urls), 'exactly one request for a key that does not exist');
});

test('any other dict= failure still retries the plain URL', async () => {
  const urls = listSnapshotUrls('name', nameListKey('Charizard ex'), { supported: true });
  const cases = [
    new TypeError('dictionary mismatch'),
    Object.assign(new Error('gateway'), { status: 503, body: { error: 'upstream down' } }),
    Object.assign(new Error('gone'), { status: 410, body: { error: 'list dropped' } }),
  ];
  for (const error of cases) {
    const seen = [];
    const value = await readSnapshotUrls(urls, async (url) => {
      seen.push(url);
      if (url === dictOf(urls)[0]) throw error;
      return { ok: true };
    });
    assert.deepEqual(seen, urls, `${error.message} falls through to the plain URL`);
    assert.deepEqual(value, { ok: true }, `${error.message} still lands the plain snapshot`);
  }
});

test('an aborted dict= read does not retry either', async () => {
  const urls = listSnapshotUrls('name', nameListKey('Mewtwo'), { supported: true });
  const seen = [];
  await assert.rejects(readSnapshotUrls(urls, async (url) => {
    seen.push(url);
    throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  }));
  assert.deepEqual(seen, dictOf(urls));
});

test('the real read of a name that is not built asks /api/marketplace-list once', async () => {
  useCompressionDictionary();
  const key = nameListKey('Mamoswine');
  const { asked, restore } = stubFetch(async () => response(MISSING, 404));
  try {
    assert.equal(await fetchListSnapshot('name', key), null, 'a missing list answers null, so the caller searches');
    const lists = asked.filter((href) => href.includes('/api/marketplace-list?'));
    assert.equal(lists.length, 1, 'one request for a key the builder has never made');
    assert.match(lists[0], /&dict=/, 'the dictionary URL, which is the one that was asked');
  } finally {
    restore();
  }
});

test('a dict= list failure of another kind still lands the plain snapshot', async () => {
  useCompressionDictionary();
  const key = nameListKey('Blastoise');
  const snapshot = { cards: [{ id: '810001', name: 'Blastoise' }], hasMore: false, count: 1 };
  const { asked, restore } = stubFetch(async (href) => (href.includes('&dict=')
    ? response({ error: 'dictionary bypass' }, 500)
    : response(snapshot)));
  try {
    assert.deepEqual(await fetchListSnapshot('name', key), snapshot, 'the fallback read is the answer');
    assert.deepEqual(
      asked.map((href) => (href.includes('&dict=') ? 'dict' : 'plain')),
      ['dict', 'plain'],
      'both requests went out, in order',
    );
  } finally {
    restore();
  }
});
