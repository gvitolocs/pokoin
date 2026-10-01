import assert from 'node:assert/strict';
import test from 'node:test';
import { createExpansionCardsFetcher } from './expansion-cards.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent searches share later set pages and include a name beyond the first page', async () => {
  const laterPage = deferred();
  const reachedLaterPage = deferred();
  const offsets = [];
  const remembered = [];
  const fetchCards = createExpansionCardsFetcher({
    pageSize: 2,
    fetchPage: async ({ offset }) => {
      offsets.push(offset);
      if (!offset) {
        return { cards: [{ id: '1', name: 'Switch' }, { id: '2', name: 'Potion' }],
          expansion: { name: 'Evolutions' } };
      }
      reachedLaterPage.resolve();
      return laterPage.promise;
    },
    rememberComplete: (identity, data) => { remembered.push(identity); return data; },
  });
  const first = fetchCards({ slug: 'evolutions' });
  const concurrent = fetchCards({ slug: 'evolutions' });
  await reachedLaterPage.promise;
  const nextKeystroke = fetchCards({ slug: 'evolutions' });
  assert.equal(concurrent, first);
  assert.equal(nextKeystroke, first);
  laterPage.resolve({ cards: [{ id: '3', name: 'Mewtwo', number: '51/108' }] });
  const result = await first;
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.cards.at(-1).name, 'Mewtwo');
  assert.equal(result.expansion.name, 'Evolutions');
  assert.equal(result.hasMore, false);
  assert.deepEqual(remembered, [{ slug: 'evolutions', expansionName: '' }]);
});

test('different set identities hydrate independently', async () => {
  const page = deferred();
  const identities = [];
  const fetchCards = createExpansionCardsFetcher({
    fetchPage: (identity) => { identities.push(identity); return page.promise; },
    rememberComplete: (_, data) => data,
  });
  const first = fetchCards({ slug: 'base-set' });
  const second = fetchCards({ slug: 'evolutions' });
  const byTitle = fetchCards({ expansionName: 'Evolutions' });
  assert.notEqual(first, second);
  assert.notEqual(second, byTitle);
  assert.equal(identities.length, 3);
  page.resolve({ cards: [] });
  await Promise.all([first, second, byTitle]);
});

test('a failed later page releases the shared request so another search can retry', async () => {
  let failed = false;
  const offsets = [];
  const fetchCards = createExpansionCardsFetcher({
    pageSize: 2,
    fetchPage: async ({ offset }) => {
      offsets.push(offset);
      if (!offset) return { cards: [{ id: '1' }, { id: '2' }] };
      if (!failed) { failed = true; throw new Error('page unavailable'); }
      return { cards: [{ id: '3' }] };
    },
    rememberComplete: (_, data) => data,
  });
  const first = fetchCards({ slug: 'evolutions' });
  const concurrent = fetchCards({ slug: 'evolutions' });
  await Promise.all([
    assert.rejects(first, /page unavailable/),
    assert.rejects(concurrent, /page unavailable/),
  ]);
  const retry = await fetchCards({ slug: 'evolutions' });
  assert.deepEqual(retry.cards.map((row) => row.id), ['1', '2', '3']);
  assert.deepEqual(offsets, [0, 2, 0, 2]);
});

test('full pages override a false legacy hasMore flag and duplicate identities keep pagination correct', async () => {
  const offsets = [];
  const fetchCards = createExpansionCardsFetcher({
    pageSize: 2,
    fetchPage: async ({ offset }) => {
      offsets.push(offset);
      return { cards: offset === 0 ? [{ id: '1' }, { id: '2' }]
        : offset === 2 ? [{ id: '2' }, { card_id: '3' }] : [], hasMore: false };
    },
    rememberComplete: (_, data) => data,
  });
  const result = await fetchCards({ slug: 'evolutions' });
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(result.cards.map((row) => row.id || row.card_id), ['1', '2', '3']);
  assert.equal(result.hasMore, false);
});

test('the page budget does not mark a truncated catalog as complete', async () => {
  let remembered = false;
  const offsets = [];
  const fetchCards = createExpansionCardsFetcher({
    pageSize: 2,
    maxPages: 2,
    fetchPage: async ({ offset }) => {
      offsets.push(offset);
      return { cards: [{ id: String(offset + 1) }, { id: String(offset + 2) }] };
    },
    rememberComplete: (_, data) => { remembered = true; return data; },
  });
  const result = await fetchCards({ slug: 'large-set' });
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.hasMore, true);
  assert.equal(remembered, false);
});
