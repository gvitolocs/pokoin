'use strict';

/**
 * React marketplace home. Fast indexed SQL only.
 * Flutter keeps GET /api/marketplace-home (hydrate + 240-row fallback).
 *
 * Pokoin overlay (server/pokoin-api) — replaces the legacy CardVault
 * api/marketplace-home-page.js copy on the Pi release.
 *
 * Redis cache contract for home snapshots
 * (`pokoin:marketplace:v1:home:react[:game:{id}]:g{gen}`):
 *   - short TTL (HOME_TTL_SEC) plus generation bump on listing/rails changes
 *   - in-process coalesce so concurrent misses share one SQL/rails load
 *   - a parsed snapshot whose `cards` is an Array is a valid hit, including
 *     the empty snapshot — an empty catalog is cached for the same short TTL
 *     instead of re-running the SQL fallback on every request.
 *   - anything else (null on miss/error, malformed payload) is a miss.
 */
const { toReactCards, parseLimit, setCorsHeaders, jsonOk, withTimeout } = require('./_marketplace_react_card');
const { mergeRecentIntoHome, recentIdsFromUrl } = require('./_marketplace_home_recent');
const { parseGameFromRequest, runWithGame, isPokemonGame, currentGame } = require('./_marketplace_game');
const sql = require('./_marketplace_react_sql');
const redisCache = require('./_redis_cache');
const {
  HOME_TTL_SEC,
  homeSnapshotKey,
  coalesce,
} = require('./_read_model_cache');
const { generationKey } = require('./_redis_ns');
const { publicErrorBody, publicErrorStatus } = require('./_public_error');
const { timed } = require('./_request_timing');

const SNAPSHOT_TTL_SEC = HOME_TTL_SEC;

function emptySections() {
  return {
    recentlySeenIds: [],
    bestSellerIds: [],
    featuredIds: [],
    newArrivalIds: [],
    spotlightIds: [],
    topSoldIds: [],
  };
}

async function homeGeneration(game) {
  const raw = await timed('redisCacheMs', () => redisCache.command([
    'GET',
    generationKey(`home:${game || 'pokemon'}`),
  ]));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? String(n) : '0';
}

async function buildHomeSnapshot({ limit = 36 } = {}) {
  if (isPokemonGame()) {
    try {
      const { readRails, assembleHomeVector, HOME_RAILS } = require('./_marketplace_rails');
      const rows = await readRails(HOME_RAILS.map((row) => row[0]));
      if (rows.length) {
        const fromRails = assembleHomeVector(rows);
        if ((fromRails.cards || []).length) {
          return fromRails;
        }
      }
    } catch (_) {
      /* newest/hot SQL fallback */
    }
  }
  const newestCap = Math.min(limit, 24);
  const hotCap = Math.min(12, limit);
  const [newestRows, hotRows] = await Promise.all([
    withTimeout(() => sql.readNewestEnglishCards(newestCap), 2500, [], 'marketplace-home-page newest'),
    withTimeout(() => sql.readHotCards(hotCap), 2500, [], 'marketplace-home-page hot'),
  ]);
  const byId = new Map();
  for (const row of [...newestRows, ...hotRows]) {
    const id = String(row.card_id || '');
    if (id && !byId.has(id)) {
      byId.set(id, row);
    }
  }
  const ids = [...byId.keys()];
  const blueprintIds = [...byId.values()].map((row) => Number(row.ct_id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  const [paths, cheapest] = await Promise.all([
    withTimeout(() => sql.readCanonicalPaths(ids), 2000, new Map(), 'marketplace-home-page urls'),
    withTimeout(
      () => sql.readCheapestMap(ids, blueprintIds),
      2000,
      { byCardId: new Map(), byBlueprint: new Map() },
      'marketplace-home-page cheapest',
    ),
  ]);
  const enriched = sql.applyCanonicalAndCheapest([...byId.values()], paths, cheapest);
  const cards = toReactCards(enriched);
  const newestIds = newestRows.map((row) => String(row.card_id)).filter(Boolean);
  const hotIds = hotRows.map((row) => String(row.card_id)).filter(Boolean);
  return {
    cards,
    sections: {
      recentlySeenIds: [],
      newArrivalIds: newestIds.slice(0, 12),
      featuredIds: hotIds.slice(0, 12),
      bestSellerIds: hotIds.slice(0, 12),
      spotlightIds: newestIds.slice(0, 16),
    },
  };
}

async function defaultLoadHomeSnapshot({ limit = 36 } = {}) {
  const game = currentGame();
  const baseKey = homeSnapshotKey(game);
  return coalesce(baseKey, async () => {
    const gen = await homeGeneration(game);
    const cacheKey = `${baseKey}:g${gen}`;
    const cached = await timed('redisCacheMs', () => redisCache.getJson(cacheKey));
    if (cached && typeof cached === 'object' && Array.isArray(cached.cards)) {
      return { ...cached, cacheSource: 'redis' };
    }
    const snapshot = await buildHomeSnapshot({ limit });
    // A valid empty snapshot is cached too: it keeps a catalog hiccup from
    // turning into one uncached SQL fallback per request.
    await timed('redisCacheMs', () => redisCache.setJson(cacheKey, snapshot, SNAPSHOT_TTL_SEC));
    return { ...snapshot, cacheSource: 'postgres' };
  });
}

function createHandler(deps = {}) {
  const loadSnapshot = deps.loadHomeSnapshot || defaultLoadHomeSnapshot;
  const loadByIds = deps.loadCardsByIds || (async (ids) => {
    const rows = await sql.readCandidatesByCardIds(ids);
    const paths = await sql.readCanonicalPaths(ids);
    const cheapest = await sql.readCheapestMap(
      ids,
      rows.map((row) => Number(row.ct_id)).filter((id) => Number.isSafeInteger(id) && id > 0),
    );
    return toReactCards(sql.applyCanonicalAndCheapest(rows, paths, cheapest));
  });

  return async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const game = parseGameFromRequest(req);
    return runWithGame(game, async () => {
      try {
        const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
        const recentIds = recentIdsFromUrl(url);
        const limit = parseLimit(url.searchParams.get('limit'), 36, 48);
        let snapshot = await loadSnapshot({ limit, recentIds });

        let extra = [];
        if (recentIds.length > 0) {
          const existing = new Set((snapshot.cards || []).map((card) => String(card.id)));
          const missing = recentIds.filter((id) => !existing.has(String(id)));
          if (missing.length) {
            extra = await withTimeout(() => loadByIds(missing), 2000, [], 'marketplace-home-page recent');
          }
          snapshot = mergeRecentIntoHome(snapshot, recentIds, extra);
          return jsonOk(res, {
            ...snapshot,
            game,
            sections: { ...emptySections(), ...(snapshot.sections || {}) },
          }, 'private, max-age=0, no-store');
        }

        return jsonOk(res, {
          ...snapshot,
          cards: snapshot.cards || [],
          game,
          source: snapshot.source || undefined,
          sections: { ...emptySections(), ...(snapshot.sections || {}) },
        }, 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');
      } catch (error) {
        console.error('marketplace-home-page failed', error);
        return res.status(publicErrorStatus(error)).json(
          publicErrorBody(error, 'Marketplace home page failed.'),
        );
      }
    });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._test = { createHandler, defaultLoadHomeSnapshot };
