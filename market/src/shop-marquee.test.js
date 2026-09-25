import assert from 'node:assert/strict';
import test from 'node:test';
import { listingSelectId, marqueeBlocked, marqueeRect, rectsIntersect } from './shop-marquee.js';

test('a rubber band starts on the row body, not on a link or the card scan', () => {
  const control = { closest: (sel) => (String(sel).includes('button') || String(sel).includes('.shop-art') ? control : null) };
  const body = { closest: () => null };
  assert.equal(marqueeBlocked(control), true);
  assert.equal(marqueeBlocked(body), false);

  const rect = marqueeRect(10, 30, 4, 8);
  assert.deepEqual(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    { left: 4, top: 8, width: 6, height: 22 },
  );
  assert.equal(rectsIntersect(rect, { left: 0, top: 0, right: 5, bottom: 10 }), true);
  assert.equal(rectsIntersect(rect, { left: 20, top: 0, right: 30, bottom: 10 }), false);
  assert.equal(listingSelectId({ id: 'lst-1' }), 'lst-1');
});
