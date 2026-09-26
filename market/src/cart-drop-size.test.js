import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { cartDropThumb } from './cart-drop-size.js';

test('cart popup thumbs shrink as the cart fills', () => {
  assert.equal(cartDropThumb(1), 200);
  assert.equal(cartDropThumb(4), 100);
  assert.ok(cartDropThumb(16) < cartDropThumb(4));
  assert.equal(cartDropThumb(400), 36);
  assert.equal(cartDropThumb(0), 200);
});

test('cart popup is twice as tall as the old panel and stays a header width', () => {
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const block = css.match(/\.cart-drop \{\s*width:[^}]+\}/);
  assert.ok(block);
  assert.match(block[0], /width:\s*18rem/);
  assert.match(block[0], /min-height:\s*12\.5rem/);
  assert.doesNotMatch(block[0], /32rem/);
});
