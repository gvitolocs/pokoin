import assert from 'node:assert/strict';
import test from 'node:test';
import { readDeskListings, writeDeskListings } from './desk-listings-store.js';
import { rememberImageFallback, resetImageFallbackMemo, workingImage } from './image-fallback-memo.js';

function memoryStore() {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
}

test('a desk reload reads the last listings of that game and card, empty included', () => {
  const store = memoryStore();
  writeDeskListings('yugioh', '658588', [{ id: 'a', pricePkn: 10 }], { store, now: 1000 });
  writeDeskListings('pokemon', '658588', [], { store, now: 1000 });
  assert.deepEqual(readDeskListings('yugioh', '658588', { store, now: 2000 }).rows, [{ id: 'a', pricePkn: 10 }]);
  assert.deepEqual(readDeskListings('pokemon', '658588', { store, now: 2000 }).rows, []);
  assert.equal(readDeskListings('magic', '658588', { store, now: 2000 }), null);
  assert.equal(readDeskListings('yugioh', '658588', { store, now: 1000 + 4 * 24 * 60 * 60_000 }), null);
});

test('the store keeps the newest desks under its caps', () => {
  const store = memoryStore();
  for (let i = 0; i < 30; i += 1) writeDeskListings('pokemon', String(i), [{ id: String(i) }], { store, now: 1000 });
  assert.equal(readDeskListings('pokemon', '0', { store, now: 1000 }), null);
  assert.ok(readDeskListings('pokemon', '29', { store, now: 1000 }));
  const big = Array.from({ length: 400 }, (_, i) => ({ id: String(i), note: 'x'.repeat(1000) }));
  writeDeskListings('pokemon', 'big', big, { store, now: 1000 });
  writeDeskListings('pokemon', 'next', big, { store, now: 1000 });
  assert.equal(readDeskListings('pokemon', 'big', { store, now: 1000 }), null);
  assert.ok(readDeskListings('pokemon', 'next', { store, now: 1000 }));
});

test('an image that failed here is replaced by the sibling that loaded', async () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) };
  resetImageFallbackMemo();
  assert.equal(workingImage('https://cdn.pokoin.com/a_homepage.webp'), 'https://cdn.pokoin.com/a_homepage.webp');
  rememberImageFallback('https://cdn.pokoin.com/a_homepage.webp', 'https://cdn.pokoin.com/a.jpg');
  assert.equal(workingImage('https://cdn.pokoin.com/a_homepage.webp'), 'https://cdn.pokoin.com/a.jpg');
  await Promise.resolve();
  resetImageFallbackMemo();
  assert.equal(workingImage('https://cdn.pokoin.com/a_homepage.webp'), 'https://cdn.pokoin.com/a.jpg');
  delete globalThis.localStorage;
});
