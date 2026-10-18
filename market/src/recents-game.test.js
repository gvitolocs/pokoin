import assert from 'node:assert/strict';
import test from 'node:test';
import { withGameQuery, gameIdFromHost, gameRequestHeaders, sellerDeskUsesGameOverride, setGamePathSource, setScanGameOverride } from './game.js';

test('hostnames map to canonical game ids used by recents', () => {
  assert.equal(gameIdFromHost('pokoin.com'), 'pokemon');
  assert.equal(gameIdFromHost('onepiece.pokoin.com'), 'one_piece');
  assert.equal(gameIdFromHost('riftbound.pokoin.com'), 'riftbound');
  assert.equal(gameIdFromHost('pokoin.com', '/one-piece/marketplace'), 'one_piece');
  assert.equal(gameIdFromHost('pokoin.com', '/magic/marketplace/search'), 'magic');
  assert.equal(gameIdFromHost('pokoin.com', '/yugioh'), 'yugioh');
  assert.equal(gameIdFromHost('pokoin.com', '/marketplace'), 'pokemon');
});

test('scan game picker applies on /dashboard, not on the marketplace', () => {
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/dashboard'), true);
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/dashboard/scan'), true);
  assert.equal(sellerDeskUsesGameOverride('www.pokoin.com', '/dashboard/'), true);
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/marketplace'), false);
  assert.equal(sellerDeskUsesGameOverride('pokoin.com', '/scan'), false);
  assert.equal(sellerDeskUsesGameOverride('dashboard.pokoin.com', '/'), true);
  assert.equal(sellerDeskUsesGameOverride('localhost', '/marketplace'), true);
  assert.equal(sellerDeskUsesGameOverride('onepiece.pokoin.com', '/dashboard'), false);
});

test('withGameQuery scopes marketplace-recents on satellite hosts', () => {
  assert.equal(
    withGameQuery('/api/marketplace-recents', 'pokoin.com'),
    '/api/marketplace-recents',
  );
  assert.equal(
    withGameQuery('/api/marketplace-recents', 'riftbound.pokoin.com'),
    '/api/marketplace-recents?game=riftbound',
  );
  assert.equal(
    withGameQuery('/api/marketplace-recents', 'onepiece.pokoin.com'),
    '/api/marketplace-recents?game=one_piece',
  );
});

test('withGameQuery scopes marketplace-card-tiles on satellite hosts', () => {
  assert.equal(
    withGameQuery('/api/marketplace-card-tiles?ids=1,2', 'riftbound.pokoin.com'),
    '/api/marketplace-card-tiles?ids=1,2&game=riftbound',
  );
  assert.equal(
    withGameQuery('/api/marketplace-card-tiles?ids=1', 'onepiece.pokoin.com'),
    '/api/marketplace-card-tiles?ids=1&game=one_piece',
  );
});


test('MyPokoin and stock routes keep the game picker inside the inventory desk', () => {
  for (const host of ['pokoin.com', 'www.pokoin.com', '127.0.0.1']) {
    for (const path of ['/mypokoin', '/mypokoin/', '/mypokoin/location/box1',
      '/mypokoin/collection', '/mypokoin/import', '/mypokoin/spreadsheet',
      '/mypokoin/settings', '/inventory/scan', '/inventory/sync-review']) {
      assert.equal(sellerDeskUsesGameOverride(host, path), true, `${host}${path}`);
    }
    assert.equal(sellerDeskUsesGameOverride(host, '/mypokoin-other'), false);
    assert.equal(sellerDeskUsesGameOverride(host, '/marketplace'), false);
  }
});

test('changing the private inventory game scopes listing pages and headers without changing its URL', () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  const path = '/mypokoin/location/box1';
  globalThis.window = {
    location: { hostname: 'pokoin.com', pathname: path },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  setGamePathSource(() => path);
  try {
    for (const id of ['one_piece', 'magic', 'riftbound', 'pokemon']) {
      setScanGameOverride(id);
      assert.equal(gameIdFromHost('pokoin.com'), id);
      const query = id === 'pokemon' ? '' : `&game=${id}`;
      assert.equal(withGameQuery('/api/marketplace-listings?sellerUid=u1&offset=200'),
        `/api/marketplace-listings?sellerUid=u1&offset=200${query}`);
      assert.equal(gameRequestHeaders()['x-pokoin-game'], id === 'pokemon' ? undefined : id);
      assert.equal(window.location.pathname, path);
      assert.equal(gameIdFromHost('pokoin.com', '/marketplace'), 'pokemon');
      assert.equal(gameIdFromHost('pokoin.com', '/one-piece/marketplace'), 'one_piece');
    }
  } finally {
    setGamePathSource(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
