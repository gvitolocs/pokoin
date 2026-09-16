import assert from 'node:assert/strict';
import test from 'node:test';
import { pickSuggestHoverSrc, suggestHoverAllowed, suggestHoverBox } from './suggest-hover.js';

test('hover is desktop-only', () => {
  assert.equal(suggestHoverAllowed(1440, true), true);
  assert.equal(suggestHoverAllowed(720, true), false);
  assert.equal(suggestHoverAllowed(1440, false), false);
});

test('hover src prefers leftover JPEG over the suggest thumb', () => {
  assert.equal(
    pickSuggestHoverSrc(
      'https://cdn.pokoin.com/206188_pikachu.jpg',
      'https://cdn.pokoin.com/206188_pikachu_homepage.webp',
    ),
    'https://cdn.pokoin.com/206188_pikachu.jpg',
  );
  assert.equal(
    pickSuggestHoverSrc('', 'https://cardtrader.com/uploads/blueprints/image/1/preview_mimikyu.jpg'),
    'https://cardtrader.com/uploads/blueprints/image/1/preview_mimikyu.jpg',
  );
});

test('places the card left of the panel when there is room', () => {
  const box = suggestHoverBox({
    viewportWidth: 1600,
    viewportHeight: 900,
    panelLeft: 520,
    panelRight: 1280,
    rowTop: 80,
    rowHeight: 72,
  });
  assert.equal(box.side, 'left');
  assert.ok(box.left + box.width <= 520 - 12);
  assert.ok(box.height <= 680);
  assert.ok(Math.abs(box.width / box.height - 63 / 88) < 0.01);
});

test('falls to overlap-left when the panel is nearly full width', () => {
  const box = suggestHoverBox({
    viewportWidth: 1440,
    viewportHeight: 900,
    panelLeft: 80,
    panelRight: 1320,
    rowTop: 120,
    rowHeight: 64,
  });
  assert.equal(box.side, 'overlap-left');
  assert.equal(box.left, 8);
  assert.ok(box.width <= 1440 * 0.42 + 1);
});

test('clamps vertically inside the viewport', () => {
  const box = suggestHoverBox({
    viewportWidth: 1600,
    viewportHeight: 400,
    panelLeft: 700,
    panelRight: 1300,
    rowTop: 0,
    rowHeight: 40,
  });
  assert.ok(box.top >= 8);
  assert.ok(box.top + box.height <= 400 - 8);
});
