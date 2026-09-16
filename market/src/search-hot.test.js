import assert from 'node:assert/strict';
import test from 'node:test';
import { prefetchSearchPage, resetHotSearchPage, takeHotSearchPage } from './search-hot.js';

test('prefetchSearchPage stores the first search page for Enter', async () => {
  resetHotSearchPage();
  const payload = { cards: [{ id: '1' }], hasMore: true };
  await prefetchSearchPage('oshaw', 'en', {
    count: 98,
    fetchSearchPage: async ({ query, limit }) => {
      assert.equal(query, 'oshaw');
      assert.equal(limit, 48);
      return payload;
    },
  });
  const hot = takeHotSearchPage('oshaw', 'en');
  assert.equal(hot.count, 98);
  assert.equal(hot.data, payload);
  assert.equal(takeHotSearchPage('oshawt', 'en'), null);
});

test('hot search page is keyed by singles vs product', async () => {
  resetHotSearchPage();
  const singles = { cards: [{ id: 'card' }], hasMore: false };
  const products = { cards: [{ id: 'box' }], hasMore: false };
  await prefetchSearchPage('mimikyu', 'en', {
    tab: 'singles',
    fetchSearchPage: async (opts) => {
      assert.equal(opts.productType, 'card');
      return singles;
    },
  });
  await prefetchSearchPage('mimikyu', 'en', {
    tab: 'product',
    fetchSearchPage: async (opts) => {
      assert.equal(opts.productSearchOnly, true);
      return products;
    },
  });
  assert.equal(takeHotSearchPage('mimikyu', 'en').data, singles);
  assert.equal(takeHotSearchPage('mimikyu', 'en', 'product').data, products);
});
