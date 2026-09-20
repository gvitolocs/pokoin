import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDayLabel,
  formatHistoryTip,
  historySeriesMax,
  nearestHistoryDay,
  niceScaleMax,
  todayHistoryDay,
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
});
