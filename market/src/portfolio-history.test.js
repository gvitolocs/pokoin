import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addUtcDays,
  availableHistoryPresets,
  cardMoves,
  daySpan,
  formatDayLabel,
  formatHistoryDelta,
  formatHistoryTip,
  formatProjectionTip,
  historyAxis,
  historyDateTicks,
  historyDayAt,
  historyPresetWindow,
  historyTimeline,
  historyWindowChange,
  normalizeHistoryDay,
  projectPortfolio,
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
  const timeline = historyTimeline(points, TODAY);
  const projection = projectPortfolio(points, timeline);
  const axis = historyAxis([
    ...points.map((day) => day.totalPkn),
    ...projection.days.flatMap((day) => [day.low, day.high]),
  ]);
  assert.deepEqual(axis.ticks, [0, 5000, 10000, 15000, 20000]);
  // Six days of moves: the projection holds today's value, no fan.
  assert.equal(projection.band, false);
  assert.equal(projection.end.value, 16300);
  assert.equal(projection.end.date, '2026-10-12');
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

test('a window that ends today puts today at two thirds with the projection on the same day scale', () => {
  const points = sliceHistorySeries(screenshotSeries(), historyPresetWindow('1M', TODAY));
  const timeline = historyTimeline(points, TODAY);
  assert.deepEqual(
    [timeline.from, timeline.to, timeline.end, timeline.span, timeline.horizonDays],
    ['2026-08-28', '2026-09-27', '2026-10-12', 30, 15],
  );
  assert.equal(timeline.split, 2 / 3);
  assert.equal(timelineRatio(timeline, '2026-09-27'), 2 / 3);
  assert.equal(timelineRatio(timeline, '2026-10-12'), 1);
  assert.equal(timelineDay(timeline, 0.9), '2026-10-08');
  // A past custom window has no projection.
  const past = historyTimeline(sliceHistorySeries(screenshotSeries(), { from: '2026-09-01', to: '2026-09-20' }), TODAY);
  assert.equal(past.horizonDays, 0);
  assert.equal(past.split, 1);
  // A single stored day still gets a realized day before it.
  const single = historyTimeline([normalizeHistoryDay({ date: '2026-09-27', currencyPkn: 15 })], TODAY);
  assert.equal(single.from, '2026-09-26');
  assert.equal(single.horizonDays, 1);
});

test('date ticks are Mondays or month starts and leave room for Today', () => {
  const month = historyTimeline(sliceHistorySeries(screenshotSeries(), historyPresetWindow('1M', TODAY)), TODAY);
  const ticks = historyDateTicks(month);
  assert.deepEqual(ticks.map((tick) => tick.label), ['Aug 31', 'Sep 7', 'Sep 14', 'Sep 21', 'Oct 5']);
  assert.ok(ticks.every((tick) => Math.abs(tick.ratio - month.split) > 0.08));
  const quarter = historyTimeline(sliceHistorySeries(screenshotSeries(), historyPresetWindow('3M', TODAY)), TODAY);
  assert.deepEqual(historyDateTicks(quarter).map((tick) => tick.label), ['Aug 1', 'Sep 1', 'Nov 1']);
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

function movingSeries(moves) {
  let value = 1000;
  const days = [normalizeHistoryDay({ date: '2026-09-01', currencyPkn: 50, cardsKnown: true, cardsValuePkn: value, cardsHeld: 10, cardsPriced: 10 })];
  moves.forEach((move, index) => {
    value = Math.round(value * (1 + move) * 100) / 100;
    days.push(normalizeHistoryDay({
      date: addUtcDays('2026-09-01', index + 1),
      currencyPkn: 50,
      cardsKnown: true,
      cardsValuePkn: value,
      cardsHeld: 10,
      cardsPriced: 10,
      cardsMove: move,
    }));
  });
  return days;
}

test('a week of basket moves draws a fan that widens with time; liquidity stays flat', () => {
  const points = movingSeries([0.01, -0.02, 0.015, 0, 0.005, -0.01, 0.02, 0, 0.01, -0.005]);
  const timeline = historyTimeline(points, new Date('2026-09-11T08:00:00Z'));
  assert.equal(timeline.horizonDays, 5);
  const projection = projectPortfolio(points, timeline);
  assert.equal(projection.band, true);
  assert.equal(projection.moves, 10);
  const [start, , mid, , , end] = projection.days;
  assert.equal(start.value, points[points.length - 1].totalPkn);
  assert.equal(start.low, start.high);
  assert.ok(end.high - end.low > mid.high - mid.low);
  assert.ok(end.low > 50 && end.high > end.value && end.value > end.low);
  assert.equal(end.liquidity, 50);
  // The mean move is shrunk toward zero: ten days cannot draw a steep trend.
  const mean = cardMoves(points).reduce((sum, move) => sum + move, 0) / 10;
  assert.ok(Math.abs(projection.drift) < Math.abs(mean));
  const tip = formatProjectionTip(end, projection);
  assert.equal(tip.dateLabel, `${formatDayLabel(end.date)} · Projection`);
  assert.match(tip.rows[0].value, /^\d+–\d+ PKN$/);
  assert.match(tip.footnote, /10 days of sold prices/);
});

test('one lucky sale cannot draw a trend, and first sales are not moves', () => {
  // The other 1-DR seller: one +57% basket print among quiet days.
  const short = movingSeries([0, 0.568, 0, 0, 0, 0]);
  const flat = projectPortfolio(short, historyTimeline(short, new Date('2026-09-07T08:00:00Z')));
  assert.equal(flat.band, false);
  assert.equal(flat.end.value, short[short.length - 1].totalPkn);
  assert.match(formatProjectionTip(flat.end, flat).footnote, /week of sold prices/);
  const week = movingSeries([0, 0.568, 0, 0, 0, 0, 0]);
  const clipped = cardMoves(week);
  assert.equal(Math.max(...clipped), 0.25);
  const fan = projectPortfolio(week, historyTimeline(week, new Date('2026-09-08T08:00:00Z')));
  assert.ok(fan.end.value < week[week.length - 1].totalPkn * 1.06);
  // Carried window edges repeat a day, so they add no move.
  const carried = [...week, { ...week[week.length - 1], date: '2026-09-09', carried: true }];
  assert.equal(cardMoves(carried).length, 7);
  // A wallet-only series projects the wallet.
  const wallet = [
    normalizeHistoryDay({ date: '2026-09-25', currencyPkn: 15 }),
    normalizeHistoryDay({ date: '2026-09-27', currencyPkn: 15 }),
  ];
  const held = projectPortfolio(wallet, historyTimeline(wallet, TODAY));
  assert.equal(held.end.value, 15);
  assert.equal(held.band, false);
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
