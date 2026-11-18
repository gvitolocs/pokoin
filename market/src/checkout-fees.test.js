import assert from 'node:assert/strict';
import test from 'node:test';
import { checkoutFees } from './checkout-fees.js';

test('buyer markup is 3 percent rounded once to the whole-PKN ledger', () => {
  const fees = checkoutFees(296);
  assert.equal(fees.commissionPkn, 9);
  assert.equal(fees.insurancePkn, 0);
  assert.equal(fees.coveragePkn, 236.8);
  assert.equal(fees.taxPkn, 9);
  assert.equal(fees.totalPkn, 296 + 9);
});

test('insurance adds 5 percent and covers 80 percent of the order', () => {
  const fees = checkoutFees(5214, { insurance: true, shippingPkn: 2000 });
  assert.equal(fees.commissionPkn, 156);
  assert.equal(fees.insurancePkn, 260.7);
  assert.equal(fees.coveragePkn, 4171.2);
  assert.equal(fees.taxPkn, 156 + 260.7);
  assert.equal(fees.totalPkn, 5214 + 156 + 260.7 + 2000);
});

test('PKN buyer markup matches server half-up rounding on small orders', () => {
  assert.equal(checkoutFees(16).buyerMarkupPkn, 0);
  assert.equal(checkoutFees(17).buyerMarkupPkn, 1);
  assert.equal(checkoutFees(296).totalPkn, 305);
});
