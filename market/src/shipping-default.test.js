import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultShippingService, shippingServiceOptions } from './shipping-quote.js';

const root = path.dirname(fileURLToPath(import.meta.url));

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

test('checkout keeps the buyer\'s own pick over the default', () => {
  const src = fs.readFileSync(path.join(root, 'pages/Checkout.jsx'), 'utf8');
  assert.match(src, /if \(!shippingPicked \|\| !selectable\.some/);
  assert.match(src, /setShippingPicked\(true\);\s*setShippingService\(option\.id\);/);
});
