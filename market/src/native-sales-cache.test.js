import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { CARD_SALES_TTL_MS } from './sold-sales-cache.js';
import {
  NATIVE_SALES_TTL_MS,
  peekNativeSales,
  resetNativeSalesCacheForTests,
  saveNativeSales,
} from './native-sales-cache.js';

// PH-R034 P7: "Sold on Pokoin" had no cache at all, so the panel was a promise
// kept by the network — it appeared under a visitor already reading the card. It
// is now stored like the sold slices it hangs under, so a desk paints it or does
// not have it, and this file is the same proof in the same shape.
const KEY = 'pokoin.nativeSales.v1.598006';
const ROW = { soldAt: '2026-11-01T09:30:00Z', condition: 'NM', language: 'EN', quantity: 1, unitPricePkn: 240 };
const store = new Map();

beforeEach(() => {
  resetNativeSalesCacheForTests();
  store.clear();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
});

test('native sales keep the sold slices’ window and outlive the page', () => {
  assert.equal(NATIVE_SALES_TTL_MS, CARD_SALES_TTL_MS);
  assert.equal(NATIVE_SALES_TTL_MS, 15 * 24 * 60 * 60 * 1000);
  saveNativeSales('598006', [ROW]);
  assert.equal(peekNativeSales('598006').sales[0].unitPricePkn, 240);
  // A desk is a new component tree, so the copy has to come back from storage.
  resetNativeSalesCacheForTests();
  assert.deepEqual(peekNativeSales('598006').sales, [ROW]);
});

test('an empty Pokoin sold answer is a stored answer', () => {
  // A card with no native sales stays without them: the desk knows at the first
  // frame and asks nothing of the panel.
  saveNativeSales('598006', []);
  resetNativeSalesCacheForTests();
  assert.deepEqual(peekNativeSales('598006').sales, []);
});

test('an expired copy is not read', () => {
  saveNativeSales('598006', [ROW]);
  const raw = JSON.parse(store.get(KEY));
  raw.savedAt = Date.now() - NATIVE_SALES_TTL_MS - 1;
  store.set(KEY, JSON.stringify(raw));
  resetNativeSalesCacheForTests();
  assert.equal(peekNativeSales('598006'), null);
});

test('nothing card-less or shapeless is written or read', () => {
  assert.equal(peekNativeSales(''), null);
  assert.equal(peekNativeSales(null), null);
  assert.equal(saveNativeSales('', [ROW]), null);
  assert.equal(saveNativeSales('598006', undefined), null);
  assert.equal(store.size, 0);
  store.set(KEY, '{"sales":"not rows","savedAt":1}');
  resetNativeSalesCacheForTests();
  assert.equal(peekNativeSales('598006'), null, 'a payload of another shape is not a cache hit');
});
