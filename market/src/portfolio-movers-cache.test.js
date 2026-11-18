import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPortfolioMovers,
  peekPortfolioMovers,
  resetPortfolioMoversCacheForTests,
} from './portfolio-movers-cache.js';

function payload(days, blueprintId) {
  return {
    ok: true,
    days,
    gainers: [{ blueprintId, name: 'Charizard ex', endPkn: 1450, changePct: 45 }],
    losers: [],
  };
}

test('one request per user and window, shared by every caller', async () => {
  resetPortfolioMoversCacheForTests();
  let calls = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const fetcher = () => {
    calls += 1;
    return response;
  };

  const dashboard = loadPortfolioMovers('user-1', 30, fetcher);
  const again = loadPortfolioMovers('user-1', 30, fetcher);
  release(payload(30, '502874'));

  const [first, second] = await Promise.all([dashboard, again]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(first.gainers[0].blueprintId, '502874');
  assert.equal(peekPortfolioMovers('user-1', 30), first);

  // The window is cached, so flipping the switch or re-mounting never refetches.
  const later = await loadPortfolioMovers('user-1', 30, fetcher);
  assert.equal(calls, 1);
  assert.equal(later, first);
});

test('movers are scoped by user and by window', async () => {
  resetPortfolioMoversCacheForTests();
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return Promise.resolve(payload(calls, `${calls}`));
  };

  const month = await loadPortfolioMovers('one', 30, fetcher);
  const all = await loadPortfolioMovers('one', 'max', fetcher);
  const other = await loadPortfolioMovers('two', 30, fetcher);
  assert.equal(calls, 3);
  assert.equal(month.gainers[0].blueprintId, '1');
  assert.equal(all.gainers[0].blueprintId, '2');
  assert.equal(other.gainers[0].blueprintId, '3');
  assert.equal(peekPortfolioMovers('two', 'max'), null);
});

test('a signed-out user and a failed request never poison the cache', async () => {
  resetPortfolioMoversCacheForTests();
  const empty = await loadPortfolioMovers('', 30, () => Promise.reject(new Error('never')));
  assert.deepEqual(empty, { days: null, gainers: [], losers: [] });
  assert.equal(peekPortfolioMovers('', 30), null);

  const failed = loadPortfolioMovers('user-1', 30, () => Promise.reject(new Error('503')));
  await assert.rejects(failed, /503/);
  assert.equal(peekPortfolioMovers('user-1', 30), null);

  // A retry is allowed to ask again.
  let calls = 0;
  const retried = await loadPortfolioMovers('user-1', 30, () => {
    calls += 1;
    return Promise.resolve(payload(30, '9'));
  });
  assert.equal(calls, 1);
  assert.equal(retried.gainers.length, 1);
});
