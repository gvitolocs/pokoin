import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { bootScript, buildShell, cspHash, entryTags, gameSlugs, routePath } from './build-ui-shell.mjs';

const REACT = `<!DOCTYPE html><html><head><meta charset="utf-8" />
<script src="/market/card-url-boot.js"></script>
    <script type="module" crossorigin src="/market/assets/index-R.js"></script>
    <link rel="modulepreload" crossorigin href="/market/assets/vendor-R.js">
    <link rel="stylesheet" crossorigin href="/market/assets/index-R.css">
  </head><body><div id="root"></div></body></html>`;
const SOLID = `<!DOCTYPE html><html><head>
<script src="/market/card-url-boot.js"></script>
    <script type="module" crossorigin src="/market/s/index-S.js"></script>
    <link rel="stylesheet" crossorigin href="/market/s/index-S.css">
    <link rel="prefetch" href="/market/s/suggest-engine-S.js" as="script" crossorigin="">
  </head><body><div id="root"></div></body></html>`;
const OWNED = ['^/marketplace/?$', '^/marketplace/[a-z]{2}/cards/\\d+(?:/[^/]+)?/?$'];

function boot(script, { path = '/marketplace', search = '', local = {}, session = {}, framed = false, random = 0.5 } = {}) {
  const written = [];
  const store = (seed) => {
    const data = { ...seed };
    return {
      data,
      getItem: (key) => (key in data ? data[key] : null),
      setItem: (key, value) => { data[key] = String(value); },
      removeItem: (key) => { delete data[key]; },
    };
  };
  const localStorage = store(local);
  const sessionStorage = store(session);
  const window = {};
  window.self = window;
  window.top = framed ? {} : window;
  const context = createContext({
    window,
    location: { pathname: path, search },
    URLSearchParams,
    localStorage,
    sessionStorage,
    Math: { ...Math, random: () => random },
    document: { write: (html) => written.push(html) },
  });
  runInContext(script, context);
  return { ui: window.__POKOIN_UI__, legacy: window.__POKOIN_REACT_LEGACY__, written: written.join(''), local: localStorage.data, session: sessionStorage.data, switched: window.__POKOIN_UI_SWITCH__ };
}

test('entryTags removes exactly the Vite entry tags and remembers where they were', () => {
  const { tags, rest, at } = entryTags(REACT);
  assert.equal(tags.length, 3);
  assert.ok(rest.includes('card-url-boot.js'));
  assert.ok(!rest.includes('index-R.js') && !rest.includes('index-R.css'));
  assert.ok(at > rest.indexOf('card-url-boot.js'));
});

test('the shell keeps card-url-boot before the switch, and the CSP hash covers the inline script', () => {
  const shell = buildShell(REACT, SOLID, { owned: OWNED });
  assert.ok(shell.html.indexOf('card-url-boot.js') < shell.html.indexOf('<script>('));
  assert.ok(!/<script type="module"/.test(shell.html.replace(/<script>\(function[\s\S]*?<\/script>/, '')));
  assert.equal(shell.hash, cspHash(shell.script));
  assert.ok(!shell.script.includes('</script>'), 'inline script must not contain </script>');
});

test('every page boots Solid: owned or not, framed or not, under a game basename', () => {
  const { script } = buildShell(REACT, SOLID, { owned: OWNED, games: ['one-piece'] });
  for (const opts of [{}, { path: '/marketplace/en/cards/123/pikachu' }, { framed: true }, { path: '/one-piece/marketplace' }, { path: '/cart' }]) {
    const run = boot(script, opts);
    assert.equal(run.ui, 'solid', JSON.stringify(opts));
    assert.ok(run.written.includes('/market/s/index-S.js') && run.written.includes('suggest-engine-S.js'));
    assert.ok(!run.written.includes('index-R.js'), 'React entry tags are never written');
    assert.equal(run.switched, 1);
  }
  assert.ok(!script.includes('index-R.js'), 'React entry is not even in the page');
  assert.equal(boot(script).legacy, undefined, 'a plain owned page reports nothing');
});

test('whatever used to pick React is reported once as react-legacy, then cleared', () => {
  const { script } = buildShell(REACT, SOLID, { owned: OWNED });
  assert.equal(boot(script, { search: '?ui=react' }).legacy, 'ui=react');
  const handed = boot(script, { session: { 'pokoin.ui.once': 'react' } });
  assert.equal(handed.legacy, 'handoff:react');
  assert.equal(handed.session['pokoin.ui.once'], undefined);
  for (const pref of ['react', 'react-auto']) {
    const run = boot(script, { local: { 'pokoin.ui': pref } });
    assert.equal(run.ui, 'solid');
    assert.equal(run.legacy, `pref:${pref}`);
    assert.equal(run.local['pokoin.ui'], undefined, 'the stored preference is cleared');
  }
  const solidPref = boot(script, { local: { 'pokoin.ui': 'solid-auto' } });
  assert.equal(solidPref.legacy, undefined);
  assert.equal(solidPref.local['pokoin.ui'], undefined);
  assert.equal(boot(script, { path: '/cart' }).legacy, 'unowned');
});

test('storage failures still boot Solid', () => {
  const { script } = buildShell(REACT, SOLID, { owned: OWNED });
  const written = [];
  const window = {};
  window.self = window;
  window.top = window;
  runInContext(script, createContext({
    window,
    location: { pathname: '/marketplace', search: '?ui=react' },
    URLSearchParams,
    get localStorage() { throw new Error('blocked'); },
    sessionStorage: { getItem() { throw new Error('blocked'); } },
    Math,
    document: { write: (html) => written.push(html) },
  }));
  assert.equal(window.__POKOIN_UI__, 'solid');
  assert.equal(window.__POKOIN_REACT_LEGACY__, 'ui=react');
  assert.ok(written.join('').includes('index-S.js'));
});

test('owned routes cover the Solid pages and nothing React still serves', () => {
  const config = JSON.parse(readFileSync(new URL('../solid/owned-routes.json', import.meta.url), 'utf8'));
  assert.equal(typeof config.enabled, 'boolean');
  const owns = (pathname) => config.patterns.some((re) => new RegExp(re).test(pathname));
  for (const pathname of [
    '/marketplace',
    '/marketplace/',
    '/marketplace/search',
    '/marketplace/en/cards/806390',
    '/marketplace/en/cards/806390/card-mega-rayquaza-ex-gold-secret-rare-113-076-storm-emeralda',
    '/marketplace/zht/cards/806390/versions',
    '/marketplace/it/cards/806390/some-slug/versions',
    '/marketplace/eras',
    '/marketplace/eras/ex',
    '/marketplace/sets',
    '/marketplace/sets/base-set/',
    '/marketplace/en/artists',
    '/marketplace/en/artists/mitsuhiro-arita',
    '/marketplace/en/users/seller',
    '/marketplace/en/pokemon/pikachu',
    '/marketplace/en/rarities',
    '/marketplace/jp/languages/japanese',
    '/marketplace/en/guides/grading',
    '/marketplace/explore',
    '/marketplace/watchlist',
    '/favorites',
    '/product',
    '/product/graded',
    '/marketplace/competitive',
    '/marketplace/competitive/decks/abc',
    '/marketplace/competitive/decklists/123',
    '/marketplace/competitive/tournaments',
    '/docs',
    '/privacy/',
    '/health',
    '/sitemap',
    '/tests',
    '/sanitize/',
    '/ocr/artists',
    '/poko/archive',
    '/jumbos',
    '/admin',
    '/marketplace/admin/edit',
    '/scan',
    '/cardscan/',
    '/inventory/scan',
    '/dashboard/scan',
    '/inventory/sync-review',
    '/forum',
    '/forum/category/general',
    '/forum/topic/abc123/',
    '/about',
    '/careers',
  ]) assert.ok(owns(pathname), pathname);
  for (const pathname of [
    '/cart', '/checkout', '/orders', '/bought', '/buy', '/sales', '/wallet', '/exchange', '/swap', '/nft',
    '/flex', '/shipping', '/protection', '/marketplace/signal', '/auth', '/extension/auth-bridge', '/profile',
    '/dashboard', '/stock', '/messages', '/messages/poko', '/associate', '/mypokoin', '/mypokoin/collection',
    '/mypokoin/location/box1', '/inventory', '/collection', '/marketplace/portfolio', '/marketplace/portfolio/abc',
    '/invite', '/join/code', '/ambassador', '/ambassadorprogram', '/email-preferences', '/marketplace/en/users/seller',
  ]) assert.ok(owns(pathname), pathname);
  // Nothing React routes is left; these are unknown paths (Solid's catch-all).
  for (const pathname of [
    '/',
    '/marketplace/en/users',
    '/marketplace/competitive/decklists',
    '/marketplace/search/extra',
    '/marketplace/en/cards/806390/slug/other',
    '/ocr/artists/x',
    '/forum/topic',
    '/scan/extra',
    '/dash-preview',
  ]) assert.ok(!owns(pathname), pathname);
});

test('other games route under their basename like the Pokemon site', async () => {
  const games = await gameSlugs(new URL('..', import.meta.url).pathname);
  assert.ok(games.includes('one-piece') && games.includes('magic') && !games.includes(''));
  assert.equal(routePath('/one-piece/marketplace', games), '/marketplace');
  assert.equal(routePath('/one-piece', games), '/');
  assert.equal(routePath('/one-piece-fan/marketplace', games), '/one-piece-fan/marketplace');
  assert.equal(routePath('/marketplace/sets', games), '/marketplace/sets');
  const tags = { solid: '<s>' };
  const script = bootScript({ owned: OWNED, games, tags });
  assert.equal(boot(script, { path: '/one-piece/marketplace' }).legacy, undefined);
  assert.equal(boot(script, { path: '/magic/marketplace/en/cards/12/x' }).legacy, undefined);
  assert.equal(boot(script, { path: '/one-piece' }).legacy, 'unowned');
  assert.equal(boot(script, { path: '/unknown-game/marketplace' }).legacy, 'unowned');
  assert.equal(boot(bootScript({ owned: OWNED, tags }), { path: '/one-piece/marketplace' }).legacy, 'unowned');
});
