'use strict';

/**
 * Targeted Redis invalidation after marketplace mutations.
 * Postgres remains authoritative; this only bumps generations / DELs so the
 * next read rebuilds from SQL/Firestore immediately.
 */

const { invalidateCard, invalidateSearch, invalidateHome } = require('./_read_model_cache');
const { invalidateSellerShop } = require('./_seller_shop_cache');

async function invalidateMarketplaceReads({
  game = 'pokemon',
  cardId = '',
  sellerUid = '',
  reason = 'mutation',
} = {}) {
  const tasks = [
    invalidateSearch(game),
    invalidateHome(game),
  ];
  if (cardId) tasks.push(invalidateCard(game, cardId));
  if (sellerUid) tasks.push(invalidateSellerShop(sellerUid));
  await Promise.all(tasks);
  console.warn(JSON.stringify({
    msg: 'redis_cache_invalidate',
    reason,
    game: game || 'pokemon',
    cardId: cardId || null,
    sellerUid: sellerUid || null,
  }));
}

module.exports = {
  invalidateMarketplaceReads,
};
