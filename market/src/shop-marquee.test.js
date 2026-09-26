import assert from 'node:assert/strict';
import test from 'node:test';
import { listingSelectId, marqueeBlocked, marqueeRect, rectsIntersect, shopDragOffers } from './shop-marquee.js';

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
