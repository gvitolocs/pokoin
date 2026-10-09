import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecallSearch, recallOrder } from './search-recall-core.js';

const compact = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function catalog(rowsByQuery) {
  const calls = [];
  async function fetchSearchPage({ query, offset = 0, limit = 48 }) {
    calls.push({ query, offset, limit });
    const all = rowsByQuery[query] || [];
    const cards = all.slice(offset, offset + limit).map((id) => ({ id: String(id) }));
    return { cards, total: all.length, hasMore: offset + cards.length < all.length, nextOffset: offset + cards.length };
  }
  return { calls, fetchSearchPage };
}

test('recallOrder puts the full query first and drops duplicates', () => {
  assert.deepEqual(recallOrder('dialga legend', ['dialga', 'Dialga Legend', 'palkia'], compact), ['dialga legend', 'dialga', 'palkia']);
  assert.deepEqual(recallOrder('mew', ['mew'], compact), ['mew']);
});

test('the union lists full-query matches first, then the stem printings, with the stem total', async () => {
  const stem = Array.from({ length: 207 }, (_, i) => i + 1);
  const { fetchSearchPage } = catalog({ 'dialga legend': [150, 151, 152], dialga: stem });
  const search = createRecallSearch({
    fetchSearchPage,
    recallLookups: async () => ['dialga legend', 'dialga'],
    pageSize: 50,
  });
  const first = await search({ query: 'dialga legend', offset: 0, limit: 48, productType: 'card' });
  assert.deepEqual(first.cards.slice(0, 4).map((c) => c.id), ['150', '151', '152', '1']);
  assert.equal(first.total, 207);
  assert.equal(first.hasMore, true);
  const ids = first.cards.map((c) => c.id);
  let offset = first.nextOffset;
  let page = first;
  while (page.hasMore) {
    page = await search({ query: 'dialga legend', offset, limit: 48, productType: 'card' });
    ids.push(...page.cards.map((c) => c.id));
    offset = page.nextOffset;
  }
  assert.equal(ids.length, 207);
  assert.equal(new Set(ids).size, 207);
  assert.equal(page.total, 207);
});

test('set-aware head rows come first and are not repeated', async () => {
  const { fetchSearchPage } = catalog({ 'dialga legend': [9, 10], dialga: [1, 2, 9, 10, 11] });
  const search = createRecallSearch({ fetchSearchPage, recallLookups: async () => ['dialga legend', 'dialga'] });
  const page = await search({ query: 'dialga legend', offset: 0, limit: 48, productType: 'card', head: async () => [{ id: '10' }, { id: '99' }] });
  assert.deepEqual(page.cards.map((c) => c.id), ['10', '99', '9', '1', '2', '11']);
  assert.equal(page.total, 6);
  assert.equal(page.hasMore, false);
});

test('non-recall requests fall through to the plain search page', async () => {
  const { calls, fetchSearchPage } = catalog({ booster: [1, 2] });
  const search = createRecallSearch({
    fetchSearchPage,
    recallLookups: async () => { throw new Error('not used'); },
    isRecallRequest: (request) => request.productType === 'card',
  });
  const page = await search({ query: 'booster', productSearchOnly: true, offset: 0, limit: 48 });
  assert.equal(page.total, 2);
  assert.equal(calls.length, 1);
});

test('a single-lookup query keeps its own total and order', async () => {
  const { fetchSearchPage } = catalog({ 'mimikyu gx': [5, 6, 7] });
  const search = createRecallSearch({ fetchSearchPage, recallLookups: async () => ['mimikyu gx'] });
  const page = await search({ query: 'mimikyu gx', offset: 0, limit: 48, productType: 'card' });
  assert.deepEqual(page.cards.map((c) => c.id), ['5', '6', '7']);
  assert.equal(page.total, 3);
  assert.equal(page.hasMore, false);
});

test('a failed page does not poison the next request', async () => {
  let fail = true;
  const search = createRecallSearch({
    fetchSearchPage: async ({ query }) => {
      if (fail) throw new Error('network');
      return { cards: [{ id: query }], total: 1, hasMore: false };
    },
    recallLookups: async () => ['x'],
  });
  await assert.rejects(search({ query: 'xx', offset: 0, limit: 48, productType: 'card' }));
  fail = false;
  const page = await search({ query: 'xx', offset: 0, limit: 48, productType: 'card' });
  assert.equal(page.cards.length, 1);
});
