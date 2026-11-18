import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const zoomSrc = read('./ThumbZoom.jsx');

test('ThumbZoom renders a pointer-following suggest-hover portal with safe teardown', () => {
  assert.match(zoomSrc, /<Portal mount=\{document\.body\}>/);
  assert.match(zoomSrc, /class="suggest-hover"/);
  // Same desktop gate as the search popup hover.
  assert.match(zoomSrc, /suggestHoverAllowed\(window\.innerWidth/);
  // Scroll un-anchors a fixed box — hide, don't chase.
  assert.match(zoomSrc, /addEventListener\('scroll', onHide, \{ capture: true, passive: true \}\)/);
  assert.match(zoomSrc, /addEventListener\('dragstart', onStart, true\)/);
  assert.match(zoomSrc, /is-card-dragging/);
  assert.match(zoomSrc, /SCAN_ZOOM_DELAY_MS/);
  assert.match(zoomSrc, /if \(!props\.openOnClick \|\| props\.disabled \|\| !props\.src\) return;/);
});

test('chat tags cap the zoom; list tiles zoom the full scan', () => {
  assert.match(read('./ChatListingTag.jsx'), /maxHeight=\{CHAT_ZOOM_MAX_HEIGHT\}/);
  assert.match(read('./CardTile.jsx'), /when=\{list\(\)\}[\s\S]*<ArtworkZoom/);
});

test('ScanDesk row thumbs open the CardTrader-style zoom of the full leftover', () => {
  const rows = read('../pages/scan-desk/rows.jsx');
  // The little row image derives both the suggest thumb and the hero (full JPEG).
  assert.match(rows, /thumb: imageSrc\(card, 'suggest'\)/);
  assert.match(rows, /hero: imageSrc\(card, 'hero'\)/);
  assert.match(rows, /<ThumbZoom src=\{zoomSrc\(\)\} full=\{Boolean\(thumbArt\(\)\.hero\)\}/);
  assert.match(rows, /import ThumbZoom from '\.\.\/\.\.\/components\/ThumbZoom\.jsx';/);
});

test('ScanDesk queue LANG lists every language', () => {
  const desk = `${read('../pages/ScanDesk.jsx')}\n${read('../pages/scan-desk/rows.jsx')}\n${read('../pages/scan-desk/bars.jsx')}`;
  assert.doesNotMatch(desk, /languagesForPrint/);
  assert.match(desk, /LANGUAGES\.includes\(langValue\(\)\) \? LANGUAGES/);
  assert.match(desk, /Full LANG list/);
});
