import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const chrome = read('./Chrome.jsx');
const drop = read('./DesktopDrop.jsx');
const cart = read('./CartDrop.jsx');

test('cart and Desktop trays mount at most TRAY_VISIBLE thumbs and full scans only for a few cards', () => {
  for (const [file, src] of [['CartDrop.jsx', cart], ['DesktopDrop.jsx', drop]]) {
    assert.match(src, /\.slice\(0, TRAY_VISIBLE\)/, file);
    assert.match(src, /full=\{fullArt\(\)\}/, file);
    assert.doesNotMatch(src, /alt="" (card=\{row\(\)\} )?full \/>/, file);
    assert.match(src, /<For each=\{shown\(\)\}/, file);
  }
});

test('Chrome mounts Desktop on the left, opposite the cart', () => {
  assert.match(chrome, /import\('\.\/DesktopDrop\.jsx'\)/);
  assert.match(chrome, /navPop\(\) === 'desktop'/);
  const brandAt = chrome.indexOf('class="brand"');
  const desktopAt = chrome.indexOf('class="desktop-anchor"');
  const searchAt = chrome.indexOf('<SearchBox');
  const iconNavAt = chrome.indexOf('class="nav icon-nav"');
  const cartAt = chrome.indexOf('class="cart-anchor"');
  assert.ok(brandAt > 0 && desktopAt > brandAt && searchAt > desktopAt);
  assert.ok(iconNavAt > searchAt && cartAt > iconNavAt);
  assert.match(drop, /Clear desktop/);
  assert.match(drop, /Add to cart/);
  assert.match(drop, /Export PDF/);
  assert.match(drop, /downloadDesktopHoldPdf/);
  assert.match(drop, /desktop-drop-x/);
  assert.match(drop, /QtyStepper/);
  assert.match(drop, /setDesktopQty/);
  assert.match(cart, /QtyStepper/);
  assert.match(drop, /Draw the shape of your next collection/);
  assert.doesNotMatch(drop, /Drop cards you are unsure about/);
  assert.doesNotMatch(drop, /downloadDesktopHoldCsv/);
  // The drop rules are shared (market/src/desktop-drop-add.js).
  assert.match(drop, /addDesktopDrop/);
});

test('Chrome defers Cart/Desktop mount so title/set/artist HTML5 drag is not aborted', () => {
  assert.match(chrome, /addEventListener\('pokoin-card-drag', openDragTrays\)/);
  const opener = chrome.slice(chrome.indexOf('function openDragTrays'));
  const rAFAt = opener.indexOf('requestAnimationFrame');
  const setCardAt = opener.indexOf('setCardDrag(true)');
  assert.ok(rAFAt > 0 && setCardAt > rAFAt);
});
