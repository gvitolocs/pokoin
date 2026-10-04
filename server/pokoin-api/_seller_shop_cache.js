'use strict';

/**
 * Redis read-through cache for public seller-shop first pages.
 *
 * Only cacheable when the request is a plain browse page (no text/filter
 * facets, not the full `book=` download). Listing mutations bump a per-seller
 * generation so the next read misses immediately.
 *
 * Key: pokoin:marketplace:v1:seller-shop-ct:{game}:{uid}:l{limit}:o{offset}:s{sort}:g{gen}
 * TTL: 20s (safety net). Source of truth: marketplace_user_listings.
 * Stale tolerance: 0 for seller/admin mutations (gen bump); ≤20s otherwise.
 */

const redisCache = require('./_redis_cache');
const { marketplaceKey, generationKey } = require('./_redis_ns');
const { coalesce } = require('./_read_model_cache');
const { timed } = require('./_request_timing');

const SHOP_TTL_SEC = Number(process.env.POKOIN_SELLER_SHOP_CACHE_TTL || 20);

function cacheEnabled() {
  if (process.env.POKOIN_READ_CACHE === '0') return false;
  if (process.env.NODE_TEST_CONTEXT && process.env.POKOIN_READ_CACHE !== '1') return false;
  return true;
}

function cleanSort(sort) {
  const raw = String(sort || '').trim().toLowerCase() || 'default';
  return raw.replace(/[^a-z0-9_-]+/g, '').slice(0, 40) || 'default';
}

/**
 * @returns {string} empty when the request must not be cached
 */
function sellerShopKey({
  game = 'pokemon',
  sellerUid,
  limit,
  offset = 0,
  sort = '',
  book = false,
  q = '',
  condition = '',
  language = '',
  rarity = '',
  reverseOnly = false,
  firstEditionOnly = false,
  fresh = false,
} = {}) {
  if (!cacheEnabled() || fresh || book) return '';
  const uid = String(sellerUid || '').trim();
  if (!uid) return '';
  if (q || condition || language || rarity || reverseOnly || firstEditionOnly) return '';
  const capped = Math.trunc(Number(limit) || 0);
  const start = Math.trunc(Number(offset) || 0);
  if (capped < 1 || capped > 100 || start < 0 || start > 5000) return '';
  return marketplaceKey(
    'seller-shop-ct',
    game || 'pokemon',
    uid,
    `l${capped}`,
    `o${start}`,
    `s${cleanSort(sort)}`,
  );
}

async function generation(sellerUid) {
  const raw = await timed('redisCacheMs', () => redisCache.command([
    'GET',
    generationKey(`seller-shop:${sellerUid}`),
  ]));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? String(n) : '0';
}

async function loadSellerShop(keyParts, load) {
  const key = sellerShopKey(keyParts);
  if (!key) {
    return { payload: await load(), source: 'postgres' };
  }
  const uid = String(keyParts.sellerUid || '').trim();
  return coalesce(key, async () => {
    const gen = await generation(uid);
    const hit = await timed('redisCacheMs', () => redisCache.getJson(`${key}:g${gen}`));
    if (hit && typeof hit === 'object' && Array.isArray(hit.listings)) {
      return { payload: hit, source: 'redis' };
    }
    const payload = await load();
    if (payload && Array.isArray(payload.listings)) {
      await timed('redisCacheMs', () => redisCache.setJson(`${key}:g${gen}`, payload, SHOP_TTL_SEC));
    }
    return { payload, source: 'postgres' };
  });
}

async function invalidateSellerShop(sellerUid) {
  const uid = String(sellerUid || '').trim();
  if (!uid || !cacheEnabled()) return null;
  return timed('redisCacheMs', () => redisCache.command([
    'INCR',
    generationKey(`seller-shop:${uid}`),
  ]));
}

module.exports = {
  SHOP_TTL_SEC,
  sellerShopKey,
  loadSellerShop,
  invalidateSellerShop,
  cacheEnabled,
};
