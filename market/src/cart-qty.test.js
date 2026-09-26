import assert from 'node:assert/strict';
import test from 'node:test';
import { nextCartQty } from './cart-qty.js';

test('a second drag does not pass the copies that seller has', () => {
  assert.equal(nextCartQty(1, 1, 1), 1);
  assert.equal(nextCartQty(2, 1, 1), 1);
  assert.equal(nextCartQty(1, 1, 4), 2);
});
