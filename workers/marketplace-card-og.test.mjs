import assert from 'node:assert/strict';
import test from 'node:test';
import {
  absoluteUrl,
  buildCardOgPayload,
  cardCrawlDecision,
  cardOgImageUrl,
  cardPathHasSlug,
  fetchCardPageForOg,
  handleMarketplaceCardOgRequest,
  isLinkPreviewBot,
  isSearchEngineBot,
  parseCardPath,
  parseCardRequest,
  renderCardOgHtml,
} from './marketplace-card-og.js';

const LD_SCRIPT_RE = /<script type="application\/ld\+json">([^]+?)<\/script>/;

/** The Product node: the graph's Product, or the whole payload when no graph. */
function productNode(jsonLd) {
  if (Array.isArray(jsonLd['@graph'])) {
    return jsonLd['@graph'].find((node) => node['@type'] === 'Product');
  }
  return jsonLd;
}

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
  const jsonLd = JSON.parse(html.match(LD_SCRIPT_RE)[1]);
  assert.equal(jsonLd['@type'], 'ItemPage');
  assert.equal(jsonLd.offers, undefined);
  // Catalog-only card: the ItemPage itself carries the primary image.
  assert.equal(jsonLd['@id'], 'https://pokoin.com/marketplace/en/cards/239000/charizard');
  assert.equal(jsonLd.image, 'https://cdn.pokoin.com/119500_charizard.jpg');
  assert.equal(jsonLd.primaryImageOfPage.url, 'https://cdn.pokoin.com/119500_charizard.jpg');
  assert.equal(jsonLd.primaryImageOfPage.contentUrl, jsonLd.image);
  assert.equal(jsonLd.primaryImageOfPage.caption, 'Charizard Base Set 4/102 Pokemon card');
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
  const eurLd = JSON.parse(eurHtml.match(LD_SCRIPT_RE)[1]);
  assert.equal(eurLd.offers.availability, 'https://schema.org/OutOfStock');
  assert.equal(eurLd.offers.price, '13.21');
  const jsonLd = JSON.parse(html.match(LD_SCRIPT_RE)[1]);
  assert.equal(jsonLd['@type'], 'Product');
  assert.equal(jsonLd['@graph'], undefined);
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
  const bareLd = JSON.parse(bare.match(LD_SCRIPT_RE)[1]);
  assert.equal(bareLd['@type'], 'ItemPage');
  assert.equal(bareLd['@graph'], undefined);
  assert.equal(bareLd.primaryImageOfPage, undefined);
  assert.equal(bareLd.offers, undefined);
  assert.equal(bareLd.review, undefined);
  assert.equal(bareLd.aggregateRating, undefined);
});

test('card JSON-LD graph marks the scan as primaryImageOfPage of the WebPage', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Charizard Base Set 4/102 Price & Cards for Sale | Pokoin',
        description: 'Charizard · 4/102 · Base Set',
        canonicalPath: '/marketplace/en/cards/239000/charizard',
        imageUrl: '/card-images/119500_charizard.jpg',
      },
      card: { id: '239000', name: 'Charizard', set: 'Base Set', number: '4/102', artist: 'Mitsuhiro Arita' },
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
      ],
    },
    { cardId: '239000', language: 'en', includeDescription: true },
  );
  payload.currency = 'EUR';
  payload.indexable = true;
  const html = renderCardOgHtml(payload);
  const scripts = html.match(new RegExp(LD_SCRIPT_RE.source, 'g')) || [];
  assert.equal(scripts.length, 1);
  const jsonLd = JSON.parse(html.match(LD_SCRIPT_RE)[1]);
  const canonical = 'https://pokoin.com/marketplace/en/cards/239000/charizard';
  const image = 'https://cdn.pokoin.com/119500_charizard.jpg';
  const caption = 'Charizard Base Set 4/102 Pokemon card';
  assert.equal(jsonLd['@context'], 'https://schema.org');
  assert.equal(jsonLd['@graph'].length, 2);
  const webPage = jsonLd['@graph'].find((node) => node['@type'] === 'WebPage');
  const product = jsonLd['@graph'].find((node) => node['@type'] === 'Product');
  assert.equal(webPage['@id'], canonical);
  assert.equal(webPage.url, canonical);
  assert.equal(webPage.name, payload.title);
  assert.deepEqual(webPage.primaryImageOfPage, {
    '@type': 'ImageObject',
    '@id': image,
    url: image,
    contentUrl: image,
    caption,
  });
  // Same scan everywhere: primaryImageOfPage === og:image === <img src>.
  assert.match(html, new RegExp(`property="og:image" content="${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, new RegExp(`<img src="${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(webPage.primaryImageOfPage.url, html.match(/property="og:image" content="([^"]*)"/)[1]);
  assert.equal(webPage.primaryImageOfPage.caption, html.match(/property="og:image:alt" content="([^"]*)"/)[1]);
  assert.deepEqual(webPage.mainEntity, { '@id': `${canonical}#product` });
  assert.equal(product['@id'], `${canonical}#product`);
  assert.equal(product.mainEntityOfPage['@id'], canonical);
  assert.equal(product['@context'], undefined);
  // Every pre-existing Product field stays on the Product node.
  assert.deepEqual(
    Object.keys(product).sort(),
    ['@id', '@type', 'additionalProperty', 'brand', 'dateModified', 'description', 'image', 'mainEntityOfPage', 'name', 'offers', 'sku', 'url'],
  );
  assert.equal(product.name, 'Charizard');
  assert.equal(product.sku, '239000');
  assert.equal(product.image, image);
  assert.equal(product.brand.name, 'Pokémon TCG');
  assert.equal(product.url, canonical);
  assert.equal(product.dateModified, payload.snapshotDate);
  assert.equal(product.offers['@type'], 'AggregateOffer');
  assert.equal(product.offers.lowPrice, '320.00');
  assert.equal(product.offers.priceCurrency, 'EUR');
  assert.equal(product.offers.url, canonical);
});

test('JSON-LD graph keeps the < escaping with unescaped name and caption strings', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Drifloon <Lv.17> · POP Series 6',
        canonicalPath: '/marketplace/en/cards/248768/card-drifloon',
        imageUrl: '/card-images/124384_drifloon-lv-17.jpg',
      },
      card: { id: '248768', name: 'Drifloon <Lv.17>', set: 'POP Series 6', number: '6/17' },
    },
    { cardId: '248768', language: 'en' },
  );
  const html = renderCardOgHtml(payload);
  const raw = html.match(LD_SCRIPT_RE)[1];
  assert.match(raw, /\\u003c/);
  const jsonLd = JSON.parse(raw);
  assert.equal(jsonLd['@type'], 'ItemPage');
  assert.equal(jsonLd.name, 'Drifloon <Lv.17>');
  assert.equal(jsonLd.primaryImageOfPage.caption, 'Drifloon <Lv.17> POP Series 6 6/17 Pokemon card');
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
  const jsonLd = productNode(JSON.parse(html.match(LD_SCRIPT_RE)[1]));
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
  const jsonLd = JSON.parse(html.match(LD_SCRIPT_RE)[1]);
  assert.equal(jsonLd['@type'], 'ItemPage');
  assert.equal(jsonLd.url, canonical);
  assert.equal(jsonLd.name, 'Tony Tony.Chopper');
  assert.equal(jsonLd.image, 'https://cdn.pokoin.com/one-piece/chopper.jpg');
  assert.equal(jsonLd['@id'], canonical);
  assert.equal(jsonLd.primaryImageOfPage.url, 'https://cdn.pokoin.com/one-piece/chopper.jpg');
  assert.equal(jsonLd.primaryImageOfPage.contentUrl, jsonLd.image);
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
  const listedLd = productNode(JSON.parse(listed.match(LD_SCRIPT_RE)[1]));
  assert.equal(listedLd['@type'], 'Product');
  assert.equal(listedLd.brand.name, 'One Piece');
  assert.equal(listedLd.url, canonical);
  assert.equal(listedLd.offers.lowPrice, '10.00');
  assert.equal(listedLd.offers.priceCurrency, 'EUR');
  assert.equal(listedLd.offers.availability, 'https://schema.org/InStock');
  assert.equal(listedLd.offers.url, canonical);
});

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

test('versions is a panel: canonical is the card, and the path is not a 301', () => {
  assert.equal(parseCardRequest('/marketplace/en/cards/695732/versions')?.versions, true);
  assert.equal(parseCardRequest('/marketplace/en/cards/300646/card-slug/versions')?.versions, true);
  assert.equal(parseCardRequest('/marketplace/en/cards/300646/card-slug')?.versions, false);
  assert.equal(cardPathHasSlug('/marketplace/en/cards/815746'), false);
  assert.equal(cardPathHasSlug('/marketplace/en/cards/815746/wrong-slug'), true);
  const versions = cardCrawlDecision({
    requestPath: '/marketplace/en/cards/815746/wrong-slug/versions',
    canonicalPath: '/marketplace/en/cards/815746/canonical-slug',
    versions: true,
  });
  assert.equal(versions.action, 'noindex');
  assert.equal(versions.canonicalPath, '/marketplace/en/cards/815746/canonical-slug');
  const mismatch = cardCrawlDecision({
    requestPath: '/marketplace/en/cards/815746/card-hop-s-rookidee-147-209-journey-together',
    canonicalPath: '/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c',
  });
  assert.equal(mismatch.action, 'redirect');
  assert.equal(
    mismatch.location,
    'https://pokoin.com/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c',
  );
  const same = cardCrawlDecision({
    requestPath: '/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c/',
    canonicalPath: '/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c',
  });
  assert.equal(same.action, 'ok');
});

test('noindex versions HTML points at the card and skips Product JSON-LD', () => {
  const payload = buildCardOgPayload(
    {
      seo: {
        title: 'Hop\'s Rookidee',
        canonicalPath: '/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c',
      },
      card: { id: '815746', name: 'Hop\'s Rookidee' },
    },
    { cardId: '815746', language: 'en' },
  );
  payload.robots = 'noindex, follow';
  const html = renderCardOgHtml(payload);
  assert.match(html, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/en\/cards\/815746\/card-hop-s-rookidee-csv10c"/);
  assert.match(html, /name="robots" content="noindex, follow"/);
  assert.equal(html.includes('application/ld+json'), false);
  assert.equal(html.includes('/versions'), false);
});

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('Googlebot wrong slug and slugless card URLs 301 to the canonical path', async () => {
  await withFetch(async () => new Response(JSON.stringify({
    game: 'pokemon',
    card: { id: '815746', name: 'Hop\'s Rookidee' },
    seo: {
      title: 'Hop\'s Rookidee',
      canonicalPath: '/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c',
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }), async () => {
    const wrong = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/815746/card-hop-s-rookidee-147-209-journey-together',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(wrong.status, 301);
    assert.equal(
      wrong.headers.get('location'),
      'https://pokoin.com/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c',
    );
    const bare = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/815746',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), wrong.headers.get('location'));
    const versions = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/815746/card-hop-s-rookidee-csv10c/versions',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(versions.status, 200);
    assert.equal(versions.headers.get('x-robots-tag'), 'noindex, follow');
    const html = await versions.text();
    assert.match(html, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/en\/cards\/815746\/card-hop-s-rookidee-csv10c"/);
    assert.equal(html.includes('application/ld+json'), false);
  });
});

test('unprefixed non-Pokemon card 301s to the game canonical path', async () => {
  await withFetch(async (url) => {
    const target = String(url);
    if (target.includes('game=one_piece')) {
      return new Response(JSON.stringify({
        game: 'one_piece',
        card: { id: '598560', name: 'Tony Tony Chopper' },
        seo: {
          title: 'Tony Tony Chopper',
          canonicalPath: '/one-piece/marketplace/en/cards/598560/alternate-art-tony-tony-chopper',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'Card not found.' }), { status: 404 });
  }, async () => {
    const response = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/598560/alternate-art-tony-tony-chopper',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(response.status, 301);
    assert.equal(
      response.headers.get('location'),
      'https://pokoin.com/one-piece/marketplace/en/cards/598560/alternate-art-tony-tony-chopper',
    );
  });
});

const DIGIMON_SLUG = 'u-onmon-bt25-045-bt-25-dual-revolution';

function digimonCardPage(overrides = {}) {
  return {
    game: 'digimon',
    card: { id: '778386', name: 'U-Onmon', set: 'BT-25 Dual Revolution', number: 'BT25-045' },
    seo: {
      title: 'U-Onmon BT25-045 · BT-25 Dual Revolution',
      // The API's normal shape for satellite games: the canonical has no game prefix.
      canonicalPath: `/marketplace/en/cards/778386/${DIGIMON_SLUG}`,
      imageUrl: '/card-images/digimon/389193_onmon.jpg',
    },
    ...overrides,
  };
}

test('satellite card with a game-less API canonical resolves (no identity throw)', async () => {
  await withFetch(async (url) => {
    assert.ok(String(url).includes('game=digimon'), String(url));
    return new Response(JSON.stringify(digimonCardPage()), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const resolved = await fetchCardPageForOg('778386', 'en', 'digimon');
    assert.equal(resolved.game, 'digimon');
    assert.equal(resolved.page.card.id, '778386');
  });
});

test('Googlebot satellite card URL is 200 with prefixed canonical and direct CDN og:image', async () => {
  await withFetch(async () => new Response(JSON.stringify(digimonCardPage()), { status: 200, headers: { 'content-type': 'application/json' } }), async () => {
    const response = await handleMarketplaceCardOgRequest(new Request(
      `https://pokoin.com/digimon/marketplace/en/cards/778386/${DIGIMON_SLUG}`,
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(response.status, 200);
    const canonicalPath = `/digimon/marketplace/en/cards/778386/${DIGIMON_SLUG}`;
    assert.equal(response.headers.get('x-pokoin-canonical'), canonicalPath);
    const html = await response.text();
    const canonical = `https://pokoin.com${canonicalPath}`;
    const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(html, new RegExp(`rel="canonical" href="${escaped}"`));
    assert.match(html, new RegExp(`property="og:url" content="${escaped}"`));
    assert.match(html, /property="og:image" content="https:\/\/cdn\.pokoin\.com\/digimon\/389193_onmon\.jpg"/);
    assert.match(html, /<img src="https:\/\/cdn\.pokoin\.com\/digimon\/389193_onmon\.jpg"/);
    const jsonLd = JSON.parse(html.match(LD_SCRIPT_RE)[1]);
    assert.equal(jsonLd.image, 'https://cdn.pokoin.com/digimon/389193_onmon.jpg');
    assert.equal(jsonLd.url, canonical);
    assert.equal(jsonLd['@id'], canonical);
    assert.equal(jsonLd.primaryImageOfPage.url, 'https://cdn.pokoin.com/digimon/389193_onmon.jpg');
    assert.equal(jsonLd.primaryImageOfPage.contentUrl, jsonLd.image);
  });
});

test('satellite card with a listing gets the WebPage/Product graph on the prefixed canonical', () => {
  const payload = buildCardOgPayload(
    digimonCardPage({
      offers: [
        {
          id: 'lst-d',
          sellerUid: 'seller-d',
          sellerName: 'Seller D',
          condition: 'NM',
          pricePkn: 2000,
          quantityAvailable: 1,
          status: 'active',
          cardImageUrl: 'https://cdn.pokoin.com/digimon/389193_onmon.jpg',
        },
      ],
    }),
    { cardId: '778386', language: 'en', includeDescription: true, game: 'digimon' },
  );
  payload.currency = 'EUR';
  payload.indexable = true;
  const html = renderCardOgHtml(payload);
  const jsonLd = JSON.parse(html.match(LD_SCRIPT_RE)[1]);
  const canonical = `https://pokoin.com/digimon/marketplace/en/cards/778386/${DIGIMON_SLUG}`;
  const webPage = jsonLd['@graph'].find((node) => node['@type'] === 'WebPage');
  const product = jsonLd['@graph'].find((node) => node['@type'] === 'Product');
  assert.equal(webPage['@id'], canonical);
  assert.equal(webPage.mainEntity['@id'], product['@id']);
  assert.equal(product['@id'], `${canonical}#product`);
  assert.equal(product.mainEntityOfPage['@id'], canonical);
  assert.equal(webPage.primaryImageOfPage.url, 'https://cdn.pokoin.com/digimon/389193_onmon.jpg');
  assert.equal(product.brand.name, 'Digimon');
  assert.equal(product.offers.lowPrice, '10.00');
  assert.equal(product.offers.url, canonical);
});

test('satellite canonical naming a different game or a different card id still 503s Googlebot', async () => {
  const respond = (page) => async () => new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  const request = () => new Request(
    `https://pokoin.com/digimon/marketplace/en/cards/778386/${DIGIMON_SLUG}`,
    { headers: { 'user-agent': GOOGLEBOT } },
  );
  await withFetch(respond(digimonCardPage({
    seo: { canonicalPath: '/one-piece/marketplace/en/cards/778386/u-onmon' },
  })), async () => {
    const response = await handleMarketplaceCardOgRequest(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('location'), null);
  });
  await withFetch(respond(digimonCardPage({
    seo: { canonicalPath: '/marketplace/en/cards/778999/u-onmon' },
  })), async () => {
    const response = await handleMarketplaceCardOgRequest(request());
    assert.equal(response.status, 503);
  });
});

test('Pokemon page whose canonical names another game still throws (unchanged)', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({
      game: 'pokemon',
      card: { id: '239000', name: 'Charizard' },
      seo: { canonicalPath: '/one-piece/marketplace/en/cards/239000/charizard' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const response = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/239000/charizard',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
    const resolved = await fetchCardPageForOg('239000', 'en', '').catch((error) => error);
    assert.match(String(resolved.message || ''), /identity mismatch/);
  });
});

test('unprefixed satellite URL 301s to the prefixed canonical, which serves 200 (no loop)', async () => {
  await withFetch(async (url) => {
    if (String(url).includes('game=digimon')) {
      return new Response(JSON.stringify(digimonCardPage()), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'Card not found.' }), { status: 404 });
  }, async () => {
    const unprefixed = await handleMarketplaceCardOgRequest(new Request(
      `https://pokoin.com/marketplace/en/cards/778386/${DIGIMON_SLUG}`,
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(unprefixed.status, 301);
    const prefixedUrl = `https://pokoin.com/digimon/marketplace/en/cards/778386/${DIGIMON_SLUG}`;
    assert.equal(unprefixed.headers.get('location'), prefixedUrl);
    const prefixed = await handleMarketplaceCardOgRequest(new Request(
      prefixedUrl,
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(prefixed.status, 200);
  });
});

test('card page 500 does not probe other games and does not throw', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return new Response('nope', { status: 500 });
  }, async () => {
    const response = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/815746/slug',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    // Googlebot gets a retryable 503, never the canonical-less SPA shell.
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '300');
    assert.equal(calls, 1);
    const social = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/815746/slug',
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)' } },
    ));
    assert.equal(social, null);
    const resolved = await fetchCardPageForOg('815746', 'en', '', { probe: false }).catch((error) => error);
    assert.match(String(resolved.message || ''), /card-page 500/);
  });
});

test('browser refresh ignores poisoned Worker canonical cache and delegates to the API', async () => {
  const oldCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => new Response(null, {
    status: 204, headers: { 'x-pokoin-canonical': '/lorcana/marketplace/en/cards/708344/rare-megara-secret-keeper-086-whispers-in-the-well' },
  }) } };
  try {
    await withFetch(async () => { throw new Error('browser must not fetch through OG'); }, async () => {
      const response = await handleMarketplaceCardOgRequest(new Request(
        'https://pokoin.com/marketplace/en/cards/806390/card-mega-rayquaza-ex-gold-secret-rare-113-076-storm-emeralda',
        { headers: { 'user-agent': 'Mozilla/5.0 Chrome/141' } },
      ));
      assert.equal(response, null);
    });
  } finally { globalThis.caches = oldCaches; }
});

test('crawler canonical cache cannot redirect Rayquaza to a different id or catalog', () => {
  for (const target of ['/lorcana/marketplace/en/cards/708344/megara', '/lorcana/marketplace/en/cards/806390/other']) {
    const decision = cardCrawlDecision({
      requestPath: '/marketplace/en/cards/806390/rayquaza',
      canonicalPath: target,
    });
    // A discovered game may change only after an authoritative 404 and same id.
    if (target.includes('/708344/')) assert.equal(decision.action, 'ok');
  }
  assert.equal(cardCrawlDecision({
    requestPath: '/lorcana/marketplace/en/cards/708344/megara',
    canonicalPath: '/marketplace/en/cards/708344/other',
  }).action, 'ok');
});

test('wrong API response is rejected before crawler redirect or cache storage', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({
      game: 'lorcana', card: { id: '708344', name: 'Megara' },
      seo: { canonicalPath: '/lorcana/marketplace/en/cards/708344/megara' },
    }), { status: 200 });
  }, async () => {
    const response = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/806390/rayquaza',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('location'), null);
    assert.equal(calls, 1);
  });
});

test('locale-less card URL 301s Googlebot to the canonical en card', async () => {
  assert.deepEqual(parseCardPath('/marketplace/cards/543028/card-charizard'), { language: 'en', cardId: '543028', game: '' });
  await withFetch(async () => new Response(JSON.stringify({
    game: 'pokemon',
    card: { id: '543028', name: 'Charizard' },
    seo: { canonicalPath: '/marketplace/en/cards/543028/card-charizard-054-adv-p-adv-promos' },
  }), { status: 200 }), async () => {
    const response = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/cards/543028/card-charizard-054-adv-p-adv-promos',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), 'https://pokoin.com/marketplace/en/cards/543028/card-charizard-054-adv-p-adv-promos');
  });
});

test('unknown card id is a hard 404 for Googlebot, not a soft-404 shell', async () => {
  await withFetch(async () => new Response('{}', { status: 404 }), async () => {
    const response = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/1/nope',
      { headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  });
});

test('crawler img does not declare dimensions the scan does not have', () => {
  const html = renderCardOgHtml({ title: 'Charizard', name: 'Charizard', cardId: '543028', path: '/marketplace/en/cards/543028/x', image: 'https://cdn.pokoin.com/271514_charizard.jpg' });
  assert.match(html, /<img src="https:\/\/cdn\.pokoin\.com\/271514_charizard\.jpg" alt="[^"]*" \/>/);
});

test('language-less card id/slug 301s every client and keeps the query string', async () => {
  const hops = [
    ['Mozilla/5.0 Chrome/141', 'https://pokoin.com/marketplace/cards/543028/card-charizard?listing=9', 'https://pokoin.com/marketplace/en/cards/543028/card-charizard?listing=9'],
    ['Discordbot/2.0', 'https://www.pokoin.com/marketplace/cards/543028/card-charizard/', 'https://www.pokoin.com/marketplace/en/cards/543028/card-charizard'],
    ['Twitterbot/1.0', 'https://pokoin.com/one-piece/marketplace/cards/598560/luffy?x=1', 'https://pokoin.com/one-piece/marketplace/en/cards/598560/luffy?x=1'],
    ['Slackbot-LinkExpanding 1.0', 'https://pokoin.com/marketplace/cards/543028/card-charizard', 'https://pokoin.com/marketplace/en/cards/543028/card-charizard'],
    ['facebookexternalhit/1.1', 'https://pokoin.com/marketplace/cards/543028/card-charizard', 'https://pokoin.com/marketplace/en/cards/543028/card-charizard'],
    [GOOGLEBOT, 'https://pokoin.com/marketplace/cards/543028/card-charizard-054-adv-p-adv-promos', 'https://pokoin.com/marketplace/en/cards/543028/card-charizard-054-adv-p-adv-promos'],
    ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'https://pokoin.com/marketplace/cards/543028/card-charizard', 'https://pokoin.com/marketplace/en/cards/543028/card-charizard'],
  ];
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    throw new Error('language-less redirect must not look up the card');
  }, async () => {
    for (const [ua, from, to] of hops) {
      const response = await handleMarketplaceCardOgRequest(new Request(from, { headers: { 'user-agent': ua } }));
      assert.equal(response?.status, 301, from);
      assert.equal(response.headers.get('location'), to, from);
    }
    const posted = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/cards/543028/card-charizard',
      { method: 'POST', headers: { 'user-agent': GOOGLEBOT } },
    ));
    assert.equal(posted, null);
    for (const path of ['/marketplace/cards/543028', '/marketplace/cards/543028/slug/versions']) {
      for (const ua of ['Mozilla/5.0 Chrome/141', 'Discordbot/2.0', GOOGLEBOT, 'Mozilla/5.0 (compatible; YandexBot/3.0)']) {
        const response = await handleMarketplaceCardOgRequest(new Request(`https://pokoin.com${path}`, { headers: { 'user-agent': ua } }));
        assert.equal(response, null, `${ua} ${path}`);
      }
    }
    assert.equal(calls, 0);
  });
});

test('YandexBot is a search crawler: card lookup failure is 503, preview bots stay on the shell', async () => {
  await withFetch(async () => new Response('nope', { status: 500 }), async () => {
    const yandex = await handleMarketplaceCardOgRequest(new Request(
      'https://pokoin.com/marketplace/en/cards/815746/slug',
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)' } },
    ));
    assert.equal(yandex.status, 503);
    assert.equal(yandex.headers.get('retry-after'), '300');
    assert.equal(yandex.headers.get('x-robots-tag'), 'noindex');
    for (const ua of ['Discordbot/2.0', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1', 'Mozilla/5.0 Chrome/141']) {
      const response = await handleMarketplaceCardOgRequest(new Request(
        'https://pokoin.com/marketplace/en/cards/815746/slug',
        { headers: { 'user-agent': ua } },
      ));
      assert.equal(response, null, ua);
    }
  });
});
