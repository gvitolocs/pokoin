import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  HUB_API_TIMEOUT_MS,
  catalogSeo,
  handleMarketplaceHubOgRequest,
  hubRedirectPath,
  hubSeo,
  languageLessHubRedirectPath,
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

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

function bot(path) {
  return handleMarketplaceHubOgRequest(new Request(`https://pokoin.com${path}`, { headers: { 'user-agent': GOOGLEBOT } }));
}

test('Googlebot hub gets a retryable 503 (not a thin page) when the API fails', async () => {
  await withFetch(async () => new Response('nope', { status: 500 }), async () => {
    for (const path of ['/marketplace/sets/151', '/marketplace/sets', '/marketplace/en/artists/ken-sugimori', '/marketplace/en/pokemon/charizard']) {
      const response = await bot(path);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get('retry-after'), '300');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    }
  });
});

test('unknown set, era, artist and species hubs are hard 404s for Googlebot', async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes('expansion-page')) return new Response('{"error":"Expansion not found."}', { status: 404 });
    if (u.includes('artist-cards')) return new Response('{"artist":null,"profile":null,"cards":[]}', { status: 200 });
    return new Response('{"cards":[]}', { status: 200 });
  }, async () => {
    for (const path of ['/marketplace/sets/zzz', '/marketplace/eras/zzz', '/marketplace/en/artists/zzz-nobody', '/marketplace/en/pokemon/zzznomon']) {
      const response = await bot(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    }
  });
});

test('duplicate hub URL forms 301 Googlebot to the canonical locale', async () => {
  assert.equal(hubRedirectPath('/marketplace/artists/ken-sugimori'), '/marketplace/en/artists/ken-sugimori');
  assert.equal(hubRedirectPath('/marketplace/it/artists/ken-sugimori'), '/marketplace/en/artists/ken-sugimori');
  assert.equal(hubRedirectPath('/marketplace/pokemon/charizard'), '/marketplace/en/pokemon/charizard');
  assert.equal(hubRedirectPath('/marketplace/en/sets/adv-promos'), '/marketplace/sets/adv-promos');
  assert.equal(hubRedirectPath('/marketplace/en/eras/xy'), '/marketplace/eras/xy');
  assert.equal(hubRedirectPath('/one-piece/marketplace/artists/oda'), '/one-piece/marketplace/en/artists/oda');
  for (const keep of ['/marketplace/en/artists/ken-sugimori', '/marketplace/sets/adv-promos', '/marketplace/en/pokemon/charizard', '/marketplace/en/cards/1/x', '/marketplace']) {
    assert.equal(hubRedirectPath(keep), '', keep);
  }
  const response = await bot('/marketplace/it/artists/ken-sugimori');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://pokoin.com/marketplace/en/artists/ken-sugimori');
  const browser = await handleMarketplaceHubOgRequest(new Request('https://pokoin.com/marketplace/it/artists/ken-sugimori', { headers: { 'user-agent': 'Mozilla/5.0 Chrome/141' } }));
  assert.equal(browser, null);
});

test('set and artist hubs publish the first card scan as og:image and JSON-LD image', async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes('expansion-page')) {
      return new Response(JSON.stringify({ expansion: { name: 'ADV Promos' }, cards: [
        { id: '673804', name: 'Darkness Energy', heroImageUrl: '/card-images/673804_darkness-energy.jpg', canonicalPath: '/marketplace/en/cards/673804/x' },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ artist: { name: 'Ken Sugimori' }, cards: [
      { card_id: '278398', name: 'Bulbasaur', image_url: 'https://cdn.pokoin.com/139199_bulbasaur.jpg' },
    ] }), { status: 200 });
  }, async () => {
    const set = await (await bot('/marketplace/sets/adv-promos')).text();
    assert.match(set, /og:image" content="https:\/\/cdn\.pokoin\.com\/336902_darkness-energy\.jpg"/);
    assert.match(set, /"image":"https:\/\/cdn\.pokoin\.com\/336902_darkness-energy\.jpg"/);
    const artist = await bot('/marketplace/en/artists/ken-sugimori');
    assert.equal(artist.status, 200);
    const html = await artist.text();
    assert.match(html, /og:image" content="https:\/\/cdn\.pokoin\.com\/139199_bulbasaur\.jpg"/);
    assert.match(html, /rel="canonical" href="https:\/\/pokoin\.com\/marketplace\/en\/artists\/ken-sugimori"/);
  });
  const hub = renderHubOgHtml({ language: 'en', kind: 'pokemon', slug: 'charizard' },
    [{ id: '239000', name: 'Charizard', heroImageUrl: 'https://cdn.pokoin.com/2_charizard.jpg' }]);
  assert.match(hub, /og:image" content="https:\/\/cdn\.pokoin\.com\/\d+_charizard\.jpg"/);
});

const PREVIEW_UAS = ['Discordbot/2.0', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1'];
const CHROME = 'Mozilla/5.0 Chrome/141';

function request(path, ua, method = 'GET') {
  return handleMarketplaceHubOgRequest(new Request(`https://pokoin.com${path}`, {
    method,
    headers: { 'user-agent': ua },
  }));
}

test('language-less hubs 301 every client and leave other marketplace routes alone', async () => {
  assert.equal(languageLessHubRedirectPath('/marketplace/pokemon/charizard'), '/marketplace/en/pokemon/charizard');
  assert.equal(languageLessHubRedirectPath('/marketplace/it/artists/ken-sugimori'), '');
  assert.equal(languageLessHubRedirectPath('/marketplace/en/sets/adv-promos'), '');
  assert.equal(languageLessHubRedirectPath('/marketplace/sets/151'), '');
  assert.equal(languageLessHubRedirectPath('/one-piece/marketplace/en/pokemon/luffy'), '');

  const hops = [
    ['/marketplace/pokemon/charizard?ref=1', '/marketplace/en/pokemon/charizard?ref=1'],
    ['/marketplace/rarities/illustration-rare', '/marketplace/en/rarities/illustration-rare'],
    ['/marketplace/languages/a', '/marketplace/en/languages/a'],
    ['/marketplace/guides/a/', '/marketplace/en/guides/a'],
    ['/marketplace/artists', '/marketplace/en/artists'],
    ['/one-piece/marketplace/artists/oda?x=1', '/one-piece/marketplace/en/artists/oda?x=1'],
  ];
  for (const ua of [CHROME, ...PREVIEW_UAS, GOOGLEBOT, 'Mozilla/5.0 (compatible; YandexBot/3.0)']) {
    for (const [path, dest] of hops) {
      const response = await request(path, ua);
      assert.equal(response?.status, 301, `${ua} ${path}`);
      assert.equal(response.headers.get('location'), `https://pokoin.com${dest}`, `${ua} ${path}`);
    }
  }
  const www = await handleMarketplaceHubOgRequest(new Request(
    'https://www.pokoin.com/marketplace/pokemon/a?ref=1',
    { headers: { 'user-agent': CHROME } },
  ));
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('location'), 'https://www.pokoin.com/marketplace/en/pokemon/a?ref=1');
  const posted = await request('/marketplace/pokemon/a', GOOGLEBOT, 'POST');
  assert.equal(posted, null);

  for (const path of [
    '/marketplace',
    '/marketplace/sets/151',
    '/marketplace/eras/xy',
    '/marketplace/en/pokemon/charizard',
    '/marketplace/en/cards/1/x',
    '/marketplace/pokemon/a/extra',
    '/one-piece/marketplace/sets/romance-dawn',
    '/one-piece/marketplace/en/pokemon/luffy',
    '/one-piece/marketplace/en/sets/romance-dawn',
  ]) {
    assert.equal(await request(path, CHROME), null, path);
    for (const ua of PREVIEW_UAS) assert.equal(await request(path, ua), null, `${ua} ${path}`);
  }

  const prefixedSets = await bot('/marketplace/en/sets/adv-promos?ref=1');
  assert.equal(prefixedSets.status, 301);
  assert.equal(prefixedSets.headers.get('location'), 'https://pokoin.com/marketplace/sets/adv-promos?ref=1');
  assert.equal(await request('/marketplace/en/sets/adv-promos?ref=1', CHROME), null);
  assert.equal(await request('/marketplace/en/sets/adv-promos', 'Discordbot/2.0'), null);
  assert.equal(await request('/marketplace/it/artists/ken-sugimori', 'Discordbot/2.0'), null);
  const era = await bot('/marketplace/en/eras/xy');
  assert.equal(era.status, 301);
  assert.equal(era.headers.get('location'), 'https://pokoin.com/marketplace/eras/xy');
  const home = await bot('/marketplace');
  assert.equal(home.status, 200);
  const xy = await bot('/marketplace/eras/xy');
  assert.equal(xy.status, 200);
  assert.equal(xy.headers.get('location'), null);
});

test('language-less hub paths run the worker ahead of the asset shell', () => {
  const raw = fs.readFileSync(new URL('../wrangler.pokoin-web.jsonc', import.meta.url), 'utf8');
  const rules = JSON.parse(raw.replace(/\/\/.*$/mg, '')).assets.run_worker_first;
  for (const rule of [
    '/marketplace/pokemon', '/marketplace/pokemon/*',
    '/marketplace/rarities', '/marketplace/rarities/*',
    '/marketplace/languages', '/marketplace/languages/*',
    '/marketplace/guides', '/marketplace/guides/*',
    '/marketplace/artists', '/marketplace/artists/*',
    '/marketplace/cards/*',
    '/marketplace', '/marketplace/sets', '/marketplace/sets/*',
    '/marketplace/eras', '/marketplace/eras/*',
    '/marketplace/*/cards', '/marketplace/*/cards/*',
    '/*/marketplace/*/cards', '/*/marketplace/*/cards/*',
  ]) {
    assert.ok(rules.includes(rule), rule);
  }
});

test('preview bots and ?og=1 browsers do not take hub 503/404; search crawlers do', async () => {
  const puts = [];
  const previous = globalThis.caches;
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put(_key, response) { puts.push(response.status); },
    },
  };
  const ctx = { async waitUntil(work) { await work; } };
  try {
    await withFetch(async () => new Response('nope', { status: 500 }), async () => {
      for (const ua of [GOOGLEBOT, 'bingbot/2.0', 'DuckDuckBot/1.0', 'Mozilla/5.0 (compatible; YandexBot/3.0)', 'Applebot/0.1']) {
        const response = await handleMarketplaceHubOgRequest(new Request(
          'https://pokoin.com/marketplace/sets/151',
          { headers: { 'user-agent': ua } },
        ), {}, ctx);
        assert.equal(response.status, 503, ua);
        assert.equal(response.headers.get('retry-after'), '300', ua);
        assert.equal(response.headers.get('cache-control'), 'no-store', ua);
      }
      for (const ua of PREVIEW_UAS) {
        assert.equal(await request('/marketplace/sets/151', ua), null, ua);
        assert.equal(await request('/marketplace/en/pokemon/charizard', ua), null, ua);
      }
      const preview = await handleMarketplaceHubOgRequest(new Request(
        'https://pokoin.com/marketplace/sets/151?og=1',
        { headers: { 'user-agent': CHROME } },
      ), {}, ctx);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('retry-after'), null);
      const forcedDiscord = await handleMarketplaceHubOgRequest(new Request(
        'https://pokoin.com/marketplace/en/artists/zzz?bot=1',
        { headers: { 'user-agent': 'Discordbot/2.0' } },
      ), {}, ctx);
      assert.equal(forcedDiscord.status, 200);
    });
    await withFetch(async () => new Response('{"error":"Expansion not found."}', { status: 404 }), async () => {
      const browser = await handleMarketplaceHubOgRequest(new Request(
        'https://pokoin.com/marketplace/sets/zzz?og=1',
        { headers: { 'user-agent': CHROME } },
      ), {}, ctx);
      assert.equal(browser.status, 200);
      const crawler = await bot('/marketplace/sets/zzz');
      assert.equal(crawler.status, 404);
      assert.equal(crawler.headers.get('x-robots-tag'), 'noindex');
      assert.equal(await request('/marketplace/sets/zzz', 'Discordbot/2.0'), null);
    });
    assert.deepEqual(puts, []);
  } finally {
    globalThis.caches = previous;
  }
});

test('hub API abort and a hung artist lookup are crawler 503s', async () => {
  assert.equal(HUB_API_TIMEOUT_MS, 4000);
  await withFetch(async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }, async () => {
    for (const path of ['/marketplace/en/artists/ken-sugimori', '/marketplace/sets/151', '/marketplace/en/pokemon/charizard']) {
      const response = await bot(path);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get('retry-after'), '300', path);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex', path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
    }
    assert.equal(await request('/marketplace/en/artists/ken-sugimori', 'Discordbot/2.0'), null);
    assert.equal(await request('/marketplace/sets/151', CHROME), null);
  });

  const previous = globalThis.caches;
  const puts = [];
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put(_key, response) { puts.push(response.status); },
    },
  };
  try {
    await withFetch((_url, init) => new Promise((resolve, reject) => {
      const fail = () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    }), async () => {
      assert.equal(await request('/marketplace/en/artists/ken-sugimori', CHROME), null);
      const response = await bot('/marketplace/en/artists/ken-sugimori');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '300');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(puts, []);
    });
  } finally {
    globalThis.caches = previous;
  }
});

test('hub HTML carries CollectionPage JSON-LD and Pokoin attribution', () => {
  const html = renderHubOgHtml({ language: 'en', kind: 'pokemon', slug: 'charizard' }, []);
  assert.match(html, /"@type":"CollectionPage"/);
  assert.match(html, /"dateModified":"\d{4}-\d{2}-\d{2}"/);
  assert.match(html, /Prices in PKN on <a href="https:\/\/pokoin\.com">Pokoin<\/a>/);
});
