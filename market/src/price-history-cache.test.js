import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  CARD_PRICE_HISTORY_TTL_MS,
  peekCardPriceHistory,
  rememberStaleCardPriceHistory,
  resetCardPriceHistoryCacheForTests,
  saveCardPriceHistory,
} from './price-history-cache.js';
import { CARD_SALES_TTL_MS } from './sold-sales-cache.js';

const store = new Map();

function fakeStorage() {
  return {
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

const PREFIX = 'pokoin.cardPriceHistory.v1.';

function entryOf(range = '3m', from = '2026-08-18', to = '2026-11-16') {
  return { range, from, to, history: { cardtrader: { days: [{ day: '2026-11-16', lowestAskPkn: 265 }] } } };
}

/** Rewrite a stored window's savedAt, the way an old visit leaves it. */
function ageStored(key, ms) {
  const raw = JSON.parse(store.get(key));
  raw.savedAt = Date.now() - ms;
  store.set(key, JSON.stringify({ entry: raw.entry, savedAt: raw.savedAt }));
}

beforeEach(() => {
  resetCardPriceHistoryCacheForTests();
  store.clear();
  globalThis.localStorage = fakeStorage();
});

test('a saved window peeks back with everything the graph draws', () => {
  assert.equal(CARD_PRICE_HISTORY_TTL_MS, 15 * 24 * 60 * 60 * 1000);
  assert.equal(CARD_PRICE_HISTORY_TTL_MS, CARD_SALES_TTL_MS, 'as fresh as the sold slices');
  const entry = entryOf();
  assert.deepEqual(saveCardPriceHistory('813622', '3m', entry), entry);
  const peeked = peekCardPriceHistory('813622', '3m');
  assert.deepEqual(peeked, entry);
  assert.equal(peeked.history.cardtrader.days[0].lowestAskPkn, 265);
  assert.ok(!('savedAt' in peeked), 'the stamp is not part of the entry');
  assert.match(store.get(`${PREFIX}813622.3m`), /"savedAt":\d+\}$/, 'savedAt sits at the end of the string');
});

test('the memory layer answers without the storage copy', () => {
  saveCardPriceHistory('813622', '3m', entryOf());
  store.clear();
  assert.deepEqual(peekCardPriceHistory('813622', '3m').range, '3m');
});

test('another card or window never reads this one', () => {
  saveCardPriceHistory('813622', '3m', entryOf());
  assert.equal(peekCardPriceHistory('813623', '3m'), null);
  assert.equal(peekCardPriceHistory('813622', '1y'), null);
  assert.equal(peekCardPriceHistory('', '3m'), null);
  assert.equal(peekCardPriceHistory('813622', ''), null);
  assert.equal(saveCardPriceHistory('813622', '', entryOf()), null);
});

test('an entry the graph cannot draw is not stored at all', () => {
  // The API answered nothing: caching that would freeze an empty graph for 15 days.
  assert.equal(saveCardPriceHistory('813622', '3m', { range: '3m', from: '2026-08-18', to: '2026-11-16', history: null }), null);
  assert.equal(saveCardPriceHistory('813622', '3m', { range: '3m', from: 'x', to: '2026-11-16', history: {} }), null);
  assert.equal(saveCardPriceHistory('813622', '3m', null), null);
  assert.equal(store.size, 0);
});

test('a 16-day window is no longer fresh, but a stale read still takes it', () => {
  saveCardPriceHistory('813622', '3m', entryOf());
  ageStored(`${PREFIX}813622.3m`, CARD_PRICE_HISTORY_TTL_MS + 1);
  resetCardPriceHistoryCacheForTests();
  assert.equal(peekCardPriceHistory('813622', '3m'), null);
  assert.deepEqual(rememberStaleCardPriceHistory('813622', '3m').range, '3m');
  assert.equal(rememberStaleCardPriceHistory('813622', '1y'), null);
});

test('41 windows keep the newest 40 of this cache only', () => {
  const other = ['pokoin.cardSales.v12.813622', 'pokoin.cardPage.v2.en:813622'];
  for (const key of other) {
    store.set(key, '{}');
  }
  const base = Date.now();
  for (let i = 0; i < 40; i += 1) {
    // Written oldest first, so key 0 is the one the bound must drop.
    store.set(`${PREFIX}90000${i}.3m`, JSON.stringify({ entry: entryOf(), savedAt: base - (40 - i) * 1000 }));
  }
  saveCardPriceHistory('912345', '3m', entryOf());
  const own = [...store.keys()].filter((key) => key.startsWith(PREFIX));
  assert.equal(own.length, 40);
  assert.ok(!own.includes(`${PREFIX}900000.3m`), 'the oldest own key went');
  assert.ok(own.includes(`${PREFIX}912345.3m`), 'the new key stayed');
  assert.deepEqual([...store.keys()].filter((key) => !key.startsWith(PREFIX)).sort(), other.sort());
  assert.equal(peekCardPriceHistory('900000', '3m'), null);
});

test('storage that throws on every call leaves the page working', () => {
  const boom = () => {
    throw new Error('private mode');
  };
  globalThis.localStorage = { length: 0, key: boom, getItem: boom, setItem: boom, removeItem: boom };
  resetCardPriceHistoryCacheForTests();
  const entry = entryOf();
  assert.deepEqual(saveCardPriceHistory('813622', '3m', entry), entry);
  assert.deepEqual(peekCardPriceHistory('813622', '3m'), entry);
  assert.deepEqual(rememberStaleCardPriceHistory('813622', '3m'), entry);
  globalThis.localStorage = undefined;
  assert.deepEqual(peekCardPriceHistory('813622', '3m'), entry);
  assert.equal(saveCardPriceHistory('813622', '1y', entryOf('1y')).range, '1y');
});

test('a corrupt value reads as nothing cached', () => {
  globalThis.localStorage = undefined;
  saveCardPriceHistory('813622', '3m', entryOf());
  globalThis.localStorage = fakeStorage();
  resetCardPriceHistoryCacheForTests();
  store.set(`${PREFIX}813622.3m`, '{"entry":{"range":"3m"');
  assert.equal(peekCardPriceHistory('813622', '3m'), null);
  assert.equal(rememberStaleCardPriceHistory('813622', '3m'), null);
  store.set(`${PREFIX}813622.3m`, 'null');
  assert.equal(peekCardPriceHistory('813622', '3m'), null);
  assert.equal(saveCardPriceHistory('813622', '3m', entryOf()).range, '3m');
  assert.deepEqual(peekCardPriceHistory('813622', '3m').range, '3m');
});
