import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { collectionSeries, normalizeSegments, segmentGroups, segmentLevels } from './portfolio-segments.js';
import { previewSegmentsFrom } from './portfolio-segments-preview.js';

/** The server's own era table, read as text: the preview may not invent another. */
const rustSegmentsSrc = fs.readFileSync(
  new URL('../../pokoin-rust/crates/accounts/src/domain/portfolio_segments.rs', import.meta.url),
  'utf8',
);

const API_ORDER = [
  'game:pokemon',
  'game:riftbound',
  'game:battle_spirits_saga',
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
  'riftbound:set:origins',
  'riftbound:set:spiritforged',
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
  assert.deepEqual(segmentLevels(model).map((level) => level.id), ['all', 'pokemon', 'riftbound']);
  assert.deepEqual(segmentLevels(model).map((level) => level.label), ['All games', 'Pokémon', 'Riftbound']);
  assert.deepEqual(
    segmentGroups(model, 'all', {})[0].rows.map((row) => row.label),
    ['Pokémon', 'Riftbound', 'Battle Spirits Saga'],
  );
  assert.deepEqual(collectionSeries(model, {}).length, 14);
  // Junk series is an empty answer, not a crash.
  assert.deepEqual(previewSegmentsFrom(null).days, []);
  assert.equal(previewSegmentsFrom(null).segmentDefs.length, API_ORDER.length);
  assert.equal(normalizeSegments(previewSegmentsFrom(null)), null);
  assert.equal(normalizeSegments(previewSegmentsFrom([{ nope: true }, { date: 'later', cardsValuePkn: 5 }])), null);
});

test('the eras add up to the Pokémon value and to the day counts', () => {
  const raw = previewSegmentsFrom(flatCardDays(6));
  for (const day of raw.days) {
    const eras = Object.entries(day.segments).filter(([key]) => key.startsWith('pokemon:era'));
    const valueSum = eras.reduce((acc, [, entry]) => acc + entry[0], 0);
    const heldSum = eras.reduce((acc, [, entry]) => acc + entry[2], 0);
    const pricedSum = eras.reduce((acc, [, entry]) => acc + entry[1], 0);
    // The eras price the Pokémon book; the other priced games sit on top of it,
    // so the day is their sum and never one of them alone.
    assert.ok(Math.abs(valueSum - day.segments['game:pokemon'][0]) <= 0.01, `${day.date}: ${valueSum} vs ${day.segments['game:pokemon'][0]}`);
    assert.ok(
      Math.abs(valueSum + day.segments['game:riftbound'][0] - day.cardsValuePkn) <= 0.01,
      `${day.date}: ${valueSum} + ${day.segments['game:riftbound'][0]} vs ${day.cardsValuePkn}`,
    );
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
  // Same card every day, so the only movement is the wobble: ±1.5 % of the share
  // plus the renormalisation, never a different pile.
  for (const day of raw.days) {
    const sv = day.segments['pokemon:era:sv'][0];
    const swsh = day.segments['pokemon:era:swsh'][0];
    assert.ok(sv > 354 && sv < 366, `sv ${sv}`);
    assert.ok(swsh > 263 && swsh < 273, `swsh ${swsh}`);
  }
  // The pattern repeats every 12 card days: day 1 and day 13 are identical.
  assert.deepEqual(erasOf(0), erasOf(12));
  assert.notDeepEqual(erasOf(0), erasOf(0 + 1));
});

test('an era share moves slowly, so the opened chart is a trend and not a saw', () => {
  const raw = previewSegmentsFrom(flatCardDays(30));
  const keys = Object.keys(raw.days[0].segments).filter((key) => key.startsWith('pokemon:era:'));
  const shareOf = (day, key) => (day.segments[key]?.[0] ?? 0) / day.cardsValuePkn;
  for (let index = 1; index < raw.days.length; index += 1) {
    for (const key of keys) {
      const before = shareOf(raw.days[index - 1], key);
      const step = Math.abs(shareOf(raw.days[index], key) - before);
      // No band takes or gives a whole percentage point of the day in one day.
      assert.ok(step <= 0.01, `${key} day ${index + 1}: ${(step * 100).toFixed(3)}pp in one day`);
      // For the bands that carry the chart, 1 % of their own share is the bound.
      // A band worth 1 PKN a day is excluded: one cent of rounding already is a
      // percent of it, and the wobble is not what moves it.
      if (before >= 0.02) {
        assert.ok(step / before <= 0.01, `${key} day ${index + 1}: ${((step / before) * 100).toFixed(2)}% of its own share`);
      }
    }
  }
  // The chart indexes a series on its first priced day; the old ±6 % wobble put
  // the second day some 10 % under the 0 % line.
  for (const key of keys) {
    const values = raw.days.map((day) => day.segments[key]?.[0] ?? 0);
    const base = values.find((value) => value > 0);
    assert.ok(base > 0, `${key}: nothing priced`);
    for (const value of values) {
      if (!(value > 0)) continue;
      const pct = ((value - base) / base) * 100;
      assert.ok(Math.abs(pct) < 5, `${key}: ${pct.toFixed(2)} % off its first day`);
    }
  }
});

test('vintage is never held, sealed starts on the 10th card day, graded stays empty', () => {
  const raw = previewSegmentsFrom(flatCardDays(12));
  assert.ok(raw.days.every((day) => day.segments['pokemon:era:vintage'] === undefined));
  assert.ok(raw.days.every((day) => day.segments['pokemon:graded'] === undefined));
  assert.ok(raw.days.every((day) => day.segments['all:graded'] === undefined));
  assert.equal(raw.days[8].segments['pokemon:sealed'], undefined);
  assert.deepEqual(raw.days[9].segments['pokemon:sealed'], [90, 4, 4]);
  assert.deepEqual(raw.days[11].segments['all:sealed'], [90, 4, 4]);
  // The preview still answers the row states the desk paints. Riftbound is a
  // priced pile now, and Battle Spirits Saga is the one that is not.
  const model = normalizeSegments(raw);
  const rows = segmentGroups(model, 'all', {}).flatMap((group) => group.rows);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.key, row.state])), {
    'game:pokemon': 'ok',
    'game:riftbound': 'ok',
    'game:battle_spirits_saga': 'unpriced',
    'all:sealed': 'ok',
    'all:graded': 'empty',
  });
  const era = segmentGroups(model, 'pokemon', {})[0].rows.find((row) => row.key === 'pokemon:era:sv');
  assert.equal(era.sub, '2023–2025');
  assert.ok(era.held > 30 && era.held < 40, `sv holds ${era.held} of the 100 cards`);
});

test('the preview says what the server says: the BANDS labels and year ranges', () => {
  const defs = previewSegmentsFrom(flatCardDays(1)).segmentDefs;
  const eras = defs.filter((def) => def.group === 'era');
  assert.deepEqual(eras.map((def) => [def.label, def.years]), [
    ['Vintage', '1999–2003'],
    ['Mid era', '2003–2013'],
    ['XY', '2013–2016'],
    ['Sun & Moon', '2017–2019'],
    ['Sword & Shield', '2020–2023'],
    ['Scarlet & Violet', '2023–2025'],
    ['After Scarlet & Violet', '2025–'],
    ['Promos and other', ''],
  ]);
  // Every label and every range is a string the Rust table actually sends, so
  // the preview cannot quietly invent a name or a year the API never answers.
  const named = [...eras, ...defs.filter((def) => def.group === 'type')];
  assert.equal(named.length, 12);
  for (const def of named) {
    assert.ok(rustSegmentsSrc.includes(`"${def.label}"`), `label ${def.label} is not in portfolio_segments.rs`);
    if (def.years) {
      assert.ok(rustSegmentsSrc.includes(`"${def.years}"`), `${def.label}: ${def.years} is not in portfolio_segments.rs`);
    }
  }
  // A game row carries no label of its own, like `segment_defs`.
  for (const def of defs.filter((def) => def.group === 'game')) {
    assert.equal(def.label, undefined);
  }
});

test('a day of 20 cards or more holds at least one of every band with a share', () => {
  const bandsOf = (cards) => {
    const raw = previewSegmentsFrom([{
      date: '2026-10-01', cardsValuePkn: 5000, cardsHeld: cards, cardsPriced: Math.round(cards * 0.6),
    }]);
    const day = raw.days[0];
    const bands = Object.entries(day.segments)
      .filter(([key]) => key.startsWith('pokemon:era:'))
      .map(([key, entry]) => [key.replace('pokemon:era:', ''), entry[1], entry[2]]);
    return { bands, day };
  };
  for (const cards of [20, 24, 227]) {
    const { bands, day } = bandsOf(cards);
    // Vintage holds no share at all, so it is the one band that stays away.
    assert.equal(bands.length, 7, `${cards} cards: ${JSON.stringify(bands)}`);
    assert.ok(bands.every(([, priced, held]) => priced >= 1 && held >= 1), `${cards} cards: ${JSON.stringify(bands)}`);
    assert.equal(bands.reduce((acc, [, , held]) => acc + held, 0), cards, 'the held counts still add up');
    assert.equal(bands.reduce((acc, [, priced]) => acc + priced, 0), Math.round(cards * 0.6), 'and the priced ones');
  }
  // The values are untouched by the card floor: the eras still price the
  // Pokémon half of the day to the cent.
  const big = bandsOf(227);
  const valueSum = Object.entries(big.day.segments)
    .filter(([key]) => key.startsWith('pokemon:era:'))
    .reduce((acc, [, entry]) => acc + entry[0], 0);
  assert.ok(Math.abs(valueSum - big.day.segments['game:pokemon'][0]) <= 0.01, `${valueSum} vs ${big.day.segments['game:pokemon'][0]}`);
  assert.equal(big.bands.length, 7);
  // Below the floor a band thinner than one card is simply absent, as the API.
  assert.ok(bandsOf(19).bands.every(([id]) => id !== 'vintage'));
  assert.ok(bandsOf(19).bands.length < 7);
});

test('riftbound prices 6 % on top of the day, battle spirits saga holds cards with no price', () => {
  const raw = previewSegmentsFrom([
    { date: '2026-10-01', currencyPkn: 15 },
    { date: '2026-10-02', cardsValuePkn: 500, cardsHeld: 10, cardsPriced: 4 },
  ]);
  assert.deepEqual(raw.days[0].segments, {});
  assert.equal(raw.days[0].cardsValuePkn, null);
  // The Pokémon half is the series' own value; Riftbound's 6 % rides on top.
  assert.deepEqual(raw.days[1].segments['game:pokemon'], [500, 4, 10]);
  assert.equal(raw.days[1].cardsValuePkn, 530);
  assert.deepEqual(raw.days[1].segments['game:riftbound'], [30, 40, 40]);
  assert.deepEqual(raw.days[1].segments['game:battle_spirits_saga'], [0, 0, 12]);
});

test('riftbound is one Sets group; the unpriced game gets no level of its own', () => {
  const raw = previewSegmentsFrom(flatCardDays(14));
  const model = normalizeSegments(raw);
  for (const day of raw.days) {
    const pokemon = day.segments['game:pokemon'][0];
    const [total, priced, held] = day.segments['game:riftbound'];
    assert.ok(Math.abs(total - pokemon * 0.06) <= 0.01, `${day.date}: ${total} vs 6% of ${pokemon}`);
    assert.deepEqual([priced, held], [40, 40], 'a priced pile has its cards priced');
    const origins = day.segments['riftbound:set:origins'];
    const spiritforged = day.segments['riftbound:set:spiritforged'];
    // 70/30 of its own value and of its 40 cards, whole and adding up.
    assert.ok(Math.abs(origins[0] + spiritforged[0] - total) <= 0.01, `${day.date}: the sets lose value`);
    assert.ok(Math.abs(origins[0] / total - 0.7) < 0.001, `${day.date}: origins ${origins[0]} of ${total}`);
    assert.deepEqual([origins[2] + spiritforged[2], origins[1] + spiritforged[1]], [40, 40]);
  }
  const sets = segmentGroups(model, 'riftbound', {});
  assert.deepEqual(sets.map((group) => group.title), ['Sets'], 'no empty Sealed or Graded rows beside them');
  assert.deepEqual(sets[0].rows.map((row) => [row.key, row.label, row.state]), [
    ['riftbound:set:origins', 'Origins', 'ok'],
    ['riftbound:set:spiritforged', 'Spiritforged', 'ok'],
  ]);
  // 12 cards and no price is the "No price data yet" row, and nothing to drill
  // into, so it never becomes a level of its own.
  const saga = segmentGroups(model, 'all', {})[0].rows.find((row) => row.key === 'game:battle_spirits_saga');
  assert.deepEqual([saga.held, saga.valuePkn, saga.state], [12, 0, 'unpriced']);
  assert.deepEqual(segmentGroups(model, 'battle_spirits_saga', {}), []);
});

test('the fixture is deterministic and reads the normalized day shape too', () => {
  const series = flatCardDays(11);
  assert.deepEqual(previewSegmentsFrom(series), previewSegmentsFrom(series));
  const nested = series.map((day) => ({ date: day.date, assets: { cardsValuePkn: day.cardsValuePkn, cardsHeld: day.cardsHeld, cardsPriced: day.cardsPriced } }));
  assert.deepEqual(previewSegmentsFrom(nested), previewSegmentsFrom(series));
});
