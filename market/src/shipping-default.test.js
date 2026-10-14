import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultShippingService, shippingServiceOptions } from './shipping-quote.js';

test('a few cards default to the untracked letter, big parcels to tracked', () => {
  const one = shippingServiceOptions({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1 });
  assert.equal(defaultShippingService(one), 'untracked');
  const twenty = shippingServiceOptions({ fromCountry: 'IT', toCountry: 'DK', cardCount: 20 });
  assert.equal(defaultShippingService(twenty), 'untracked');
  const many = shippingServiceOptions({ fromCountry: 'IT', toCountry: 'DK', cardCount: 60 });
  assert.equal(defaultShippingService(many), 'tracked');
  // Only a tracked rate (or nothing selectable) → first selectable / tracked.
  assert.equal(defaultShippingService([{ id: 'tracked', packageTier: 'SMALL' }]), 'tracked');
  assert.equal(defaultShippingService([]), 'tracked');
});
