/**
 * Pokoin overlay (server/pokoin-api) — replaces the legacy CardVault
 * api/marketplace-image-log.js copy on the Pi release. Change from the
 * legacy copy: the per-process hitsByIp Map (unbounded, per-instance) is now
 * the shared best-effort limiter (Redis counter, bounded local fallback).
 */
const { limitBestEffort } = require('./_rate_limit');
const {
  listMarketplaceImages,
  recordMarketplaceImage,
} = require('./_marketplace_image_log');
const { authorizeSearchDebugRequest } = require('./_search_debug_auth');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || req.headers['x-real-ip'] || '');
}

async function rateLimited(ip) {
  const verdict = await limitBestEffort({ scope: 'image-log', identity: ip, limit: 40, windowSeconds: 60 });
  return !verdict.allowed;
}

module.exports = async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method === 'GET') {
    try {
      await authorizeSearchDebugRequest(req);
    } catch (error) {
      return res.status(error.statusCode || 401).json({ error: error.message || 'Sign in required.' });
    }
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const rows = listMarketplaceImages(url.searchParams.get('limit'));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: rows.length, rows });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (await rateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'Too many image logs.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const entry = recordMarketplaceImage({
    source: body.source || 'client',
    status: body.status || 'error',
    route: body.route || body.routePath,
    cardId: body.cardId || body.card_id,
    ctId: body.ctId || body.ct_id,
    name: body.name,
    url: body.url || body.imageUrl,
    fallbackUrl: body.fallbackUrl,
    error: body.error,
    sessionId: body.sessionId,
  });
  return res.status(201).json({ ok: true, prefixKind: entry.prefixKind, prefix: entry.prefix });
};

module.exports._test = {
  clientIp,
  rateLimited,
};
