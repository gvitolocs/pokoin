import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findShippingRate,
  packageTierForCount,
  pknFromEurCents,
  previewShipmentCents,
  shippingServiceOptions,
} from './shipping-quote.js';

test('Italy to Denmark one-card SMALL tracked quotes the live rate table', () => {
  assert.equal(packageTierForCount(1), 'SMALL');
  const rate = findShippingRate({
    fromCountry: 'IT',
    toCountry: 'DK',
    packageTier: 'SMALL',
    tracked: true,
  });
  assert.equal(rate.id, 'it-dk-small');
  assert.ok(rate.priceEURCents > 0);
  assert.equal(
    previewShipmentCents({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1, tracked: true }),
    rate.priceEURCents,
  );
  assert.equal(pknFromEurCents(rate.priceEURCents), Math.round((rate.priceEURCents / 100) / 0.005));
});

test('Italy to Denmark offers tracked, untracked, and unavailable Pokoin Flex', () => {
  const options = shippingServiceOptions({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1 });
  assert.equal(options.length, 3);
  assert.equal(options[0].id, 'tracked');
  assert.ok(options[0].amountCents > 0);
  assert.equal(options[1].id, 'untracked');
  assert.ok(options[1].amountCents <= options[0].amountCents);
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

test('60 cards stay LARGE letter rates, not the Flex bag EXTRA_LARGE', () => {
  assert.equal(packageTierForCount(60), 'LARGE');
  const alone = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'LARGE', tracked: true });
  const bag = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'EXTRA_LARGE', tracked: true });
  assert.ok(alone.priceEURCents < bag.priceEURCents);
  assert.ok(/inpost/i.test(alone.carrier));
});
