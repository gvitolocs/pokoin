import assert from 'node:assert/strict';
import test from 'node:test';
import { listingSelectId, marqueeBlocked, marqueeRect, rectsIntersect } from './shop-marquee.js';

test('a press on empty space can start a selection box; a row cannot', () => {
  const row = { closest: (sel) => (String(sel).includes('.shop-row') ? row : null) };
  const empty = { closest: () => null };
  assert.equal(marqueeBlocked(row), true);
  assert.equal(marqueeBlocked(empty), false);

  const rect = marqueeRect(10, 30, 4, 8);
  assert.deepEqual(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    { left: 4, top: 8, width: 6, height: 22 },
  );
  assert.equal(rectsIntersect(rect, { left: 0, top: 0, right: 5, bottom: 10 }), true);
  assert.equal(rectsIntersect(rect, { left: 20, top: 0, right: 30, bottom: 10 }), false);
  assert.equal(listingSelectId({ id: 'lst-1' }), 'lst-1');
});
