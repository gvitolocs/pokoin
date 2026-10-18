import assert from 'node:assert/strict';
import test from 'node:test';
import { createInventoryBookStore } from './inventory-book.js';

function fixture() {
  const values = new Map();
  const storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  let time = 1000;
  return { storage, store: createInventoryBookStore({ storage: () => storage, now: () => time, retryMs: 5 }), advance: () => { time += 20_000; } };
}
const row = (id) => ({ id: String(id), cardName: `Card ${id}`, quantityAvailable: 1, status: 'active' });

test('cold inventory paints the first page then caches the complete book beyond 1000 rows', async () => {
  const { store } = fixture();
  const rows = Array.from({ length: 1463 }, (_, i) => row(i));
  rows[1].status = 'paused';
  const requests = [];
  const paints = [];
  const book = await store.load('alice', 'pokemon', {
    fetchPage: async ({ limit, offset }) => {
      requests.push([limit, offset]);
      return { listings: rows.slice(offset, offset + limit) };
    },
    onUpdate: (rows) => paints.push(rows.length),
  });
  assert.deepEqual(requests, [[200, 0], [1000, 200], [1000, 1200]]);
  assert.deepEqual(paints, [200, 1200, 1463]);
  assert.equal(book.rows.length, 1463);
  assert.equal(book.rows[1].status, 'paused');
});

test('revisits paint synchronously from tab storage and never mix accounts or games', async () => {
  const { storage, store } = fixture();
  await store.load('alice', 'magic', { fetchPage: async () => ({ listings: [row(1)] }) });
  const nextPage = createInventoryBookStore({ storage: () => storage, now: () => 1000 });
  let painted = false;
  const pending = nextPage.load('alice', 'magic', {
    fetchPage: () => { throw Error('fresh cache should not request'); },
    onUpdate: (rows) => { painted = rows.length === 1; },
  });
  assert.equal(painted, true);
  await pending;
  assert.equal(nextPage.peek('bob', 'magic'), null);
  assert.equal(nextPage.peek('alice', 'pokemon'), null);
});

test('stale books remain complete while a shared background refresh arrives', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: async () => ({ listings: [row('old')] }) });
  advance();
  let finish;
  let calls = 0;
  const paints = [];
  const fetchPage = async () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const a = store.load('alice', 'pokemon', { fetchPage, onUpdate: (rows) => paints.push(rows[0].id) });
  const b = store.load('alice', 'pokemon', { fetchPage });
  await Promise.resolve();
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
  await Promise.resolve();
  store.invalidate('alice', 'pokemon');
  await store.load('alice', 'pokemon', { fetchPage: async () => ({ listings: [row('updated')] }) });
  finish({ listings: [row('old')] });
  await old;
  assert.equal(store.peek('alice', 'pokemon').rows[0].id, 'updated');
  store.clear();
  assert.equal(store.peek('alice', 'pokemon'), null);
});

test('failed refresh retains the previous complete book and storage failures do not block reads', async () => {
  const { store, advance } = fixture();
  await store.load('alice', 'pokemon', { fetchPage: async () => ({ listings: [row(1)] }) });
  advance();
  await assert.rejects(store.load('alice', 'pokemon', { fetchPage: async () => { throw Error('offline'); } }), /offline/);
  assert.equal(store.peek('alice', 'pokemon').rows.length, 1);
  const blocked = createInventoryBookStore({ storage: () => { throw Error('private mode'); } });
  assert.equal((await blocked.load('alice', 'pokemon', { fetchPage: async () => ({ listings: [row(2)] }) })).rows.length, 1);
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
  await store.load('alice', 'pokemon', {
    fetchPage: async ({ limit, offset }) => ({ listings: oldRows.slice(offset, offset + limit) }),
  });
  const nextRows = oldRows.slice(0, 200);
  const paints = [];
  await store.load('alice', 'pokemon', {
    force: true,
    fetchPage: async ({ limit, offset }) => ({ listings: nextRows.slice(offset, offset + limit) }),
    onUpdate: (rows) => paints.push(rows.length),
  });
  assert.deepEqual(paints, [300, 200]);
});
