import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCollectionHistory,
  formatDayLabel,
  formatHistoryTip,
  historySeriesMax,
  marketValueFromHoldings,
  movementFromLedger,
  nearestHistoryDay,
  niceScaleMax,
  normalizeHistoryDay,
  readPortfolioHistory,
  todayHistoryDay,
  withLiveHistoryDay,
  writePortfolioHistory,
  yTickValues,
} from './portfolio-history.js';

test('niceScaleMax rounds up cleanly', () => {
  assert.equal(niceScaleMax(0), 20);
  assert.equal(niceScaleMax(15), 20);
  assert.equal(niceScaleMax(21), 50);
});

test('y ticks include zero and the top', () => {
  assert.deepEqual(yTickValues(20, 4), [0, 5, 10, 15, 20]);
});

test('todayHistoryDay keeps the wallet and does not treat an ask as collection value', () => {
  const day = todayHistoryDay({
    currencyPkn: 15,
    listedPkn: 100,
    cardsOwned: 3,
    nftOwned: 1,
    date: '2026-09-20T12:00:00.000Z',
  });
  assert.equal(day.date, '2026-09-20');
  assert.equal(day.totalPkn, 15);
  assert.equal(day.assets.cardsValuePkn, null);
  assert.equal(day.assets.cardsOwned, 3);
  assert.equal(day.assets.nftOwned, 1);
});

test('nearest day and tip composition', () => {
  const days = [
    todayHistoryDay({ currencyPkn: 10, listedPkn: 0, date: '2026-09-18T00:00:00Z' }),
    todayHistoryDay({ currencyPkn: 15, listedPkn: 0, date: '2026-09-20T00:00:00Z' }),
  ];
  assert.equal(historySeriesMax(days), 15);
  assert.equal(nearestHistoryDay(days, 1).date, '2026-09-20');
  const tip = formatHistoryTip(days[1]);
  assert.equal(tip.totalLabel, '15 PKN');
  assert.equal(formatDayLabel('2026-09-20'), 'Sep 20');
  assert.ok(tip.rows.some((row) => row.label === 'Currency' && row.value === '15 PKN'));
  assert.equal(tip.rows.length, 1);
  assert.ok(tip.rows.every((row) => String(row.value).endsWith('PKN')));
  assert.equal(tip.rows.some((row) => row.label === 'Cards'), false);
});

test('collection history starts at zero, keeps the wallet on its own day, and prices cards at the homepage minimum', () => {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  const received = movementFromLedger({
    type: 'account_transfer_received',
    amountPkn: 15,
    createdAt: '2026-09-01T12:00:00.000Z',
  });
  const spent = movementFromLedger({
    type: 'account_transfer_sent',
    amountPkn: 5,
    createdAt: '2026-09-10T12:00:00.000Z',
  });
  assert.equal(received.amountPkn, 15);
  assert.equal(spent.amountPkn, -5);
  const prices = marketValueFromHoldings([
    { cardId: '1', quantity: 2 },
    { cardId: '2', quantity: 1 },
    { cardId: '3', quantity: 4 },
  ], { 1: 10, 2: 0 });
  assert.equal(prices.cardsValuePkn, 20);
  assert.equal(prices.copies, 2);
  assert.equal(marketValueFromHoldings([{ cardId: '9', quantity: 1 }], {}), null);
  const series = buildCollectionHistory({
    movements: [received, spent],
    balance: 10,
    marketCardsPkn: prices.cardsValuePkn,
    today: '2026-09-25T18:00:00.000Z',
  });
  assert.equal(series[0].date, '2026-08-31');
  assert.equal(series[0].totalPkn, 0);
  assert.equal(series[0].assets.cardsValuePkn, null);
  assert.equal(series.find((row) => row.date === '2026-09-01').totalPkn, 15);
  assert.equal(series.find((row) => row.date === '2026-09-10').totalPkn, 10);
  const today = series.find((row) => row.date === '2026-09-25');
  assert.equal(today.assets.currencyPkn, 10);
  assert.equal(today.assets.cardsValuePkn, 20);
  assert.equal(today.totalPkn, 30);
  const tip = formatHistoryTip(today);
  assert.ok(tip.rows.some((row) => row.label === 'Cards' && row.value === '20 PKN'));
  assert.equal(tip.rows.some((row) => row.label === 'Listed'), false);
  const uid = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';
  writePortfolioHistory(uid, series[0]);
  writePortfolioHistory(uid, today);
  const saved = readPortfolioHistory(uid);
  assert.equal(saved.length, 2);
  const live = withLiveHistoryDay(saved, null);
  assert.equal(live.length, 2);
});

test('normalizeHistoryDay is idempotent — desk may re-normalize today()', () => {
  const once = todayHistoryDay({
    currencyPkn: 15,
    listedPkn: 0,
    cardsOwned: 0,
    nftOwned: 0,
    date: '2026-09-20T12:00:00.000Z',
  });
  const twice = normalizeHistoryDay(once);
  assert.equal(twice.totalPkn, 15);
  assert.equal(twice.assets.currencyPkn, 15);
  const tip = formatHistoryTip(twice);
  assert.ok(tip.rows.some((row) => row.label === 'Currency' && row.value === '15 PKN'));
});
