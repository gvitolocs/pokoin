import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addUtcDays,
  availableHistoryPresets,
  daySpan,
  formatDayLabel,
  formatHistoryDelta,
  formatHistoryTip,
  historyAxis,
  historyDateTicks,
  historyDayAt,
  historyPresetWindow,
  historyTimeline,
  historyWindowChange,
  normalizeHistoryDay,
  previewHistoryMonth,
  sliceHistorySeries,
  stepHistoryPoints,
  timelineDay,
  timelineRatio,
  withLiveToday,
} from './portfolio-history.js';

const TODAY = new Date('2026-09-27T10:00:00.000Z');

/** The API's daily series for the seller in the dashboard screenshot. */
function screenshotSeries() {
  const days = [{ date: '2026-05-20', currencyPkn: 0 }];
  for (let day = '2026-05-21'; day <= '2026-09-27'; day = addUtcDays(day, 1)) {
    const cards = day < '2026-09-21'
      ? null
      : (day < '2026-09-22' ? [13135, 86, null] : (day < '2026-09-23' ? [13163, 87, 0] : [16285, 106, day === '2026-09-23' ? -0.002127 : 0]));
    days.push(cards
      ? { date: day, currencyPkn: 15, cardsKnown: true, cardsValuePkn: cards[0], cardsPriced: cards[1], cardsHeld: 227, cardsMove: cards[2] }
      : { date: day, currencyPkn: 15, cardsKnown: false, cardsValuePkn: null });
  }
  return days;
}

test('a day normalizes once: cards stay null before stock, never an ask', () => {
  const wallet = normalizeHistoryDay({ date: '2026-09-20', currencyPkn: 15, cardsValuePkn: 999 });
  assert.equal(wallet.totalPkn, 15);
  assert.equal(wallet.assets.cardsValuePkn, null);
  assert.equal(wallet.assets.cardsHeld, 0);
  const held = normalizeHistoryDay({
    date: '2026-09-23',
    currencyPkn: 15,
    cardsKnown: true,
    cardsValuePkn: 16285,
    cardsPriced: 106,
    cardsHeld: 227,
    cardsMove: -0.002127,
  });
  assert.equal(held.totalPkn, 16300);
  assert.deepEqual(normalizeHistoryDay(held), held);
  assert.equal(held.assets.cardsMove, -0.002127);
});

test('today ends on the live wallet and 1-DR totals shown above the chart', () => {
  const series = screenshotSeries();
  const live = withLiveToday(series, {
    currencyPkn: 20,
    cards: { valuePkn: 16301.5, pricedCards: 107, cards: 227 },
  }, TODAY);
  const today = live[live.length - 1];
  assert.equal(today.date, '2026-09-27');
  assert.equal(today.totalPkn, 16321.5);
  assert.equal(today.assets.cardsPriced, 107);
  assert.equal(live.length, series.length);
  // Unknown 1-DR totals leave the server's cards alone.
  const walletOnly = withLiveToday(series, { currencyPkn: 20 }, TODAY);
  assert.equal(walletOnly[walletOnly.length - 1].assets.cardsValuePkn, 16285);
  // A stored series that stops yesterday gains today from the last day.
  const stale = withLiveToday(series.slice(0, -1), { currencyPkn: 15 }, TODAY);
  assert.equal(stale[stale.length - 1].date, '2026-09-27');
  assert.equal(stale[stale.length - 1].assets.cardsValuePkn, 16285);
  assert.equal(stale[stale.length - 1].assets.cardsMove, null);
  assert.deepEqual(withLiveToday([], { currencyPkn: 0 }, TODAY), []);
});

test('the screenshot seller: quiet days hold the pile and the header matches the chart', () => {
  const days = withLiveToday(screenshotSeries(), {
    currencyPkn: 15,
    cards: { valuePkn: 16285, pricedCards: 106, cards: 227 },
  }, TODAY);
  const points = sliceHistorySeries(days, historyPresetWindow('1M', TODAY));
  assert.equal(points[0].date, '2026-08-28');
  assert.equal(points[points.length - 1].date, '2026-09-27');
  for (const date of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) {
    assert.equal(historyDayAt(points, date).totalPkn, 16300);
  }
  const change = historyWindowChange(points, '1M');
  assert.equal(change.last, 16300);
  // The cards arrived inside the month, so there is no percentage return.
  assert.equal(formatHistoryDelta(change), '+16285 PKN in the last month');
  const axis = historyAxis(points.map((day) => day.totalPkn));
  assert.deepEqual(axis.ticks, [0, 5000, 10000, 15000, 20000]);
});

test('history opens on the last month and hides windows the series does not reach', () => {
  const series = [
    { date: '2026-05-16', currencyPkn: 0 },
    { date: '2026-05-21', currencyPkn: 15 },
    { date: '2026-09-25', currencyPkn: 15, cardsKnown: true, cardsValuePkn: 400, cardsHeld: 3, cardsPriced: 2 },
  ];
  const today = new Date('2026-09-25T12:00:00.000Z');
  assert.deepEqual(availableHistoryPresets(series, today).map((row) => row.id), ['1M', '3M', 'MAX']);
  assert.equal(historyPresetWindow('1M', today).from, '2026-08-26');
  const month = sliceHistorySeries(series, historyPresetWindow('1M', today));
  assert.equal(month[0].date, '2026-08-26');
  assert.equal(month[0].totalPkn, 15);
  assert.equal(month[0].carried, true);
  const custom = sliceHistorySeries(series, { from: '2026-09-01', to: '2026-09-10' });
  assert.deepEqual(custom.map((day) => [day.date, day.totalPkn]), [['2026-09-01', 15], ['2026-09-10', 15]]);
  assert.equal(formatHistoryDelta({ last: 30, delta: 15, pct: 100, phrase: 'in the last month' }), '+15 PKN (+100%) in the last month');
  const steady = historyWindowChange([
    normalizeHistoryDay({ date: '2026-09-01', currencyPkn: 0, cardsKnown: true, cardsValuePkn: 200, cardsHeld: 2 }),
    normalizeHistoryDay({ date: '2026-09-02', currencyPkn: 0, cardsKnown: true, cardsValuePkn: 150, cardsHeld: 2 }),
  ]);
  assert.equal(formatHistoryDelta(steady), '-50 PKN (-25%) in this period');
});

test('a window that ends today spans the whole plot on its own realized day scale', () => {
  const points = sliceHistorySeries(screenshotSeries(), historyPresetWindow('1M', TODAY));
  const timeline = historyTimeline(points, TODAY);
  assert.deepEqual(
    [timeline.from, timeline.to, timeline.span, timeline.live],
    ['2026-08-28', '2026-09-27', 30, true],
  );
  assert.equal(timelineRatio(timeline, timeline.from), 0);
  assert.equal(timelineRatio(timeline, timeline.to), 1);
  assert.equal(timelineDay(timeline, 0.5), '2026-09-12');
  assert.equal(timelineDay(timeline, 1), '2026-09-27');
  // A past custom window is realized end to end and is not today.
  const past = historyTimeline(sliceHistorySeries(screenshotSeries(), { from: '2026-09-01', to: '2026-09-20' }), TODAY);
  assert.equal(past.live, false);
  assert.equal(past.span, 19);
  // A single stored day still gets a realized day before it.
  const single = historyTimeline([normalizeHistoryDay({ date: '2026-09-27', currencyPkn: 15 })], TODAY);
  assert.equal(single.from, '2026-09-26');
  assert.equal(single.span, 1);
});

test('the last realized day of a live window maps to the right edge, never past today', () => {
  const points = sliceHistorySeries(screenshotSeries(), historyPresetWindow('1M', TODAY));
  const timeline = historyTimeline(points, TODAY);
  assert.equal(timelineRatio(timeline, points[points.length - 1].date), 1);
  // The far right of the plot is today, so nothing hovers or ticks past it.
  assert.equal(timelineDay(timeline, 1), '2026-09-27');
  assert.ok(historyDateTicks(timeline).every((tick) => tick.date <= timeline.to));
});

test('date ticks are Mondays or month starts and leave room for Today', () => {
  const month = historyTimeline(sliceHistorySeries(screenshotSeries(), historyPresetWindow('1M', TODAY)), TODAY);
  const ticks = historyDateTicks(month);
  assert.deepEqual(ticks.map((tick) => tick.label), ['Aug 31', 'Sep 7', 'Sep 14', 'Sep 21']);
  assert.ok(ticks.every((tick) => tick.ratio < 0.92));
  const quarter = historyTimeline(sliceHistorySeries(screenshotSeries(), historyPresetWindow('3M', TODAY)), TODAY);
  assert.deepEqual(historyDateTicks(quarter).map((tick) => tick.label), ['Jul 6', 'Jul 20', 'Aug 3', 'Aug 17', 'Aug 31', 'Sep 14']);
  assert.equal(formatDayLabel('2026-09-20'), 'Sep 20');
  assert.equal(daySpan('2026-09-01', '2026-10-01'), 30);
});

test('the axis starts at zero for a big move and hugs a steady pile', () => {
  const jump = historyAxis([15, 13150, 16300]);
  assert.equal(jump.yMin, 0);
  assert.deepEqual(jump.ticks, [0, 5000, 10000, 15000, 20000]);
  const steady = historyAxis([16300, 16420, 16180, 16510]);
  assert.ok(steady.yMin > 15000);
  assert.ok(steady.yMax < 17500);
  assert.ok((16510 - 16180) / (steady.yMax - steady.yMin) > 0.25);
  assert.equal(historyAxis([]).yMax, 20);
  assert.deepEqual(stepHistoryPoints([{ x: 0, y: 180 }, { x: 640, y: 20 }]), [
    { x: 0, y: 180 },
    { x: 640, y: 180 },
    { x: 640, y: 20 },
  ]);
});

test('the tip lists every layer at that day, cards with how many have a sale', () => {
  const tip = formatHistoryTip(normalizeHistoryDay({
    date: '2026-09-23',
    currencyPkn: 15,
    cardsKnown: true,
    cardsValuePkn: 16285,
    cardsPriced: 106,
    cardsHeld: 227,
  }));
  assert.equal(tip.dateLabel, 'Sep 23');
  assert.equal(tip.totalLabel, '16300 PKN');
  assert.deepEqual(tip.rows.map((row) => [row.label, row.value, row.note || '']), [
    ['Cards', '16285 PKN', '106 of 227 with a sale'],
    ['Liquidity', '15 PKN', ''],
  ]);
  const wallet = formatHistoryTip(normalizeHistoryDay({ date: '2026-09-20', currencyPkn: 15 }));
  assert.deepEqual(wallet.rows.map((row) => row.label), ['Liquidity']);
});


test('preview history keeps only actual observations in the last 30 UTC days', () => {
  const rows = [
    { date: '2026-08-28', totalPkn: 1 },
    { date: '2026-08-29', totalPkn: 2 },
    { date: '2026-09-27', totalPkn: 3 },
    { date: '2026-09-28', totalPkn: 4 },
  ];
  assert.deepEqual(previewHistoryMonth(rows, TODAY), rows.slice(1, 3));
  assert.deepEqual(previewHistoryMonth(rows.slice(0, 1), TODAY), []);
  assert.deepEqual(previewHistoryMonth(rows.slice(1, 2), TODAY), rows.slice(1, 2));
});
