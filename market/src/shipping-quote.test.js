import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findShippingRate,
  packageTierForCount,
  pknFromEurCents,
  previewShipmentCents,
  shippingServiceOptions,
} from './shipping-quote.js';

test('Italy to Denmark one-card SMALL tracked is 650 EUR cents', () => {
  assert.equal(packageTierForCount(1), 'SMALL');
  const rate = findShippingRate({
    fromCountry: 'IT',
    toCountry: 'DK',
    packageTier: 'SMALL',
    tracked: true,
  });
  assert.equal(rate.id, 'it-dk-small');
  assert.equal(rate.priceEURCents, 650);
  assert.equal(previewShipmentCents({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1, tracked: true }), 650);
  assert.equal(pknFromEurCents(650), 1300);
});

test('Italy to Denmark offers tracked, cheaper untracked, and unavailable Pokoin Flex', () => {
  const options = shippingServiceOptions({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1 });
  assert.equal(options.length, 3);
  assert.equal(options[0].id, 'tracked');
  assert.equal(options[0].amountCents, 650);
  assert.equal(options[1].id, 'untracked');
  assert.ok(options[1].amountCents < options[0].amountCents);
  assert.equal(options[2].id, 'pokoin_flex');
  assert.equal(options[2].unavailable, true);
  assert.equal(options[2].href, '/flex');
  assert.equal(
    previewShipmentCents({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1, tracked: false }),
    options[1].amountCents,
  );
});

test('missing route returns null for preview', () => {
  assert.equal(previewShipmentCents({ fromCountry: 'FR', toCountry: 'PT', cardCount: 1 }), null);
});
