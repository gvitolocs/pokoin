import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCollectionHistory,
  availableHistoryPresets,
  formatDayLabel,
  formatHistoryDelta,
  formatHistoryTip,
  historyWindowChange,
  historyPresetWindow,
  historyAxis,
  sliceHistorySeries,
  stepHistoryPoints,
  historySeriesMax,
  marketValueFromHoldings,
  movementFromLedger,
  historyPlotX,
  historyPointerDay,
  projectCardValue,
  historyWindowSplit,
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

test('history opens on the last month and hides years the series does not reach', () => {
  const today = new Date('2026-09-25T12:00:00.000Z');
  const series = [
    { date: '2026-05-16', currencyPkn: 0, cardsKnown: false },
    { date: '2026-05-21', currencyPkn: 15, cardsKnown: false },
    { date: '2026-09-25', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 4026552 },
  ];
  const presets = availableHistoryPresets(series, today).map((row) => row.id);
  assert.deepEqual(presets, ['1M', '3M', 'MAX']);
  assert.equal(historyPresetWindow('1M', today).from, '2026-08-26');
  const month = sliceHistorySeries(series, historyPresetWindow('1M', today));
  assert.equal(month[0].date, '2026-08-26');
  assert.equal(month[0].totalPkn, 15);
  assert.equal(month[0].carried, true);
  assert.equal(month[month.length - 1].date, '2026-09-25');
  assert.equal(month[month.length - 1].totalPkn, 4026567);
  assert.equal(
    formatHistoryDelta(historyWindowChange(month, '1M')),
    '+4026552 PKN in the last month',
  );
  const change = formatHistoryDelta({ last: 30, delta: 15, pct: 100, phrase: 'in the last month' });
  assert.equal(change, '+15 PKN (+100%) in the last month');
  const custom = sliceHistorySeries(series, { from: '2026-09-01', to: '2026-09-10' });
  assert.equal(custom[0].date, '2026-09-01');
  assert.equal(custom[custom.length - 1].date, '2026-09-10');
  assert.equal(custom[0].totalPkn, 15);
  assert.equal(custom[1].totalPkn, 15);
  const stepped = stepHistoryPoints([{ x: 0, y: 180 }, { x: 640, y: 20 }]);
  assert.deepEqual(stepped, [
    { x: 0, y: 180 },
    { x: 640, y: 180 },
    { x: 640, y: 20 },
  ]);
});

test('a priced pile does not stretch the axis down to the wallet', () => {
  const axis = historyAxis([
    normalizeHistoryDay({ date: '2026-08-26', currencyPkn: 15, cardsKnown: false }),
    normalizeHistoryDay({ date: '2026-09-21', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 4073702 }),
    normalizeHistoryDay({ date: '2026-09-23', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 4026552 }),
    normalizeHistoryDay({ date: '2026-09-26', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 4026530 }),
  ]);
  assert.ok(axis.yMin > 3900000);
  assert.ok(axis.yMax < 4200000);
  const span = axis.yMax - axis.yMin;
  assert.ok((4073717 - 4026545) / span > 0.2);
  const nearZero = historyAxis([
    normalizeHistoryDay({ date: '2026-09-01', currencyPkn: 0, cardsKnown: false }),
    normalizeHistoryDay({ date: '2026-09-02', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 100 }),
  ]);
  assert.equal(nearZero.yMin, 0);
});

test('nearest day and tip composition', () => {
  const days = [
    todayHistoryDay({ currencyPkn: 10, listedPkn: 0, date: '2026-09-18T00:00:00Z' }),
    todayHistoryDay({ currencyPkn: 15, listedPkn: 0, date: '2026-09-20T00:00:00Z' }),
  ];
  assert.equal(historySeriesMax(days), 15);
  assert.equal(nearestHistoryDay(days, 1).date, '2026-09-20');
  assert.equal(nearestHistoryDay(days, 0.25).date, '2026-09-18');
  const stepped = [
    { date: '2026-08-27', totalPkn: 15 },
    { date: '2026-09-21', totalPkn: 4026567 },
    { date: '2026-09-26', totalPkn: 4026545 },
  ];
  assert.equal(nearestHistoryDay(stepped, 0.5).date, '2026-08-27');
  assert.equal(nearestHistoryDay(stepped, 25 / 30).date, '2026-09-21');
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

test('today stops at two thirds and the rest of the plot is a projection', () => {
  const points = [
    normalizeHistoryDay({ date: '2026-09-01', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 100 }),
    normalizeHistoryDay({ date: '2026-09-26', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 80 }),
  ];
  assert.equal(historyWindowSplit(points, '2026-09-26T12:00:00.000Z'), 2 / 3);
  assert.equal(historyWindowSplit(points, '2026-09-27T12:00:00.000Z'), 1);
  const end = historyPlotX('2026-09-26', {
    from: '2026-09-01',
    to: '2026-09-26',
    width: 640,
    split: 2 / 3,
  });
  assert.equal(end, 640 * (2 / 3));
  assert.equal(historyPlotX('2026-09-01', {
    from: '2026-09-01',
    to: '2026-09-26',
    width: 640,
    split: 2 / 3,
  }), 0);
  const hatch = historyPointerDay(points, 0.9, { split: 2 / 3 });
  assert.equal(hatch.projection, true);
  assert.equal(hatch.day.date, '2026-09-26');
  const tip = formatHistoryTip(hatch.day, { projection: true });
  assert.ok(tip.rows.some((row) => row.label === 'Projection' && row.value === 'Rest of today'));
  const known = historyPointerDay(points, 1 / 3, { split: 2 / 3 });
  assert.equal(known.projection, false);
  assert.equal(known.day.date, '2026-09-01');
});

test('card projection is a one-step regression of sold days', () => {
  const rising = [
    normalizeHistoryDay({ date: '2026-09-24', currencyPkn: 0, cardsKnown: true, cardsValuePkn: 100 }),
    normalizeHistoryDay({ date: '2026-09-25', currencyPkn: 0, cardsKnown: true, cardsValuePkn: 200 }),
  ];
  assert.deepEqual(projectCardValue(rising), { value: 300, slope: 100, days: 2 });
  const tip = formatHistoryTip(rising[1], { projection: true, forecast: projectCardValue(rising) });
  assert.ok(tip.rows.some((row) => row.label === 'Projection' && row.value === '300 PKN'));
  const walletOnly = [
    normalizeHistoryDay({ date: '2026-09-25', currencyPkn: 15 }),
    normalizeHistoryDay({ date: '2026-09-26', currencyPkn: 15 }),
  ];
  assert.equal(projectCardValue(walletOnly), null);
  assert.equal(projectCardValue([rising[0]]), null);
});
