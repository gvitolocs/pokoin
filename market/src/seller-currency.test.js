import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSellerPrice, pknFromPriceInput, priceInputFromPkn, sellerListCurrency } from './seller-currency.js';

test('opted-out sellers list in their ship-from currency', () => {
  assert.equal(sellerListCurrency(null), 'PKN');
  assert.equal(sellerListCurrency({ acceptsPkn: true, shipFromCountry: 'IT' }), 'PKN');
  assert.equal(sellerListCurrency({ acceptsPkn: false, shipFromCountry: 'IT' }), 'EUR');
  assert.equal(sellerListCurrency({ acceptsPkn: false, shipFromCountry: 'DK' }), 'DKK');
  assert.equal(sellerListCurrency({ acceptsPkn: false, shipFromCountry: '' }), 'EUR');
});

test('prices round-trip between stored PKN and the seller currency', () => {
  assert.equal(formatSellerPrice(2642, 'PKN'), '2642 PKN');
  assert.equal(formatSellerPrice(2642, 'EUR'), '€13.21');
  assert.equal(formatSellerPrice(2000, 'DKK'), '75 DKK');
  assert.equal(priceInputFromPkn(2642, 'EUR'), '13.21');
  assert.equal(priceInputFromPkn(null, 'EUR'), '');
  assert.equal(pknFromPriceInput('13.21', 'EUR'), 2642);
  assert.equal(pknFromPriceInput('75', 'DKK'), 2000);
  assert.equal(pknFromPriceInput('12.5', 'PKN'), 12.5);
  assert.equal(pknFromPriceInput('abc', 'EUR'), null);
});
