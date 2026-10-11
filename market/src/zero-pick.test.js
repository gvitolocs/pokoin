import assert from 'node:assert/strict';
import test from 'node:test';
import { pickingOrdersMatch } from './zero-pick.js';

const line = (itemId, position) => ({ itemId, powerTools: position == null ? null : { position } });

test('a pack matches when location order is the Power Tools position order', () => {
  assert.deepEqual(pickingOrdersMatch([line('a', 1), line('b', 2), line('c', 3)]), {
    comparable: true,
    equal: true,
  });
  assert.equal(pickingOrdersMatch([line('a', 2), line('b', 1)]).equal, false);
  assert.equal(pickingOrdersMatch([line('a', 1), line('b', null)]).comparable, false);
  assert.equal(pickingOrdersMatch([]).comparable, false);
});
