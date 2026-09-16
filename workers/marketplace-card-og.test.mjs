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
    { language: 'en', cardId: '248768' },
  );
  assert.deepEqual(parseCardPath('/marketplace/en/cards/248768'), { language: 'en', cardId: '248768' });
  assert.deepEqual(
    parseCardPath('/marketplace/en/cards/999806370/card-zinnia-s-trust-ultra-rare-102-076-storm-emeralda'),
    { language: 'en', cardId: '806370' },
  );
  assert.equal(parseCardPath('/marketplace'), null);
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
