'use strict';

/**
 * Central request security for the Pi Node API: trusted client IP stamping,
 * a single authoritative CORS pass on every response (writeHead wrapper),
 * OPTIONS preflight handling, and the opt-in public route manifest gate.
 */

const { applyTrustedClientIp } = require('./_client_ip');
const { SATELLITE_HOSTS, corsHeaders, mergeCorsIntoHeaders } = require('./_cors_policy');

function routeManifestEnabled(env = process.env) {
  return env.POKOIN_EXPOSE_ROUTE_MANIFEST === '1';
}

/**
 * Cache-poisoning guard. Cloudflare caches public GETs keyed by URL only (it
 * ignores Vary), while the API picks the game from request headers, so a
 * crafted header can make Cloudflare serve another game's data for a Pokémon
 * URL. The SPA always sends ?game=, so any request that selects the game
 * outside the URL is non-cacheable.
 */
function gameSelectedOutsideUrl(req) {
  let url;
  try {
    url = new URL(req?.url, 'http://local');
  } catch (_) {
    return false;
  }
  if (url.searchParams.has('game')) return false;
  const headers = (req && req.headers) || {};
  const headerValue = (name) => {
    let value = headers[name];
    if (value === undefined) {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
      value = key === undefined ? undefined : headers[key];
    }
    if (value === undefined) return '';
    return Array.isArray(value) ? String(value[0] || '') : String(value);
  };
  for (const name of ['x-pokoin-game', 'x-pokoin-host', 'x-forwarded-host', 'x-original-host']) {
    if (headerValue(name).trim()) return true;
  }
  const origin = headerValue('origin').trim();
  if (origin) {
    try {
      const host = new URL(origin).hostname.toLowerCase();
      for (const satellite of SATELLITE_HOSTS) {
        if (host === `${satellite}.pokoin.com`) return true;
      }
    } catch (_) {
      // Unparseable Origin: not a satellite.
    }
  }
  return false;
}

function markAuthFailure(req) {
  try {
    if (!req) return;
    req.pokoinAuthFailure = true;
    if (req.pokoinResponse && typeof req.pokoinResponse === 'object') {
      req.pokoinResponse.pokoinAuthFailure = true;
    }
  } catch (_) {
    // Never throw from a security helper.
  }
}

function prepareRequest(req, res, { env = process.env } = {}) {
  applyTrustedClientIp(req);

  if (!res.__pokoinSecured) {
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function securedWriteHead(status, maybeMessageOrHeaders, maybeHeaders) {
      const statusValue = Number(status) || res.statusCode || 200;
      let statusMessage;
      let headers;
      if (typeof maybeMessageOrHeaders === 'string') {
        statusMessage = maybeMessageOrHeaders;
        headers = maybeHeaders;
      } else {
        headers = maybeMessageOrHeaders;
      }
      const finalStatus = (res.pokoinAuthFailure && statusValue >= 500) ? 401 : statusValue;
      res.statusCode = finalStatus;

      for (const key of Object.keys(res.getHeaders())) {
        const lower = key.toLowerCase();
        if (lower.startsWith('access-control-') || lower === 'vary') {
          res.removeHeader(key);
        }
      }
      const merged = mergeCorsIntoHeaders(
        headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : undefined,
        req,
        env,
      );
      for (const [key, value] of Object.entries(merged)) {
        res.setHeader(key, value);
      }

      // Game selected outside the URL: Cloudflare keys its cache on the URL
      // only, so this response must never be shared across origins.
      if (gameSelectedOutsideUrl(req)) {
        for (const key of Object.keys(res.getHeaders())) {
          if (key.toLowerCase() === 'cache-control') res.removeHeader(key);
        }
        res.setHeader('cache-control', 'private, no-store');
        res.setHeader('cdn-cache-control', 'no-store');
      }

      if (statusMessage !== undefined) {
        return originalWriteHead(finalStatus, statusMessage);
      }
      return originalWriteHead(finalStatus);
    };
    res.__pokoinSecured = true;
  }

  if (req && req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req, env));
    res.end();
    return { preflightHandled: true };
  }
  return { preflightHandled: false };
}

module.exports = {
  routeManifestEnabled,
  markAuthFailure,
  gameSelectedOutsideUrl,
  prepareRequest,
};
