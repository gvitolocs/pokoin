'use strict';

/**
 * Central route limits for handlers this repository does not own.
 * Enforced in oracle-api-server before routing: the request is counted in
 * the GLOBAL limiter (public.marketplace_rate_limits) before it ever reaches
 * a third-party handler. Matching is method + exact pathname (query string
 * and a trailing slash ignored). A rejected or unanswerable verdict writes a
 * 429 and returns true so the caller stops; everything else returns false.
 */

const { limitGlobal } = require('./_rate_limit');
const { clientIp } = require('./_client_ip');

const ROUTE_LIMITS = Object.freeze([
  Object.freeze({ method: 'POST', path: '/api/register-email', scope: 'register-email-ip', limit: 10, windowSeconds: 3600 }),
  Object.freeze({ method: 'POST', path: '/api/verify-email-signup', scope: 'verify-signup-ip', limit: 30, windowSeconds: 3600 }),
  Object.freeze({ method: 'POST', path: '/api/pokoin-assistant', scope: 'pokoin-assistant-ip', limit: 20, windowSeconds: 60 }),
]);

function matchRouteLimit(req) {
  if (!req || !req.method) return undefined;
  let pathname;
  try {
    pathname = new URL(req.url, 'http://local').pathname;
  } catch (_) {
    pathname = String(req.url || '').split('?')[0];
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  for (const entry of ROUTE_LIMITS) {
    if (entry.method === req.method && entry.path === pathname) return entry;
  }
  return undefined;
}

/**
 * Returns true when the request was rejected (the response was written),
 * false when the caller should continue routing.
 */
async function enforceRouteLimits(req, res, { limiter = limitGlobal } = {}) {
  const entry = matchRouteLimit(req);
  if (!entry) return false;
  const verdict = await limiter({ scope: entry.scope, identity: clientIp(req), limit: entry.limit, windowSeconds: entry.windowSeconds });
  if (verdict.allowed && verdict.backend !== 'error') return false;
  res.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': String(verdict.retryAfterSec || entry.windowSeconds),
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ error: 'Too many requests. Try again later.', code: 'rate_limited' }));
  return true;
}

module.exports = {
  ROUTE_LIMITS,
  enforceRouteLimits,
};
