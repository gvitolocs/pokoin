import assert from 'node:assert/strict';
import test from 'node:test';
import { prefetchSearchPage, resetHotSearchPage, takeHotSearchPage } from './search-hot.js';

test('prefetchSearchPage stores the first search page for Enter', async () => {
  resetHotSearchPage();
  const payload = { cards: [{ id: '1' }], hasMore: true, total: 137 };
  await prefetchSearchPage('oshaw', 'en', {
    fetchSearchPage: async ({ query, limit }) => {
      assert.equal(query, 'oshaw');
      assert.equal(limit, 48);
      return payload;
    },
  });
  const hot = takeHotSearchPage('oshaw', 'en');
  // The cached count is the payload's OWN total — the same predicate that
  // produced its rows — never a caller-supplied suggest-side hint.
  assert.equal(hot.count, 137);
  assert.equal(hot.data, payload);
  assert.equal(takeHotSearchPage('oshawt', 'en'), null);
});

test('hot search page is keyed by singles vs product', async () => {
  resetHotSearchPage();
  const singles = { cards: [{ id: 'card' }], hasMore: false, total: 9 };
  const products = { cards: [{ id: 'box' }], hasMore: false, total: 3 };
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
  assert.equal(takeHotSearchPage('mimikyu', 'en').count, 9);
  assert.equal(takeHotSearchPage('mimikyu', 'en', 'product').data, products);
  assert.equal(takeHotSearchPage('mimikyu', 'en', 'product').count, 3);
});

test('missing payload total leaves the count unset instead of a page-size lie', async () => {
  resetHotSearchPage();
  await prefetchSearchPage('mimikyu', 'en', {
    tab: 'singles',
    fetchSearchPage: async () => ({ cards: [{ id: 'a' }, { id: 'b' }], hasMore: false }),
  });
  const hot = takeHotSearchPage('mimikyu', 'en');
  assert.equal(hot.data.cards.length, 2);
  assert.equal(hot.count, 0);
});
