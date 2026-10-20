import assert from 'node:assert/strict';
import test from 'node:test';
import { buyerPriceLabel, buyerPriceParts, formatListingPrice, formatSellerPrice, pknFromPriceInput, priceInputFromPkn, sellerListCurrency } from './seller-currency.js';

test('opted-out sellers list in their ship-from currency', () => {
  assert.equal(sellerListCurrency(null), 'PKN');
  assert.equal(sellerListCurrency({ acceptsPkn: true, shipFromCountry: 'IT' }), 'PKN');
  assert.equal(sellerListCurrency({ acceptsPkn: false, shipFromCountry: 'IT' }), 'EUR');
  assert.equal(sellerListCurrency({ acceptsPkn: false, shipFromCountry: 'DK' }), 'DKK');
  assert.equal(sellerListCurrency({ acceptsPkn: false, shipFromCountry: '' }), 'EUR');
});

test('prices round-trip between stored PKN and the seller currency', () => {
  assert.equal(formatSellerPrice(2642, 'PKN'), '2642 PKN');
  assert.equal(formatSellerPrice(2642, 'EUR'), '€13.21 (2642 PKN)');
  assert.equal(formatSellerPrice(2000, 'DKK'), '75 DKK (2000 PKN)');
  assert.equal(priceInputFromPkn(2642, 'EUR'), '13.21');
  assert.equal(priceInputFromPkn(null, 'EUR'), '');
  assert.equal(pknFromPriceInput('13.21', 'EUR'), 2642);
  assert.equal(pknFromPriceInput('75', 'DKK'), 2000);
  assert.equal(pknFromPriceInput('12.5', 'PKN'), 12.5);
  assert.equal(pknFromPriceInput('abc', 'EUR'), null);
});

test('buyers see card-only sellers in local currency with PKN in brackets', () => {
  assert.equal(formatListingPrice(2642, true, 'EUR'), '2642 PKN');
  assert.equal(formatListingPrice(2642, undefined, 'EUR'), '2642 PKN');
  assert.equal(formatListingPrice(2642, false, 'EUR'), '€13.21 (2642 PKN)');
  assert.equal(formatListingPrice(2000, false, 'DKK'), '75 DKK (2000 PKN)');
});

test('unaffordable prices show the buyer local currency only', () => {
  const parts = buyerPriceParts({ pricePkn: 86, currency: 'DKK', balancePkn: 18 });
  assert.equal(parts.pkn, '');
  assert.ok(parts.local.endsWith('DKK'));
  const label = buyerPriceLabel({ pricePkn: 86, currency: 'DKK', balancePkn: 18 });
  assert.equal(label.includes('PKN'), false);
  assert.match(label, /DKK$/);
});

test('a pinned currency label keeps PKN in parentheses', () => {
  const label = buyerPriceLabel({ pricePkn: 86, currency: 'DKK', balancePkn: 18, pinned: 'DKK' });
  assert.match(label, /DKK \(86 PKN\)$/);
});

test('affordable prices stay PKN only', () => {
  const parts = buyerPriceParts({ pricePkn: 86, currency: 'DKK', balancePkn: 1000 });
  assert.equal(parts.local, '');
  assert.equal(parts.pkn, '86 PKN');
});

test('card-only sellers show local currency only even with a big balance', () => {
  const parts = buyerPriceParts({ pricePkn: 86, currency: 'DKK', balancePkn: 1000, sellerAcceptsPkn: false });
  assert.equal(parts.pkn, '');
  assert.ok(parts.local.endsWith('DKK'));
});

test('a pinned URL currency keeps the two-line local + PKN stack', () => {
  const parts = buyerPriceParts({ pricePkn: 86, currency: 'DKK', balancePkn: 18, pinned: 'DKK' });
  assert.ok(parts.local.endsWith('DKK'));
  assert.equal(parts.pkn, '86 PKN');
});

test('signed-out buyers see local currency first, PKN under it', () => {
  const parts = buyerPriceParts({ pricePkn: 86, currency: 'DKK', balancePkn: null });
  assert.ok(parts.local.endsWith('DKK'));
  assert.equal(parts.pkn, '86 PKN');
  assert.deepEqual(buyerPriceParts({ pricePkn: 352, currency: 'EUR', balancePkn: null }), { local: '€1.76', pkn: '352 PKN' });
  assert.equal(buyerPriceLabel({ pricePkn: 352, currency: 'EUR', balancePkn: null }), '€1.76 (352 PKN)');
});

test('signed-out buyers pinned to PKN keep plain PKN; card-only sellers stay local only', () => {
  assert.deepEqual(buyerPriceParts({ pricePkn: 86, currency: 'DKK', balancePkn: null, pinned: 'PKN' }), { local: '', pkn: '86 PKN' });
  const cardOnly = buyerPriceParts({ pricePkn: 86, currency: 'DKK', balancePkn: null, sellerAcceptsPkn: false });
  assert.equal(cardOnly.pkn, '');
  assert.ok(cardOnly.local.endsWith('DKK'));
});
