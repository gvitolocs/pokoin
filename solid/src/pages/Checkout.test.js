import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./Checkout.jsx', import.meta.url), 'utf8');
const cart = fs.readFileSync(new URL('../stores/cart-actions.js', import.meta.url), 'utf8');

test('PKN balance voucher is opt-in and priced at 2 PKN per euro-cent', () => {
  // The saved opt-in (shipping-choice.js readPknDiscount) seeds the toggle; it starts off.
  assert.match(cart, /createSignal\(browser \? readPknDiscount\(\) : false\)/);
  assert.match(src, /Use my PKN balance as a discount/);
  assert.match(src, /const pknDiscountEurCents = \(\) => \(cartUseBalance\(\) \? voucher\(\)\.eurCents : 0\)/);
  assert.match(src, /const pknDiscountPkn = \(\) => pknDiscountEurCents\(\) \* 2/);
  assert.match(src, /usePknDiscount: pknDiscountPkn\(\) >= 1/);
  assert.doesNotMatch(src, /pknDiscountPkn\(\) \* 50|\/ 50,/);
});

test('checkout does not claim the card is charged in EUR', () => {
  assert.doesNotMatch(src, /charged in EUR|Stripe charges EUR/);
});

test('checkout keeps the buyer\'s own shipping pick over the default', () => {
  // Cart parcel picks seed checkout; a pick here is that parcel's service
  // (checkoutParcelShipping falls back to the default only without a pick).
  assert.match(src, /createSignal\(untrack\(\(\) => \(\{ \.\.\.\(cartShippingChoice\(\)\.parcels \|\| \{\}\) \}\)\)\)/);
  assert.match(src, /picks: parcelPicks\(\)/);
  assert.match(src, /setParcelPicks\(\(current\) => \(\{ \.\.\.current, \[sellerId\]: serviceId \}\)\)/);
  assert.match(src, /pickParcelService\(parcel\.sellerId, option\.id, \{ orderWide: true \}\)/);
});
