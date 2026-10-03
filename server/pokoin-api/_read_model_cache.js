'use strict';

const crypto = require('node:crypto');
const redisCache = require('./_redis_cache');
const { marketplaceKey, generationKey } = require('./_redis_ns');
const { timed } = require('./_request_timing');

const CARD_TTL_SEC = Number(process.env.POKOIN_CARD_CACHE_TTL || 20);
const SEARCH_TTL_SEC = Number(process.env.POKOIN_SEARCH_CACHE_TTL || 20);
const HOME_TTL_SEC = Number(process.env.POKOIN_HOME_CACHE_TTL || 20);
const flights = new Map();

function cacheEnabled() {
  if (process.env.POKOIN_READ_CACHE === '0') return false;
  if (process.env.NODE_TEST_CONTEXT && process.env.POKOIN_READ_CACHE !== '1') return false;
  return true;
}

function cardPageKey({
  game = 'pokemon',
  cardId,
  lang = 'en',
  includeOffers = false,
  includeSales = false,
  includeSameAs = false,
  liveOffers = false,
} = {}) {
  if (liveOffers) return '';
  const id = String(cardId || '').trim();
  if (!id) return '';
  return marketplaceKey(
    'card',
    String(game || 'pokemon'),
    id,
    String(lang || 'en').toLowerCase(),
    includeOffers ? 'offers' : 'nooffers',
    includeSales ? 'sales' : 'nosales',
    includeSameAs ? 'same' : 'nosame',
  );
}

function searchPageKey({
  game = 'pokemon',
  query,
  lang = 'en',
  limit = 24,
  offset = 0,
  productType = '',
  printLanguage = 'all',
  productSearchOnly = false,
} = {}) {
  const text = String(query || '').trim().toLowerCase();
  const capped = Math.trunc(Number(limit) || 0);
  const start = Math.trunc(Number(offset) || 0);
  if (text.length < 2 || text.length > 48) return '';
  if (start !== 0 || capped < 1 || capped > 48) return '';
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  return marketplaceKey(
    'search',
    String(game || 'pokemon'),
    String(lang || 'en').toLowerCase(),
    String(productType || 'any'),
    String(printLanguage || 'all'),
    productSearchOnly ? 'products' : 'mixed',
    String(capped),
    digest,
  );
}

function homeSnapshotKey(game = 'pokemon') {
  const id = String(game || 'pokemon');
  return id === 'pokemon'
    ? marketplaceKey('home', 'react')
    : marketplaceKey('home', 'react', 'game', id);
}

async function generation(scope) {
  const raw = await timed('redisCacheMs', () => redisCache.command(['GET', generationKey(scope)]));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? String(n) : '0';
}

async function readAssembled(key, scope) {
  if (!cacheEnabled() || !key) return null;
  const gen = await generation(scope);
  const hit = await timed('redisCacheMs', () => redisCache.getJson(`${key}:g${gen}`));
  return hit && typeof hit === 'object' ? hit : null;
}

async function writeAssembled(key, scope, payload, ttlSeconds) {
  if (!cacheEnabled() || !key || payload == null) return false;
  const gen = await generation(scope);
  return timed('redisCacheMs', () => redisCache.setJson(`${key}:g${gen}`, payload, ttlSeconds));
}

async function bumpGeneration(scope) {
  if (!cacheEnabled() || !scope) return null;
  return timed('redisCacheMs', () => redisCache.command(['INCR', generationKey(scope)]));
}

async function invalidateHome(game = 'pokemon') {
  if (!cacheEnabled()) return null;
  const scope = `home:${game || 'pokemon'}`;
  await bumpGeneration(scope);
  // Also drop the legacy TTL key used before gen-scoped home caching.
  await timed('redisCacheMs', () => redisCache.del(homeSnapshotKey(game)));
  return true;
}

function beginFlight(key) {
  if (!key) {
    return { leader: true, wait: Promise.resolve(null), finish() {}, fail() {} };
  }
  const flightKey = `flight:${key}`;
  const existing = flights.get(flightKey);
  if (existing) return { leader: false, wait: existing, finish() {}, fail() {} };
  let finish = () => {};
  let fail = () => {};
  const flight = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  flight.catch(() => {});
  flights.set(flightKey, flight);
  const drop = () => {
    if (flights.get(flightKey) === flight) flights.delete(flightKey);
  };
  return {
    leader: true,
    wait: flight,
    finish(value) { drop(); finish(value); },
    fail(error) { drop(); fail(error); },
  };
}

function coalesce(key, load) {
  if (!key) return load();
  const existing = flights.get(key);
  if (existing) return existing;
  const flight = Promise.resolve()
    .then(load)
    .finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
}

async function loadCardPage(keyParts, load) {
  const key = cardPageKey(keyParts);
  const scope = `card:${keyParts.game || 'pokemon'}:${keyParts.cardId}`;
  return coalesce(key || `miss:${keyParts.cardId}`, async () => {
    const cached = await readAssembled(key, scope);
    if (cached) return { payload: cached, source: 'redis' };
    const payload = await load();
    if (payload) await writeAssembled(key, scope, payload, CARD_TTL_SEC);
    return { payload, source: 'postgres' };
  });
}

async function loadSearchPage(keyParts, load) {
  const key = searchPageKey(keyParts);
  const scope = `search:${keyParts.game || 'pokemon'}`;
  return coalesce(key || `search-miss:${keyParts.query}`, async () => {
    const cached = await readAssembled(key, scope);
    if (cached) return { payload: cached, source: 'redis' };
    const payload = await load();
    if (payload) await writeAssembled(key, scope, payload, SEARCH_TTL_SEC);
    return { payload, source: 'postgres' };
  });
}

async function invalidateCard(game, cardId) {
  return bumpGeneration(`card:${game || 'pokemon'}:${cardId}`);
}

async function invalidateSearch(game) {
  return bumpGeneration(`search:${game || 'pokemon'}`);
}

module.exports = {
  CARD_TTL_SEC,
  SEARCH_TTL_SEC,
  HOME_TTL_SEC,
  cardPageKey,
  searchPageKey,
  homeSnapshotKey,
  loadCardPage,
  loadSearchPage,
  beginFlight,
  coalesce,
  invalidateCard,
  invalidateSearch,
  invalidateHome,
  bumpGeneration,
  cacheEnabled,
  _test: { flights },
};
