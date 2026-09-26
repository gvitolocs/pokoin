import assert from 'node:assert/strict';
import test from 'node:test';
import { checkoutFees, insuranceCoveragePkn } from './checkout-fees.js';

test('insurance is off by default and commission stays 3 percent', () => {
  const fees = checkoutFees(296);
  assert.equal(fees.commissionPkn, 8.88);
  assert.equal(fees.insurancePkn, 0);
  assert.equal(fees.taxPkn, 8.88);
  assert.equal(fees.totalPkn, 296 + 8.88);
});

test('insurance adds 5 percent and covers a lost order up to 50 dollars', () => {
  const fees = checkoutFees(296, { insurance: true, shippingPkn: 2000 });
  assert.equal(fees.insurancePkn, 14.8);
  assert.equal(fees.taxPkn, 8.88 + 14.8);
  assert.equal(fees.totalPkn, 296 + 8.88 + 14.8 + 2000);
  assert.equal(insuranceCoveragePkn(), 10000);
  assert.equal(fees.coveragePkn, 10000);
});
