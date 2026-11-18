import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionSeries, normalizeSegments, segmentGroups, segmentLevels } from './portfolio-segments.js';
import { previewSegmentsFrom } from './portfolio-segments-preview.js';

const API_ORDER = [
  'game:pokemon',
  'game:riftbound',
  'all:sealed',
  'all:graded',
  'pokemon:era:vintage',
  'pokemon:era:mid',
  'pokemon:era:xy',
  'pokemon:era:sm',
  'pokemon:era:swsh',
  'pokemon:era:sv',
  'pokemon:era:post-sv',
  'pokemon:era:other',
  'pokemon:sealed',
  'pokemon:graded',
];

function flatCardDays(count, value = 1000) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    cardsValuePkn: value,
    cardsHeld: 100,
    cardsPriced: 50,
  }));
}

test('the fixture answers the shape normalizeSegments takes', () => {
  const raw = previewSegmentsFrom(flatCardDays(14));
  const model = normalizeSegments(raw);
  assert.ok(model, 'the fixture must feed the same reader as the live API');
  assert.deepEqual(model.defs.map((def) => def.key), API_ORDER);
  assert.deepEqual(segmentLevels(model).map((level) => level.id), ['all', 'pokemon']);
  assert.deepEqual(segmentGroups(model, 'all', {})[0].rows.map((row) => row.label), ['Pokémon', 'Riftbound']);
  assert.deepEqual(collectionSeries(model, {}).length, 14);
  // Junk series is an empty answer, not a crash.
  assert.deepEqual(previewSegmentsFrom(null).days, []);
  assert.equal(previewSegmentsFrom(null).segmentDefs.length, API_ORDER.length);
  assert.equal(normalizeSegments(previewSegmentsFrom(null)), null);
  assert.equal(normalizeSegments(previewSegmentsFrom([{ nope: true }, { date: 'later', cardsValuePkn: 5 }])), null);
});

test('the eras add up to the day value and to the day counts', () => {
  const raw = previewSegmentsFrom(flatCardDays(6));
  for (const day of raw.days) {
    const eras = Object.entries(day.segments).filter(([key]) => key.startsWith('pokemon:era'));
    const valueSum = eras.reduce((acc, [, entry]) => acc + entry[0], 0);
    const heldSum = eras.reduce((acc, [, entry]) => acc + entry[2], 0);
    const pricedSum = eras.reduce((acc, [, entry]) => acc + entry[1], 0);
    assert.ok(Math.abs(valueSum - day.cardsValuePkn) <= 0.01, `${day.date}: ${valueSum} vs ${day.cardsValuePkn}`);
    assert.equal(heldSum, 100);
    assert.equal(pricedSum, 50);
    for (const [, entry] of eras) {
      assert.ok(Number.isInteger(entry[1]) && Number.isInteger(entry[2]), 'counts stay whole cards');
    }
  }
});

test('the split wobbles on a fixed per-day cycle and never runs away', () => {
  const raw = previewSegmentsFrom(flatCardDays(25));
  const erasOf = (index) => Object.entries(raw.days[index].segments)
    .filter(([key]) => key.startsWith('pokemon:era:sv') || key.startsWith('pokemon:era:swsh'))
    .map(([, entry]) => entry[0]);
  // Same card every day, so the only movement is the wobble: ±6 % of the share
  // plus the renormalisation, never a different pile.
  for (const day of raw.days) {
    const sv = day.segments['pokemon:era:sv'][0];
    const swsh = day.segments['pokemon:era:swsh'][0];
    assert.ok(sv > 300 && sv < 420, `sv ${sv}`);
    assert.ok(swsh > 220 && swsh < 310, `swsh ${swsh}`);
  }
  // The pattern repeats every 12 card days: day 1 and day 13 are identical.
  assert.deepEqual(erasOf(0), erasOf(12));
  assert.notDeepEqual(erasOf(0), erasOf(0 + 1));
});

test('vintage is never held, sealed starts on the 10th card day, graded stays empty', () => {
  const raw = previewSegmentsFrom(flatCardDays(12));
  assert.ok(raw.days.every((day) => day.segments['pokemon:era:vintage'] === undefined));
  assert.ok(raw.days.every((day) => day.segments['pokemon:graded'] === undefined));
  assert.ok(raw.days.every((day) => day.segments['all:graded'] === undefined));
  assert.equal(raw.days[8].segments['pokemon:sealed'], undefined);
  assert.deepEqual(raw.days[9].segments['pokemon:sealed'], [90, 4, 4]);
  assert.deepEqual(raw.days[11].segments['all:sealed'], [90, 4, 4]);
  // The preview still answers the row states the desk paints.
  const model = normalizeSegments(raw);
  const rows = segmentGroups(model, 'all', {}).flatMap((group) => group.rows);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.key, row.state])), {
    'game:pokemon': 'ok',
    'game:riftbound': 'unpriced',
    'all:sealed': 'ok',
    'all:graded': 'empty',
  });
  const era = segmentGroups(model, 'pokemon', {})[0].rows.find((row) => row.key === 'pokemon:era:sv');
  assert.equal(era.sub, '2023–2026');
  assert.ok(era.held > 30 && era.held < 40, `sv holds ${era.held} of the 100 cards`);
});

test('riftbound holds an unpriced pile on every card day and nothing before', () => {
  const raw = previewSegmentsFrom([
    { date: '2026-10-01', currencyPkn: 15 },
    { date: '2026-10-02', cardsValuePkn: 500, cardsHeld: 10, cardsPriced: 4 },
  ]);
  assert.deepEqual(raw.days[0].segments, {});
  assert.equal(raw.days[0].cardsValuePkn, null);
  assert.deepEqual(raw.days[1].segments['game:riftbound'], [0, 0, 40]);
  assert.deepEqual(raw.days[1].segments['game:pokemon'], [500, 4, 10]);
});

test('the fixture is deterministic and reads the normalized day shape too', () => {
  const series = flatCardDays(11);
  assert.deepEqual(previewSegmentsFrom(series), previewSegmentsFrom(series));
  const nested = series.map((day) => ({ date: day.date, assets: { cardsValuePkn: day.cardsValuePkn, cardsHeld: day.cardsHeld, cardsPriced: day.cardsPriced } }));
  assert.deepEqual(previewSegmentsFrom(nested), previewSegmentsFrom(series));
});
