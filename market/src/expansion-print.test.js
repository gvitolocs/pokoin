import assert from 'node:assert/strict';
import test from 'node:test';
import { printFlagFromNationality } from './locale.js';
import { pinnedExpansionNationality, resolveExpansionNationality } from './expansion-print.js';

test('unknown 30th and Mega sets take the Japanese print flag', () => {
  for (const row of [
    { name: '30th Celebration Premium Deck Set', slug: '30th-celebration-premium-deck-set', nationality: 'unknown' },
    { slug: 'aura-seeker', nationality: '' },
    { name: 'MEGA x MEGA Parade', nationality: 'unknown' },
  ]) {
    assert.equal(resolveExpansionNationality(row), 'japanese');
    assert.equal(printFlagFromNationality(resolveExpansionNationality(row)).code, 'jpko');
  }
});

test('CSV9.5 Master Ball Reverse takes the Chinese print flag', () => {
  const row = { name: 'CSV9.5: Master Ball Reverse', nationality: 'unknown' };
  assert.equal(pinnedExpansionNationality(row), 'chinese');
  assert.equal(printFlagFromNationality(resolveExpansionNationality(row)).code, 'zh');
});

test('a known nationality and product buckets are left alone', () => {
  assert.equal(
    resolveExpansionNationality({ name: '30th Celebration', nationality: 'western' }),
    'western',
  );
  assert.equal(
    resolveExpansionNationality({ name: 'Mega Evolution Products', slug: 'mega-evolution-products', nationality: 'product' }),
    'product',
  );
  assert.equal(printFlagFromNationality('product'), null);
});
