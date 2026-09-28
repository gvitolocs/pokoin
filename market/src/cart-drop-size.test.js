import assert from 'node:assert/strict';
import test from 'node:test';
import { cartDropThumb } from './cart-drop-size.js';

test('cart drop thumbs shrink as the cart fills', () => {
  assert.equal(cartDropThumb(1), 200);
  assert.equal(cartDropThumb(2), 136);
  assert.ok(cartDropThumb(16) < cartDropThumb(4));
  assert.ok(cartDropThumb(400) >= 56);
  assert.equal(cartDropThumb(0), 200);
});
