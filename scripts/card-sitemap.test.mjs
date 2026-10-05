import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkCardPaths,
  crawlableCardImage,
  existingCardSitemapNames,
  gameCardPath,
  renderShoppingFeed,
  renderUrlSet,
  shoppingFeedFileName,
} from './card-sitemap.mjs';

test('card sitemaps keep canonical desks and drop currency duplicates', () => {
  const chunks = chunkCardPaths([
    '/marketplace/en/cards/239000/card-charizard-4-102-base-set',
    'https://pokoin.com/marketplace/en/cards/239000/card-charizard-4-102-base-set?currency=EUR',
    '/marketplace/en/cards/239000/card-charizard-4-102-base-set?currency=DKK',
    '/marketplace/search?q=charizard',
    '/marketplace/da/cards/18/card-pikachu',
    '/magic/marketplace/en/cards/404750/mythic-angel',
  ], 2);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], [
    '/marketplace/en/cards/239000/card-charizard-4-102-base-set',
    '/marketplace/da/cards/18/card-pikachu',
  ]);
  assert.deepEqual(chunks[1], ['/magic/marketplace/en/cards/404750/mythic-angel']);
  assert.equal(gameCardPath('/marketplace/en/cards/12/card-luffy', 'one-piece'), '/one-piece/marketplace/en/cards/12/card-luffy');
  const xml = renderUrlSet(chunks[0]);
  assert.equal(xml.includes('currency='), false);
  assert.match(xml, /pokoin.com\/marketplace\/en\/cards\/239000\/card-charizard-4-102-base-set</);
  const withImage = renderUrlSet(chunkCardPaths([
    { path: '/marketplace/en/cards/342436/card-charizard', image: 'https://pokoin.com/card-images/171218_charizard.jpg' },
  ])[0]);
  assert.match(withImage, /xmlns:image="http:\/\/www.google.com\/schemas\/sitemap-image\/1.1"/);
  assert.match(withImage, /<image:loc>https:\/\/cdn.pokoin.com\/171218_charizard.jpg<\/image:loc>/);
  assert.equal(crawlableCardImage('https://pokoin.com/card-images/magic/1.jpg'), 'https://cdn.pokoin.com/magic/1.jpg');
  const feed = renderShoppingFeed([{
    id: 'pokemon-342436-EUR',
    title: 'Charizard 001/025',
    description: 'Out of stock · minimum 250.54 EUR',
    link: 'https://pokoin.com/marketplace/en/cards/342436/card-charizard?currency=EUR',
    image: 'https://cdn.pokoin.com/charizard.jpg',
    availability: 'out_of_stock',
    price: '250.54',
    currency: 'EUR',
    brand: 'Pokémon',
    condition: 'used',
  }]);
  assert.match(feed, /<g:availability>out_of_stock<\/g:availability>/);
  assert.match(feed, /<g:price>250.54 EUR<\/g:price>/);
  assert.match(feed, /identifier_exists>no</);
  assert.equal(shoppingFeedFileName('EUR', 0), 'google-shopping-eur-001.xml');
  assert.deepEqual(existingCardSitemapNames(['sitemap.xml', 'sitemap-cards-002.xml', 'sitemap-cards-001.xml']), [
    'sitemap-cards-001.xml',
    'sitemap-cards-002.xml',
  ]);
});
