import assert from 'node:assert/strict';
import test from 'node:test';
import { scanZoomBox, SCAN_ZOOM_RATIO, SCAN_ZOOM_MAX_HEIGHT, CHAT_ZOOM_MAX_HEIGHT } from './scan-thumb-zoom.js';

test('shop and cart hover at the full card height; chat keeps the smaller cap', () => {
  assert.equal(SCAN_ZOOM_MAX_HEIGHT, 640);
  assert.equal(CHAT_ZOOM_MAX_HEIGHT, 320);
  const chat = scanZoomBox({
    viewportWidth: 1400,
    viewportHeight: 900,
    pointerX: 400,
    pointerY: 450,
    maxHeight: CHAT_ZOOM_MAX_HEIGHT,
  });
  assert.equal(chat.height, 320);
});

test('scan zoom box floats right of the pointer and centers vertically', () => {
  const box = scanZoomBox({ viewportWidth: 1400, viewportHeight: 900, pointerX: 400, pointerY: 450 });
  assert.equal(box.height, SCAN_ZOOM_MAX_HEIGHT);
  assert.equal(box.width, Math.round(SCAN_ZOOM_MAX_HEIGHT * SCAN_ZOOM_RATIO));
  assert.ok(box.left > 400, 'right of pointer when there is room');
  assert.ok(Math.abs((box.top + box.height / 2) - 450) <= 1, 'centered on pointer');
});

test('scan zoom box flips left near the right edge and clamps into the viewport', () => {
  const vw = 1400;
  const box = scanZoomBox({ viewportWidth: vw, viewportHeight: 900, pointerX: 1310, pointerY: 450 });
  assert.ok(box.left + box.width <= vw - 10, 'right edge inside viewport');
  assert.ok(box.left < 1310, 'flipped left of pointer');

  const topClamped = scanZoomBox({ viewportWidth: 1400, viewportHeight: 900, pointerX: 400, pointerY: 0 });
  assert.ok(topClamped.top >= 10, 'top clamped to pad');

  const bottomClamped = scanZoomBox({ viewportWidth: 1400, viewportHeight: 900, pointerX: 400, pointerY: 9000 });
  assert.ok(bottomClamped.top + bottomClamped.height <= 890, 'bottom clamped to pad');

  const shortViewport = scanZoomBox({ viewportWidth: 1400, viewportHeight: 280, pointerX: 400, pointerY: 140 });
  assert.equal(shortViewport.height, 260, 'viewport height bounds the card, not the max');
  assert.ok(shortViewport.width <= 1400 - 20);
});
