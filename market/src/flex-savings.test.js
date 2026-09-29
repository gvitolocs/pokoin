import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLEX_ASSUMPTIONS,
  flexAverageSaving,
  flexCountries,
  flexLaneTable,
  flexLanes,
  flexQuote,
  formatEur,
  packGrams,
  routeServices,
  trunkLeg,
} from './flex-savings.js';

test('lanes and countries come from the live rate table', () => {
  const lanes = flexLanes().map((lane) => `${lane.from}-${lane.to}`);
  assert.ok(lanes.includes('DK-IT'));
  assert.ok(lanes.includes('IT-DK'));
  assert.ok(lanes.includes('DE-DE'));
  const countries = flexCountries();
  assert.ok(countries.from.includes('DK'));
  assert.ok(countries.to.includes('IT'));
});

test('route services come from the checkout rate table, cheapest first', () => {
  const services = routeServices({ from: 'IT', to: 'IT', cards: 20 });
  assert.deepEqual(services.map((row) => [row.service, row.tracked, row.cents]), [
    ['Untracked letter', false, 270],
    ['Standard', true, 600],
  ]);
  assert.deepEqual(routeServices({ from: 'IT', to: 'IT', cards: 50 }).map((row) => row.tracked), [true]);
});

test('DK → IT, 20 cards, pickup: alone is the chosen checkout service, Flex a bag share', () => {
  const quote = flexQuote({ from: 'DK', to: 'IT', cards: 20 });
  assert.equal(quote.tier, 'MEDIUM');
  assert.equal(quote.alone.cents, 900);
  assert.equal(quote.alone.tracked, true);
  // The bag is one PostNord EU parcel DK → IT.
  assert.equal(quote.trunk.cents, 2200);
  assert.equal(quote.packGrams, FLEX_ASSUMPTIONS.boxGrams + 20 * FLEX_ASSUMPTIONS.gramsPerCard);
  // 2200 × 85 g / (20 kg × 60 %) ≈ 16 cents.
  assert.equal(quote.flex.parts.trunk, 16);
  assert.equal(quote.flex.cents, 60 + 50 + 16);
  assert.equal(quote.savedPct, 86);

  const untracked = flexQuote({ from: 'DK', to: 'IT', cards: 20, tracked: false });
  assert.equal(untracked.alone.service, 'Untracked letter');
  assert.equal(untracked.alone.cents, 405);
  assert.equal(untracked.flex.cents, quote.flex.cents);
});

test('home delivery adds the same kind of service inside the destination country', () => {
  const tracked = flexQuote({ from: 'DK', to: 'IT', cards: 20, delivery: 'home' });
  assert.equal(tracked.lastMile.carrier, 'Poste');
  assert.equal(tracked.lastMile.tracked, true);
  assert.equal(tracked.flex.parts.lastMile, 600);
  const letter = flexQuote({ from: 'DK', to: 'IT', cards: 20, delivery: 'home', tracked: false });
  assert.equal(letter.lastMile.service, 'Untracked letter');
  assert.equal(letter.flex.parts.lastMile, 270);
  // Inside one country, home delivery costs about what posting it yourself does.
  const domestic = flexQuote({ from: 'IT', to: 'IT', cards: 20, delivery: 'home', tracked: false });
  assert.ok(domestic.savedCents < 0);
  assert.ok(flexQuote({ from: 'IT', to: 'IT', cards: 20, tracked: false }).savedCents > 0);
});

test('a fuller bag is cheaper per pack', () => {
  const half = flexQuote({ from: 'IT', to: 'DK', cards: 50, bagFill: 0.5 });
  const full = flexQuote({ from: 'IT', to: 'DK', cards: 50, bagFill: 1 });
  assert.ok(full.flex.cents < half.flex.cents);
  assert.ok(full.packsPerBag > half.packsPerBag);
});

test('a missing parcel direction borrows the reverse lane and says so', () => {
  assert.equal(trunkLeg('DE', 'IT').estimated, false);
  assert.equal(trunkLeg('IT', 'DE').estimated, true);
  assert.equal(flexQuote({ from: 'XX', to: 'DK', cards: 4 }), null);
});

test('lane table and average cover every lane', () => {
  const table = flexLaneTable();
  assert.equal(table.length, flexLanes().length);
  assert.ok(table.every((row) => row.quotes.length === 3));
  const avg = flexAverageSaving();
  assert.ok(avg.quotes > 0);
  assert.ok(avg.savedPct > 0 && avg.savedPct < 100);
});

test('helpers', () => {
  assert.equal(packGrams(0), FLEX_ASSUMPTIONS.boxGrams + FLEX_ASSUMPTIONS.gramsPerCard);
  assert.equal(formatEur(763), '€7.63');
  assert.equal(formatEur(-50), '−€0.50');
});
