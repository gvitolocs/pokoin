import assert from 'node:assert/strict';
import test from 'node:test';
import { smoothHistorySegments } from './portfolio-history.js';
import {
  MOVER_SPARK,
  formatMoverChange,
  formatMoverValue,
  moverChips,
  moverDaysForPreset,
  moverSpark,
  moverSparkHover,
  moverSparkTipPlacement,
  moverTileLine,
  moverTitle,
  moverTone,
  normalizeMover,
  normalizeMovers,
} from './portfolio-movers.js';

/** One API item as /api/marketplace-portfolio-movers sends it. */
function apiMover(over = {}) {
  return {
    blueprintId: '502874',
    cardId: '1234',
    name: 'Charizard ex',
    setName: 'Stellar Crown',
    collectorNumber: '124/182',
    imageUrl: 'https://cdn.pokoin.com/card-images/502874_charizard-ex.jpg',
    condition: 'NM',
    language: 'EN',
    reverse: false,
    firstEdition: false,
    graded: false,
    quantity: 2,
    startPkn: 1000,
    endPkn: 1450,
    changePkn: 450,
    changePct: 45,
    series: [
      { day: '2026-08-20', pkn: 1000 },
      { day: '2026-09-03', pkn: 1450 },
    ],
    ...over,
  };
}

test('the movers window follows the chart preset', () => {
  assert.equal(moverDaysForPreset('1M'), 30);
  assert.equal(moverDaysForPreset('3M'), 91);
  assert.equal(moverDaysForPreset('6M'), 182);
  assert.equal(moverDaysForPreset('MAX'), 'max');
  assert.equal(moverDaysForPreset('max'), 'max');
  // An unknown or missing preset falls back to the month the chart opens on.
  assert.equal(moverDaysForPreset('5Y'), 30);
  assert.equal(moverDaysForPreset(), 30);
});

test('a mover normalizes into the tile model', () => {
  const mover = normalizeMover(apiMover());
  assert.equal(mover.key, '502874|NM|EN|-|-|-');
  assert.equal(mover.cardId, '1234');
  assert.equal(mover.collectorNumber, '124/182');
  assert.equal(mover.quantity, 2);
  assert.deepEqual(mover.series, [
    { day: '2026-08-20', pkn: 1000 },
    { day: '2026-09-03', pkn: 1450 },
  ]);
  assert.equal(normalizeMover(null), null);
});

test('a mover without numbers still paints, and bad spark points are dropped', () => {
  const thin = normalizeMover(apiMover({
    cardId: null,
    name: '  ',
    quantity: undefined,
    endPkn: 'nonsense',
    series: [{ day: '2026-09-03', pkn: 1450 }, { day: '', pkn: 5 }, { day: '2026-09-04', pkn: 0 }],
  }));
  assert.equal(thin.name, '');
  assert.equal(thin.quantity, 0);
  assert.equal(thin.endPkn, 0);
  assert.deepEqual(thin.series, [{ day: '2026-09-03', pkn: 1450 }]);
});

test('the payload becomes both sides of the switch', () => {
  const payload = normalizeMovers({
    ok: true,
    days: 30,
    gainers: [apiMover()],
    losers: [apiMover({ blueprintId: '7', changePct: -20 })],
  });
  assert.equal(payload.days, 30);
  assert.equal(payload.gainers.length, 1);
  assert.equal(payload.losers[0].blueprintId, '7');
  assert.deepEqual(normalizeMovers(null), { days: null, gainers: [], losers: [] });
});

test('tile text reads value, then the move in PKN and percent', () => {
  const mover = normalizeMover(apiMover());
  assert.equal(formatMoverValue(mover), '1450 PKN');
  assert.equal(formatMoverChange(mover), '+450 PKN (+45%)');
  assert.equal(moverTileLine(mover), 'Stellar Crown · 124/182');
  assert.deepEqual(moverChips(mover), ['NM', 'EN']);
  assert.equal(moverTone(mover), 'is-up');

  const down = normalizeMover(apiMover({ changePkn: -150, changePct: -12.55 }));
  assert.equal(formatMoverChange(down), '-150 PKN (-12.6%)');
  assert.equal(moverTone(down), 'is-down');

  const flat = normalizeMover(apiMover({ changePkn: 0, changePct: 0 }));
  assert.equal(formatMoverChange(flat), '0 PKN (0%)');
  assert.equal(moverTone(flat), 'is-flat');

  // PKN never shows a thousands comma (D000014).
  assert.equal(formatMoverValue(normalizeMover(apiMover({ endPkn: 2642 }))), '2642 PKN');
  assert.equal(formatMoverValue(normalizeMover(apiMover({ endPkn: 0 }))), '');
});

/**
 * The tiles read in the seller's display currency (docs/MARKET.md "Buyer
 * display currency", docs/BUYSELL.md "Currency"): the same helper and rounding
 * the Inventory page uses, and a PKN display currency keeps today's text.
 */
test('a DKK seller sees value and change in kroner', () => {
  const up = normalizeMover(apiMover());
  assert.equal(formatMoverValue(up, 'DKK'), '54.38 DKK');
  assert.equal(formatMoverChange(up, 'DKK'), '+16.88 DKK (+45%)');

  const down = normalizeMover(apiMover({ changePkn: -150, changePct: -12.55 }));
  assert.equal(formatMoverChange(down, 'DKK'), '-5.63 DKK (-12.6%)');

  const flat = normalizeMover(apiMover({ changePkn: 0, changePct: 0 }));
  assert.equal(formatMoverChange(flat, 'DKK'), '0 DKK (0%)');
  // A slice that never sold still has no value to print, in any currency.
  assert.equal(formatMoverValue(normalizeMover(apiMover({ endPkn: 0 })), 'DKK'), '');
  assert.equal(
    moverTitle(normalizeMover(apiMover({ reverse: true, quantity: 3 })), 'DKK'),
    'Charizard ex · Stellar Crown · 124/182 · NM · EN · Reverse · Qty 3 · 54.38 DKK · +16.88 DKK (+45%)',
  );
});

test('a EUR seller sees euros and a USD seller dollars', () => {
  const up = normalizeMover(apiMover());
  assert.equal(formatMoverValue(up, 'EUR'), '€7.25');
  assert.equal(formatMoverChange(up, 'EUR'), '+€2.25 (+45%)');
  const flat = normalizeMover(apiMover({ changePkn: 0, changePct: 0 }));
  assert.equal(formatMoverChange(flat, 'EUR'), '€0 (0%)');
  // A zero move still prices the slice that did sell.
  assert.equal(formatMoverValue(flat, 'EUR'), '€7.25');
  assert.equal(formatMoverValue(up, 'eur'), '€7.25');
  assert.equal(formatMoverValue(up, 'USD'), '$7.25');
});

test('a PKN seller keeps the PKN text, whatever spelling arrives', () => {
  const up = normalizeMover(apiMover());
  for (const currency of ['PKN', 'pkn', '', '  ', undefined]) {
    assert.equal(formatMoverValue(up, currency), '1450 PKN');
    assert.equal(formatMoverChange(up, currency), '+450 PKN (+45%)');
  }
  assert.equal(formatMoverChange(normalizeMover(apiMover({ changePkn: 0, changePct: 0 })), 'PKN'), '0 PKN (0%)');
});

test('the sparkline stays unitless when the tile switches currency', () => {
  const mover = normalizeMover(apiMover());
  assert.deepEqual(moverSpark(mover), moverSpark(mover, MOVER_SPARK));
  assert.equal(moverSpark(mover).high, 1450);
  assert.equal(moverSpark(mover).low, 1000);
});

test('finishes and quantity appear in the chips and the title', () => {
  const mover = normalizeMover(apiMover({ reverse: true, firstEdition: true, quantity: 3 }));
  assert.deepEqual(moverChips(mover), ['NM', 'EN', 'Reverse', '1st Ed.']);
  assert.equal(
    moverTitle(mover),
    'Charizard ex · Stellar Crown · 124/182 · NM · EN · Reverse · 1st Ed. · Qty 3 · 1450 PKN · +450 PKN (+45%)',
  );
  assert.equal(moverTitle(normalizeMover(apiMover({ quantity: 1 }))).includes('Qty'), false);
});

/** One sale per day, starting 2026-08-01, as the endpoint sends the series. */
function sparkMover(values) {
  return normalizeMover(apiMover({
    series: values.map((pkn, index) => ({
      day: `2026-08-${String(index + 1).padStart(2, '0')}`,
      pkn,
    })),
  }));
}

/**
 * The curve as the tile draws it, read back off the segment geometry rather
 * than the string: every data point is a segment end in order, a segment's
 * control points sit inside that segment's own x and y box (so a run never
 * overshoots the two prices it joins), and the whole curve stays inside the
 * padded box it was laid out in.
 */
function assertSmoothSparkShape(spark) {
  const points = spark.points;
  const segments = smoothHistorySegments(points);
  assert.equal(segments.length, points.length - 1);
  // The pen starts on the first point and every segment ends on the next one.
  const drawn = [[segments[0].x0, segments[0].y0], ...segments.map((s) => [s.x1, s.y1])];
  assert.deepEqual(drawn, points.map((p) => [p.x, p.y]));
  const floor = MOVER_SPARK.pad;
  const ceiling = spark.height - MOVER_SPARK.pad;
  for (const s of segments) {
    const yLo = Math.min(s.y0, s.y1);
    const yHi = Math.max(s.y0, s.y1);
    const xLo = Math.min(s.x0, s.x1);
    const xHi = Math.max(s.x0, s.x1);
    for (const [cx, cy] of [[s.cx1, s.cy1], [s.cx2, s.cy2]]) {
      assert.ok(cy >= yLo && cy <= yHi, `control y ${cy} leaves [${yLo}, ${yHi}]`);
      assert.ok(cy >= floor && cy <= ceiling, `control y ${cy} leaves [${floor}, ${ceiling}]`);
      assert.ok(cx >= xLo && cx <= xHi, `control x ${cx} leaves [${xLo}, ${xHi}]`);
    }
  }
}

test('the sparkline curves through sales with the chart above it', () => {
  const spark = moverSpark(sparkMover([100, 140, 120]));
  assert.equal(
    spark.line,
    'M 3.00 31.00 C 22.00 21.67, 41.00 3.00, 60.00 3.00 C 79.00 3.00, 98.00 12.33, 117.00 17.00',
  );
  assert.equal(spark.high, 140);
  assert.equal(spark.low, 100);
  assert.equal(spark.points.length, 3);
  assert.deepEqual(
    { width: spark.width, height: spark.height },
    { width: MOVER_SPARK.width, height: MOVER_SPARK.height },
  );
  // Each point names its own day and price, so a hover can quote a real value.
  assert.deepEqual(spark.points[1], { x: 60, y: 3, day: '2026-08-02', pkn: 140 });
  // The fill drops to the baseline at the last x and walks it back to the first.
  assert.equal(spark.area.includes('L 117.00 31.00 '), true);
  assert.equal(spark.area.endsWith('3.00 31.00 Z'), true);
  assertSmoothSparkShape(spark);

  // A quiet slice holds mid-box rather than drawing a false trend.
  const flat = moverSpark(normalizeMover(apiMover({
    series: [{ day: '2026-08-01', pkn: 100 }, { day: '2026-08-09', pkn: 100 }],
  })));
  assert.equal(flat.line, 'M 3.00 17.00 C 41.00 17.00, 79.00 17.00, 117.00 17.00');

  // One point or none: nothing to draw.
  assert.deepEqual(
    moverSpark(normalizeMover(apiMover({ series: [{ day: '2026-08-01', pkn: 100 }] }))),
    { line: '', area: '', points: [] },
  );
  assert.deepEqual(moverSpark(null), { line: '', area: '', points: [] });
});

test('a jagged sparkline turns at the prices, not past them', () => {
  const jag = moverSpark(sparkMover([64500, 61000, 64600, 59500, 59000, 61300]));
  assert.equal(jag.points.length, 6);
  assertSmoothSparkShape(jag);
  // The top and the bottom sale land on the padded edges of the box.
  assert.equal(Math.min(...jag.points.map((p) => p.y)), MOVER_SPARK.pad);
  assert.equal(Math.max(...jag.points.map((p) => p.y)), MOVER_SPARK.height - MOVER_SPARK.pad);
});

test('a pointer over the sparkline reads a real day, priced like the tile', () => {
  const spark = moverSpark(sparkMover([100, 140, 120]));
  const at = (ratio) => moverSparkHover(spark, ratio);
  assert.deepEqual(at(0), {
    index: 0,
    x: 3,
    y: 31,
    day: '2026-08-01',
    pkn: 100,
    dateLabel: 'Aug 1',
    valueLabel: '100 PKN',
  });
  assert.equal(at(0.5).index, 1);
  assert.equal(at(0.5).day, '2026-08-02');
  assert.equal(at(0.5).pkn, 140);
  assert.equal(at(0.5).dateLabel, 'Aug 2');
  // Nearest point by x, never a price read off the curve between two sales.
  assert.equal(at(0.42).index, 1);
  assert.equal(at(1).index, 2);
  assert.equal(at(1).valueLabel, '120 PKN');
  // A pointer outside the sparkline still answers with an end day.
  assert.equal(at(-3).index, 0);
  assert.equal(at(4).index, 2);
  assert.equal(at('nonsense').index, 0);
  // PKN stays digits-only (D000014); another currency takes the tile's label.
  assert.equal(moverSparkHover(moverSpark(sparkMover([64500, 61000])), 0).valueLabel, '64500 PKN');
  assert.equal(moverSparkHover(spark, 0.5, 'DKK').valueLabel, '5.25 DKK');
  // A currency the tile has not settled yet is the PKN text it already shows.
  assert.equal(moverSparkHover(spark, 0.5, '').valueLabel, '140 PKN');
  // Nothing hovered, no sparkline: no day to name.
  assert.equal(moverSparkHover({ line: '', area: '', points: [] }, 0.5), null);
  assert.equal(moverSparkHover(moverSpark(normalizeMover(apiMover({ series: [] }))), 0.5), null);
  assert.equal(moverSparkHover(null, 0.5), null);
});

test('the spark tip sits inside the spark box, on the side away from the point', () => {
  const spark = moverSpark(sparkMover([100, 140, 120]));
  // A point in the lower half pins the tip to the box's top edge, still
  // anchored to the hovered day.
  assert.deepEqual(moverSparkTipPlacement({ x: 60, y: 31 }, spark), {
    top: '0px',
    left: '50%',
    transform: 'translateX(-50%)',
  });
  // A point in the upper half pins it to the box's bottom edge.
  assert.deepEqual(moverSparkTipPlacement({ x: 60, y: 3 }, spark), {
    bottom: '0px',
    left: '50%',
    transform: 'translateX(-50%)',
  });
  // A flat series sits mid-box; its point reads as upper half.
  const flat = moverSpark(sparkMover([100, 100, 100]));
  assert.deepEqual(moverSparkTipPlacement(flat.points[1], flat), {
    bottom: '0px',
    left: '50%',
    transform: 'translateX(-50%)',
  });
});

test('the spark tip clamps to the box edges and never leaves the tile', () => {
  const spark = moverSpark(sparkMover([100, 140, 120]));
  // Near the left edge the tip pins to the box's left edge, no centering.
  assert.deepEqual(moverSparkTipPlacement({ x: 3, y: 31 }, spark), { top: '0px', left: '0px' });
  // Near the right edge it pins to the box's right edge.
  assert.deepEqual(moverSparkTipPlacement({ x: 117, y: 3 }, spark), { bottom: '0px', right: '0px' });
  // The pinning bands reach 35% in from each side; their bounds pin too.
  assert.deepEqual(moverSparkTipPlacement({ x: 42, y: 31 }, spark), { top: '0px', left: '0px' });
  assert.deepEqual(moverSparkTipPlacement({ x: 78, y: 3 }, spark), { bottom: '0px', right: '0px' });
  // Between the bands the tip centers on the day, inside the box.
  assert.deepEqual(moverSparkTipPlacement({ x: 48, y: 31 }, spark), {
    top: '0px',
    left: '40%',
    transform: 'translateX(-50%)',
  });
  assert.deepEqual(moverSparkTipPlacement({ x: 72, y: 3 }, spark), {
    bottom: '0px',
    left: '60%',
    transform: 'translateX(-50%)',
  });
});
