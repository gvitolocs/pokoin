import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchListSnapshot, nameListKey } from './api.js';

// PH-C038 client point 2: one `{"missing":true}` answer says the key is not in
// `public.marketplace_list_snapshots`, and the desk asks the same key twice per
// page view (the mount read and the neighbour warm). The miss is therefore kept
// in memory for the 60 s the API itself gives it, so the second read answers
// null where a miss answers today and the caller takes the live search.
//
// Each case asks its own key: the answer for one key must not silence another.

const MISSING = { error: 'List not built yet.', missing: true };

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function useLocalStorage() {
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => items.set(String(key), String(value)),
    removeItem: (key) => items.delete(String(key)),
  };
}

/** fetch stub with its own request log and a clock the case can move forward. */
function stubFetch(answer, { delayMs = 0 } = {}) {
  const realNow = Date.now;
  let offset = 0;
  const asked = [];
  const original = globalThis.fetch;
  Date.now = () => realNow() + offset;
  globalThis.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return answer(href, asked.length);
  };
  return {
    asked,
    lists: () => asked.filter((href) => href.includes('/api/marketplace-list?')),
    advance: (ms) => { offset += ms; },
    restore: () => {
      globalThis.fetch = original;
      Date.now = realNow;
      delete globalThis.localStorage;
    },
  };
}

test('a second read of a missing key inside the window asks nothing, after it asks again', async () => {
  useLocalStorage();
  const key = nameListKey('Mamoswine');
  const { asked, lists, advance, restore } = stubFetch(async () => response(MISSING, 404));
  try {
    assert.equal(await fetchListSnapshot('name', key), null, 'the miss answers null, as today');
    assert.equal(lists().length, 1, 'the first read goes out');
    assert.equal(await fetchListSnapshot('name', key), null);
    assert.equal(lists().length, 1, 'the second read of the same key is remembered, not asked');
    assert.equal(await fetchListSnapshot('name', key, { prefetch: true }), null);
    assert.equal(lists().length, 1, 'nor does a warm read of it go out');
    advance(61_000);
    assert.equal(await fetchListSnapshot('name', key), null);
    assert.equal(lists().length, 2, 'past the window the key is asked about once more');
    assert.equal(asked.length, 2, 'and nothing else was requested');
  } finally {
    restore();
  }
});

test('two reads of one key in flight at the same time share the request', async () => {
  useLocalStorage();
  const key = nameListKey('Umbreon');
  const { lists, restore } = stubFetch(async () => response(MISSING, 404), { delayMs: 10 });
  try {
    const [desk, warm] = await Promise.all([
      fetchListSnapshot('name', key),
      fetchListSnapshot('name', key, { prefetch: true }),
    ]);
    assert.equal(desk, null);
    assert.equal(warm, null);
    assert.equal(lists().length, 1, 'one request for two readers of the same key');
  } finally {
    restore();
  }
});

test('a failure that does not say missing is not remembered', async () => {
  useLocalStorage();
  const key = nameListKey('Glaceon');
  const { lists, restore } = stubFetch(async () => response({ error: 'upstream down' }, 503));
  try {
    assert.equal(await fetchListSnapshot('name', key), null);
    assert.equal(await fetchListSnapshot('name', key), null);
    assert.equal(lists().length, 2, 'a route failure says nothing about the key, so it is asked again');
  } finally {
    restore();
  }
});

test('a remembered miss silences its own key only', async () => {
  useLocalStorage();
  const missing = nameListKey('Espeon');
  const built = nameListKey('Espeon VSTAR');
  assert.notEqual(missing, built, 'two different keys');
  const { lists, restore } = stubFetch(async (href) => (new URL(href).searchParams.get('key') === missing
    ? response(MISSING, 404)
    : response({ cards: [{ id: '810002', name: 'Espeon' }], hasMore: false, count: 1 })));
  try {
    assert.equal(await fetchListSnapshot('name', missing), null);
    assert.equal(await fetchListSnapshot('name', missing), null);
    assert.equal(lists().length, 1, 'the missing key asked once');
    const snapshot = await fetchListSnapshot('name', built);
    assert.equal(snapshot?.cards?.length, 1, 'another key is read normally');
    assert.equal(lists().length, 2, 'and asked on the network, miss cache or not');
  } finally {
    restore();
  }
});

test('the remembered misses are bounded: 500 kept, the oldest dropped', async () => {
  useLocalStorage();
  const { lists, restore } = stubFetch(async () => response(MISSING, 404));
  try {
    const first = '8000000001';
    for (let i = 0; i < 501; i += 1) {
      await fetchListSnapshot('name', `${first}${i}`);
    }
    assert.equal(lists().length, 501, 'each key asked once');
    await fetchListSnapshot('name', `${first}499`);
    assert.equal(lists().length, 501, 'a key still inside the bound is not asked again');
    await fetchListSnapshot('name', first);
    assert.equal(lists().length, 502, 'the oldest was dropped when the bound was passed');
  } finally {
    restore();
  }
});
