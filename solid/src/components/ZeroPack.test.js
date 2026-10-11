import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pack = fs.readFileSync(new URL('./ZeroPack.jsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../pages/CardTraderZero.jsx', import.meta.url), 'utf8');

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
