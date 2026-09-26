import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanZoomBox, SCAN_ZOOM_DELAY_MS, SCAN_ZOOM_RATIO, SCAN_ZOOM_MAX_HEIGHT } from './scan-thumb-zoom.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const deskSrc = fs.readFileSync(path.join(root, 'pages/ScanDesk.jsx'), 'utf8');
const zoomSrc = fs.readFileSync(path.join(root, 'components/ThumbZoom.jsx'), 'utf8');

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

test('ScanDesk row thumbs open the CardTrader-style zoom of the full leftover', () => {
  // The little row image derives both the suggest thumb and the hero (full JPEG).
  assert.match(deskSrc, /thumb: imageSrc\(card, 'suggest'\)/);
  assert.match(deskSrc, /hero: imageSrc\(card, 'hero'\)/);
  assert.match(deskSrc, /<ThumbZoom src=\{zoomSrc\} full=\{Boolean\(thumbArt\.hero\)\}/);
  assert.match(deskSrc, /import ThumbZoom from '\.\.\/components\/ThumbZoom\.jsx';/);
});

test('ThumbZoom renders a pointer-following suggest-hover portal with safe teardown', () => {
  assert.match(zoomSrc, /createPortal\(/);
  assert.match(zoomSrc, /className="suggest-hover"/);
  assert.match(zoomSrc, /document\.body/);
  // Same desktop gate as the search popup hover.
  assert.match(zoomSrc, /suggestHoverAllowed\(window\.innerWidth/);
  // Scroll un-anchors a fixed box — hide, don't chase.
  assert.match(zoomSrc, /addEventListener\('scroll', onHide, \{ capture: true, passive: true \}\)/);
  assert.match(zoomSrc, /addEventListener\('dragstart', onStart, true\)/);
  assert.match(zoomSrc, /is-card-dragging/);
  assert.match(zoomSrc, /SCAN_ZOOM_DELAY_MS/);
});
