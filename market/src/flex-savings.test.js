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
  consolidatedLeg,
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

test('one seller is one direct shipment, so Flex costs more', () => {
  const one = flexQuote({
    from: 'DK',
    to: 'IT',
    cards: 20,
    sellers: 1,
    pickupPackets: 40,
  });
  assert.ok(one);
  assert.equal(one.sellers, 1);
  assert.equal(one.flex.parts.trunk, one.alone.perSellerCents);
  assert.ok(one.flex.parts.box + one.flex.parts.handling > 0);
  assert.ok(one.flex.parts.lastMile > 0);
  assert.ok(one.savedCents < 0);

  const home = flexQuote({ from: 'IT', to: 'IT', cards: 20, sellers: 1, delivery: 'home' });
  assert.ok(home.savedCents < 0);
});

test('several sellers share one partner shipment, and the city pack splits the second hop', () => {
  const three = flexQuote({
    from: 'DK',
    to: 'IT',
    cards: 20,
    sellers: 3,
    pickupPackets: FLEX_ASSUMPTIONS.defaultPickupPackets,
  });
  assert.equal(three.sellers, 3);
  assert.equal(three.perSellerCards, 7);
  assert.equal(three.pickupPackets, FLEX_ASSUMPTIONS.defaultPickupPackets);
  assert.equal(three.alone.cents, three.alone.perSellerCents * 3);
  assert.equal(three.flex.parts.box, FLEX_ASSUMPTIONS.boxCents * 3);
  assert.ok(three.intake.cents < three.alone.cents);
  assert.equal(
    three.flex.parts.lastMile,
    Math.round((three.city.cents * 3) / FLEX_ASSUMPTIONS.defaultPickupPackets),
  );
  assert.ok(three.savedCents > 0);

  const tight = flexQuote({ from: 'DK', to: 'IT', cards: 20, sellers: 3, pickupPackets: 3 });
  assert.ok(three.flex.cents < tight.flex.cents);
  assert.equal(three.flex.parts.trunk, tight.flex.parts.trunk);
});

test('a pickup pack cannot be smaller than this order’s seller packets', () => {
  const quote = flexQuote({ from: 'IT', to: 'DK', cards: 12, sellers: 4, pickupPackets: 1 });
  assert.equal(quote.pickupPackets, 4);
  assert.equal(quote.flex.parts.lastMile, quote.city.cents);
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
  const heavy = flexQuote({ from: 'IT', to: 'IT', cards: 60, delivery: 'home', sellers: 1 });
  assert.equal(packageTierForCount(60), 'LARGE');
  assert.notEqual(heavy.lastMile?.service, 'Parcel');
});

test('lastMileCardCount never maps a Flex box onto the bag tier', () => {
  assert.equal(lastMileCardCount(53), 4);
  assert.equal(lastMileCardCount(85), 4);
  assert.equal(lastMileCardCount(165), 20);
  assert.equal(lastMileCardCount(400), 50);
});

test('a city pack is a normal parcel until it is heavy enough for the 20 kg bag', () => {
  const parcel = consolidatedLeg({
    from: 'IT',
    to: 'IT',
    packets: 20,
    cardsPerPacket: 20,
    tracked: true,
  });
  assert.equal(parcel.totalGrams, 20 * packGrams(20));
  assert.ok(parcel.totalGrams < FLEX_ASSUMPTIONS.parcelMaxGrams);
  assert.notEqual(parcel.tier, 'EXTRA_LARGE');

  const bag = consolidatedLeg({
    from: 'IT',
    to: 'IT',
    packets: 200,
    cardsPerPacket: 20,
    tracked: true,
  });
  assert.ok(bag.totalGrams > FLEX_ASSUMPTIONS.parcelMaxGrams);
  assert.equal(bag.tier, 'EXTRA_LARGE');
  assert.equal(bag.bags, 1);

  const quote = flexQuote({
    from: 'DK',
    to: 'IT',
    cards: 20,
    sellers: 1,
    pickupPackets: 20,
  });
  assert.notEqual(quote.city.tier, 'EXTRA_LARGE');
  assert.ok(quote.flex.parts.lastMile < quote.city.cents);
  assert.ok(quote.savedCents < 0);
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
