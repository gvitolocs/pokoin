'use strict';

/**
 * Shared Pokoin API — game-scoped Recently Seen.
 *
 * Canonical source for the Pi overlay. Deploy with
 * `scripts/deploy-recents-api.sh` from an origin/main commit.
 * Both Pokoin Web and CardVault (app) consume this same contract on
 * api.pokoin.com — this is not a website-only or CardVault-app backend.
 *
 * Sibling requires (`_marketplace_db`, `_firebase`, `_marketplace_game`,
 * `_marketplace_react_card`) come from the live Pi release base.
 */

const { marketplaceQuery, marketplaceWriteQuery } = require('./_marketplace_db');
const { authErrorResponse, verifyBearerToken } = require('./_firebase');
const {
  GAMES,
  runWithGame,
} = require('./_marketplace_game');
const {
  parsePublicCardId,
  setCorsHeaders,
} = require('./_marketplace_react_card');

const RECENT_MAX = 24;

/** Aliases accepted as explicit game scope (must match live Pi _marketplace_game). */
const GAME_ALIASES = {
  pokemon: 'pokemon',
  poke: 'pokemon',
  default: 'pokemon',
  one_piece: 'one_piece',
  onepiece: 'one_piece',
  op: 'one_piece',
  'one-piece': 'one_piece',
  riftbound: 'riftbound',
  rb: 'riftbound',
  lol: 'riftbound',
};

function normalizeRecentIds(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = parsePublicCardId(value);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= RECENT_MAX) {
      break;
    }
  }
  return out;
}

function isUndefinedTable(error) {
  return error?.code === '42P01' || /does not exist/i.test(String(error?.message || ''));
}

function isUndefinedColumn(error) {
  return error?.code === '42703' || /column .*game.* does not exist/i.test(String(error?.message || ''));
}

function firstHeader(req, name) {
  const headers = req?.headers || {};
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
  }
  return '';
}

function compactGameToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

/**
 * Known marketplace game, or null. Never maps unknown tokens to pokemon.
 */
function knownMarketplaceGame(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  const compact = compactGameToken(raw);
  if (GAME_ALIASES[raw.toLowerCase()] || GAME_ALIASES[compact]) {
    const id = GAME_ALIASES[raw.toLowerCase()] || GAME_ALIASES[compact];
    return GAMES[id] ? id : null;
  }
  if (GAMES[compact]) {
    return compact;
  }
  return null;
}

function invalidGameError(value) {
  const error = new Error(
    value
      ? `Invalid or missing game "${value}". Pass an explicit game (pokemon, one_piece, riftbound).`
      : 'Missing game. Pass ?game= / body.game / x-pokoin-game (pokemon, one_piece, riftbound).',
  );
  error.statusCode = 400;
  error.code = 'INVALID_GAME';
  return error;
}

function gameIdFromHost(hostname = '') {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .split(':')[0];
  if (host === 'onepiece.pokoin.com' || host.startsWith('onepiece.')) {
    return 'one_piece';
  }
  if (host === 'riftbound.pokoin.com' || host.startsWith('riftbound.')) {
    return 'riftbound';
  }
  return '';
}

function explicitGameHint(req) {
  try {
    const host = firstHeader(req, 'host') || 'pokoin.com';
    const url = new URL(req.url || '/', `https://${host}`);
    const fromQuery = url.searchParams.get('game') || url.searchParams.get('marketplaceGame');
    if (fromQuery != null && String(fromQuery).trim() !== '') {
      return String(fromQuery).trim();
    }
  } catch (_) {
    /* ignore */
  }
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const fromBody = body.game || body.marketplaceGame;
  if (fromBody != null && String(fromBody).trim() !== '') {
    return String(fromBody).trim();
  }
  const fromHeader = firstHeader(req, 'x-pokoin-game') || firstHeader(req, 'x-marketplace-game');
  if (fromHeader.trim()) {
    return fromHeader.trim();
  }
  // Satellite storefront Host / x-pokoin-host counts as explicit scope.
  const hostHint = firstHeader(req, 'x-pokoin-host')
    || firstHeader(req, 'x-forwarded-host')
    || firstHeader(req, 'host');
  const fromHost = gameIdFromHost(hostHint);
  if (fromHost) {
    return fromHost;
  }
  try {
    const origin = firstHeader(req, 'origin') || firstHeader(req, 'referer');
    if (origin) {
      const fromOrigin = gameIdFromHost(new URL(origin).hostname);
      if (fromOrigin) {
        return fromOrigin;
      }
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

/**
 * Recents require an explicit game. No silent pokemon default for bare calls.
 */
function resolveRecentsGame(req) {
  const hint = explicitGameHint(req);
  if (!hint) {
    throw invalidGameError('');
  }
  const known = knownMarketplaceGame(hint);
  if (!known) {
    throw invalidGameError(hint);
  }
  return known;
}

/** Recents rows live on the pokemon marketplace writer DB, keyed by game. */
function withRecentsDb(fn) {
  return runWithGame('pokemon', fn);
}

async function readRecents(uid, game) {
  try {
    return await withRecentsDb(async () => {
      const result = await marketplaceQuery(
        `select card_ids
           from public.marketplace_user_recents
          where user_uid = $1
            and game = $2
          limit 1`,
        [uid, game],
      );
      return normalizeRecentIds(result.rows[0]?.card_ids || []);
    });
  } catch (error) {
    if (isUndefinedTable(error)) {
      return [];
    }
    // Pre-migration schema: unscoped table — treat as empty (do not return mixed ids).
    if (isUndefinedColumn(error)) {
      return [];
    }
    throw error;
  }
}

async function writeRecents(uid, game, ids) {
  const cardIds = normalizeRecentIds(ids);
  await withRecentsDb(async () => {
    await marketplaceWriteQuery(
      `insert into public.marketplace_user_recents (user_uid, game, card_ids, updated_at)
       values ($1, $2, $3::bigint[], now())
       on conflict (user_uid, game) do update
         set card_ids = excluded.card_ids,
             updated_at = now()`,
      [uid, game, cardIds],
    );
  });
  return cardIds;
}

/**
 * Keep only ids that exist in the requested game's catalog.
 * Queries that game's DB via runWithGame (not the shared recents writer).
 */
async function filterCardsInGameCatalog(game, ids) {
  const wanted = normalizeRecentIds(ids);
  if (!wanted.length) {
    return [];
  }
  return runWithGame(game, async () => {
    const result = await marketplaceQuery(
      `select card_id::text as id
         from public.marketplace_search_candidates
        where card_id = any($1::bigint[])`,
      [wanted],
    );
    const ok = new Set((result.rows || []).map((row) => String(row.id)));
    return wanted.filter((id) => ok.has(String(id)));
  });
}

async function assertCardsInGameCatalog(game, ids) {
  const wanted = normalizeRecentIds(ids);
  if (!wanted.length) {
    return [];
  }
  const valid = await filterCardsInGameCatalog(game, wanted);
  if (valid.length !== wanted.length) {
    const error = new Error('Card not found in this game catalog.');
    error.statusCode = 400;
    error.code = 'INVALID_CARD_FOR_GAME';
    throw error;
  }
  return valid;
}

async function recordRecentCard(uid, game, cardId) {
  const id = parsePublicCardId(cardId);
  if (!id) {
    const error = new Error('Missing cardId.');
    error.statusCode = 400;
    throw error;
  }
  await assertCardsInGameCatalog(game, [id]);
  const current = await readRecents(uid, game);
  return writeRecents(uid, game, [id, ...current]);
}

function cors(res) {
  setCorsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-pokoin-game, x-pokoin-host, x-marketplace-game');
}

function jsonPrivate(res, body) {
  cors(res);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json(body);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  try {
    const decoded = await verifyBearerToken(req);
    const uid = String(decoded.uid || '').trim();
    if (!uid) {
      return res.status(401).json({ error: 'Missing Pokoin user.' });
    }
    const game = resolveRecentsGame(req);
    if (req.method === 'GET') {
      return jsonPrivate(res, {
        game,
        cardIds: await readRecents(uid, game),
      });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const extra = body.cardId ?? body.card_id;
      const incoming = body.cardIds || body.card_ids;
      if (extra != null && extra !== '' && (incoming == null || !Array.isArray(incoming))) {
        return jsonPrivate(res, {
          game,
          cardIds: await recordRecentCard(uid, game, extra),
        });
      }
      const merged = normalizeRecentIds(
        extra != null && extra !== ''
          ? [extra, ...(Array.isArray(incoming) ? incoming : [])]
          : incoming,
      );
      const valid = await assertCardsInGameCatalog(game, merged);
      return jsonPrivate(res, {
        game,
        cardIds: await writeRecents(uid, game, valid),
      });
    }
    res.setHeader('Allow', 'GET, PUT, POST, OPTIONS');
    return res.status(405).json({ error: 'GET, PUT, or POST only.' });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message, code: error.code || 'BAD_REQUEST' });
    }
    if (error.statusCode === 401 || error.code === 'auth/id-token-expired') {
      const auth = authErrorResponse(error);
      return res.status(auth.statusCode).json(auth.body);
    }
    console.error('marketplace-recents failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Recents failed.',
    });
  }
};

module.exports._test = {
  normalizeRecentIds,
  isUndefinedTable,
  isUndefinedColumn,
  knownMarketplaceGame,
  resolveRecentsGame,
  explicitGameHint,
  filterCardsInGameCatalog,
  RECENT_MAX,
  GAME_ALIASES,
};
