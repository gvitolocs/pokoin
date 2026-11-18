import assert from 'node:assert/strict';
import test from 'node:test';
import { createInventoryBookStore, reconcileRows } from './inventory-book.js';

/** A Map standing in for IndexedDB, plus the localStorage marks. */
function fixture() {
  const saved = new Map();
  const persist = {
    async get(id) { return saved.has(id) ? structuredClone(saved.get(id)) : null; },
    async put(id, book) { saved.set(id, structuredClone({ uid: book.uid, game: book.game, stamp: book.stamp, savedAt: book.savedAt, rows: book.rows })); },
    async delete(id) { saved.delete(id); },
    async retain(uid) { for (const [id, book] of saved) if (!uid || book.uid !== uid) saved.delete(id); },
  };
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
  const clock = { time: 1000 };
  const make = () => createInventoryBookStore({ persist, storage: () => storage, now: () => clock.time, retryMs: 5 });
  return { saved, storage, clock, make, store: make(), advance: (ms = 20_000) => { clock.time += ms; } };
}
const row = (id, extra = {}) => ({ id: String(id), cardName: `Card ${id}`, quantityAvailable: 1, status: 'active', ...extra });
const pages = (rows, stamp = 's1') => async ({ limit, offset }) => ({
  listings: rows.slice(offset, offset + limit),
  ...(offset === 0 ? { stamp } : {}),
});

test('cold inventory paints the first page then caches the complete book beyond 1000 rows', async () => {
  const { store, saved } = fixture();
  const rows = Array.from({ length: 1463 }, (_, i) => row(i));
  rows[1].status = 'paused';
  const requests = [];
  const paints = [];
  const book = await store.load('alice', 'pokemon', {
    fetchPage: async ({ limit, offset }) => {
      requests.push([limit, offset]);
      return { listings: rows.slice(offset, offset + limit), ...(offset === 0 ? { stamp: '1463:t' } : {}) };
    },
    onUpdate: (next, complete) => paints.push([next.length, complete]),
  });
  assert.deepEqual(requests, [[200, 0], [1000, 200], [1000, 1200]]);
  assert.deepEqual(paints, [[200, false], [1200, false], [1463, true]]);
  assert.equal(book.rows.length, 1463);
  assert.equal(book.rows[1].status, 'paused');
  assert.equal(book.stamp, '1463:t');
  await Promise.resolve();
  assert.equal(saved.size, 1);
});

test('a reload paints the persisted book, and a matching stamp costs one tiny read', async () => {
  const { make, advance } = fixture();
  const first = make();
  await first.load('alice', 'pokemon', { fetchPage: pages([row(1), row(2)]) });
  advance(60_000);
  const reloaded = make();
  const paints = [];
  let stamps = 0;
  const book = await reloaded.load('alice', 'pokemon', {
    fetchPage: () => { throw Error('an unchanged book is not read again'); },
    fetchStamp: async () => { stamps += 1; return 's1'; },
    onUpdate: (next) => paints.push(next.map((r) => r.id)),
  });
  assert.deepEqual(paints, [['1', '2']]);
  assert.equal(stamps, 1);
  assert.equal(book.rows.length, 2);
  // Checked just now: a remount within FRESH_MS asks nothing.
  await reloaded.load('alice', 'pokemon', {
    fetchPage: () => { throw Error('fresh'); },
    fetchStamp: () => { throw Error('fresh'); },
  });
});

test('a moved stamp reads the book again and keeps unchanged rows as the same objects', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: pages([row(1), row(2), row(3)]) });
  const before = store.peek('alice', 'pokemon').rows;
  advance();
  const paints = [];
  const book = await store.load('alice', 'pokemon', {
    fetchStamp: async () => 's2',
    fetchPage: pages([row(1), row(2, { pricePkn: 99 }), row(3)], 's2'),
    onUpdate: (next) => paints.push(next),
  });
  assert.equal(paints.length, 2);
  assert.equal(paints[0], before);
  assert.equal(book.rows[0], before[0]);
  assert.notEqual(book.rows[1], before[1]);
  assert.equal(book.rows[1].pricePkn, 99);
  assert.equal(book.rows[2], before[2]);
  assert.equal(book.stamp, 's2');
});

test('an identical refresh hands back the very same array', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: pages([row(1), row(2)], '') });
  const before = store.peek('alice', 'pokemon').rows;
  advance();
  // No stamp from an older API: the book is read again, nothing changed.
  const book = await store.load('alice', 'pokemon', { fetchStamp: async () => 'x', fetchPage: pages([row(1), row(2)], '') });
  assert.equal(book.rows, before);
});

test('reconcileRows keeps order changes, additions and removals', () => {
  const a = row(1);
  const b = row(2);
  const out = reconcileRows([a, b], [row(3), row(2), row(1)]);
  assert.equal(out.length, 3);
  assert.equal(out[1], b);
  assert.equal(out[2], a);
  assert.deepEqual(reconcileRows([a, b], [row(1)]), [a]);
  assert.deepEqual(reconcileRows([], [a]), [a]);
});

test('a listing write makes every book read again in full, but it keeps painting', async () => {
  const { store, advance, make } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: pages([row(1)]) });
  advance(1000);
  store.markStale();
  advance(1000);
  let stamps = 0;
  const fetchStamp = async () => { stamps += 1; return 's1'; };
  // The mark survives a reload of the page.
  const reloaded = make();
  const restored = await reloaded.load('alice', 'pokemon', { fetchStamp, fetchPage: pages([row(1, { pricePkn: 4 })]) });
  assert.equal(restored.rows[0].pricePkn, 4);
  const paints = [];
  store.markStale();
  advance(1000);
  await store.load('alice', 'pokemon', {
    fetchStamp,
    fetchPage: pages([row(1, { pricePkn: 5 })]),
    onUpdate: (next) => paints.push(next[0].pricePkn ?? null),
  });
  assert.equal(stamps, 0);
  assert.deepEqual(paints, [null, 5]);
});

test('revisits never mix accounts or games, and sign-out wipes the stored books', async () => {
  const { store, saved, storage, make } = fixture();
  await store.load('alice', 'magic', { fetchPage: pages([row(1)]) });
  await Promise.resolve();
  const next = make();
  assert.equal(next.peek('bob', 'magic'), null);
  assert.equal(await next.restore('bob', 'magic'), null);
  assert.equal(await next.restore('alice', 'pokemon'), null);
  assert.equal((await next.restore('alice', 'magic')).rows.length, 1);
  next.retainOnly('bob');
  await Promise.resolve();
  assert.equal(saved.size, 0);
  await next.load('bob', 'magic', { fetchPage: pages([row(2)]) });
  assert.equal(storage.getItem('pokoin.inventory-book.stored'), '1');
  next.clear();
  await Promise.resolve();
  assert.equal(saved.size, 0);
  assert.equal(next.peek('bob', 'magic'), null);
  assert.equal(storage.getItem('pokoin.inventory-book.stored'), null);
});

test('stale books remain complete while a shared background refresh arrives', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: pages([row('old')], '') });
  advance();
  let finish;
  let calls = 0;
  const paints = [];
  const fetchPage = async () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const a = store.load('alice', 'pokemon', { fetchPage, onUpdate: (rows) => paints.push(rows[0].id) });
  const b = store.load('alice', 'pokemon', { fetchPage });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(paints, ['old']);
  assert.equal(calls, 1);
  finish({ listings: [row('new')] });
  await Promise.all([a, b]);
  assert.deepEqual(paints, ['old', 'new']);
});

test('mutations invalidate old requests so late replies cannot restore stale stock', async () => {
  const { store } = fixture();
  let finish;
  const old = store.load('alice', 'pokemon', { fetchPage: () => new Promise((resolve) => { finish = resolve; }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.invalidate('alice', 'pokemon');
  await store.load('alice', 'pokemon', { force: true, fetchPage: async () => ({ listings: [row('updated')] }) });
  finish({ listings: [row('old')] });
  await old;
  assert.equal(store.peek('alice', 'pokemon').rows[0].id, 'updated');
  store.clear();
  assert.equal(store.peek('alice', 'pokemon'), null);
});

test('failed refresh retains the previous complete book and missing storage does not block reads', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: pages([row(1)], '') });
  advance();
  await assert.rejects(store.load('alice', 'pokemon', { fetchPage: async () => { throw Error('offline'); } }), /offline/);
  assert.equal(store.peek('alice', 'pokemon').rows.length, 1);
  const blocked = createInventoryBookStore({ persist: null, storage: () => { throw Error('private mode'); } });
  assert.equal((await blocked.load('alice', 'pokemon', { fetchPage: async () => ({ listings: [row(2)] }) })).rows.length, 1);
});

test('a failed stamp read falls back to reading the book', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: pages([row(1)]) });
  advance();
  const book = await store.load('alice', 'pokemon', {
    fetchStamp: async () => { throw Error('old API'); },
    fetchPage: pages([row(1), row(2)], 's2'),
  });
  assert.equal(book.rows.length, 2);
});

test('a stamp is trusted for hours, then the whole book is read again', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: pages([row(1)]) });
  advance(7 * 60 * 60_000);
  let read = false;
  await store.load('alice', 'pokemon', {
    fetchStamp: async () => 's1',
    fetchPage: async (page) => { read = true; return pages([row(1)])(page); },
  });
  assert.equal(read, true);
});

test('a stalled first request can be overtaken by its retry', async () => {
  const { store } = fixture();
  let calls = 0;
  const book = await store.load('alice', 'pokemon', {
    fetchPage: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve({ listings: [row(7)] }),
  });
  assert.equal(calls, 2);
  assert.equal(book.rows[0].id, '7');
});

test('a warm refresh never replaces the full book with its first partial page', async () => {
  const { store } = fixture();
  const oldRows = Array.from({ length: 300 }, (_, i) => row(i));
  await store.load('alice', 'pokemon', { fetchPage: pages(oldRows) });
  const nextRows = oldRows.slice(0, 200);
  const paints = [];
  await store.load('alice', 'pokemon', {
    force: true,
    fetchPage: pages(nextRows),
    onUpdate: (rows) => paints.push(rows.length),
  });
  assert.deepEqual(paints, [300, 200]);
});
