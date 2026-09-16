import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeSoldIndex,
  formatSoldAxisTick,
  formatSoldDay,
  nearestSoldIndex,
  isSoldGraphClick,
  soldGraphScale,
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
} from './sold-graph.js';

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

test('sold y-axis is 0–50 by tens, 0–500, then 0–2500 by 500s', () => {
  assert.deepEqual(soldGraphScale(22).ticks, [0, 10, 20, 30, 40, 50]);
  assert.equal(soldGraphScale(50).max, 50);
  assert.deepEqual(soldGraphScale(51).ticks, [0, 100, 200, 300, 400, 500]);
  assert.deepEqual(soldGraphScale(220).ticks, [0, 100, 200, 300, 400, 500]);
  assert.deepEqual(soldGraphScale(633).ticks, [0, 500, 1000, 1500, 2000, 2500]);
  assert.deepEqual(soldGraphScale(2500).ticks, [0, 500, 1000, 1500, 2000, 2500]);
  assert.deepEqual(soldGraphScale(2501).ticks, [0, 1000, 2000, 3000, 4000, 5000]);
  assert.equal(soldGraphScale(0).max, 50);
});

test('60k PKN uses 0–125k by 25k, not a flat 0–500k axis', () => {
  assert.deepEqual(soldGraphScale(50000).ticks, [0, 10000, 20000, 30000, 40000, 50000]);
  assert.deepEqual(soldGraphScale(50001).ticks, [0, 25000, 50000, 75000, 100000, 125000]);
  assert.deepEqual(soldGraphScale(60794).ticks, [0, 25000, 50000, 75000, 100000, 125000]);
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

test('sold-day labels follow the viewer locale, not MM/DD', () => {
  assert.equal(formatSoldDay('2026-09-03', 'en-US'), '09/03');
  assert.equal(formatSoldDay('2026-09-03', 'en-GB'), '03/09');
  assert.equal(formatSoldDay('2026-09-03', 'it-IT'), '03/09');
  assert.equal(formatSoldDay('2026-09-06', 'it-IT'), '06/09');
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
