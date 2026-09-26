import assert from 'node:assert/strict';
import test from 'node:test';
import { cartDropThumb } from './cart-drop-size.js';

test('cart popup thumbs shrink as the cart fills', () => {
  assert.equal(cartDropThumb(1), 200);
  assert.equal(cartDropThumb(4), 100);
  assert.ok(cartDropThumb(16) < cartDropThumb(4));
  assert.equal(cartDropThumb(400), 36);
  assert.equal(cartDropThumb(0), 200);
});
