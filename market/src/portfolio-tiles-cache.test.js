import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PORTFOLIO_TILES_CACHE_PREFIX,
  normalizePortfolioTiles,
  portfolioTilesCacheKey,
  portfolioTilesFingerprint,
  portfolioTilesFromSummary,
  readPortfolioTilesCache,
  writePortfolioTilesCache,
} from './portfolio-tiles-cache.js';

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

test('cache key is uid-scoped', () => {
  assert.equal(portfolioTilesCacheKey('u1'), `${PORTFOLIO_TILES_CACHE_PREFIX}:u1`);
  assert.equal(portfolioTilesCacheKey(''), '');
});

test('summary API maps into tile fields', () => {
  const tiles = portfolioTilesFromSummary({
    cardsOwned: 12,
    physicalOwned: 10,
    nftOwned: 2,
    items: 9,
  });
  assert.deepEqual(tiles, {
    ownedCards: 12,
    physicalOwned: 10,
    nftOwned: 2,
    uniqueItems: 9,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(tiles, 'listed'), false);
});

test('summary with a listed object maps copies onto the inventory tile', () => {
  const tiles = portfolioTilesFromSummary({
    cardsOwned: 1473,
    physicalOwned: 1470,
    nftOwned: 3,
    items: 190,
    listed: { listings: 1463, copies: 1472, listedPkn: 99 },
  });
  assert.equal(tiles.ownedCards, 1473);
  assert.deepEqual(tiles.listed, { listings: 1463, cards: 1472, listedPkn: 99 });
});

test('summary with null listed omits the inventory tile so a merge keeps it', () => {
  globalThis.localStorage = memoryStore();
  const uid = 'user-listed';
  writePortfolioTilesCache(uid, {
    ownedCards: 5,
    physicalOwned: 4,
    nftOwned: 1,
    uniqueItems: 5,
    listed: { listings: 2, cards: 3, listedPkn: 900 },
  });
  const tiles = portfolioTilesFromSummary({
    cardsOwned: 7,
    physicalOwned: 7,
    nftOwned: 0,
    items: 4,
    listed: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(tiles, 'listed'), false);
  writePortfolioTilesCache(uid, tiles);
  const cached = readPortfolioTilesCache(uid);
  assert.equal(cached.ownedCards, 7);
  assert.equal(cached.listed.listings, 2);
  assert.equal(cached.listed.cards, 3);
  assert.equal(cached.listed.listedPkn, 900);
  delete globalThis.localStorage;
});

test('fingerprint changes when a tile metric changes', () => {
  const a = normalizePortfolioTiles({ ownedCards: 1, physicalOwned: 1, listed: { cards: 0, listings: 0, listedPkn: 0 } });
  const b = normalizePortfolioTiles({ ownedCards: 2, physicalOwned: 1, listed: { cards: 0, listings: 0, listedPkn: 0 } });
  assert.notEqual(portfolioTilesFingerprint(a), portfolioTilesFingerprint(b));
});

test('localStorage read/write merges listed onto collection tiles', () => {
  globalThis.localStorage = memoryStore();
  const uid = 'user-1';
  writePortfolioTilesCache(uid, {
    ownedCards: 5,
    physicalOwned: 4,
    nftOwned: 1,
    uniqueItems: 5,
  });
  writePortfolioTilesCache(uid, {
    listed: { listings: 2, cards: 3, listedPkn: 900 },
  });
  const cached = readPortfolioTilesCache(uid);
  assert.equal(cached.ownedCards, 5);
  assert.equal(cached.physicalOwned, 4);
  assert.equal(cached.nftOwned, 1);
  assert.equal(cached.listed.cards, 3);
  assert.equal(cached.listed.listedPkn, 900);
  assert.equal(cached.fingerprint, portfolioTilesFingerprint(cached));
  delete globalThis.localStorage;
});
