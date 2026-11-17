import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeSoldIndex,
  formatSoldAxisTick,
  formatSoldDay,
  formatSoldDayWithYear,
  nearestSoldIndex,
  isSoldGraphClick,
  soldGraphDateWindow,
  soldGraphDayMs,
  soldGraphDayOnOrBefore,
  soldGraphGapSegments,
  soldGraphHoverRows,
  soldGraphNearDay,
  soldGraphRangeBounds,
  soldGraphRangeDays,
  soldGraphScale,
  soldGraphSpansYears,
  soldGraphTipMods,
  soldGraphY,
  soldConditionLabel,
  soldGraphTone,
  soldLanguageLabel,
  soldFlagLabel,
  soldFlagQueryValue,
  soldFilterValue,
  soldFilterShowsAll,
  soldUnitCount,
  formatSoldSampleCount,
  SOLD_GRAPH_PAD,
  SOLD_GRAPH_TIP_ROWS,
  SOLD_SERIES_PALETTES,
  soldSeriesColor,
} from './sold-graph.js';

test('compared sold series never share a colour across the first three languages', () => {
  const grades = ['NM', 'SP', 'MP', 'PL', 'Poor'];
  const colours = [0, 1, 2].flatMap((language) => grades.map((grade) => soldSeriesColor(grade, language)));
  assert.equal(new Set(colours).size, 15);
  // The first language keeps the grade colours of the single graph.
  assert.equal(soldSeriesColor('NM', 0), '#147a3f');
  assert.equal(soldSeriesColor('MP', 0), '#ffd33d');
  // Another language is not a grade of the first: light blue and magenta, not green and yellow.
  assert.equal(soldSeriesColor('NM', 1), '#5fb8e8');
  assert.equal(soldSeriesColor('MP', 1), '#e45fd0');
  // Past the third language the palettes repeat, never the first one.
  assert.equal(soldSeriesColor('NM', 3), SOLD_SERIES_PALETTES[1].NM);
  assert.equal(soldSeriesColor('NM', 4), SOLD_SERIES_PALETTES[2].NM);
  assert.equal(soldSeriesColor('', 0), '#f3f4f7');
  assert.equal(soldSeriesColor('NM', -3), '#147a3f');
});

test('nearest day prefers the last x when the pointer is on the right edge', () => {
  assert.equal(nearestSoldIndex([10, 160, 310], 318), 2);
  assert.equal(nearestSoldIndex([10, 160, 310], 0), 0);
});

test('graph click ignores pointer travel that looks like a scrub', () => {
  assert.equal(isSoldGraphClick({ x: 40, y: 80 }, { clientX: 44, clientY: 82 }), true);
  assert.equal(isSoldGraphClick({ x: 40, y: 80 }, { clientX: 80, clientY: 80 }), false);
  assert.equal(isSoldGraphClick(null, { clientX: 40, clientY: 80 }), false);
});

test('with no hover the price popup stays off', () => {
  assert.equal(activeSoldIndex(null, 5), null);
  assert.equal(activeSoldIndex(1, 5), 1);
  assert.equal(activeSoldIndex(9, 5), null);
  assert.equal(activeSoldIndex(0, 0), null);
});

test('last-day tip anchors inside the chart instead of overflowing right', () => {
  const pad = { l: 10, r: 10, t: 18, b: 28 };
  assert.deepEqual(soldGraphTipMods(310, 20, 320, pad), ['is-below', 'is-end']);
  assert.deepEqual(soldGraphTipMods(10, 80, 320, pad), ['is-start']);
  assert.deepEqual(soldGraphTipMods(160, 80, 320, pad), []);
});

test('sold y-axis is five 1–2–2.5–5 steps sized to the data, never under tens', () => {
  assert.deepEqual(soldGraphScale(22).ticks, [0, 10, 20, 30, 40, 50]);
  assert.equal(soldGraphScale(50).max, 50);
  assert.deepEqual(soldGraphScale(51).ticks, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(soldGraphScale(220).ticks, [0, 50, 100, 150, 200, 250]);
  assert.deepEqual(soldGraphScale(633).ticks, [0, 200, 400, 600, 800, 1000]);
  assert.deepEqual(soldGraphScale(2500).ticks, [0, 500, 1000, 1500, 2000, 2500]);
  assert.deepEqual(soldGraphScale(2501).ticks, [0, 1000, 2000, 3000, 4000, 5000]);
  assert.equal(soldGraphScale(0).max, 50);
});

test('the axis follows the data: the highest value always sits in the upper half', () => {
  // 7,000 PKN used to land on a 0–50k axis and read as a flat line on the floor.
  assert.deepEqual(soldGraphScale(7000).ticks, [0, 2000, 4000, 6000, 8000, 10000]);
  // Above the 0–50 floor (the smallest axis, kept so a 22 PKN card is not drawn on a 0–25 one).
  for (const max of [51, 99, 101, 260, 999, 5001, 7000, 12000, 26000, 50001, 90000, 400000, 1234567]) {
    const scale = soldGraphScale(max);
    assert.ok(scale.max >= max, `${max} fits under ${scale.max}`);
    assert.ok(max / scale.max >= 0.5, `${max} uses at least half of a 0–${scale.max} axis`);
  }
});

test('large values keep round ticks: 0–100k by 20k, 0–125k by 25k', () => {
  assert.deepEqual(soldGraphScale(50000).ticks, [0, 10000, 20000, 30000, 40000, 50000]);
  assert.deepEqual(soldGraphScale(50001).ticks, [0, 20000, 40000, 60000, 80000, 100000]);
  assert.deepEqual(soldGraphScale(60794).ticks, [0, 20000, 40000, 60000, 80000, 100000]);
  assert.deepEqual(soldGraphScale(125000).ticks, [0, 25000, 50000, 75000, 100000, 125000]);
  assert.deepEqual(soldGraphScale(125001).ticks, [0, 50000, 100000, 150000, 200000, 250000]);
  assert.equal(formatSoldAxisTick(25000), '25k');
  assert.equal(formatSoldAxisTick(75000), '75k');
  assert.equal(formatSoldAxisTick(125000), '125k');
});

test('22 PKN sits mid-band on a 0–50 axis, not on the floor', () => {
  const y = soldGraphY(22, 50, 20, 120);
  assert.ok(y < 20 + 120 - 1);
  assert.equal(Math.round(y), 87);
  assert.equal(soldGraphY(0, 50, 20, 120), 140);
  assert.equal(soldGraphY(50, 50, 20, 120), 20);
  assert.equal(formatSoldAxisTick(5000), '5000');
  assert.equal(formatSoldAxisTick(100000), '100k');
});

test('a local-currency axis can step in cents, and its ticks are clean decimals', () => {
  // 45 PKN is 1.69 DKK: a 0–2.5 axis by 0.5, not the PKN floor of 0–50.
  assert.deepEqual(soldGraphScale(1.69, { minStep: 0.01 }).ticks, [0, 0.5, 1, 1.5, 2, 2.5]);
  assert.deepEqual(soldGraphScale(0.21, { minStep: 0.01 }).ticks, [0, 0.05, 0.1, 0.15, 0.2, 0.25]);
  assert.deepEqual(soldGraphScale(0.03, { minStep: 0.01 }).ticks, [0, 0.01, 0.02, 0.03, 0.04, 0.05]);
  assert.deepEqual(soldGraphScale(37.5, { minStep: 0.01 }).ticks, [0, 10, 20, 30, 40, 50]);
  for (const max of [0.06, 0.3, 0.74, 1.69, 9.99, 12.4, 180]) {
    const scale = soldGraphScale(max, { minStep: 0.01 });
    assert.ok(scale.max >= max && max / scale.max >= 0.5, `${max} on 0–${scale.max}`);
  }
  // The PKN axis is unchanged without the option.
  assert.deepEqual(soldGraphScale(22).ticks, [0, 10, 20, 30, 40, 50]);
  assert.equal(formatSoldAxisTick(0.5), '0.5');
  assert.equal(formatSoldAxisTick(0.05), '0.05');
  assert.equal(formatSoldAxisTick(1.2), '1.2');
  // A top under one unit is a real ceiling, not rounded up to 1.
  assert.equal(soldGraphY(0.25, 0.25, 20, 120), 20);
  assert.equal(Math.round(soldGraphY(0.125, 0.25, 20, 120)), 80);
});

test('sold-day labels follow the viewer locale, not MM/DD', () => {
  assert.equal(formatSoldDay('2026-09-03', 'en-US'), '09/03');
  assert.equal(formatSoldDay('2026-09-03', 'en-GB'), '03/09');
  assert.equal(formatSoldDay('2026-09-03', 'it-IT'), '03/09');
  assert.equal(formatSoldDay('2026-09-06', 'it-IT'), '06/09');
});

test('long or year-crossing windows put the two-digit year on the dates', () => {
  // A 90-day window inside one year stays day and month.
  assert.equal(soldGraphSpansYears(soldGraphDayMs('2026-06-01'), soldGraphDayMs('2026-08-30')), false);
  // 366 days: the year joins both axis labels and the tooltip date.
  assert.equal(soldGraphSpansYears(soldGraphDayMs('2025-11-16'), soldGraphDayMs('2026-11-17')), true);
  // 30 days across New Year: the first and last day are in different years.
  assert.equal(soldGraphSpansYears(soldGraphDayMs('2026-12-20'), soldGraphDayMs('2027-01-18')), true);
  // Exactly 300 days apart is still short; one day more is not.
  assert.equal(soldGraphSpansYears(soldGraphDayMs('2026-01-20'), soldGraphDayMs('2026-11-16')), false);
  assert.equal(soldGraphSpansYears(soldGraphDayMs('2026-01-19'), soldGraphDayMs('2026-11-16')), true);
  assert.equal(soldGraphSpansYears(NaN, soldGraphDayMs('2026-11-16')), false);
  // The locale keeps its own order and separators, with or without the year.
  assert.equal(formatSoldDayWithYear('2026-09-03', 'en-US', true), '09/03/26');
  assert.equal(formatSoldDayWithYear('2026-09-03', 'it-IT', true), '03/09/26');
  assert.equal(formatSoldDayWithYear('2026-09-03', 'en-GB', false), '03/09');
  assert.equal(formatSoldDayWithYear('2026-09-03', 'en-US', false), formatSoldDay('2026-09-03', 'en-US'));
  assert.equal(formatSoldDayWithYear('nonsense', 'en-US', true), '');
});

test('plot padding leaves room for unstretched axis labels', () => {
  assert.ok(SOLD_GRAPH_PAD.l >= 40);
  assert.ok(SOLD_GRAPH_PAD.r >= 36);
  assert.ok(SOLD_GRAPH_PAD.t >= 52);
  assert.ok(SOLD_GRAPH_PAD.b >= 20);
});

test('sold graph tone follows the selected condition', () => {
  assert.equal(soldGraphTone(''), 'all');
  assert.equal(soldGraphTone('NM'), 'nm');
  assert.equal(soldGraphTone('SP'), 'sp');
  assert.equal(soldGraphTone('MP'), 'mp');
  assert.equal(soldGraphTone('PL'), 'pl');
  assert.equal(soldGraphTone('Poor'), 'poor');
});

test('sold condition labels use full names in the graph dropdown', () => {
  assert.equal(soldConditionLabel(''), 'All');
  assert.equal(soldConditionLabel('NM'), 'Near Mint');
  assert.equal(soldConditionLabel('SP'), 'Slightly Played');
  assert.equal(soldConditionLabel('MP'), 'Moderately Played');
  assert.equal(soldConditionLabel('PL'), 'Played');
  assert.equal(soldLanguageLabel('IT'), 'Italiano');
  assert.equal(soldLanguageLabel('en'), 'English');
  assert.equal(soldLanguageLabel(''), 'All');
  assert.equal(soldFlagLabel('firstEdition', ''), 'All');
  assert.equal(soldFlagLabel('firstEdition', '1'), '1st');
  assert.equal(soldFlagLabel('firstEdition', '0'), 'Unl');
  assert.equal(soldFlagLabel('reverse', true), 'Rev');
  assert.equal(soldFlagLabel('graded', false), 'Raw');
});

test('a sold graph filter with one key shows that key, not All', () => {
  assert.equal(soldFilterShowsAll(['EN']), false);
  assert.equal(soldFilterShowsAll(['EN', 'IT']), true);
  assert.equal(soldFilterValue(['EN'], ''), 'EN');
  assert.equal(soldFilterValue(['EN', 'IT'], ''), '');
  assert.equal(soldFilterValue([false], '', soldFlagQueryValue), '0');
  assert.equal(soldFilterValue([false, true], '', soldFlagQueryValue), '');
  assert.equal(soldFilterValue(['MP', 'Poor'], 'NM'), '');
  assert.equal(soldFilterValue(['MP', 'Poor'], 'MP'), 'MP');
});

test('sold graph unit count sums copies sold, not listing events', () => {
  assert.equal(
    soldUnitCount([
      { soldQty: 8, sampleCount: 2 },
      { soldQty: 4, sampleCount: 3 },
    ]),
    12,
  );
  assert.equal(soldUnitCount([{ listings: 3 }, { sampleCount: 2 }]), 5);
  assert.equal(formatSoldSampleCount(1), '1 unit');
  assert.equal(formatSoldSampleCount(128), '128 units');
});

test('a range window clips the days it covers, and no range clips nothing', () => {
  const bounds = soldGraphRangeBounds({ key: '1m', from: '2026-10-17', to: '2026-11-16' });
  assert.deepEqual(bounds, { key: '1m', from: '2026-10-17', to: '2026-11-16' });
  const days = [
    { day: '2026-11-16', medianPkn: 300 },
    { day: '2026-10-17', medianPkn: 320 },
    { day: '2026-10-16', medianPkn: 330 },
    { day: '2026-11-17', medianPkn: 290 },
  ];
  // Outside the window is not drawn; inside it is oldest first.
  assert.deepEqual(soldGraphRangeDays(days, bounds).map((row) => row.day), ['2026-10-17', '2026-11-16']);
  assert.equal(soldGraphRangeBounds(undefined), null);
  assert.equal(soldGraphRangeBounds({ key: '3m' }), null);
  assert.equal(soldGraphRangeBounds({ from: '2026-10-17', to: 'not a day' }), null);
  // Without a range the series is passed through untouched, as today's graph.
  assert.deepEqual(soldGraphRangeDays(days, null), days);
  assert.deepEqual(soldGraphRangeDays([{ day: 'nope' }, null], null), []);
});

test('the drawn window is the range clipped to the visible days', () => {
  const bounds = { from: '2026-10-17', to: '2026-11-16' };
  const days = [{ day: '2026-10-17' }, { day: '2026-11-01' }];
  assert.deepEqual(
    soldGraphDateWindow(days, bounds),
    { start: soldGraphDayMs('2026-10-17'), end: soldGraphDayMs('2026-11-01') },
  );
  // A range that covers everything still starts and ends where the data does.
  const wide = soldGraphDateWindow([{ day: '2024-03-01' }, { day: '2026-11-10' }], { from: '2024-02-08', to: '2026-11-16' });
  assert.deepEqual(wide, { start: soldGraphDayMs('2024-03-01'), end: soldGraphDayMs('2026-11-10') });
  // One day, or no range at all: the window is the series itself.
  assert.deepEqual(soldGraphDateWindow([{ day: '2026-01-05' }], null), { start: soldGraphDayMs('2026-01-05'), end: soldGraphDayMs('2026-01-05') });
  assert.equal(soldGraphDateWindow([], null), null);
});

test('a source line breaks where its own days are further apart than its gap', () => {
  const days = [
    { day: '2026-11-01', pkn: 100 },
    { day: '2026-11-02', pkn: 110 },
    { day: '2026-11-12', pkn: 120 },
    { day: '2026-11-13', pkn: 130 },
  ];
  // Exactly the gap is still one price move; one day more is a hole.
  assert.deepEqual(soldGraphGapSegments(days, 10).segments.map((run) => run.length), [4]);
  assert.deepEqual(soldGraphGapSegments(days, 10).bridges, []);
  const nine = soldGraphGapSegments(days, 9);
  assert.deepEqual(nine.segments.map((run) => run.map((row) => row.day)), [['2026-11-01', '2026-11-02'], ['2026-11-12', '2026-11-13']]);
  assert.deepEqual(nine.bridges, [[days[1], days[2]]]);
  // A line that starts and ends at its own first and last day: no edge carry.
  assert.equal(nine.segments[0][0].day, '2026-11-01');
  assert.equal(nine.segments[1][1].day, '2026-11-13');
  assert.deepEqual(soldGraphGapSegments([], 3), { segments: [], bridges: [] });
  assert.deepEqual(soldGraphGapSegments([{ day: 'oops' }], 3), { segments: [], bridges: [] });
});

test('a source reads its nearest day inside the gap, its weekly one backwards', () => {
  const days = [
    { day: '2026-11-01', value: 100 },
    { day: '2026-11-05', value: 120 },
    { day: '2026-11-20', value: 90 },
  ];
  assert.equal(soldGraphNearDay(days, '2026-11-07', 3)?.value, 120);
  assert.equal(soldGraphNearDay(days, '2026-11-07', 1), null);
  assert.equal(soldGraphNearDay(days, '2026-11-12', 10)?.value, 120);
  assert.equal(soldGraphNearDay(days, '2026-11-14', 10)?.value, 90);
  assert.equal(soldGraphNearDay(days, 'nonsense', 99), null);
  assert.equal(soldGraphDayOnOrBefore(days, '2026-11-19')?.value, 120);
  assert.equal(soldGraphDayOnOrBefore(days, '2026-11-20')?.value, 90);
  assert.equal(soldGraphDayOnOrBefore(days, '2026-10-31'), null);
});

test('the hover names every visible series, capped at six rows', () => {
  const sold = { key: 'picked', label: 'NM · EN', kind: 'sold', picked: true, days: [{ day: '2026-11-10', value: 300 }] };
  const tp = {
    key: 'tcgplayer', label: 'TCGplayer', kind: 'source', gapDays: 10,
    days: [{ day: '2026-11-08', value: 280 }, { day: '2026-11-12', value: 290 }],
  };
  const cm = { key: 'cardmarket', label: 'Cardmarket', kind: 'source', carry: 'onOrBefore', gapDays: 99, days: [{ day: '2026-11-09', value: 260 }] };
  const now = { key: 'pokoin_now', label: 'Pokoin now', kind: 'now', value: 275 };
  const options = { formatValue: (value) => `${value} PKN`, formatDay: (iso) => iso.slice(5), endDay: '2026-11-11' };
  const today = soldGraphHoverRows([sold, tp, cm, now], '2026-11-11', options);
  assert.deepEqual(today.rows.map((row) => [row.label, row.text, row.value]), [
    ['NM · EN', 'no sale', null],
    ['TCGplayer', '290 PKN', 290],
    ['Cardmarket', '260 PKN', 260],
    ['Pokoin now', '275 PKN', 275],
  ]);
  assert.equal(today.more, 0);
  // Before Cardmarket has any trend: say where it starts. Pokoin now is today only.
  const early = soldGraphHoverRows([sold, tp, cm, now], '2026-11-05', options);
  assert.deepEqual(early.rows.map((row) => row.text), ['no sale', '280 PKN', 'from 11-09', 'no data']);
  const eight = soldGraphHoverRows([
    sold, tp, cm, now,
    { key: 'x1', label: 'SP', kind: 'sold', days: [] },
    { key: 'x2', label: 'PL', kind: 'sold', days: [] },
    { key: 'x3', label: 'Poor', kind: 'sold', days: [] },
    { key: 'x4', label: 'IT', kind: 'sold', days: [] },
  ], '2026-11-10', options);
  assert.equal(eight.rows.length, SOLD_GRAPH_TIP_ROWS);
  assert.equal(eight.more, 2);
  assert.deepEqual(eight.rows.map((row) => row.label), ['NM · EN', 'TCGplayer', 'Cardmarket', 'Pokoin now', 'SP', 'PL']);
  assert.equal(soldGraphHoverRows([], '2026-11-10').rows.length, 0);
});
