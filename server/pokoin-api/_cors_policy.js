'use strict';

/**
 * The ONE CORS allowlist for the Pokoin API, shared by every origin (Pi edge,
 * Pi Node API, k3s pods). Only exact https:// production origins are allowed
 * (plus dev localhost outside production and POKOIN_CORS_EXTRA_ORIGINS).
 * A non-allowed origin gets `*` with no credentials; a non-allowed origin is
 * never echoed, and `*` is never combined with credentials.
 */

const SATELLITE_HOSTS = [
  'magic', 'yugioh', 'fab', 'fleshandblood', 'digimon', 'dbs', 'dragonball',
  'vanguard', 'onepiece', 'lorcana', 'starwars', 'unionarena', 'riftbound',
  'gundam', 'sorcery', 'palworld', 'cyberpunk',
];

const PRODUCTION_ORIGINS = Object.freeze([
  'https://pokoin.com',
  'https://www.pokoin.com',
  'https://dashboard.pokoin.com',
  'https://test.pokoin.com',
  'https://scan.pokoin.com',
  'https://cardscan.pokoin.com',
  'https://app.pokoin.com',
  ...SATELLITE_HOSTS.map((host) => `https://${host}.pokoin.com`),
]);

const DEFAULT_ALLOW_HEADERS = 'authorization,content-type,accept,x-pokoin-game,x-pokoin-host';
const ALLOW_HEADER_TOKEN = /^[a-z0-9-]{1,64}$/;
const MAX_ALLOW_HEADERS = 32;

function allowedOrigins(env = process.env) {
  const set = new Set(PRODUCTION_ORIGINS);
  for (const raw of String((env && env.POKOIN_CORS_EXTRA_ORIGINS) || '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      set.add(new URL(entry).origin);
    } catch (_) {
      // Not a URL: ignore.
    }
  }
  // Fail safe: dev origins only when the environment says so explicitly. The Pi
  // edge and the Pi API run without NODE_ENV, and they are production.
  if (env && (env.NODE_ENV === 'development' || env.NODE_ENV === 'test')) {
    set.add('http://localhost:5173');
    set.add('http://localhost:4173');
    set.add('http://127.0.0.1:5173');
  }
  return set;
}

/** First value of a header that may arrive as an array; undefined when absent. */
function firstHeader(req, name) {
  const value = (req && req.headers) ? req.headers[name] : undefined;
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function corsHeaders(req, env = process.env) {
  const origin = firstHeader(req, 'origin');
  const out = {
    vary: 'Origin',
    'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '86400',
  };
  if (typeof origin === 'string' && origin && origin !== 'null' && allowedOrigins(env).has(origin)) {
    out['access-control-allow-origin'] = origin;
    out['access-control-allow-credentials'] = 'true';
  } else {
    out['access-control-allow-origin'] = '*';
  }
  const requested = firstHeader(req, 'access-control-request-headers');
  const seen = new Set();
  const kept = [];
  if (typeof requested === 'string') {
    for (const rawToken of requested.split(',')) {
      const token = rawToken.trim().toLowerCase();
      if (!token || seen.has(token) || kept.length >= MAX_ALLOW_HEADERS) continue;
      if (!ALLOW_HEADER_TOKEN.test(token)) continue;
      seen.add(token);
      kept.push(token);
    }
  }
  out['access-control-allow-headers'] = kept.length ? kept.join(',') : DEFAULT_ALLOW_HEADERS;
  return out;
}

/**
 * Apply the policy to a real response, replacing anything the handler set
 * (res.setHeader can be called before writeHead). Returns the headers object.
 */
function applyCorsHeaders(res, req, env = process.env) {
  const headers = corsHeaders(req, env);
  for (const [key, value] of Object.entries(headers)) {
    res.removeHeader(key);
    res.setHeader(key, value);
  }
  if (!('access-control-allow-credentials' in headers)) res.removeHeader('access-control-allow-credentials');
  return headers;
}

/**
 * A new headers object for writeHead: the policy is authoritative, so any
 * handler-supplied access-control-* or vary entries are dropped first.
 */
function mergeCorsIntoHeaders(headers, req, env = process.env) {
  const base = headers && typeof headers === 'object' && !Array.isArray(headers) ? { ...headers } : {};
  const vary = new Set(['Origin']);
  for (const key of Object.keys(base)) {
    const lower = key.toLowerCase();
    if (lower === 'vary') {
      // Keep the handler's other Vary tokens; the policy always adds Origin.
      for (const token of String(base[key]).split(',')) {
        const t = token.trim();
        if (t && t !== '*' && t.toLowerCase() !== 'origin') vary.add(t);
      }
    }
    if (lower.startsWith('access-control-') || lower === 'vary') delete base[key];
  }
  return { ...base, ...corsHeaders(req, env), vary: [...vary].join(', ') };
}

function isPreflight(req) {
  return !!(req && req.method === 'OPTIONS');
}

module.exports = {
  PRODUCTION_ORIGINS,
  SATELLITE_HOSTS,
  allowedOrigins,
  corsHeaders,
  applyCorsHeaders,
  mergeCorsIntoHeaders,
  isPreflight,
};
