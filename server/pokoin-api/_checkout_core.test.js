'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  packageTierForCount,
  quoteShipment,
  quoteCheckout,
  groupCartBySeller,
  assertShipFromCountry,
  validateAddressFields,
  findRate,
  DEFAULT_RATES,
} = require('./_checkout_core');
const { encryptAddressPayload, decryptAddressPayload } = require('./_address_crypto');

const TEST_KEY = Buffer.alloc(32, 7).toString('hex');

test('EU is rejected as ship-from', () => {
  assert.throws(() => assertShipFromCountry('EU'), /ISO/);
  assert.equal(assertShipFromCountry('dk'), 'DK');
});

test('package tier boundaries match seed table', () => {
  assert.equal(packageTierForCount(1), 'SMALL');
  assert.equal(packageTierForCount(4), 'SMALL');
  assert.equal(packageTierForCount(5), 'MEDIUM');
  assert.equal(packageTierForCount(20), 'MEDIUM');
  assert.equal(packageTierForCount(21), 'LARGE');
  assert.equal(packageTierForCount(50), 'LARGE');
  assert.equal(packageTierForCount(60), 'LARGE');
  assert.equal(packageTierForCount(201), 'EXTRA_LARGE');
});

test('Italy to Denmark one-card SMALL quotes the live PackZoo row', () => {
  const itDk = findRate({ fromCountry: 'IT', toCountry: 'DK', packageTier: 'SMALL', tracked: true });
  assert.equal(itDk.id, 'it-dk-small');
  assert.ok(itDk.priceEURCents > 0);
  const shipment = quoteShipment({
    sellerId: 'redshakkio',
    fromCountry: 'IT',
    toCountry: 'DK',
    items: [{ qty: 1 }],
    tracked: true,
  });
  assert.equal(shipment.amountCents, itDk.priceEURCents);
  assert.equal(shipment.packageTier, 'SMALL');
  assert.equal(shipment.tracked, true);
  const cheap = quoteShipment({
    sellerId: 'redshakkio',
    fromCountry: 'IT',
    toCountry: 'DK',
    items: [{ qty: 1 }],
    tracked: false,
  });
  assert.ok(cheap.amountCents <= shipment.amountCents);
  assert.equal(cheap.tracked, false);
});

test('country routing differs by origin/destination for same tier', () => {
  const dkIt = findRate({ fromCountry: 'DK', toCountry: 'IT', packageTier: 'SMALL' });
  const dkDk = findRate({ fromCountry: 'DK', toCountry: 'DK', packageTier: 'SMALL' });
  const deIt = findRate({ fromCountry: 'DE', toCountry: 'IT', packageTier: 'MEDIUM' });
  assert.ok(dkIt.priceEURCents > 0);
  assert.ok(dkDk.priceEURCents > 0);
  assert.ok(deIt.priceEURCents > 0);
  assert.notEqual(dkIt.priceEURCents, dkDk.priceEURCents);
});

test('missing route fails closed', () => {
  assert.throws(
    () => findRate({ fromCountry: 'FR', toCountry: 'PT', packageTier: 'SMALL' }),
    (err) => err.code === 'shipping_rate_missing',
  );
});

test('multi-seller cart becomes two shipments', () => {
  const groups = groupCartBySeller([
    { sellerUid: 'A', qty: 4, pricePkn: 200 },
    { sellerUid: 'B', qty: 12, pricePkn: 200 },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.sellerId === 'A').cardCount, 4);
  assert.equal(groups.find((g) => g.sellerId === 'B').cardCount, 12);
});

test('quoteCheckout sums per-seller shipping from the rate table', () => {
  const quote = quoteCheckout({
    toCountry: 'IT',
    sellerOrigins: { A: 'DK', B: 'DE' },
    items: [
      { sellerUid: 'A', qty: 4, pricePkn: 2000 },
      { sellerUid: 'B', qty: 12, pricePkn: 1000 },
    ],
  });
  assert.equal(quote.shipments.length, 2);
  const a = quote.shipments.find((s) => s.sellerId === 'A');
  const b = quote.shipments.find((s) => s.sellerId === 'B');
  assert.equal(a.packageTier, 'SMALL');
  assert.equal(b.packageTier, 'MEDIUM');
  const aRate = findRate({ fromCountry: 'DK', toCountry: 'IT', packageTier: 'SMALL' });
  const bRate = findRate({ fromCountry: 'DE', toCountry: 'IT', packageTier: 'MEDIUM' });
  assert.equal(a.amountCents, aRate.priceEURCents);
  assert.equal(b.amountCents, bRate.priceEURCents);
  assert.equal(quote.shippingTotalCents, a.amountCents + b.amountCents);
  assert.equal(quote.grandTotalCents, quote.itemsSubtotalCents + quote.shippingTotalCents);
});

test('adding a fifth card bumps DK→IT tier', () => {
  const four = quoteShipment({
    sellerId: 'A',
    fromCountry: 'DK',
    toCountry: 'IT',
    items: [{ qty: 4 }],
  });
  const five = quoteShipment({
    sellerId: 'A',
    fromCountry: 'DK',
    toCountry: 'IT',
    items: [{ qty: 5 }],
  });
  assert.equal(four.packageTier, 'SMALL');
  assert.equal(five.packageTier, 'MEDIUM');
  // PackZoo often flat-prices letter tiers; tier still changes.
  assert.ok(five.amountCents >= four.amountCents);
});

test('address validation and encryption round-trip', () => {
  const address = validateAddressFields({
    fullName: 'Mario Rossi',
    addressLine1: 'Via Roma 12',
    postalCode: '20100',
    city: 'Milano',
    countryCode: 'IT',
  });
  const enc = encryptAddressPayload({
    fullName: address.fullName,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    postalCode: address.postalCode,
    city: address.city,
    stateProvinceRegion: address.stateProvinceRegion,
    phoneNumber: address.phoneNumber,
    deliveryInstructions: address.deliveryInstructions,
  }, TEST_KEY);
  assert.ok(enc.ciphertext);
  assert.equal(enc.ciphertext.includes('Mario'), false);
  const dec = decryptAddressPayload(enc, TEST_KEY);
  assert.equal(dec.fullName, 'Mario Rossi');
  assert.equal(dec.city, 'Milano');
});

test('seed catalog is loaded', () => {
  assert.ok(DEFAULT_RATES.rates.length >= 20);
  assert.ok(DEFAULT_RATES.tiers.some((t) => t.id === 'SMALL'));
  assert.match(String(DEFAULT_RATES.source?.provider || ''), /packzoo/);
});
