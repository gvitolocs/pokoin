'use strict';

/**
 * Authenticated personal marketplace context for Poko.
 *
 * POST /api/poko-personal-context
 *   Firebase bearer:
 *     { action: "get"|"sync", watchlistIds?, cart?, desk? }
 *   Hermes service bearer:
 *     { action: "get", firebaseUid }
 *
 * Sync stores cart/watchlist/desk so linked Telegram/Discord turns can reuse
 * the same personal facts. Recents, inventory, and collection are always live.
 */

const crypto = require('node:crypto');
const path = require('node:path');

const { marketplaceQuery, marketplaceWriteQuery } = require('./_marketplace_db');
const { authErrorResponse, verifyBearerToken, getFirebaseAdmin } = require('./_firebase');
const {
  buildPersonalContext,
  formatPersonalIntent,
  cleanCartItems,
  cleanDesk,
  normalizeCardIds,
} = require('./_poko_personal_context');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

function summarizeOwnedCollectionSafe() {
  try {
    return requireHelper('_user_card_collection').summarizeOwnedCollection;
  } catch (_) {
    return null;
  }
}

function serviceToken() {
  return String(process.env.POKO_MARKET_SERVICE_TOKEN || process.env.POKONTACT_SERVICE_TOKEN || '').trim();
}

function timingSafeEqualText(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isServiceAuthorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || ''));
  if (!match) return false;
  return timingSafeEqualText(match[1].trim(), expected);
}

function cleanText(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sendJson(res, statusCode, body) {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(statusCode).json(body);
}

function overlayFromBody(body = {}) {
  const overlay = {};
  if (body.watchlistIds != null || body.watchlist != null) {
    overlay.watchlistIds = normalizeCardIds(body.watchlistIds || body.watchlist);
  }
  if (body.cart != null) {
    overlay.cart = cleanCartItems(body.cart);
  }
  if (body.desk != null || body.deskCardId != null || body.pageContext != null) {
    const deskSrc = body.desk || body.pageContext || body;
    overlay.desk = cleanDesk(deskSrc);
  }
  return overlay;
}

async function resolveUid(req, body = {}) {
  if (isServiceAuthorized(req)) {
    const uid = cleanText(body.firebaseUid || body.uid || body.userId, 160);
    if (!uid) {
      const error = new Error('firebaseUid required for service personal-context.');
      error.statusCode = 400;
      throw error;
    }
    return { uid, via: 'service', persistOverlay: false };
  }
  const decoded = await verifyBearerToken(req);
  const uid = cleanText(decoded?.uid, 160);
  if (!uid) {
    const error = new Error('Missing Pokoin user.');
    error.statusCode = 401;
    throw error;
  }
  return { uid, via: 'firebase', persistOverlay: true };
}

module.exports = async function handler(req, res) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'POST only' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = cleanText(body.action || 'get', 20) || 'get';
  if (action !== 'get' && action !== 'sync') {
    return sendJson(res, 400, { error: 'action must be get or sync' });
  }

  let auth;
  try {
    auth = await resolveUid(req, body);
  } catch (error) {
    if (error.statusCode === 400) {
      return sendJson(res, 400, { error: error.message });
    }
    const authErr = authErrorResponse(error);
    return sendJson(res, authErr.statusCode || 401, authErr.body || { error: 'unauthorized' });
  }

  try {
    let firestore = null;
    try {
      firestore = getFirebaseAdmin().firestore();
    } catch (_) {
      firestore = null;
    }
    const overlay = overlayFromBody(body);
    const personal = await buildPersonalContext({
      query: marketplaceQuery,
      writeQuery: marketplaceWriteQuery,
      uid: auth.uid,
      firestore,
      summarizeOwnedCollection: summarizeOwnedCollectionSafe(),
      overlay,
      persistOverlay: action === 'sync' && auth.persistOverlay,
    });
    return sendJson(res, 200, {
      ok: true,
      action,
      personal,
      intent: formatPersonalIntent(personal),
    });
  } catch (error) {
    console.error('poko-personal-context failed', String(error?.message || error).slice(0, 300));
    return sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.statusCode === 401 ? 'Authentication required.' : 'Could not load personal context.',
    });
  }
};

module.exports._test = {
  overlayFromBody,
  resolveUid,
  isServiceAuthorized,
  serviceToken,
};
