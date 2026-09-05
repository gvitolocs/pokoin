import assert from 'node:assert/strict';
import test from 'node:test';
import {
  absoluteUrl,
  buildCardOgPayload,
  isLinkPreviewBot,
  parseCardPath,
  renderCardOgHtml,
} from './marketplace-card-og.js';

test('detects Discord and other link-preview bots', () => {
  assert.equal(isLinkPreviewBot('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), true);
  assert.equal(isLinkPreviewBot('Twitterbot/1.0'), true);
  assert.equal(isLinkPreviewBot('Mozilla/5.0'), false);
  assert.equal(isLinkPreviewBot('Mozilla/5.0', true), true);
});

test('parses marketplace card paths', () => {
  assert.deepEqual(
    parseCardPath('/marketplace/en/cards/248768/card-drifloon-lv-17-non-holo-promo-6-17-pop-series-6'),
    { language: 'en', cardId: '248768' },
  );
  assert.deepEqual(parseCardPath('/marketplace/en/cards/248768'), { language: 'en', cardId: '248768' });
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
  assert.equal(payload.image, 'https://pokoin.com/card-images/248768_drifloon-lv-17.jpg?v=br4');
  assert.equal(absoluteUrl('https://cdn.pokoin.com/x.jpg'), 'https://cdn.pokoin.com/x.jpg');
  const html = renderCardOgHtml(payload);
  assert.match(html, /property="og:title" content="Drifloon Lv\.17 · POP Series 6"/);
  assert.match(html, /property="og:image" content="https:\/\/pokoin\.com\/card-images\/248768_drifloon-lv-17\.jpg\?v=br4"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});
