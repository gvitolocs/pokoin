import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOVER_SPARK,
  formatMoverChange,
  formatMoverValue,
  moverChips,
  moverDaysForPreset,
  moverSpark,
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

test('the sparkline steps between sales like the chart above it', () => {
  const mover = normalizeMover(apiMover({
    series: [
      { day: '2026-08-01', pkn: 100 },
      { day: '2026-08-02', pkn: 140 },
      { day: '2026-08-03', pkn: 120 },
    ],
  }));
  const spark = moverSpark(mover);
  assert.equal(spark.line, '3.0,31.0 60.0,31.0 60.0,3.0 117.0,3.0 117.0,17.0');
  assert.equal(spark.high, 140);
  assert.equal(spark.low, 100);
  assert.equal(spark.points.length, 3);
  assert.deepEqual(
    { width: spark.width, height: spark.height },
    { width: MOVER_SPARK.width, height: MOVER_SPARK.height },
  );
  assert.equal(spark.area.startsWith('3.0,31.0 '), true);

  // A quiet slice holds mid-box rather than drawing a false trend.
  const flat = moverSpark(normalizeMover(apiMover({
    series: [{ day: '2026-08-01', pkn: 100 }, { day: '2026-08-09', pkn: 100 }],
  })));
  assert.equal(flat.line, '3.0,17.0 117.0,17.0 117.0,17.0');

  // One point or none: nothing to draw.
  assert.deepEqual(
    moverSpark(normalizeMover(apiMover({ series: [{ day: '2026-08-01', pkn: 100 }] }))),
    { line: '', area: '', points: [] },
  );
  assert.deepEqual(moverSpark(null), { line: '', area: '', points: [] });
});
