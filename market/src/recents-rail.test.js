import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECENT_RAIL_FRESH_MS,
  recentRailRefreshedAt,
  refreshRecentTiles,
  railThumbUrl,
  resetRecentRailForTests,
  stableRecentIds,
  syncRecentAccount,
  warmRecentThumbs,
} from './recents-rail.js';
import { clearRecentTileMemory, readRecentTiles, recentIdsKey, recentTilesKey } from './recents-storage.js';

function memoryStorage(start = {}) {
  const data = { ...start };
  return {
    get length() {
      return Object.keys(data).length;
    },
    key(index) {
      return Object.keys(data)[index] || null;
    },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

function seed(ids, tiles = {}, extra = {}) {
  clearRecentTileMemory();
  resetRecentRailForTests();
  globalThis.localStorage = memoryStorage({
    [recentIdsKey('pokemon')]: JSON.stringify(ids),
    [recentTilesKey('pokemon')]: JSON.stringify(tiles),
    ...extra,
  });
  globalThis.sessionStorage = memoryStorage();
}

const tile = (id, name, price) => ({ id, name, price, gridImageUrl: `/card-images/${id}_${name.toLowerCase()}.jpg` });

test('a refresh keeps the painted order and appends new ids at the end', () => {
  assert.deepEqual(stableRecentIds(['3', '1', '2'], ['9', '1', '3', '8']), ['3', '1', '2', '9', '8']);
  // Ids the account no longer lists stay on screen for this visit.
  assert.deepEqual(stableRecentIds(['3', '1'], ['1']), ['3', '1']);
  assert.deepEqual(stableRecentIds([], ['5', '4']), ['5', '4']);
  assert.deepEqual(stableRecentIds(['1', '', null, '1'], undefined), ['1']);
});

test('rail thumbs are the homepage derivative a rail tile asks for first', () => {
  assert.equal(
    railThumbUrl({ id: '806390', name: 'Mega Rayquaza ex', gridImageUrl: 'https://cdn.pokoin.com/403195_mega-rayquaza-ex.jpg' }),
    'https://cdn.pokoin.com/403195_mega-rayquaza-ex_homepage.webp?v=t480',
  );
  assert.equal(railThumbUrl(null), '');
  const preloaded = [];
  const urls = warmRecentThumbs([
    tile('806390', 'Rayquaza', 1),
    tile('806390', 'Rayquaza', 1),
    tile('806338', 'Azurill', 2),
    tile('806384', 'Golurk', 3),
  ], 3, (list) => preloaded.push(...list));
  assert.equal(urls.length, 2);
  assert.deepEqual(preloaded, urls);
  assert.match(urls[0], /_homepage\.webp\?v=t480$/);
});

test('a fresh stored rail only fetches the tiles it is missing', async () => {
  const now = 10 * RECENT_RAIL_FRESH_MS;
  seed(['1', '2', '3'], { 1: tile('1', 'Pikachu', 100), 3: tile('3', 'Eevee', 300) }, {
    'pokoin.recentRailAt.pokemon': String(now - 1000),
  });
  const asked = [];
  const changed = await refreshRecentTiles({
    now,
    deps: {
      fetchTiles: async (ids) => {
        asked.push(ids);
        return ids.map((id) => tile(id, 'Lugia', 200));
      },
      fillPrices: async (cards) => cards,
    },
  });
  assert.equal(changed, true);
  assert.deepEqual(asked, [['2']]);
  assert.deepEqual(readRecentTiles('pokemon').map((row) => [row.id, row.name, row.price]), [
    ['1', 'Pikachu', 100],
    ['2', 'Lugia', 200],
    ['3', 'Eevee', 300],
  ]);
  // Nothing missing and still fresh: no request.
  assert.equal(await refreshRecentTiles({ now, deps: { fetchTiles: async () => assert.fail('no fetch') } }), false);
});

test('a stale stored rail refetches every tile, prices unlisted ones and marks itself fresh', async () => {
  const now = 10 * RECENT_RAIL_FRESH_MS;
  seed(['1', '2'], { 1: tile('1', 'Pikachu', 100), 2: tile('2', 'Lugia', 200) }, {
    'pokoin.recentRailAt.pokemon': String(now - RECENT_RAIL_FRESH_MS - 1),
  });
  const asked = [];
  const changed = await refreshRecentTiles({
    now,
    deps: {
      fetchTiles: async (ids, options) => {
        asked.push([ids, options]);
        return [tile('1', 'Pikachu', 120), { ...tile('2', 'Lugia', 0), price: null }];
      },
      fillPrices: async (cards) => cards.map((card) => (card.id === '2' ? { ...card, price: 210 } : card)),
    },
  });
  assert.equal(changed, true);
  assert.deepEqual(asked, [[['1', '2'], { priority: 'low', game: 'pokemon' }]]);
  assert.deepEqual(readRecentTiles('pokemon').map((row) => row.price), [120, 210]);
  assert.equal(recentRailRefreshedAt('pokemon'), now);
});

test('a failed refresh keeps the stored rail and stays stale', async () => {
  seed(['1'], { 1: tile('1', 'Pikachu', 100) });
  const before = JSON.stringify(readRecentTiles('pokemon'));
  const changed = await refreshRecentTiles({ deps: { fetchTiles: async () => { throw new Error('offline'); } } });
  assert.equal(changed, false);
  assert.equal(JSON.stringify(readRecentTiles('pokemon')), before);
  assert.equal(recentRailRefreshedAt('pokemon'), 0);
});

test('concurrent refreshes share one request', async () => {
  seed(['1', '2'], { 1: tile('1', 'Pikachu', 100) });
  let calls = 0;
  const deps = {
    fetchTiles: async (ids) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ids.map((id) => tile(id, 'Mew', 50));
    },
    fillPrices: async (cards) => cards,
  };
  const [a, b] = await Promise.all([refreshRecentTiles({ deps }), refreshRecentTiles({ deps })]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('the account sync runs at most once a minute and once at a time', async () => {
  seed(['1']);
  let calls = 0;
  const sync = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return ['9', '1'];
  };
  const [a, b] = await Promise.all([syncRecentAccount({ sync }), syncRecentAccount({ sync })]);
  assert.deepEqual(a, ['9', '1']);
  assert.deepEqual(b, ['9', '1']);
  assert.equal(calls, 1);
  assert.deepEqual(await syncRecentAccount({ sync }), ['1']);
  assert.equal(calls, 1);
  await syncRecentAccount({ sync, force: true });
  assert.equal(calls, 2);
});

test('a refreshed tile moves price and stock, never the stored scan or identity', async () => {
  const { refreshTile } = await import('./recents-rail.js');
  const desk = {
    id: '695126',
    name: "Lillie's Determination",
    number: '119/132',
    price: 64,
    tileImageUrl: '/card-images/695126_lillie-s-determination_homepage.webp',
    gridImageUrl: '/card-images/695126_lillie-s-determination.jpg',
  };
  const read = { id: '695126', name: 'Lillies Determination', price: 70, inStock: true, tileImageUrl: '/card-images/695126_lillie-s-determination.jpg' };
  const next = refreshTile(desk, read);
  assert.equal(next.price, 70);
  assert.equal(next.inStock, true);
  assert.equal(next.name, desk.name);
  assert.equal(next.tileImageUrl, desk.tileImageUrl);
  assert.equal(railThumbUrl(next), railThumbUrl(desk));
  // Sold out without a median: the last price stays.
  assert.equal(refreshTile(desk, { id: '695126', name: 'x', price: null }).price, 64);
  // Nothing stored yet: the read is the tile.
  assert.equal(refreshTile(undefined, read), read);
});
