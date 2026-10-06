import assert from 'node:assert/strict';
import test from 'node:test';
import {
  absoluteUrl,
  buildCardOgPayload,
  cardOgImageUrl,
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
  assert.equal(payload.image, 'https://cdn.pokoin.com/weiss-schwarz/100062354_card.jpg');
  const html = renderCardOgHtml(payload);
  assert.match(html, /property="og:image" content="https:\/\/cdn\.pokoin\.com\/weiss-schwarz\/100062354_card\.jpg"/);
  assert.match(html, /<img src="https:\/\/cdn\.pokoin\.com\/weiss-schwarz\/100062354_card\.jpg"/);
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
  assert.equal(payload.image, 'https://cdn.pokoin.com/124384_drifloon-lv-17.jpg?v=br4');
  assert.equal(
    cardOgImageUrl('https://pokoin.com/card-images/342436_charizard-001-025-25th-anniversary-edition.jpg', '342436'),
    'https://cdn.pokoin.com/171218_charizard-001-025-25th-anniversary-edition.jpg',
  );
  assert.equal(payload.description, '');
  assert.equal(absoluteUrl('https://cdn.pokoin.com/x.jpg'), 'https://cdn.pokoin.com/x.jpg');
  const html = renderCardOgHtml(payload);
  assert.match(html, /property="og:title" content="Drifloon Lv\.17 · POP Series 6"/);
  assert.match(html, /property="og:image" content="https:\/\/cdn\.pokoin\.com\/124384_drifloon-lv-17\.jpg\?v=br4"/);
  assert.match(html, /property="og:image:type" content="image\/jpeg"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.equal(html.includes('name="description"'), false);
  assert.equal(html.includes('property="og:description"'), false);
  assert.equal(html.includes('name="twitter:description"'), false);
  assert.equal(html.includes('Drifloon Lv.17 · Non-Holo Promo'), false);
  assert.equal(html.includes('http-equiv="refresh"'), false);
});

test('search-engine card HTML keeps description, ItemPage JSON-LD, and crawlable links', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Charizard Base Set 4/102 Price & Cards for Sale | Pokoin',
        description: 'Charizard · 4/102 · Base Set',
        canonicalPath: '/marketplace/en/cards/239000/charizard',
        imageUrl: '/card-images/119500_charizard.jpg',
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
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(jsonLd['@type'], 'ItemPage');
  assert.equal(jsonLd.offers, undefined);
  assert.match(html, /href="\/marketplace\/sets\/base-set"/);
  assert.match(html, /property="og:image" content="https:\/\/cdn\.pokoin\.com\/119500_charizard\.jpg"/);
  assert.ok(html.indexOf('<img ') < html.indexOf('Venusaur'));
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
  const eurHtml = renderCardOgHtml({ ...payload, currency: 'EUR' });
  assert.match(eurHtml, /Out of stock · minimum 13.21 EUR/);
  const eurLd = JSON.parse(eurHtml.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(eurLd.offers.availability, 'https://schema.org/OutOfStock');
  assert.equal(eurLd.offers.price, '13.21');
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(jsonLd['@type'], 'Product');
  assert.equal(jsonLd.dateModified, payload.snapshotDate);
  assert.equal(jsonLd.offers.availability, 'https://schema.org/OutOfStock');
  assert.equal(jsonLd.offers.priceCurrency, 'EUR');
  assert.equal(jsonLd.offers.price, '13.21');
  assert.equal(jsonLd.offers.url, jsonLd.url);
  assert.equal(html.includes('>In stock'), false);
  const bare = renderCardOgHtml(
    buildCardOgPayload({ card: { name: 'Drifloon' } }, { cardId: '248768', language: 'en' }),
  );
  assert.match(bare, /No Pokoin listing is currently for sale/);
  assert.equal(bare.includes('InStock'), false);
  assert.equal(bare.includes('pokoin-512.png'), false);
  assert.equal(bare.includes('og:image'), false);
  assert.equal(bare.includes('<img '), false);
  assert.equal(cardOgImageUrl('', '248768'), '');
  assert.equal(cardOgImageUrl('https://pokoin.com/pokoin-512.png', '248768'), '');
  const bareLd = JSON.parse(bare.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(bareLd['@type'], 'ItemPage');
  assert.equal(bareLd.offers, undefined);
  assert.equal(bareLd.review, undefined);
  assert.equal(bareLd.aggregateRating, undefined);
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
  assert.match(html, /name="robots" content="index, follow, max-image-preview:large"/);
  assert.match(html, /1 Pokoin listing from 320.00 EUR/);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(jsonLd.offers['@type'], 'AggregateOffer');
  assert.equal(jsonLd.offers.lowPrice, '320.00');
  assert.equal(jsonLd.offers.highPrice, '320.00');
  assert.equal(jsonLd.offers.offerCount, 1);
  assert.equal(jsonLd.offers.priceCurrency, 'EUR');
  assert.equal(jsonLd.offers.availability, 'https://schema.org/InStock');
  assert.equal(jsonLd.offers.url, jsonLd.url);
  assert.equal(jsonLd.brand.name, 'Pokémon TCG');
});

test('a catalog-only non-Pokémon card is an ItemPage on the game URL', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Tony Tony.Chopper',
        description: 'Tony Tony.Chopper · Alternate Art · OP08-007a · Two Legends',
        canonicalPath: '/marketplace/en/cards/598560/alternate-art-tony-tony-chopper-op08-007a-op-08-two-legends',
        imageUrl: 'https://cdn.pokoin.com/one-piece/chopper.jpg',
      },
      card: {
        id: '598560',
        name: 'Tony Tony.Chopper',
        set: 'Two Legends',
        number: 'OP08-007a',
      },
      offers: [],
    },
    { cardId: '598560', language: 'en', includeDescription: true, game: 'one_piece' },
  );
  payload.currency = 'EUR';
  payload.indexable = true;
  const html = renderCardOgHtml(payload);
  const canonical = 'https://pokoin.com/one-piece/marketplace/en/cards/598560/alternate-art-tony-tony-chopper-op08-007a-op-08-two-legends';
  assert.match(html, new RegExp(`rel="canonical" href="${canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, new RegExp(`property="og:url" content="${canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, /href="\/one-piece\/marketplace"/);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(jsonLd['@type'], 'ItemPage');
  assert.equal(jsonLd.url, canonical);
  assert.equal(jsonLd.name, 'Tony Tony.Chopper');
  assert.equal(jsonLd.image, 'https://cdn.pokoin.com/one-piece/chopper.jpg');
  assert.equal(jsonLd.offers, undefined);
  assert.equal(jsonLd.review, undefined);
  assert.equal(jsonLd.aggregateRating, undefined);
  assert.equal(JSON.stringify(jsonLd).includes('"Product"'), false);
  const listed = renderCardOgHtml({
    ...payload,
    currency: 'EUR',
    offers: [{
      id: 'lst-op',
      sellerUid: 'seller-a',
      sellerName: 'Seller A',
      condition: 'NM',
      pricePkn: 2000,
      quantityAvailable: 1,
      status: 'active',
      cardImageUrl: 'https://cdn.pokoin.com/one-piece/chopper.jpg',
    }],
  });
  const listedLd = JSON.parse(listed.match(/<script type="application\/ld\+json">([^]+?)<\/script>/)[1]);
  assert.equal(listedLd['@type'], 'Product');
  assert.equal(listedLd.brand.name, 'One Piece');
  assert.equal(listedLd.url, canonical);
  assert.equal(listedLd.offers.lowPrice, '10.00');
  assert.equal(listedLd.offers.priceCurrency, 'EUR');
  assert.equal(listedLd.offers.availability, 'https://schema.org/InStock');
  assert.equal(listedLd.offers.url, canonical);
});
