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
  lastMileCardCount,
  packGrams,
  routeServices,
  trunkLeg,
} from './flex-savings.js';
import { findShippingRate, packageTierForCount } from './shipping-quote.js';

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
  assert.ok(services.length >= 1);
  assert.ok(services.every((row, i) => i === 0 || row.cents >= services[i - 1].cents));
  const tracked = services.find((row) => row.tracked);
  const untracked = services.find((row) => !row.tracked);
  assert.ok(tracked);
  assert.ok(untracked);
  assert.ok(tracked.cents > 0);
  assert.ok(untracked.cents > 0);
  assert.deepEqual(routeServices({ from: 'IT', to: 'IT', cards: 50 }).map((row) => row.tracked), [true]);
});

test('DK → IT, 20 cards, pickup: alone is the chosen checkout service, Flex a bag share', () => {
  const quote = flexQuote({ from: 'DK', to: 'IT', cards: 20 });
  assert.equal(quote.tier, 'MEDIUM');
  assert.equal(quote.alone.tracked, true);
  assert.ok(quote.alone.cents > 0);
  const trunk = findShippingRate({ fromCountry: 'DK', toCountry: 'IT', packageTier: 'EXTRA_LARGE' });
  assert.equal(quote.trunk.cents, Number(trunk.priceEURCents));
  assert.equal(quote.packGrams, FLEX_ASSUMPTIONS.boxGrams + 20 * FLEX_ASSUMPTIONS.gramsPerCard);
  const expectedTrunkShare = Math.round((quote.trunk.cents * quote.packGrams) / (FLEX_ASSUMPTIONS.bagGrams * 0.6));
  assert.equal(quote.flex.parts.trunk, expectedTrunkShare);
  assert.equal(quote.flex.cents, 60 + 50 + expectedTrunkShare);
  assert.ok(quote.savedPct > 0);

  const untracked = flexQuote({ from: 'DK', to: 'IT', cards: 20, tracked: false });
  assert.equal(untracked.alone.tracked, false);
  assert.equal(untracked.flex.cents, quote.flex.cents);
});

test('home delivery quotes one Flex box, never the EXTRA_LARGE bag tier', () => {
  const tracked = flexQuote({ from: 'DK', to: 'IT', cards: 20, delivery: 'home' });
  assert.ok(tracked.lastMile);
  assert.equal(tracked.lastMile.tracked, true);
  assert.ok(tracked.flex.parts.lastMile > 0);
  const letter = flexQuote({ from: 'DK', to: 'IT', cards: 20, delivery: 'home', tracked: false });
  assert.equal(letter.lastMile.tracked, false);
  // 60 cards alone used to hit EXTRA_LARGE bag pricing; LARGE stops at 200 cards.
  const heavy = flexQuote({ from: 'IT', to: 'IT', cards: 60, delivery: 'home', tracked: true, bagFill: 1 });
  assert.ok(heavy);
  assert.equal(packageTierForCount(60), 'LARGE');
  assert.notEqual(heavy.alone.service, 'Parcel');
  assert.notEqual(heavy.lastMile.service, 'Parcel');
  // Domestic home ≈ alone letter + box/handling, so Flex is not cheaper here.
  assert.ok(heavy.savedCents < 0);
  const domesticPickup = flexQuote({ from: 'IT', to: 'IT', cards: 60, tracked: true, bagFill: 1 });
  assert.ok(domesticPickup.savedCents > 0);
  // Cross-border home still beats shipping alone.
  const cross = flexQuote({ from: 'DK', to: 'IT', cards: 20, delivery: 'home', tracked: true });
  assert.ok(cross.savedCents > 0);
});

test('lastMileCardCount never maps a Flex box onto the bag tier', () => {
  assert.equal(lastMileCardCount(53), 4);
  assert.equal(lastMileCardCount(85), 4);
  assert.equal(lastMileCardCount(165), 20);
  assert.equal(lastMileCardCount(400), 50);
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

test('IT domestic tracked is InPost-class (~€5), not a €17 bag', () => {
  const medium = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'MEDIUM', tracked: true });
  const xl = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'EXTRA_LARGE', tracked: true });
  assert.ok(medium.priceEURCents <= 700, `medium ${medium.priceEURCents}`);
  assert.ok(/inpost/i.test(medium.carrier), medium.carrier);
  assert.ok(xl.priceEURCents >= 1000 && xl.priceEURCents <= 2500, `xl ${xl.priceEURCents}`);
});
