import assert from 'node:assert/strict';
import test from 'node:test';
import { brandSrc } from './brand-assets.js';

// The no-hard-coded-/brand/ scan of the pages is solid/src/brand-paths.test.js.

test('brand assets resolve under the build base', () => {
  assert.equal(brandSrc('flex/flex-hero.svg'), '/brand/flex/flex-hero.svg');
  assert.equal(brandSrc('/protection/shield.svg'), '/brand/protection/shield.svg');
});
