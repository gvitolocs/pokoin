import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalReader, FRESH_MS, localStorable, MAX_STALE_MS } from './local-read.js';

const URL_A = 'https://api.pokoin.com/api/marketplace-list?kind=set&key=surging-sparks&format=c1v2';

function setup({ rows = {}, answers = {}, storeDelayMs = 0 } = {}) {
  let clock = 1_000_000_000;
  const fetched = [];
  const puts = [];
  const confirms = [];
  const removed = [];
  const stored = new Map(Object.entries(rows));
  const reader = createLocalReader({
    now: () => clock,
    decode: (text) => JSON.parse(text),
    store: {
      get: async (url) => {
        if (storeDelayMs) await new Promise((resolve) => setTimeout(resolve, storeDelayMs));
        return stored.get(url) || null;
      },
      put: async (url, body, etag, savedAt) => {
        puts.push(url);
        stored.set(url, { body, savedAt });
      },
      confirm: async (url, savedAt) => confirms.push([url, savedAt]),
      remove: async (url) => {
        removed.push(url);
        stored.delete(url);
      },
    },
    fetchText: async (url, init) => {
      fetched.push({ url, init });
      const answer = answers[url];
      if (typeof answer === 'function') return answer(init);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw Object.assign(new Error('Request failed (404)'), { status: 404 });
      return { text: answer, etag: '' };
    },
  });
  return {
    reader, fetched, puts, confirms, removed, stored,
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('allowlist: public catalogue reads only, never personal or live-price routes', () => {
  const yes = [
    '/api/marketplace-list?kind=set&key=x&format=c1v2',
    'https://api.pokoin.com/api/marketplace-card-page?cardId=1&lang=en&slug=a',
    '/api/marketplace-related?cardId=1',
    '/api/marketplace-version-set?cardId=1',
    '/api/marketplace-expansion-page?limit=2000&format=c1',
    '/api/marketplace-expansion-page?slug=surging-sparks&limit=1',
    '/api/marketplace-artist-cards?summaries=1&limit=1000&format=c1',
    '/api/dictionary',
    '/api/marketplace-list?kind=set&key=x&game=magic',
  ];
  const no = [
    '/api/marketplace-card-page?cardId=1&includeOffers=1',
    '/api/marketplace-expansion-page?slug=x&limit=400&offset=0',
    '/api/marketplace-artist-cards?artistSlug=x&limit=240&tiles=1',
    '/api/marketplace-listings?cardId=1',
    '/api/marketplace-cart',
    '/api/marketplace-orders?action=sold-history',
    '/api/marketplace-checkout-quote',
    '/api/create-order-checkout-session',
    '/api/account-addresses',
    '/api/marketplace-seller-settings',
    '/api/scan-batch',
    '/api/poko-chat',
    '/api/marketplace-card-sales?cardId=1',
    '/api/marketplace-search-page?query=x',
    '/api/marketplace-home-page',
    'not a url at all',
  ];
  for (const url of yes) assert.equal(localStorable(url), true, url);
  for (const url of no) assert.equal(localStorable(url), false, url);
});

test('a miss reads the network once, stores the text, then answers from memory', async () => {
  const t = setup({ answers: { [URL_A]: '{"cards":[1]}' } });
  const [a, b] = await Promise.all([t.reader.read(URL_A), t.reader.read(URL_A)]);
  assert.deepEqual(a, { cards: [1] });
  assert.equal(a, b);
  assert.equal(t.fetched.length, 1);
  assert.deepEqual(t.puts, [URL_A]);
  assert.equal(t.stored.get(URL_A).body, '{"cards":[1]}');
  assert.equal(await t.reader.read(URL_A), a);
  assert.equal(t.fetched.length, 1);
  assert.equal(t.reader.peek(URL_A), a);
});

test('a stored copy younger than FRESH_MS answers, and the request that raced it is dropped', async () => {
  const t = setup({
    answers: {
      [URL_A]: (init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    },
  });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - 1000 });
  assert.deepEqual(await t.reader.read(URL_A), { v: 1 });
  await flush();
  assert.equal(t.fetched.length, 1);
  assert.equal(t.fetched[0].init.signal.aborted, true);
  assert.equal(t.reader.fresh(URL_A), true);
  // An onUpdate read gives the store its head start instead: no request at all.
  const u = setup();
  u.stored.set(URL_A, { body: '{"v":1}', savedAt: u.now() - 1000 });
  assert.deepEqual(await u.reader.read(URL_A, { onUpdate: () => {} }), { v: 1 });
  await flush();
  assert.equal(u.fetched.length, 0);
});

test('stale-while-revalidate: an old copy answers at once, an unchanged body only refreshes its date', async () => {
  const t = setup({ answers: { [URL_A]: '{"v":1}' } });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 10 });
  const updates = [];
  assert.deepEqual(await t.reader.read(URL_A, { onUpdate: (v) => updates.push(v) }), { v: 1 });
  await flush();
  await flush();
  assert.equal(t.fetched.length, 1);
  assert.equal(t.fetched[0].init.priority, 'low');
  assert.deepEqual(updates, []);
  assert.deepEqual(t.puts, []);
  assert.deepEqual(t.confirms.map(([url]) => url), [URL_A]);
  assert.equal(t.reader.fresh(URL_A), true);
});

test('stale-while-revalidate: a changed body is stored and reaches onUpdate and subscribers', async () => {
  const t = setup({ answers: { [URL_A]: '{"v":2}' } });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 10 });
  const heard = [];
  const unsubscribe = t.reader.subscribe(URL_A, (v) => heard.push(['sub', v]));
  const first = await t.reader.read(URL_A, { onUpdate: (v) => heard.push(['own', v]) });
  assert.deepEqual(first, { v: 1 });
  await flush();
  await flush();
  assert.deepEqual(heard, [['sub', { v: 2 }], ['own', { v: 2 }]]);
  assert.equal(t.stored.get(URL_A).body, '{"v":2}');
  assert.deepEqual(t.reader.peek(URL_A), { v: 2 });
  unsubscribe();
});

test('an onUpdate read shows the stored copy beside a plain read in flight, and joins that request', async () => {
  for (const [answer, expected] of [['{"v":2}', [{ v: 2 }]], ['{"v":1}', []]]) {
    let release;
    const t = setup({
      answers: { [URL_A]: () => new Promise((resolve) => { release = () => resolve({ text: answer }); }) },
    });
    t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 10 });
    // A route preload: may not show the old copy, so it waits for the network.
    const plain = t.reader.read(URL_A);
    await flush();
    assert.equal(t.fetched.length, 1);
    const updates = [];
    assert.deepEqual(await t.reader.read(URL_A, { onUpdate: (v) => updates.push(v) }), { v: 1 });
    assert.equal(t.fetched.length, 1, 'the revalidation is the request already in flight');
    release();
    assert.deepEqual(await plain, JSON.parse(answer));
    await flush();
    assert.deepEqual(updates, expected);
    assert.equal(t.fetched.length, 1);
  }
});

test('a slow store does not send a second request when the read in flight landed meanwhile', async () => {
  let release;
  const t = setup({
    storeDelayMs: 60,
    answers: {
      [URL_A]: () => (release
        ? { text: '{"v":2}' }
        : new Promise((resolve) => { release = () => resolve({ text: '{"v":2}' }); })),
    },
  });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 10 });
  const plain = t.reader.read(URL_A);
  await flush();
  const updates = [];
  // The desk mounts while the preload is still out; the preload lands before
  // the store answers (busy main thread, cold database).
  const desk = t.reader.read(URL_A, { onUpdate: (v) => updates.push(v) });
  release();
  assert.deepEqual(await plain, { v: 2 });
  assert.deepEqual(await desk, { v: 2 });
  assert.equal(t.fetched.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(t.fetched.length, 1);
  assert.deepEqual(updates, []);
});

test('a revalidation that finds the copy gone drops it: the next read shows the 404', async () => {
  const t = setup();
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 10 });
  const updates = [];
  assert.deepEqual(await t.reader.read(URL_A, { onUpdate: (v) => updates.push(v) }), { v: 1 });
  await flush();
  await flush();
  assert.deepEqual(updates, []);
  assert.deepEqual(t.removed, [URL_A]);
  assert.equal(t.reader.peek(URL_A), undefined);
  await assert.rejects(t.reader.read(URL_A, { onUpdate: () => {} }), (err) => err.status === 404);
  // Any other failure keeps the copy.
  const down = setup({ answers: { [URL_A]: Object.assign(new Error('Bad gateway'), { status: 502 }) } });
  down.stored.set(URL_A, { body: '{"v":1}', savedAt: down.now() - FRESH_MS * 10 });
  assert.deepEqual(await down.reader.read(URL_A, { onUpdate: () => {} }), { v: 1 });
  await flush();
  await flush();
  assert.deepEqual(down.removed, []);
  assert.deepEqual(down.reader.peek(URL_A), { v: 1 });
});

test('without onUpdate an old copy waits for the network, and stands in only when it fails', async () => {
  const fail = Object.assign(new Error('The network request failed.'), { status: 530 });
  const t = setup({ answers: { [URL_A]: fail } });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 2 });
  assert.deepEqual(await t.reader.read(URL_A), { v: 1 });
  assert.equal(t.fetched.length, 1);

  const ok = setup({ answers: { [URL_A]: '{"v":3}' } });
  ok.stored.set(URL_A, { body: '{"v":1}', savedAt: ok.now() - FRESH_MS * 2 });
  assert.deepEqual(await ok.reader.read(URL_A), { v: 3 });
});

test('a 4xx is an answer: the stored copy does not hide a card that is gone', async () => {
  const t = setup();
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 2 });
  await assert.rejects(t.reader.read(URL_A), { status: 404 });
});

test('copies older than MAX_STALE_MS are never shown first, even with onUpdate', async () => {
  const t = setup({ answers: { [URL_A]: '{"v":9}' } });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - MAX_STALE_MS - 1 });
  assert.deepEqual(await t.reader.read(URL_A, { onUpdate: () => {} }), { v: 9 });
});

test('fresh reads skip memory and store but still keep the answer', async () => {
  const t = setup({ answers: { [URL_A]: '{"v":5}' } });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() });
  assert.deepEqual(await t.reader.read(URL_A, { fresh: true }), { v: 5 });
  assert.deepEqual(await t.reader.read(URL_A), { v: 5 });
  assert.equal(t.fetched.length, 1);
});

test('a stored body that no longer decodes is dropped and read again', async () => {
  const t = setup({ answers: { [URL_A]: '{"v":2}' } });
  t.stored.set(URL_A, { body: 'not json', savedAt: t.now() });
  assert.deepEqual(await t.reader.read(URL_A), { v: 2 });
  assert.deepEqual(t.removed, [URL_A]);
});

test('a prefetch can be aborted until a real read joins it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const t = setup({
    answers: {
      [URL_A]: (init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        gate.then(() => resolve({ text: '{"v":1}' }));
      }),
    },
  });
  const controller = new AbortController();
  const prefetch = t.reader.read(URL_A, { prefetch: true, signal: controller.signal });
  await flush();
  assert.equal(t.fetched[0].init.priority, 'low');
  controller.abort();
  await assert.rejects(prefetch, { name: 'AbortError' });

  const adopted = setup({ answers: { [URL_A]: () => gate.then(() => ({ text: '{"v":1}' })) } });
  const second = new AbortController();
  const warm = adopted.reader.read(URL_A, { prefetch: true, signal: second.signal });
  await flush();
  const real = adopted.reader.read(URL_A);
  await flush();
  second.abort();
  release();
  assert.deepEqual(await real, { v: 1 });
  assert.deepEqual(await warm, { v: 1 });
  assert.equal(adopted.fetched.length, 1);
});

test('an already aborted prefetch never touches storage or network', async () => {
  const t = setup({ answers: { [URL_A]: '{"v":1}' } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(t.reader.read(URL_A, { prefetch: true, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(t.fetched.length, 0);
});

test('a failing store is a miss, never an error', async () => {
  const fetched = [];
  const reader = createLocalReader({
    decode: (text) => JSON.parse(text),
    store: {
      get: () => { throw new Error('blocked'); },
      put: () => Promise.reject(new Error('quota')),
      confirm: () => { throw new Error('blocked'); },
      remove: () => Promise.reject(new Error('blocked')),
    },
    fetchText: async (url) => {
      fetched.push(url);
      return { text: '{"ok":true}' };
    },
  });
  assert.deepEqual(await reader.read(URL_A), { ok: true });
  assert.equal(fetched.length, 1);
});

test('a prefetch takes any stored copy without asking the network: the view revalidates on open', async () => {
  const t = setup({ answers: { [URL_A]: '{"v":2}' } });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 20 });
  assert.deepEqual(await t.reader.read(URL_A, { prefetch: true }), { v: 1 });
  await flush();
  assert.equal(t.fetched.length, 0);
  assert.equal(t.reader.fresh(URL_A), false);
  // The page's own read (no onUpdate) then waits for the network.
  assert.deepEqual(await t.reader.read(URL_A), { v: 2 });
  assert.equal(t.fetched.length, 1);
});

test('a slow store does not hold up the network: the first usable answer wins', async () => {
  // Store slower than the network: the network answers.
  const slow = setup({ storeDelayMs: 120, answers: { [URL_A]: '{"v":2}' } });
  slow.stored.set(URL_A, { body: '{"v":1}', savedAt: slow.now() });
  const started = Date.now();
  assert.deepEqual(await slow.reader.read(URL_A), { v: 2 });
  assert.ok(Date.now() - started < 110, 'answered before the store did');

  // Network slower than the store: the stored copy answers, the request revalidates it.
  const updates = [];
  const t = setup({
    storeDelayMs: 40,
    answers: { [URL_A]: () => new Promise((resolve) => setTimeout(() => resolve({ text: '{"v":3}' }), 150)) },
  });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 10 });
  assert.deepEqual(await t.reader.read(URL_A, { onUpdate: (v) => updates.push(v) }), { v: 1 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(updates, [{ v: 3 }]);
  assert.equal(t.fetched.length, 1);

  // Both late and the network fails: an old copy still stands in.
  const down = setup({ storeDelayMs: 40, answers: { [URL_A]: Object.assign(new Error('down'), { status: 530 }) } });
  down.stored.set(URL_A, { body: '{"v":1}', savedAt: down.now() - MAX_STALE_MS * 2 });
  assert.deepEqual(await down.reader.read(URL_A), { v: 1 });
});

test('a prefetch waits for a slow store instead of asking the network', async () => {
  const t = setup({ storeDelayMs: 60, answers: { [URL_A]: '{"v":2}' } });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() });
  assert.deepEqual(await t.reader.read(URL_A, { prefetch: true }), { v: 1 });
  assert.equal(t.fetched.length, 0);
});

test('only reads that may show an old copy give the store a head start', async () => {
  let release;
  const t = setup({
    storeDelayMs: 5,
    answers: { [URL_A]: () => new Promise((resolve) => { release = () => resolve({ text: '{"v":2}' }); }) },
  });
  t.stored.set(URL_A, { body: '{"v":1}', savedAt: t.now() - FRESH_MS * 10 });
  const read = t.reader.read(URL_A, { maxStaleMs: FRESH_MS * 20 });
  await flush();
  assert.equal(t.fetched.length, 0, 'a read that may show an old copy waits for the store first');
  assert.deepEqual(await read, { v: 1 });
  release?.();

  const fresh = setup({ storeDelayMs: 50, answers: { [URL_A]: '{"v":2}' } });
  fresh.stored.set(URL_A, { body: '{"v":1}', savedAt: fresh.now() - 1000 });
  const raced = fresh.reader.read(URL_A);
  await flush();
  assert.equal(fresh.fetched.length, 1, 'a fresh-only read asks the network before the store answers');
  assert.deepEqual(await raced, { v: 2 });

  const stale = setup({ storeDelayMs: 5, answers: { [URL_A]: '{"v":3}' } });
  stale.stored.set(URL_A, { body: '{"v":1}', savedAt: stale.now() - FRESH_MS * 2 });
  assert.deepEqual(await stale.reader.read(URL_A), { v: 3 });
});
