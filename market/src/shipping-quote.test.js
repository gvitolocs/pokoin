import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findShippingRate,
  packageTierForCount,
  pknFromEurCents,
  previewShipmentCents,
  shippingServiceOptions,
} from './shipping-quote.js';
import ratesCatalog from './shipping-rates.json' with { type: 'json' };

test('Italy to Denmark one-card SMALL tracked quotes the live rate table', () => {
  assert.equal(packageTierForCount(1), 'SMALL');
  const rate = findShippingRate({
    fromCountry: 'IT',
    toCountry: 'DK',
    packageTier: 'SMALL',
    tracked: true,
  });
  assert.ok(rate);
  assert.ok(rate.priceEURCents > 0);
  assert.equal(
    previewShipmentCents({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1, tracked: true }),
    rate.priceEURCents,
  );
  assert.equal(pknFromEurCents(rate.priceEURCents), Math.round((rate.priceEURCents / 100) / 0.005));
});

test('Italy to Denmark offers tracked, untracked, and unavailable Pokoin Flex', () => {
  const options = shippingServiceOptions({ fromCountry: 'IT', toCountry: 'DK', cardCount: 1 });
  assert.ok(options.length >= 2);
  assert.equal(options[0].id, 'tracked');
  assert.ok(options[0].amountCents > 0);
  const flex = options.find((row) => row.id === 'pokoin_flex');
  assert.ok(flex);
  assert.equal(flex.unavailable, true);
  assert.equal(flex.href, '/flex');
});

test('missing route returns null for preview', () => {
  assert.equal(previewShipmentCents({ fromCountry: 'XX', toCountry: 'YY', cardCount: 1 }), null);
});

test('60 cards stay LARGE letter rates, not the Flex bag EXTRA_LARGE', () => {
  assert.equal(packageTierForCount(60), 'LARGE');
  const alone = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'LARGE', tracked: true });
  const bag = findShippingRate({ fromCountry: 'IT', toCountry: 'IT', packageTier: 'EXTRA_LARGE', tracked: true });
  assert.ok(alone.priceEURCents < bag.priceEURCents);
});

test('catalog was built from live providers', () => {
  assert.ok((ratesCatalog.rates || []).length > 50);
  assert.ok(Array.isArray(ratesCatalog.source?.providers));
  assert.ok(ratesCatalog.source.providers.includes('packzoo'));
});
