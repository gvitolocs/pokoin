import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { cartDropThumb } from './cart-drop-size.js';

test('cart drop thumbs shrink as the cart fills', () => {
  assert.equal(cartDropThumb(1), 200);
  assert.equal(cartDropThumb(2), 136);
  assert.ok(cartDropThumb(16) < cartDropThumb(4));
  assert.ok(cartDropThumb(400) >= 56);
  assert.equal(cartDropThumb(0), 200);
});

test('the cart panel fits two thumbs of a two-card cart on one row', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const width = Number(css.match(/\.cart-drop \{[^}]*width: min\(([\d.]+)rem/)[1]) * 16;
  const content = width - 2 * 0.85 * 16 - 2 - 15; // padding, border, scrollbar
  assert.ok(content >= 2 * cartDropThumb(2) + 0.45 * 16);
});
