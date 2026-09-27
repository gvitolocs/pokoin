import assert from 'node:assert/strict';
import test from 'node:test';
import { cartDropThumb } from './cart-drop-size.js';
import fs from 'node:fs';

test('cart popup thumbs: one card is large, many shrink', () => {
  assert.equal(cartDropThumb(1), 248);
  assert.equal(cartDropThumb(2), 148);
  assert.ok(cartDropThumb(16) < cartDropThumb(4));
  assert.ok(cartDropThumb(400) >= 56);
  assert.equal(cartDropThumb(0), 248);
});

test('cart popup is twice as tall as the old panel and stays a header width', () => {
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const block = css.match(/\.cart-drop \{\s*width:[^}]+\}/);
  assert.ok(block);
  assert.match(block[0], /width:\s*18rem/);
  assert.match(block[0], /min-height:\s*12\.5rem/);
  assert.doesNotMatch(block[0], /32rem/);
  assert.match(css, /\.cart-drop-card > a\s*\{[^}]*width:\s*100%/s);
});
