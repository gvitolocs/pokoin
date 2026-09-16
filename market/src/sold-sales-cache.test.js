import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  CARD_SALES_TTL_MS,
  peekCardSales,
  rememberStaleCardSales,
  resetCardSalesCacheForTests,
  saveCardSales,
} from './sold-sales-cache.js';

const store = new Map();

beforeEach(() => {
  resetCardSalesCacheForTests();
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

test('card sales cache keeps slices for 15 days', () => {
  assert.equal(CARD_SALES_TTL_MS, 15 * 24 * 60 * 60 * 1000);
  saveCardSales('598006', [{ day: '2026-09-01', language: 'EN' }]);
  assert.equal(peekCardSales('598006').slices[0].language, 'EN');
  assert.equal(peekCardSales('598006').slices.length, 1);
});

test('expired card sales cache is ignored until a stale read', () => {
  saveCardSales('598006', [{ day: '2026-09-01' }]);
  const raw = JSON.parse(store.get('pokoin.cardSales.v11.598006'));
  raw.savedAt = Date.now() - CARD_SALES_TTL_MS - 1;
  store.set('pokoin.cardSales.v11.598006', JSON.stringify(raw));
  resetCardSalesCacheForTests();
  assert.equal(peekCardSales('598006'), null);
  assert.equal(rememberStaleCardSales('598006').slices[0].day, '2026-09-01');
});

test('tile last-median fetchers do not write this cache', () => {
  assert.equal(peekCardSales('1'), null);
  assert.equal(saveCardSales('', [{ day: '2026-09-01' }]), null);
});
