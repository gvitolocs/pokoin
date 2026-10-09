import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { publicApiUrl } from './extension-auth-bridge.js';
import { GAMES, gameRequestHeaders, withGameQuery } from './game.js';

const source = readFileSync(new URL('../public/card-url-boot.js', import.meta.url), 'utf8');

function bootFns() {
  const context = createContext({
    navigator: {},
    URLSearchParams,
    encodeURIComponent,
  });
  runInContext(source, context);
  return context;
}

const { cardBootPlan } = bootFns();

function appCardRequest(pathname, hostname) {
  globalThis.window = { location: { hostname, pathname } };
  const plan = cardBootPlan(pathname, hostname);
  assert.ok(plan, pathname);
  const pageParams = new URLSearchParams({ cardId: plan.id });
  pageParams.set('lang', plan.lang);
  if (plan.slug) pageParams.set('slug', plan.slug);
  const urlParams = new URLSearchParams({ cardId: plan.id });
  urlParams.set('language', plan.lang);
  return {
    plan,
    pageUrl: withGameQuery(`/api/marketplace-card-page?${pageParams}`),
    urlUrl: withGameQuery(`/api/marketplace-card-url?${urlParams}`),
    headers: { Accept: 'application/json', ...gameRequestHeaders() },
  };
}

function assertSameRequest(pathname, hostname) {
  const expected = appCardRequest(pathname, hostname);
  // The desk fetches publicApiUrl(path); the boot script fetches API_ORIGIN + path.
  assert.equal(`https://api.pokoin.com${expected.plan.pageUrl}`, publicApiUrl(expected.pageUrl), pathname);
  assert.equal(expected.plan.pageUrl, expected.pageUrl, pathname);
  assert.equal(expected.plan.urlUrl, expected.urlUrl, pathname);
  // Headers are created inside the boot script's vm; copy them into this realm.
  assert.deepEqual({ ...expected.plan.headers }, expected.headers, pathname);
  return expected.plan;
}

test('pokemon card boot prefetch stays unprefixed and matches the desk fetch', () => {
  const slugged = assertSameRequest(
    '/marketplace/en/cards/342436/card-charizard',
    'pokoin.com',
  );
  assert.equal(slugged.apiGame, '');
  assert.equal(
    slugged.pageUrl,
    '/api/marketplace-card-page?cardId=342436&lang=en&slug=card-charizard',
  );
  assert.equal(slugged.headers['x-pokoin-game'], undefined);
  const bare = assertSameRequest('/marketplace/it/cards/713754', 'pokoin.com');
  assert.equal(bare.pageUrl, '/api/marketplace-card-page?cardId=713754&lang=it');
  assert.equal(bare.slug, '');
  assert.equal(cardBootPlan('/marketplace/en/cards/713754/', 'pokoin.com').pageUrl, bare.pageUrl.replace('lang=it', 'lang=en'));
});

test('one-piece and star-wars card URLs prefetch the same request the desk fetches', () => {
  const chopper = assertSameRequest(
    '/one-piece/marketplace/en/cards/598560/alternate-art-tony-tony-chopper-op08-007a-op-08-two-legends',
    'pokoin.com',
  );
  assert.equal(chopper.apiGame, 'one_piece');
  assert.equal(
    chopper.pageUrl,
    '/api/marketplace-card-page?cardId=598560&lang=en&slug=alternate-art-tony-tony-chopper-op08-007a-op-08-two-legends&game=one_piece',
  );
  const student = assertSameRequest(
    '/star-wars/marketplace/en/cards/795832/uncommon-the-student-guides-the-master',
    'pokoin.com',
  );
  assert.equal(student.apiGame, 'star_wars');
  assert.match(student.pageUrl, /cardId=795832&lang=en&slug=uncommon-the-student-guides-the-master&game=star_wars$/);
  assert.equal(student.headers['x-pokoin-game'], 'star_wars');
  assert.equal(student.headers['x-pokoin-host'], 'pokoin.com');
});

test('every game slug prefetches its api game, including zht', () => {
  const slugs = [];
  for (const game of Object.values(GAMES)) {
    if (!game.slug) continue;
    slugs.push(game.slug);
    const plan = assertSameRequest(
      `/${game.slug}/marketplace/zht/cards/42/printing`,
      'pokoin.com',
    );
    assert.equal(plan.apiGame, game.apiGame, game.slug);
    assert.equal(plan.lang, 'zht');
  }
  const block = source.match(/var GAME_API = (\{[\s\S]*?\});/);
  assert.ok(block, 'GAME_API map is present');
  const listed = runInContext(`(${block[1]})`, createContext({}));
  assert.deepEqual(Object.keys(listed).sort(), slugs.sort());
  for (const [slug, apiGame] of Object.entries(listed)) {
    assert.equal(apiGame, GAMES[Object.keys(GAMES).find((id) => GAMES[id].slug === slug)].apiGame);
  }
});

test('satellite hosts prefetch the game on an unprefixed card path', () => {
  const piece = assertSameRequest(
    '/marketplace/en/cards/812446/luffy',
    'onepiece.pokoin.com',
  );
  assert.equal(piece.apiGame, 'one_piece');
  assert.equal(piece.headers['x-pokoin-host'], 'onepiece.pokoin.com');
  const local = assertSameRequest(
    '/marketplace/en/cards/10/card',
    'riftbound.localhost',
  );
  assert.equal(local.apiGame, 'riftbound');
  assert.equal(local.headers['x-pokoin-host'], 'riftbound.localhost');
  const prefixedWins = assertSameRequest(
    '/star-wars/marketplace/en/cards/795832/student',
    'onepiece.pokoin.com',
  );
  assert.equal(prefixedWins.apiGame, 'star_wars');
});

test('non-card and unknown prefixes do not prefetch', () => {
  assert.equal(cardBootPlan('/marketplace', 'pokoin.com'), null);
  assert.equal(cardBootPlan('/one-piece/marketplace', 'pokoin.com'), null);
  assert.equal(cardBootPlan('/api/marketplace-card-page', 'pokoin.com'), null);
  assert.equal(cardBootPlan('/not-a-game/marketplace/en/cards/1/x', 'pokoin.com'), null);
  assert.equal(cardBootPlan('/one-piece/marketplace/en/cards/598560/luffy/versions', 'pokoin.com'), null);
  // Slug-less versions URL: the boot must not treat "versions" as the card slug.
  assert.equal(cardBootPlan('/marketplace/en/cards/806390/versions', 'pokoin.com'), null);
  assert.equal(cardBootPlan('/marketplace/en/cards/806390/versions/', 'pokoin.com'), null);
  assert.equal(cardBootPlan('/one-piece/marketplace/en/cards/598560/versions', 'pokoin.com'), null);
  assert.equal(cardBootPlan('/marketplace/en/sets/base-set', 'pokoin.com'), null);
});

test('a card URL starts exactly one card-page prefetch and one canonical prefetch', () => {
  const calls = [];
  const context = createContext({
    navigator: {},
    URLSearchParams,
    encodeURIComponent,
    location: {
      pathname: '/one-piece/marketplace/en/cards/598560/luffy',
      hostname: 'pokoin.com',
    },
    history: { state: null, replaceState() {} },
    fetch(url, init) {
      calls.push({ url, headers: init.headers });
      return Promise.resolve({ ok: false });
    },
  });
  runInContext(source, context);
  const pages = calls.filter((call) => String(call.url).startsWith(publicApiUrl('/api/marketplace-card-page?')));
  const urls = calls.filter((call) => String(call.url).startsWith(publicApiUrl('/api/marketplace-card-url?')));
  assert.equal(calls.length, 2);
  assert.equal(pages.length, 1);
  assert.equal(urls.length, 1);
  assert.equal(
    pages[0].url,
    publicApiUrl('/api/marketplace-card-page?cardId=598560&lang=en&slug=luffy&game=one_piece'),
  );
  assert.equal(pages[0].headers['x-pokoin-game'], 'one_piece');
  assert.equal(
    urls[0].url,
    publicApiUrl('/api/marketplace-card-url?cardId=598560&language=en&game=one_piece'),
  );

  const pokemon = [];
  runInContext(source, createContext({
    navigator: {},
    URLSearchParams,
    encodeURIComponent,
    location: {
      pathname: '/marketplace/en/cards/342436/card-charizard',
      hostname: 'pokoin.com',
    },
    history: { state: null, replaceState() {} },
    fetch(url, init) {
      pokemon.push({ url, headers: { ...init.headers } });
      return Promise.resolve({ ok: false });
    },
  }));
  assert.equal(pokemon.length, 2);
  assert.equal(
    pokemon.filter((call) => call.url.includes('marketplace-card-page')).length,
    1,
  );
  assert.equal(
    pokemon.find((call) => call.url.includes('marketplace-card-page')).url,
    publicApiUrl('/api/marketplace-card-page?cardId=342436&lang=en&slug=card-charizard'),
  );
  assert.equal(pokemon[0].headers['x-pokoin-game'], undefined);

  const idle = [];
  runInContext(source, createContext({
    navigator: {},
    URLSearchParams,
    encodeURIComponent,
    location: { pathname: '/one-piece/marketplace', hostname: 'pokoin.com' },
    history: { state: null, replaceState() {} },
    fetch(url) {
      idle.push(url);
      return Promise.resolve({ ok: false });
    },
  }));
  assert.deepEqual(idle, []);
});
