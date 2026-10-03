'use strict';

/**
 * Shared Pokoin API — the signed-in buyer's cart.
 *
 *   GET /api/marketplace-cart-sync  → { items, saved, gift, rev, updatedAt }
 *   PUT /api/marketplace-cart-sync  { items, saved, gift, baseRev }
 *       → 200 { ...cart } or 409 { error, code: 'CART_REV', cart: <current> }
 *
 * One cart per account (every game's lines together, like the browser cart).
 * Reads use the Pi replica; writes go to the nezopt writer. Canonical source
 * for the Pi overlay — deploy with scripts/deploy-cart-api.sh from origin/main.
 * Sibling requires `_marketplace_db`, `_firebase`, `_marketplace_game` and
 * `_marketplace_react_card` come from the live Pi release base.
 */

const { marketplaceQuery, marketplaceWriteQuery } = require('./_marketplace_db');
const { authErrorResponse, verifyBearerToken } = require('./_firebase');
const { runWithGame } = require('./_marketplace_game');
const { setCorsHeaders } = require('./_marketplace_react_card');
const { limitBestEffort } = require('./_rate_limit');
const { readCart, writeCart } = require('./_cart_store');

/** Generous: the SPA debounces saves, this only stops a runaway loop. */
const WRITES_PER_MINUTE = 120;

function cors(res) {
  setCorsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-pokoin-game, x-pokoin-host, x-marketplace-game');
}

function sendPrivate(res, status, body) {
  cors(res);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(status).json(body);
}

/** Carts live on the pokemon marketplace writer DB for every storefront. */
function withCartDb(fn) {
  return runWithGame('pokemon', fn);
}

function isAuthError(error) {
  return error?.statusCode === 401
    || error?.statusCode === 403
    || String(error?.code || '').startsWith('auth/')
    || /bearer|id token|authentication/i.test(String(error?.message || ''));
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT, OPTIONS');
    return sendPrivate(res, 405, { error: 'GET or PUT only.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const uid = String(decoded?.uid || '').trim();
    if (!uid) {
      return sendPrivate(res, 401, { error: 'Missing Pokoin user.' });
    }
    if (req.method === 'GET') {
      const cart = await withCartDb(() => readCart(marketplaceQuery, uid));
      return sendPrivate(res, 200, cart);
    }
    const limit = await limitBestEffort({
      scope: 'cart-sync',
      identity: uid,
      limit: WRITES_PER_MINUTE,
      windowSeconds: 60,
    });
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec || 60));
      return sendPrivate(res, 429, { error: 'Too many cart saves. Try again in a minute.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const saved = await withCartDb(() => writeCart(marketplaceWriteQuery, uid, body, body.baseRev));
    if (!saved.ok) {
      return sendPrivate(res, 409, {
        error: 'The cart changed on another device.',
        code: 'CART_REV',
        cart: saved.cart,
      });
    }
    return sendPrivate(res, 200, saved.cart);
  } catch (error) {
    if (isAuthError(error)) {
      const auth = authErrorResponse(error);
      return sendPrivate(res, auth.statusCode, auth.body);
    }
    console.error('marketplace-cart-sync failed', { message: error.message, code: error.code });
    return sendPrivate(res, error.statusCode || 500, { error: 'Cart sync failed.' });
  }
};
