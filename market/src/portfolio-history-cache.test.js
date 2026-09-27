import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPortfolioHistory,
  peekPortfolioHistory,
  resetPortfolioHistoryCacheForTests,
} from './portfolio-history-cache.js';

test('dashboard and nav share one normalized history request per user', async () => {
  resetPortfolioHistoryCacheForTests();
  let calls = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const fetcher = () => {
    calls += 1;
    return response;
  };

  const dashboard = loadPortfolioHistory('user-1', fetcher);
  const preview = loadPortfolioHistory('user-1', fetcher);
  release({ days: [
    { date: '2026-09-25', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 2001981 },
    { date: '2026-09-26', currencyPkn: 15, cardsKnown: false },
  ] });

  const [dashboardDays, previewDays] = await Promise.all([dashboard, preview]);
  assert.equal(calls, 1);
  assert.equal(dashboardDays, previewDays);
  assert.equal(previewDays.at(-1).totalPkn, 15);
  assert.equal(peekPortfolioHistory('user-1'), dashboardDays);

  const again = await loadPortfolioHistory('user-1', fetcher);
  assert.equal(calls, 1);
  assert.equal(again, dashboardDays);
});

test('history cache is scoped by user', async () => {
  resetPortfolioHistoryCacheForTests();
  await loadPortfolioHistory('one', async () => ({ days: [{ date: '2026-09-26', currencyPkn: 1 }] }));
  await loadPortfolioHistory('two', async () => ({ days: [{ date: '2026-09-26', currencyPkn: 2 }] }));
  assert.equal(peekPortfolioHistory('one').at(-1).totalPkn, 1);
  assert.equal(peekPortfolioHistory('two').at(-1).totalPkn, 2);
});
