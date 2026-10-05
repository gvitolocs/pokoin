import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pickingOrdersMatch } from './zero-pick.js';

const page = readFileSync(new URL('./pages/CardTraderZero.jsx', import.meta.url), 'utf8');
const pack = readFileSync(new URL('./zero-pack.jsx', import.meta.url), 'utf8');

test('the current pack is two rows: Pick, then Picked', () => {
  assert.match(pack, /title="Pick"/);
  assert.match(pack, /title="Picked"/);
  assert.match(pack, /draggable/);
  assert.match(pack, /onDropTo=\{\(itemId\) => move\(itemId, true\)\}/);
  assert.match(pack, /Your location order matches the Power Tools position order/);
  assert.match(page, /location box, then stock number from smaller to bigger/);
  assert.match(page, /<ShipmentPanel/);
  assert.match(page, /onSession=\{load\}/);
});

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
