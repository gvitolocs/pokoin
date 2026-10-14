import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('seller country selects use long names, not bare ISO codes', () => {
  for (const rel of ['./SellerShippingSettings.jsx', '../desk/ShipFromCountryGate.jsx']) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /shipFromCountryOptionLabel/, rel);
    assert.match(src, /SHIP_FROM_COUNTRIES/, rel);
    assert.equal(src.includes('>{code}</option>'), false, rel);
  }
});
