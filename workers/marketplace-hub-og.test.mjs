import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogSeo,
  handleMarketplaceHubOgRequest,
  hubSeo,
  parseCatalogPath,
  parseHubPath,
  renderCatalogOgHtml,
  renderHubOgHtml,
} from './marketplace-hub-og.js';

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

test('catalog paths cover marketplace home, sets, eras, and artists', () => {
  assert.equal(parseCatalogPath('/marketplace')?.kind, 'home');
  assert.equal(parseCatalogPath('/marketplace/sets')?.kind, 'sets');
  assert.equal(parseCatalogPath('/marketplace/sets/151')?.slug, '151');
  assert.equal(parseCatalogPath('/marketplace/eras')?.kind, 'eras');
  assert.equal(parseCatalogPath('/marketplace/eras/scarlet-violet')?.slug, 'scarlet-violet');
  assert.equal(parseCatalogPath('/marketplace/en/artists')?.kind, 'artists');
  assert.equal(parseCatalogPath('/marketplace/en/artists/mitsuhiro-arita')?.slug, 'mitsuhiro-arita');
  assert.equal(parseCatalogPath('/one-piece/marketplace/sets/romance-dawn')?.game, 'one_piece');
  assert.equal(parseCatalogPath('/marketplace/en/cards/1'), null);
  assert.equal(parseCatalogPath('/marketplace/en/pokemon/charizard'), null);

  const home = renderCatalogOgHtml(catalogSeo({ kind: 'home', game: '', language: 'en', slug: '' }));
  assert.match(home, /<title>Pokoin marketplace<\/title>/);
  assert.match(home, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace"/);
  assert.match(home, /"@type":"WebPage"/);

  const set = renderCatalogOgHtml(catalogSeo(
    { kind: 'sets', game: '', language: 'en', slug: '151' },
    { name: '151' },
  ), [{ href: '/marketplace/en/cards/1/pikachu', name: 'Pikachu' }]);
  assert.match(set, /<title>151 Card List, Prices &amp; Values \| Pokoin<\/title>/);
  assert.match(set, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/sets\/151"/);
  assert.match(set, /"@type":"CollectionPage"/);
  assert.match(set, /href="\/marketplace\/en\/cards\/1\/pikachu"/);

  const era = renderCatalogOgHtml(catalogSeo({ kind: 'eras', game: '', language: 'en', slug: 'scarlet-violet' }));
  assert.match(era, /Scarlet &amp; Violet Pokémon TCG Sets/);
  assert.match(era, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/eras\/scarlet-violet"/);

  const artists = renderCatalogOgHtml(catalogSeo({ kind: 'artists', game: '', language: 'en', slug: '' }));
  assert.match(artists, /Pokémon Card Artists \| Pokoin/);
  assert.match(artists, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/en\/artists"/);
});

test('Googlebot set page is prerendered HTML when the expansion API fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const response = await handleMarketplaceHubOgRequest(new Request(
      'https://pokoin.com/marketplace/sets/151',
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } },
    ));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-pokoin-og-cache'), 'miss');
    const html = await response.text();
    assert.match(html, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/sets\/151"/);
    assert.match(html, /"@type":"CollectionPage"/);
  } finally {
    globalThis.fetch = original;
  }
});

test('hub HTML carries CollectionPage JSON-LD and Pokoin attribution', () => {
  const html = renderHubOgHtml({ language: 'en', kind: 'pokemon', slug: 'charizard' }, []);
  assert.match(html, /"@type":"CollectionPage"/);
  assert.match(html, /"dateModified":"\d{4}-\d{2}-\d{2}"/);
  assert.match(html, /Prices in PKN on <a href="https:\/\/pokoin\.com">Pokoin<\/a>/);
});
