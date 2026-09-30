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
  perSellerCards,
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
  assert.ok(countries.from.includes('FR'));
});

test('route services come from the checkout rate table, cheapest first', () => {
  const services = routeServices({ from: 'IT', to: 'IT', cards: 20 });
  assert.ok(services.length >= 1);
  assert.ok(services.every((row, i) => i === 0 || row.cents >= services[i - 1].cents));
  assert.ok(services.some((row) => row.tracked));
});

test('perSellerCards splits an order across sellers', () => {
  assert.equal(perSellerCards(20, 1), 20);
  assert.equal(perSellerCards(20, 3), 7);
  assert.equal(perSellerCards(4, 3), 2);
});

test('DK → IT pickup: alone is N parcels, Flex is N boxes in one bag', () => {
  const one = flexQuote({ from: 'DK', to: 'IT', cards: 20, sellers: 1 });
  assert.ok(one);
  assert.equal(one.sellers, 1);
  assert.ok(one.alone.cents > 0);
  assert.ok(one.savedPct > 0);

  const three = flexQuote({ from: 'DK', to: 'IT', cards: 20, sellers: 3 });
  assert.equal(three.sellers, 3);
  assert.equal(three.perSellerCards, 7);
  assert.equal(three.alone.cents, three.alone.perSellerCents * 3);
  assert.ok(three.flex.parts.box === FLEX_ASSUMPTIONS.boxCents * 3);
  assert.ok(three.savedPct > one.savedPct || three.alone.cents > one.alone.cents);
});

test('three IT sellers make Flex cheaper than alone on pickup', () => {
  const one = flexQuote({ from: 'IT', to: 'IT', cards: 20, sellers: 1, delivery: 'home' });
  assert.ok(one.savedCents < 0);
  const three = flexQuote({ from: 'IT', to: 'IT', cards: 20, sellers: 3, delivery: 'pickup' });
  assert.ok(three.savedCents > 0);
  assert.ok(three.savedPct >= 50);
});

test('home delivery is one warehouse hop, not one per seller', () => {
  const three = flexQuote({ from: 'IT', to: 'IT', cards: 20, sellers: 3, delivery: 'home' });
  assert.ok(three?.lastMile);
  assert.equal(three.flex.parts.lastMile, three.lastMile.cents);
  assert.notEqual(three.flex.parts.lastMile, three.lastMile.cents * 3);
});

test('home delivery quotes Flex-box last-mile, never EXTRA_LARGE bag tier', () => {
  const tracked = flexQuote({ from: 'DK', to: 'IT', cards: 20, delivery: 'home', sellers: 1 });
  assert.ok(tracked.lastMile);
  assert.equal(tracked.lastMile.tracked, true);
  const heavy = flexQuote({ from: 'IT', to: 'IT', cards: 60, delivery: 'home', sellers: 1, bagFill: 1 });
  assert.equal(packageTierForCount(60), 'LARGE');
  assert.notEqual(heavy.lastMile?.service, 'Parcel');
});

test('lastMileCardCount never maps a Flex box onto the bag tier', () => {
  assert.equal(lastMileCardCount(53), 4);
  assert.equal(lastMileCardCount(85), 4);
  assert.equal(lastMileCardCount(165), 20);
  assert.equal(lastMileCardCount(400), 50);
});

test('a fuller bag is cheaper per pack', () => {
  const half = flexQuote({ from: 'IT', to: 'DK', cards: 50, sellers: 1, bagFill: 0.5 });
  const full = flexQuote({ from: 'IT', to: 'DK', cards: 50, sellers: 1, bagFill: 1 });
  assert.ok(full.flex.cents < half.flex.cents);
});

test('a missing parcel direction borrows the reverse lane and says so', () => {
  assert.equal(trunkLeg('DE', 'IT').estimated, false);
  // IT→DE may now have a direct XL from the expanded matrix
  const itDe = trunkLeg('IT', 'DE');
  assert.ok(itDe);
  assert.equal(flexQuote({ from: 'XX', to: 'DK', cards: 4 }), null);
});

test('lane table defaults to 3 sellers', () => {
  const table = flexLaneTable();
  assert.equal(table.length, flexLanes().length);
  assert.ok(table.every((row) => row.quotes.length === 3));
  const sample = table[0].quotes.find(Boolean);
  assert.equal(sample.sellers, 3);
  const avg = flexAverageSaving();
  assert.ok(avg.quotes > 0);
  assert.ok(avg.savedPct > 0 && avg.savedPct < 100);
});

test('helpers', () => {
  assert.equal(packGrams(0), FLEX_ASSUMPTIONS.boxGrams + FLEX_ASSUMPTIONS.gramsPerCard);
  assert.equal(formatEur(763), '€7.63');
  assert.equal(formatEur(-50), '−€0.50');
});

test('IT domestic tracked is letter-class, bag is EXTRA_LARGE', () => {
  const medium = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'MEDIUM', tracked: true });
  const xl = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'EXTRA_LARGE', tracked: true });
  assert.ok(medium.priceEURCents <= 800, `medium ${medium.priceEURCents}`);
  assert.ok(xl.priceEURCents >= 1000, `xl ${xl.priceEURCents}`);
  assert.ok(medium.priceEURCents < xl.priceEURCents);
});
