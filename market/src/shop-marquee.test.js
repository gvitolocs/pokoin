import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  clearShopSelectionOnPointer,
  listingSelectId,
  marqueeBlocked,
  marqueeRect,
  marqueeStartAllowed,
  rectsIntersect,
  shopDragOffers,
} from './shop-marquee.js';

test('a rubber band starts on the card scan, not on a button', () => {
  const control = { closest: (sel) => (String(sel).includes('button') ? control : null) };
  const scan = { closest: (sel) => (String(sel).includes('.shop-art') ? scan : null) };
  const body = { closest: () => null };
  assert.equal(marqueeBlocked(control), true);
  assert.equal(marqueeBlocked(scan), false);
  assert.equal(marqueeBlocked(body), false);
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const selected = new Set(['a', 'c']);
  assert.deepEqual(shopDragOffers(rows, selected, rows[0]).map((row) => row.id), ['a', 'c']);
  assert.deepEqual(shopDragOffers(rows, selected, rows[2]).map((row) => row.id), ['c', 'a']);
  assert.equal(shopDragOffers(rows, new Set(['a']), rows[0]), null);

  const rect = marqueeRect(10, 30, 4, 8);
  assert.deepEqual(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    { left: 4, top: 8, width: 6, height: 22 },
  );
  assert.equal(rectsIntersect(rect, { left: 0, top: 0, right: 5, bottom: 10 }), true);
  assert.equal(rectsIntersect(rect, { left: 20, top: 0, right: 30, bottom: 10 }), false);
  assert.equal(listingSelectId({ id: 'lst-1' }), 'lst-1');
});

test('empty page background may start a shop marquee; art-frame and tiles may not', () => {
  function mock(hits) {
    return {
      closest: (sel) => {
        const parts = String(sel).split(',').map((part) => part.trim());
        return parts.some((part) => hits.includes(part)) ? mock(hits) : null;
      },
    };
  }
  const bg = mock(['main']);
  const art = mock(['.art-frame', 'main']);
  const tile = mock(['[data-card-id]', 'main']);
  const shop = mock(['.shop-row']);
  const species = mock(['.species-drag', 'header', 'main']);
  const setLink = mock(['a', '.asset-sub', 'header', 'main']);
  assert.equal(marqueeStartAllowed(bg), true);
  assert.equal(marqueeStartAllowed(art), false);
  assert.equal(marqueeStartAllowed(tile), false);
  assert.equal(marqueeStartAllowed(shop), true);
  assert.equal(marqueeStartAllowed(species), false);
  assert.equal(marqueeStartAllowed(setLink), false);
});

test('ShopList listens on main so a band from empty background can hit listings', () => {
  const src = readFileSync(new URL('./components/ShopList.jsx', import.meta.url), 'utf8');
  assert.match(src, /closest\('main'\)/);
  assert.match(src, /marqueeStartAllowed/);
  assert.match(
    readFileSync(new URL('./components/CardSelectGrid.jsx', import.meta.url), 'utf8'),
    /\.shop-panel/,
  );
});

test('a plain pointer outside selected shop rows clears the selection', () => {
  const selected = new Set(['a', 'b']);
  const selectedRow = { dataset: { listingId: 'a' } };
  const otherRow = { dataset: { listingId: 'c' } };
  const list = { contains: (row) => row === selectedRow || row === otherRow };
  const target = (row) => ({ closest: () => row });

  assert.equal(clearShopSelectionOnPointer(target(selectedRow), list, selected), false);
  assert.equal(clearShopSelectionOnPointer(target(otherRow), list, selected), true);
  assert.equal(clearShopSelectionOnPointer({ closest: () => null }, list, selected), true);
  assert.equal(
    clearShopSelectionOnPointer(target(otherRow), list, selected, { ctrlKey: true }),
    false,
  );
});
