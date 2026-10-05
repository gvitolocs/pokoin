import assert from 'node:assert/strict';
import test from 'node:test';
import {
  absoluteUrl,
  buildCardOgPayload,
  isLinkPreviewBot,
  isSearchEngineBot,
  parseCardPath,
  renderCardOgHtml,
} from './marketplace-card-og.js';

test('detects Discord and other link-preview bots', () => {
  assert.equal(isLinkPreviewBot('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), true);
  assert.equal(isLinkPreviewBot('Twitterbot/1.0'), true);
  assert.equal(isLinkPreviewBot('Mozilla/5.0'), false);
  assert.equal(isLinkPreviewBot('Mozilla/5.0', true), true);
  assert.equal(isSearchEngineBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isSearchEngineBot('Mozilla/5.0 (compatible; Discordbot/2.0)'), false);
});

test('parses marketplace card paths', () => {
  assert.deepEqual(
    parseCardPath('/marketplace/en/cards/248768/card-drifloon-lv-17-non-holo-promo-6-17-pop-series-6'),
    { language: 'en', cardId: '248768', game: '' },
  );
  assert.deepEqual(parseCardPath('/marketplace/en/cards/248768'), { language: 'en', cardId: '248768', game: '' });
  assert.deepEqual(
    parseCardPath('/marketplace/en/cards/999806370/card-zinnia-s-trust-ultra-rare-102-076-storm-emeralda'),
    { language: 'en', cardId: '806370', game: '' },
  );
  assert.deepEqual(
    parseCardPath('/one-piece/marketplace/en/cards/818358/luffy'),
    { language: 'en', cardId: '818358', game: 'one_piece' },
  );
  assert.deepEqual(
    parseCardPath('/weiss-schwarz/marketplace/en/cards/200124708/sr-pxr-s94-t44s-toy-story-30th-anniversary'),
    { language: 'en', cardId: '200124708', game: 'weiss_schwarz' },
  );
  assert.equal(parseCardPath('/marketplace'), null);
});

test('other TCG card HTML keeps the game scan in og:image and img', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'SR PXR/S94-T44S Toy Story 30th Anniversary',
        imageUrl: '/card-images/weiss-schwarz/100062354_card.jpg',
        canonicalPath: '/weiss-schwarz/marketplace/en/cards/200124708/sr-pxr-s94-t44s-toy-story-30th-anniversary',
      },
      card: { id: '200124708', name: 'Toy Story' },
    },
    { cardId: '200124708', language: 'en' },
  );
  assert.equal(payload.image, 'https://pokoin.com/card-images/weiss-schwarz/100062354_card.jpg');
  const html = renderCardOgHtml(payload);
  assert.match(html, /property="og:image" content="https:\/\/pokoin\.com\/card-images\/weiss-schwarz\/100062354_card\.jpg"/);
  assert.match(html, /<img src="https:\/\/pokoin\.com\/card-images\/weiss-schwarz\/100062354_card\.jpg"/);
});

test('builds absolute image and HTML with og tags', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Drifloon Lv.17 · POP Series 6',
        description: 'Drifloon Lv.17 · Non-Holo Promo',
        imageUrl: '/card-images/248768_drifloon-lv-17.jpg?v=br4',
        canonicalPath: '/marketplace/en/cards/248768/card-drifloon',
      },
      card: { name: 'Drifloon Lv.17' },
    },
    { cardId: '248768', language: 'en' },
  );
  assert.equal(payload.image, 'https://pokoin.com/card-images/124384_drifloon-lv-17.jpg?v=br4');
  assert.equal(payload.description, '');
  assert.equal(absoluteUrl('https://cdn.pokoin.com/x.jpg'), 'https://cdn.pokoin.com/x.jpg');
  const html = renderCardOgHtml(payload);
  assert.match(html, /property="og:title" content="Drifloon Lv\.17 · POP Series 6"/);
  assert.match(html, /property="og:image" content="https:\/\/pokoin\.com\/card-images\/124384_drifloon-lv-17\.jpg\?v=br4"/);
  assert.match(html, /property="og:image:type" content="image\/jpeg"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.equal(html.includes('name="description"'), false);
  assert.equal(html.includes('property="og:description"'), false);
  assert.equal(html.includes('name="twitter:description"'), false);
  assert.equal(html.includes('Drifloon Lv.17 · Non-Holo Promo'), false);
  assert.equal(html.includes('http-equiv="refresh"'), false);
});

test('search-engine card HTML keeps description, Product JSON-LD, and crawlable links', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Charizard Base Set 4/102 Price & Cards for Sale | Pokoin',
        description: 'Charizard · 4/102 · Base Set',
        canonicalPath: '/marketplace/en/cards/239000/charizard',
      },
      card: { id: '239000', name: 'Charizard', set: 'Base Set', number: '4/102', artist: 'Mitsuhiro Arita' },
      neighbors: { prev: [{ id: '238998', name: 'Venusaur' }], next: [{ id: '239002', name: 'Clefairy' }] },
    },
    { cardId: '239000', language: 'en', includeDescription: true },
  );
  assert.match(payload.description, /Charizard/);
  const html = renderCardOgHtml(payload);
  assert.match(html, /<h1>Charizard<\/h1>/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /href="\/marketplace\/sets\/base-set"/);
  assert.match(html, /Venusaur/);
});

test('card HTML carries the dated price snapshot and Pokoin attribution', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Charizard Base Set 4/102 Price & Cards for Sale | Pokoin',
        canonicalPath: '/marketplace/en/cards/239000/charizard',
      },
      card: { id: '239000', name: 'Charizard', set: 'Base Set', number: '4/102' },
      cheapest: [{ pricePkn: 2642 }],
    },
    { cardId: '239000', language: 'en' },
  );
  assert.match(payload.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);
  const html = renderCardOgHtml(payload);
  assert.match(html, /Market reference 2642 PKN · price snapshot \d{4}-\d{2}-\d{2}/);
  assert.match(html, /not a Pokoin offer/);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(jsonLd['@type'], 'Product');
  assert.equal(jsonLd.dateModified, payload.snapshotDate);
  assert.equal(jsonLd.offers, undefined);
  assert.equal(html.includes('InStock'), false);
  const bare = renderCardOgHtml(
    buildCardOgPayload({ card: { name: 'Drifloon' } }, { cardId: '248768', language: 'en' }),
  );
  assert.match(bare, /No Pokoin listing is currently for sale/);
  assert.equal(bare.includes('InStock'), false);
});

test('search HTML AggregateOffer uses only active Pokoin listings in the pinned currency', () => {
  const payload = buildCardOgPayload(
    {
      seo: { canonicalPath: '/marketplace/en/cards/239000/card-charizard-4-102-base-set' },
      card: {
        id: '239000',
        name: 'Charizard',
        set: 'Base Set',
        number: '4/102',
        heroImageUrl: 'https://cdn.pokoin.com/cards/239000.jpg',
      },
      offers: [
        {
          id: 'lst-a',
          sellerUid: 'seller-a',
          sellerName: 'Seller A',
          condition: 'NM',
          pricePkn: 64000,
          quantityAvailable: 1,
          status: 'active',
          cardImageUrl: 'https://cdn.pokoin.com/cards/239000.jpg',
        },
        {
          id: 'lst-sold',
          sellerUid: 'seller-b',
          sellerName: 'Seller B',
          condition: 'LP',
          pricePkn: 1000,
          quantityAvailable: 0,
          status: 'sold_out',
          cardImageUrl: 'https://cdn.pokoin.com/cards/239000.jpg',
        },
      ],
    },
    { cardId: '239000', language: 'en', includeDescription: true },
  );
  payload.currency = 'EUR';
  payload.indexable = true;
  const html = renderCardOgHtml(payload);
  assert.match(html, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/en\/cards\/239000\/card-charizard-4-102-base-set"/);
  assert.match(html, /name="robots" content="index, follow"/);
  assert.match(html, /1 Pokoin listing from 320.00 EUR/);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(jsonLd.offers['@type'], 'AggregateOffer');
  assert.equal(jsonLd.offers.lowPrice, '320.00');
  assert.equal(jsonLd.offers.highPrice, '320.00');
  assert.equal(jsonLd.offers.offerCount, 1);
  assert.equal(jsonLd.offers.priceCurrency, 'EUR');
  assert.equal(jsonLd.offers.availability, 'https://schema.org/InStock');
});
