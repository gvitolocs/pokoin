import assert from 'node:assert/strict';
import test from 'node:test';
import { checkoutFees } from './checkout-fees.js';

test('insurance is off by default and commission stays 3 percent', () => {
  const fees = checkoutFees(296);
  assert.equal(fees.commissionPkn, 8.88);
  assert.equal(fees.insurancePkn, 0);
  assert.equal(fees.coveragePkn, 236.8);
  assert.equal(fees.taxPkn, 8.88);
  assert.equal(fees.totalPkn, 296 + 8.88);
});

test('insurance adds 5 percent and covers 80 percent of the order', () => {
  const fees = checkoutFees(5214, { insurance: true, shippingPkn: 2000 });
  assert.equal(fees.commissionPkn, 156.42);
  assert.equal(fees.insurancePkn, 260.7);
  assert.equal(fees.coveragePkn, 4171.2);
  assert.equal(fees.taxPkn, 156.42 + 260.7);
  assert.equal(fees.totalPkn, 5214 + 156.42 + 260.7 + 2000);
});
