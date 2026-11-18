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
  historyCountValue,
  historyDateTicks,
  historyDayAt,
  historyDrawProgress,
  historyLabelAnchor,
  historyPresetWindow,
  historyTimeline,
  historyWindowChange,
  HISTORY_COUNT_FROM,
  HISTORY_DRAW_MS,
  liquidityBandRatio,
  normalizeHistoryDay,
  previewHistoryMonth,
  sliceHistorySeries,
  smoothHistoryBandPath,
  smoothHistoryPath,
  smoothHistoryPointAt,
  smoothHistorySegments,
  stepHistoryPath,
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

const JAGGED_VALUES = [64500, 61000, 64600, 63100, 59500, 59000, 61300, 65100, 59800, 58300];

/** The panel's plot box: x spread over 640, y inside 12..212, newest value high. */
function jaggedCoords() {
  const high = Math.max(...JAGGED_VALUES);
  const low = Math.min(...JAGGED_VALUES);
  return JAGGED_VALUES.map((value, index) => ({
    x: (index / (JAGGED_VALUES.length - 1)) * 640,
    y: 212 - ((value - low) / (high - low)) * 200,
  }));
}

test('the smooth curve runs through every day and never overshoots between two', () => {
  const coords = jaggedCoords();
  const segments = smoothHistorySegments(coords);
  assert.equal(segments.length, coords.length - 1);
  segments.forEach((segment, index) => {
    const from = coords[index];
    const to = coords[index + 1];
    assert.deepEqual([segment.x0, segment.y0, segment.x1, segment.y1], [from.x, from.y, to.x, to.y]);
    const lo = Math.min(from.y, to.y);
    const hi = Math.max(from.y, to.y);
    assert.ok(segment.cx1 > from.x && segment.cx1 < to.x, `first control x on ${index}`);
    assert.ok(segment.cx2 > from.x && segment.cx2 < to.x, `second control x on ${index}`);
    assert.ok(segment.cy1 >= lo && segment.cy1 <= hi, `first control y on ${index}`);
    assert.ok(segment.cy2 >= lo && segment.cy2 <= hi, `second control y on ${index}`);
  });
});

test('a flat run stays flat and a reversed edge is the very same curve', () => {
  const flat = [0, 80, 160, 240, 320].map((x) => ({ x, y: 100 }));
  const levels = smoothHistorySegments(flat);
  assert.equal(levels.length, flat.length - 1);
  for (const segment of levels) {
    assert.equal(segment.cy1, 100);
    assert.equal(segment.cy2, 100);
  }
  const coords = jaggedCoords();
  const forward = smoothHistorySegments(coords);
  const back = smoothHistorySegments([...coords].reverse());
  const mirror = (segment) => [
    segment.cx2, segment.cy2, segment.cx1, segment.cy1,
    segment.x1, segment.y1, segment.x0, segment.y0,
  ];
  back.forEach((segment, index) => {
    const want = mirror(forward[forward.length - 1 - index]);
    const got = [
      segment.cx1, segment.cy1, segment.cx2, segment.cy2,
      segment.x0, segment.y0, segment.x1, segment.y1,
    ];
    want.forEach((value, at) => {
      assert.ok(Math.abs(value - got[at]) < 1e-9, `segment ${index} field ${at}: ${got[at]} vs ${value}`);
    });
  });
});

test('a short window has no curve, two days join straight, junk x never makes NaN', () => {
  assert.deepEqual(smoothHistorySegments([]), []);
  assert.deepEqual(smoothHistorySegments([{ x: 0, y: 10 }]), []);
  const pair = smoothHistorySegments([{ x: 0, y: 200 }, { x: 100, y: 100 }]);
  assert.equal(pair.length, 1);
  const [only] = pair;
  assert.equal(only.cy1, 200 + (100 - 200) / 3);
  assert.equal(only.cy2, 100 - (100 - 200) / 3);
  // A day that repeats or is not a number cannot widen the curve.
  const broken = [
    [{ x: 0, y: 200 }, { x: 0, y: 12 }, { x: 640, y: 30 }],
    [{ x: 0, y: 200 }, { x: NaN, y: 12 }, { x: 120, y: Infinity }, { x: 640, y: 30 }],
    [{ x: 640, y: 30 }, { x: 120, y: 12 }],
  ];
  for (const coords of broken) {
    for (const segment of smoothHistorySegments(coords)) {
      for (const value of Object.values(segment)) assert.ok(Number.isFinite(value), `${value} is not a number`);
    }
  }
  // A backwards series is a curve too: an area returns along its own edge.
  assert.equal(smoothHistorySegments(broken[2]).length, 1);
  assert.equal(smoothHistorySegments(broken[0]).length, 1);
  assert.equal(smoothHistoryPath([{ x: 5, y: 5 }]), 'M 5.00 5.00');
  assert.equal(smoothHistoryPath([]), '');
  assert.equal(smoothHistoryBandPath([], []), '');
});

test('the area band keeps the line curve and closes on its own edges', () => {
  const top = jaggedCoords();
  const bottom = top.map((point) => ({ x: point.x, y: point.y + 40 }));
  const line = smoothHistoryPath(top);
  const band = smoothHistoryBandPath(top, bottom);
  assert.ok(band.startsWith(`${line} L `), band.slice(0, 60));
  assert.ok(band.endsWith(' Z'));
  assert.equal(band.split('M').length, 2);
  // Both edges carry the curve, so the band is not a triangle over one leg.
  assert.equal(band.split('C').length - 1, 2 * (top.length - 1));
  line.split('C').slice(1).forEach((commands, index) => {
    const end = commands.split(',').pop().trim().split(' ').map(Number);
    assert.deepEqual(end, [Number(top[index + 1].x.toFixed(2)), Number(top[index + 1].y.toFixed(2))]);
  });
  for (const value of band.split(/[^-\d.]+/).filter(Boolean)) {
    assert.match(value, /^-?\d+(\.\d{1,2})?$/, value);
  }
  // The lowest band steps down to the baseline at its first and last x.
  const area = smoothHistoryBandPath(bottom, bottom.map((point) => ({ x: point.x, y: 212 })));
  assert.ok(area.startsWith(`${smoothHistoryPath(bottom)} L `));
  assert.ok(area.includes(`L ${bottom[bottom.length - 1].x.toFixed(2)} 212.00`), area.slice(-40));
});

test('the draw-in eases out over 900 ms and clamps at both ends', () => {
  assert.equal(HISTORY_DRAW_MS, 900);
  assert.equal(historyDrawProgress(0, HISTORY_DRAW_MS), 0);
  assert.equal(historyDrawProgress(HISTORY_DRAW_MS / 2, HISTORY_DRAW_MS), 0.9375);
  assert.equal(historyDrawProgress(HISTORY_DRAW_MS, HISTORY_DRAW_MS), 1);
  assert.equal(historyDrawProgress(HISTORY_DRAW_MS * 2, HISTORY_DRAW_MS), 1);
  assert.equal(historyDrawProgress(-20, HISTORY_DRAW_MS), 0);
  assert.equal(historyDrawProgress(Number.NaN, HISTORY_DRAW_MS), 0);
  let previous = 0;
  for (let elapsed = -100; elapsed <= 1100; elapsed += 10) {
    const value = historyDrawProgress(elapsed, HISTORY_DRAW_MS);
    assert.ok(value >= 0 && value <= 1, `${elapsed} is out of range`);
    assert.ok(value >= previous, `${elapsed} went backwards`);
    previous = value;
  }
});

test('the headline counts up from 85% of its value to the value', () => {
  assert.equal(HISTORY_COUNT_FROM, 0.85);
  assert.equal(historyCountValue(20000, 0), 17000);
  assert.equal(historyCountValue(20000, 0.5), 18500);
  assert.equal(historyCountValue(20000, 1), 20000);
  assert.equal(historyCountValue(20000, 4), 20000);
  assert.equal(historyCountValue(20000, -1), 17000);
  assert.equal(historyCountValue(16300, historyDrawProgress(0, HISTORY_DRAW_MS)), 13855);
  assert.equal(historyCountValue(16300, historyDrawProgress(HISTORY_DRAW_MS, HISTORY_DRAW_MS)), 16300);
  assert.equal(historyCountValue(undefined, 0.5), 0);
});

test('the head dot of the draw rides the curve at the revealed x', () => {
  const coords = jaggedCoords();
  const start = smoothHistoryPointAt(coords, 0);
  assert.deepEqual([start.x, start.y], [coords[0].x, coords[0].y]);
  const end = smoothHistoryPointAt(coords, 640);
  assert.ok(Math.abs(end.x - 640) < 1e-9, String(end.x));
  assert.ok(Math.abs(end.y - coords[coords.length - 1].y) < 1e-9, String(end.y));
  // Every real day is on the curve, so the tip never detaches from the stroke.
  for (const point of coords) {
    const at = smoothHistoryPointAt(coords, point.x);
    assert.ok(Math.abs(at.y - point.y) < 1e-6, `${point.x}: ${at.y} vs ${point.y}`);
  }
  // Between two days it stays inside the value they join.
  const between = smoothHistoryPointAt(coords, (coords[2].x + coords[3].x) / 2);
  const lo = Math.min(coords[2].y, coords[3].y);
  const hi = Math.max(coords[2].y, coords[3].y);
  assert.ok(between.y >= lo - 1e-9 && between.y <= hi + 1e-9, String(between.y));
  assert.equal(smoothHistoryPointAt([], 10), null);
});

test('the hover label is centred over the day and clamped at both edges', () => {
  const box = {
    plotWidth: 640, plotHeight: 200, labelWidth: 120, labelHeight: 24, gap: 14, pad: 6,
  };
  assert.deepEqual(historyLabelAnchor({ ...box, x: 300, y: 100 }), { left: 300, top: 86 });
  // Left edge: the label's own left stops on the padding, not the point.
  assert.equal(historyLabelAnchor({ ...box, x: 4, y: 100 }).left, 66);
  // Right edge: its right stops inside the plot instead of over the frame.
  assert.equal(historyLabelAnchor({ ...box, x: 638, y: 100 }).left, 574);
  // A value near the top or the bottom keeps the whole line inside the plot.
  assert.equal(historyLabelAnchor({ ...box, x: 300, y: 12 }).top, 30);
  assert.equal(historyLabelAnchor({ ...box, x: 300, y: 210 }).top, 194);
  // Before the label is measured only the anchor x is known.
  assert.deepEqual(historyLabelAnchor({ x: 0, y: 100, plotWidth: 640, plotHeight: 200 }), { left: 6, top: 86 });
});

test('the liquidity band scales on the window peak, not on the portfolio', () => {
  assert.equal(liquidityBandRatio(0, 500), 0);
  assert.equal(liquidityBandRatio(250, 500), 0.5);
  assert.equal(liquidityBandRatio(500, 500), 1);
  assert.equal(liquidityBandRatio(900, 500), 1);
  assert.equal(liquidityBandRatio(-5, 500), 0);
  assert.equal(liquidityBandRatio(10, 0), 0);
  assert.equal(liquidityBandRatio(null, 500), 0);
});

test('the stepped stroke holds a day and jumps on the day it changes', () => {
  assert.equal(
    stepHistoryPath([{ x: 0, y: 180 }, { x: 320, y: 100 }]),
    'M 0.00 180.00 L 320.00 180.00 L 320.00 100.00',
  );
  assert.equal(stepHistoryPath([{ x: 5, y: 5 }]), 'M 5.00 5.00');
  assert.equal(stepHistoryPath([]), '');
});

test('a flat window draws a straight line through the middle of the plot', () => {
  const axis = historyAxis([200, 200, 200, 200]);
  assert.equal((200 - axis.yMin) / (axis.yMax - axis.yMin), 0.5);
  const levels = [0, 160, 320, 480].map((x) => ({ x, y: 112 }));
  assert.equal(smoothHistoryPath(levels), 'M 0.00 112.00 C 53.33 112.00, 106.67 112.00, 160.00 112.00 C 213.33 112.00, 266.67 112.00, 320.00 112.00 C 373.33 112.00, 426.67 112.00, 480.00 112.00');
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
