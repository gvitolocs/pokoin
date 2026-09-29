import assert from 'node:assert/strict';
import test from 'node:test';
import { brandTarget } from './pokoin-brand.js';

test('brand paths map under /market/, others pass through', () => {
  assert.equal(brandTarget('https://pokoin.com/brand/flex/flex-hero.svg').toString(), 'https://pokoin.com/market/brand/flex/flex-hero.svg');
  assert.equal(brandTarget('https://pokoin.com/brand/pokoin-logo.svg?v=2').toString(), 'https://pokoin.com/market/brand/pokoin-logo.svg?v=2');
  assert.equal(brandTarget('https://pokoin.com/market/brand/x.svg'), null);
  assert.equal(brandTarget('https://pokoin.com/marketplace'), null);
});
