import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findShippingRate,
  packageTierForCount,
  pknFromEurCents,
  previewShipmentCents,
} from './shipping-quote.js';

test('Italy to Denmark one-card SMALL is the seeded minimum', () => {
  assert.equal(packageTierForCount(1), 'SMALL');
  const rate = findShippingRate({ fromCountry: 'IT', toCountry: 'DK', packageTier: 'SMALL' });
  assert.equal(rate.id, 'it-dk-small');
  assert.equal(rate.priceEURCents, 650);
  assert.equal(previewShipmentCents({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1 }), 650);
  assert.equal(pknFromEurCents(650), 1300);
});

test('missing route returns null for preview', () => {
  assert.equal(previewShipmentCents({ fromCountry: 'FR', toCountry: 'PT', cardCount: 1 }), null);
});
