import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { BUYSELL_BUY, BUYSELL_ICON, BUYSELL_SELL } from './buysell-icon.js';

const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const component = fs.readFileSync(new URL('../../solid/src/components/buysell/BuySellIcon.jsx', import.meta.url), 'utf8');

test('the mark is two distinct arrow paths and one combined path', () => {
  assert.notEqual(BUYSELL_BUY, BUYSELL_SELL);
  assert.equal(BUYSELL_ICON, `${BUYSELL_SELL}${BUYSELL_BUY}`);
  for (const path of [BUYSELL_BUY, BUYSELL_SELL]) assert.match(path, /^M[\d. -]+/);
});

test('the two arrows take their colour from two existing CSS variables', () => {
  assert.match(css, /--buysell-buy: var\(--yellow\);/);
  assert.match(css, /--buysell-sell: var\(--ct-blue\);/);
  assert.match(css, /\.buysell-ico \.bs-buy \{ fill: var\(--buysell-buy\); \}/);
  assert.match(css, /\.buysell-ico \.bs-sell \{ fill: var\(--buysell-sell\); \}/);
  assert.match(css, /--ct-blue: #5bbad5;/);
  assert.match(component, /class="bs-buy" d=\{BUYSELL_BUY\}/);
  assert.match(component, /class="bs-sell" d=\{BUYSELL_SELL\}/);
  assert.doesNotMatch(component, /fill="#|id="|url\(#/);
});

test('the mark keeps 3:1 contrast on the darkest and the lightest dark desk backgrounds', () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const bg of ['#000000', '#16141a', '#1f202d', '#25222c']) {
    assert.ok(ratio('#ffd33d', bg) >= 3, `gold on ${bg}`);
    assert.ok(ratio('#5bbad5', bg) >= 3, `blue on ${bg}`);
  }
});
