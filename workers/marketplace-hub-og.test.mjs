import assert from 'node:assert/strict';
import test from 'node:test';
import { hubSeo, parseHubPath, renderHubOgHtml } from './marketplace-hub-og.js';

test('parses marketplace hub paths', () => {
  assert.deepEqual(parseHubPath('/marketplace/en/pokemon/charizard'), {
    language: 'en',
    kind: 'pokemon',
    slug: 'charizard',
  });
  assert.deepEqual(parseHubPath('/marketplace/en/rarities/special-illustration-rare/'), {
    language: 'en',
    kind: 'rarities',
    slug: 'special-illustration-rare',
  });
  assert.equal(parseHubPath('/marketplace/en/cards/239000'), null);
});

test('hub HTML has crawlable card links', () => {
  const html = renderHubOgHtml(
    { language: 'en', kind: 'pokemon', slug: 'charizard' },
    [{ id: '239000', name: 'Charizard', canonicalPath: '/marketplace/en/cards/239000/charizard-base-set' }],
  );
  assert.match(html, /<h1>Charizard Pokémon Cards<\/h1>/);
  assert.match(html, /href="\/marketplace\/en\/cards\/239000\/charizard-base-set"/);
  assert.equal(hubSeo({ language: 'en', kind: 'pokemon', slug: 'charizard' }).path, '/marketplace/en/pokemon/charizard');
});
