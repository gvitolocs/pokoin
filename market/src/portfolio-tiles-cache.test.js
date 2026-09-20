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
