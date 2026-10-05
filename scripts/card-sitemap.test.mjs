import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkCardPaths, existingCardSitemapNames, renderUrlSet } from './card-sitemap.mjs';

test('card sitemaps keep canonical desks and drop currency duplicates', () => {
  const chunks = chunkCardPaths([
    '/marketplace/en/cards/239000/card-charizard-4-102-base-set',
    'https://pokoin.com/marketplace/en/cards/239000/card-charizard-4-102-base-set?currency=EUR',
    '/marketplace/en/cards/239000/card-charizard-4-102-base-set?currency=DKK',
    '/marketplace/search?q=charizard',
    '/marketplace/da/cards/18/card-pikachu',
  ], 2);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], [
    '/marketplace/en/cards/239000/card-charizard-4-102-base-set',
    '/marketplace/da/cards/18/card-pikachu',
  ]);
  const xml = renderUrlSet(chunks[0]);
  assert.equal(xml.includes('currency='), false);
  assert.match(xml, /pokoin.com\/marketplace\/en\/cards\/239000\/card-charizard-4-102-base-set</);
  assert.deepEqual(existingCardSitemapNames(['sitemap.xml', 'sitemap-cards-002.xml', 'sitemap-cards-001.xml']), [
    'sitemap-cards-001.xml',
    'sitemap-cards-002.xml',
  ]);
});
