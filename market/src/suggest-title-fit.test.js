import assert from 'node:assert/strict';
import test from 'node:test';
import { SUGGEST_TITLE_MIN_SCALE, fitTitlePx } from './suggest-title-fit.js';

test('a title that already fits keeps the CSS size', () => {
  assert.equal(fitTitlePx(18.4, 132, 172), 18.4);
  assert.equal(fitTitlePx(18.4, 172, 172), 18.4);
});

test('a long title shrinks just enough to fit its box', () => {
  // Phone "Reshiram - BW-P 051": 185px of text in a 172px box.
  const px = fitTitlePx(18.4, 185, 172);
  assert.ok(px < 18.4);
  assert.ok((185 * px) / 18.4 <= 172, `${px}px still overflows`);
  assert.ok(18.4 - px < 1.5, `${px}px shrank more than needed`);
  assert.equal(px % 0.25, 0);
});

test('a very long title stops at the floor and lets the ellipsis take over', () => {
  // "Team Rocket's Mewtwo ex - 039/098" is 325px at 18.4px.
  const floor = 18.4 * SUGGEST_TITLE_MIN_SCALE;
  const px = fitTitlePx(18.4, 325, 100);
  assert.ok(px >= floor, `${px}px is under the ${floor}px floor`);
  assert.ok(px - floor < 0.25);
  assert.ok(fitTitlePx(18.4, 325, 186) >= floor);
});

test('missing measurements never change the size', () => {
  assert.equal(fitTitlePx(18.4, 0, 172), 18.4);
  assert.equal(fitTitlePx(18.4, 200, 0), 18.4);
  assert.equal(fitTitlePx(0, 200, 172), 0);
});
