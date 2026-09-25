import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDayLabel,
  formatHistoryTip,
  historySeriesMax,
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

test('todayHistoryDay totals currency + listed without inventing card PKN', () => {
  const day = todayHistoryDay({
    currencyPkn: 15,
    listedPkn: 100,
    cardsOwned: 3,
    nftOwned: 1,
    date: '2026-09-20T12:00:00.000Z',
  });
  assert.equal(day.date, '2026-09-20');
  assert.equal(day.totalPkn, 115);
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
  assert.equal(tip.rows.length, 4);
  assert.ok(tip.rows.every((row) => String(row.value).endsWith('PKN')));
  assert.ok(tip.rows.some((row) => row.label === 'Cards owned' && row.value === '0 PKN'));
  assert.ok(tip.rows.some((row) => row.label === 'Digital / NFT' && row.value === '0 PKN'));
});

test('collection value includes the CardTrader 1-DR mark and one snapshot per day', () => {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  const uid = 'PUH1ygG9mOOyQRPXaY5Fa1W6DKd2';
  const first = todayHistoryDay({
    currencyPkn: 15,
    cardsValuePkn: 1000,
    date: '2026-09-24T12:00:00.000Z',
  });
  assert.equal(first.totalPkn, 1015);
  assert.equal(first.assets.cardsValuePkn, 1000);
  writePortfolioHistory(uid, first);
  writePortfolioHistory(uid, todayHistoryDay({
    currencyPkn: 15,
    cardsValuePkn: 4043760,
    date: '2026-09-25T18:00:00.000Z',
  }));
  writePortfolioHistory(uid, todayHistoryDay({
    currencyPkn: 15,
    cardsValuePkn: 4043760,
    date: '2026-09-25T20:00:00.000Z',
  }));
  const saved = readPortfolioHistory(uid);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].date, '2026-09-25');
  assert.equal(saved[1].totalPkn, 4043775);
  const live = withLiveHistoryDay(saved, todayHistoryDay({
    currencyPkn: 20,
    cardsValuePkn: 4043760,
    date: '2026-09-25T21:00:00.000Z',
  }));
  assert.equal(live.length, 2);
  assert.equal(live[1].assets.currencyPkn, 20);
  const tip = formatHistoryTip(live[1]);
  assert.ok(tip.rows.some((row) => row.label === 'Cards owned' && row.value === '4043760 PKN'));
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
