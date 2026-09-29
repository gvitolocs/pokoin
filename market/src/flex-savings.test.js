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

test('DK → IT, 20 cards, pickup: alone is the real PostNord rate, Flex is a bag share', () => {
  const quote = flexQuote({ from: 'DK', to: 'IT', cards: 20 });
  assert.equal(quote.tier, 'MEDIUM');
  assert.equal(quote.alone.cents, 900);
  assert.equal(quote.alone.carrier, 'PostNord');
  // DK→DK parcel 1600 in, DK→IT parcel 2200 out.
  assert.equal(quote.trunk.cents, 3800);
  assert.equal(quote.packGrams, FLEX_ASSUMPTIONS.boxGrams + 20 * FLEX_ASSUMPTIONS.gramsPerCard);
  // 3800 × 85 g / (20 kg × 60 %) ≈ 27 cents.
  assert.equal(quote.flex.parts.trunk, 27);
  assert.equal(quote.flex.cents, 60 + 50 + 27);
  assert.equal(quote.savedCents, 900 - 137);
  assert.equal(quote.savedPct, 85);
  assert.equal(quote.packsPerBag, Math.floor(12000 / 85));
});

test('home delivery adds the destination tracked small-parcel rate', () => {
  const pickup = flexQuote({ from: 'DK', to: 'IT', cards: 20 });
  const home = flexQuote({ from: 'DK', to: 'IT', cards: 20, delivery: 'home' });
  assert.equal(home.lastMile.carrier, 'Poste');
  assert.equal(home.flex.cents - pickup.flex.cents, home.lastMile.cents);
  assert.ok(home.savedCents < pickup.savedCents);
});

test('a fuller bag is cheaper per pack', () => {
  const half = flexQuote({ from: 'IT', to: 'DK', cards: 50, bagFill: 0.5 });
  const full = flexQuote({ from: 'IT', to: 'DK', cards: 50, bagFill: 1 });
  assert.ok(full.flex.cents < half.flex.cents);
  assert.ok(full.packsPerBag > half.packsPerBag);
});

test('a missing trunk direction borrows the reverse lane and says so', () => {
  const leg = trunkLeg('DK', 'DE');
  assert.equal(leg.estimated, true);
  assert.ok(leg.cents > 0);
  const quote = flexQuote({ from: 'DE', to: 'DE', cards: 4 });
  assert.equal(quote.trunk.estimated, true);
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
