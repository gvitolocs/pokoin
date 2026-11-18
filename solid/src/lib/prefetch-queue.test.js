import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrefetchQueue, linkTarget, prefetchBlocked } from './prefetch-queue.js';

test('links to card desks, version pages, set pages, artist pages and seller shops are prefetch targets', () => {
  assert.deepEqual(linkTarget('/marketplace/en/cards/612968/card-night-stretcher'), {
    kind: 'card', key: 'card:en:612968', id: '612968', lang: 'en', slug: 'card-night-stretcher',
  });
  assert.deepEqual(linkTarget('/marketplace/ja/cards/7'), { kind: 'card', key: 'card:ja:7', id: '7', lang: 'ja', slug: '' });
  assert.equal(linkTarget('/marketplace/en/cards/7/slug/versions').kind, 'versions');
  assert.equal(linkTarget('/marketplace/en/cards/7/versions').kind, 'versions');
  assert.deepEqual(linkTarget('/marketplace/sets/surging-sparks'), { kind: 'set', key: 'set:surging-sparks', slug: 'surging-sparks' });
  assert.deepEqual(linkTarget('/marketplace/en/artists/toyste-beach'), { kind: 'artist', key: 'artist:toyste-beach', slug: 'toyste-beach' });
  assert.deepEqual(linkTarget('/marketplace/it/users/RedShakkio'), { kind: 'seller', key: 'seller:redshakkio', handle: 'RedShakkio' });
  assert.equal(linkTarget('/magic/marketplace/sets/x', { base: '/magic' }).key, 'set:x');
  for (const path of ['/marketplace', '/marketplace/sets', '/marketplace/search', '/cart', '/marketplace/en/artists',
    '/marketplace/en/cards/not-a-number/x', '/marketplace/en/users', '/marketplace/en/users/givi/x', '/checkout']) {
    assert.equal(linkTarget(path), null, path);
  }
  // Provisional URL ids map to the public id the desk reads.
  assert.equal(linkTarget('/marketplace/en/cards/999001', { cardId: (id) => String(Number(id) - 999000) }).key, 'card:en:1');
});

test('Save-Data and 2g prefetch nothing', () => {
  assert.equal(prefetchBlocked({ saveData: true }), true);
  assert.equal(prefetchBlocked({ effectiveType: '2g' }), true);
  assert.equal(prefetchBlocked({ effectiveType: 'slow-2g' }), true);
  assert.equal(prefetchBlocked({ effectiveType: '4g' }), false);
  assert.equal(prefetchBlocked(null), false);
  const queue = createPrefetchQueue({ load: () => assert.fail('blocked'), idle: (fn) => fn(), blocked: () => true });
  assert.equal(queue.add({ key: 'card:en:1' }), false);
});

function harness(options = {}) {
  const started = [];
  const releases = new Map();
  const idles = [];
  let clock = 0;
  const queue = createPrefetchQueue({
    load: (target, signal, intent) => new Promise((resolve, reject) => {
      started.push({ key: target.key, intent, signal });
      releases.set(target.key, resolve);
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    idle: (fn) => idles.push(fn),
    now: () => clock,
    ...options,
  });
  const runIdle = () => {
    while (idles.length) idles.shift()();
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { queue, started, releases, runIdle, settle, advance: (ms) => { clock += ms; } };
}

test('loads start at idle, newest intent first, at most 4 at once', async () => {
  const h = harness();
  for (let i = 1; i <= 6; i += 1) h.queue.add({ key: `card:en:${i}` }, { intent: i === 6 });
  assert.deepEqual(h.started, []);
  h.runIdle();
  await h.settle();
  assert.deepEqual(h.started.map((s) => s.key), ['card:en:6', 'card:en:5', 'card:en:4', 'card:en:3']);
  assert.equal(h.started[0].intent, true);
  assert.deepEqual(h.queue.state().queued, ['card:en:2', 'card:en:1']);
  h.releases.get('card:en:6')();
  await h.settle();
  h.runIdle();
  await h.settle();
  assert.equal(h.started.length, 5);
  assert.equal(h.started[4].key, 'card:en:2');
});

test('a navigation drops the queue and aborts every running load but its own', async () => {
  const h = harness();
  for (let i = 1; i <= 6; i += 1) h.queue.add({ key: `card:en:${i}` });
  h.runIdle();
  await h.settle();
  h.queue.abort('card:en:5');
  assert.deepEqual(h.queue.state(), { queued: [], running: ['card:en:5'] });
  assert.deepEqual(h.started.filter((s) => s.signal.aborted).map((s) => s.key).sort(), ['card:en:3', 'card:en:4', 'card:en:6']);
  await h.settle();
  h.runIdle();
  assert.equal(h.started.length, 4);
});

test('a target loaded recently or still running is not queued again', async () => {
  const h = harness({ repeatMs: 1000 });
  assert.equal(h.queue.add({ key: 'set:x' }), true);
  h.runIdle();
  await h.settle();
  assert.equal(h.queue.add({ key: 'set:x' }), false);
  h.releases.get('set:x')();
  await h.settle();
  assert.equal(h.queue.add({ key: 'set:x' }), false);
  h.advance(1001);
  assert.equal(h.queue.add({ key: 'set:x' }), true);
});

test('an aborted load can be queued again at once', async () => {
  const h = harness();
  h.queue.add({ key: 'artist:a' });
  h.runIdle();
  await h.settle();
  h.queue.abort();
  await h.settle();
  assert.equal(h.queue.add({ key: 'artist:a' }), true);
});

test('the queue keeps the newest 24 targets', () => {
  const h = harness();
  for (let i = 0; i < 40; i += 1) h.queue.add({ key: `card:en:${i}` });
  const { queued } = h.queue.state();
  assert.equal(queued.length, 24);
  assert.equal(queued[0], 'card:en:39');
});
