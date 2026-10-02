#!/usr/bin/env node
/**
 * One public API origin on the Pi. api.pokoin.com and api2.pokoin.com both
 * land here. JSON API stays on :18080; leftover image keys go to :18081.
 * `/card-images/*` is stripped like the old Oracle api2 Caddy site.
 * GSC sitemaps are static XML here: apex Bot Fight 403s Google's fetch IPs.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const BIND = process.env.POKOIN_API_EDGE_BIND || '127.0.0.1';
const PORT = Number(process.env.POKOIN_API_EDGE_PORT || 18079);
const API = process.env.POKOIN_API_ORIGIN || 'http://127.0.0.1:18080';
const CDN = process.env.POKOIN_CDN_ORIGIN || 'http://127.0.0.1:18081';
// Overflow (docs/NEZOPT_OVERFLOW.md): when the Pi API already has LOCAL_MAX
// requests in flight, GET/HEAD API calls go to the k3s copy on nezopt — only
// while its probe answers. Writes, webhooks and uploads always stay here.
const OVERFLOW = process.env.POKOIN_API_OVERFLOW_ORIGIN || '';
const LOCAL_MAX = Number(process.env.POKOIN_API_LOCAL_MAX || 16);
const PROBE_MS = Number(process.env.POKOIN_API_OVERFLOW_PROBE_MS || 5000);
const PROBE_PATH = process.env.POKOIN_API_OVERFLOW_PROBE_PATH || '/api/marketplace-suggest?q=pika&limit=1';
// Micro-cache (docs/NEZOPT_OVERFLOW.md): public GETs are cached for the API's
// own s-maxage and coalesced, so a hot or expiring URL is built once, not once
// per visitor (the home feed took ~7 s under 8 parallel misses on 2026-09-29).
const CACHE_MAX_BYTES = Number(process.env.POKOIN_API_CACHE_MB || 64) * 1024 * 1024;
const CACHE_MAX_TTL = Number(process.env.POKOIN_API_CACHE_MAX_TTL || 300);
const CACHE_MAX_ENTRY = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = Number(process.env.POKOIN_API_UPSTREAM_TIMEOUT_MS || 60_000);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'date']);
const SEO_DIR = process.env.POKOIN_SEO_DIR || '/srv/pokoin/seo';
const SITEMAP_FILES = new Set([
  'sitemap.xml',
  'sitemap-hubs.xml',
  'sitemap-pokemon.xml',
  'sitemap-sets.xml',
]);

function rewritePath(pathname) {
  if (pathname === '/card-images' || pathname.startsWith('/card-images/')) {
    const stripped = pathname.slice('/card-images'.length) || '/';
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
  }
  return pathname;
}

function isApiPath(pathname) {
  return (
    pathname === '/'
    || pathname === '/marketplace'
    || pathname === '/healthz'
    || pathname === '/api'
    || pathname === '/api/healthz'
    || (pathname.startsWith('/api/') && pathname !== '/api/health')
  );
}

function pickOrigin(pathname) {
  return isApiPath(pathname) ? API : CDN;
}

/** AI/search robots: API responses are app data, never indexable pages. */
function withNoindex(pathname, headers) {
  if (!isApiPath(pathname)) return headers;
  return { ...headers, 'x-robots-tag': 'noindex' };
}

function sitemapFile(pathname) {
  const name = String(pathname || '').replace(/^\//, '');
  return SITEMAP_FILES.has(name) ? name : '';
}

function sendSitemap(req, res, name) {
  const file = path.join(SEO_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!res.headersSent) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('Not Found');
      return;
    }
    const headers = {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'content-length': String(st.size),
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

/** Where one API request goes. Pure so it can be tested. */
function chooseApiOrigin({ method, pathname, inFlight, localMax, overflowHealthy, overflowOrigin }) {
  if (pathname === '/api/marketplace-live') return 'local';
  const idempotent = method === 'GET' || method === 'HEAD';
  if (overflowOrigin && overflowHealthy && idempotent && inFlight >= localMax) {
    return 'overflow';
  }
  return 'local';
}

/**
 * How long the edge may keep one upstream response: s-maxage (else max-age)
 * and stale-while-revalidate, or null when it must not be stored.
 */
function cachePolicy(status, headers, maxTtl = CACHE_MAX_TTL) {
  if (status !== 200 || headers['set-cookie']) return null;
  const cc = String(headers['cache-control'] || '').toLowerCase();
  if (!/\bpublic\b/.test(cc) || /\b(private|no-store|no-cache)\b/.test(cc)) return null;
  if (/text\/event-stream/.test(String(headers['content-type'] || ''))) return null;
  const num = (name) => {
    const match = cc.match(new RegExp(`\\b${name}=(\\d+)`));
    return match ? Number(match[1]) : null;
  };
  const ttl = num('s-maxage') ?? num('max-age');
  if (!ttl) return null;
  return { ttl: Math.min(ttl, maxTtl), swr: Math.min(num('stale-while-revalidate') || 0, 600) };
}

/** Key for a GET anyone could have made; null when the request is personal. */
function cacheKey(req, pathname, search) {
  if (req.method !== 'GET') return null;
  if (pathname === '/api/marketplace-live') return null;
  if (req.headers.authorization || req.headers.cookie) return null;
  return [pathname + search, req.headers['x-pokoin-game'] || '', req.headers['x-pokoin-host'] || ''].join('\n');
}

/** Byte-capped LRU (Map keeps insertion order; a hit re-inserts). */
class ResponseCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key, entry) {
    this.delete(key);
    this.map.set(key, entry);
    this.bytes += entry.body.length;
    for (const [oldKey] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(oldKey);
    }
  }

  delete(key) {
    const entry = this.map.get(key);
    if (!entry) return;
    this.bytes -= entry.body.length;
    this.map.delete(key);
  }
}

const state = { inFlight: 0, overflowHealthy: false, overflowServed: 0, hits: 0, misses: 0, fallbacks: 0 };
const cache = new ResponseCache(CACHE_MAX_BYTES);
const flights = new Map();
// Paths whose last response was not storable (no-store, private, errors):
// skip coalescing for a while so identical requests do not queue behind one.
const UNCACHEABLE_MS = 5 * 60 * 1000;
const uncacheablePaths = new Map();

function knownUncacheable(pathname) {
  const until = uncacheablePaths.get(pathname);
  if (!until) return false;
  if (Date.now() < until) return true;
  uncacheablePaths.delete(pathname);
  return false;
}

function probeOverflow() {
  if (!OVERFLOW) return;
  const target = new URL(PROBE_PATH, OVERFLOW);
  const probe = http.get(target, { timeout: 2000 }, (res) => {
    res.resume();
    state.overflowHealthy = res.statusCode === 200;
  });
  probe.on('timeout', () => probe.destroy(new Error('probe timeout')));
  probe.on('error', () => { state.overflowHealthy = false; });
}

function upstreamRequest(req, origin, pathname, search, onResponse) {
  const headers = { ...req.headers, host: origin.host };
  delete headers.connection;
  const upstream = http.request({
    protocol: origin.protocol,
    hostname: origin.hostname,
    port: origin.port,
    method: req.method,
    path: pathname + search,
    headers,
    timeout: UPSTREAM_TIMEOUT_MS,
  }, onResponse);
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  return upstream;
}

/** Stream a request through unchanged (CDN, writes, personal or uncacheable GETs). */
function forward(req, res, origin, pathname, search, { onDone, onConnectError, body } = {}) {
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    if (onDone) onDone();
  };
  const upstream = upstreamRequest(req, origin, pathname, search, (up) => {
    res.writeHead(up.statusCode || 502, withNoindex(pathname, up.headers));
    up.pipe(res);
    up.on('end', done);
    up.on('error', done);
  });
  res.on('close', done);
  upstream.on('error', (error) => {
    done();
    if (onConnectError && !res.headersSent) {
      onConnectError(error);
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Bad Gateway');
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}

function pickRoute(req, pathname) {
  return chooseApiOrigin({
    method: req.method,
    pathname,
    inFlight: state.inFlight,
    localMax: LOCAL_MAX,
    overflowHealthy: state.overflowHealthy,
    overflowOrigin: OVERFLOW,
  });
}

/**
 * Streamed API request. The Pi first unless it is saturated; a GET/HEAD whose
 * first origin refuses the connection (Pi API restarting, nezopt asleep) tries
 * the other one before answering 502.
 */
function forwardApi(req, res, pathname, search) {
  const idempotent = req.method === 'GET' || req.method === 'HEAD';
  const toLocal = (retry) => {
    state.inFlight += 1;
    res.setHeader('x-pokoin-origin', 'pi');
    forward(req, res, new URL(API), pathname, search, {
      body: retry ? Buffer.alloc(0) : null,
      onDone: () => { state.inFlight -= 1; },
      onConnectError: idempotent && !retry && OVERFLOW && state.overflowHealthy
        ? () => { state.fallbacks += 1; toOverflow(true); }
        : null,
    });
  };
  const toOverflow = (retry) => {
    state.overflowServed += 1;
    res.setHeader('x-pokoin-origin', 'nezopt');
    forward(req, res, new URL(OVERFLOW), pathname, search, {
      body: Buffer.alloc(0),
      onConnectError: retry ? null : () => { state.overflowHealthy = false; toLocal(true); },
    });
  };
  if (pickRoute(req, pathname) === 'overflow') toOverflow(false);
  else toLocal(false);
}

/**
 * One buffered upstream fetch for a cacheable key. Resolves with the entry, or
 * { uncacheable: true } after streaming a response that must not be stored
 * straight to `leaderRes` (so it is never buffered or shared).
 */
function fetchEntry(req, pathname, search, leaderRes) {
  return new Promise((resolve, reject) => {
    const attempt = (route, retried) => {
      const local = route === 'local';
      const origin = new URL(local ? API : OVERFLOW);
      if (local) state.inFlight += 1;
      else state.overflowServed += 1;
      let released = false;
      const release = () => {
        if (local && !released) {
          released = true;
          state.inFlight -= 1;
        }
      };
      const upstream = upstreamRequest(req, origin, pathname, search, (up) => {
        const policy = cachePolicy(up.statusCode, up.headers);
        if (!policy) {
          // Only an endpoint that says it is never storable skips coalescing;
          // one 404 or 500 must not switch caching off for every URL on it.
          const neverStorable = !/\bpublic\b/i.test(String(up.headers['cache-control'] || ''))
            || /\b(private|no-store)\b/i.test(String(up.headers['cache-control'] || ''));
          if (leaderRes && !leaderRes.headersSent) {
            leaderRes.setHeader('x-pokoin-origin', local ? 'pi' : 'nezopt');
            leaderRes.setHeader('x-pokoin-edge-cache', 'BYPASS');
            leaderRes.writeHead(up.statusCode || 502, withNoindex(pathname, up.headers));
            up.pipe(leaderRes);
          } else {
            up.resume();
          }
          up.on('end', release);
          up.on('error', release);
          resolve({ uncacheable: true, neverStorable });
          return;
        }
        const chunks = [];
        let size = 0;
        up.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
        up.on('error', (error) => { release(); reject(error); });
        up.on('end', () => {
          release();
          const now = Date.now();
          const headers = {};
          for (const [name, value] of Object.entries(up.headers)) {
            if (!HOP_HEADERS.has(name)) headers[name] = value;
          }
          resolve({
            status: up.statusCode,
            headers: withNoindex(pathname, headers),
            body: Buffer.concat(chunks, size),
            origin: local ? 'pi' : 'nezopt',
            storedAt: now,
            freshUntil: now + policy.ttl * 1000,
            staleUntil: now + (policy.ttl + policy.swr) * 1000,
          });
        });
      });
      upstream.on('error', (error) => {
        release();
        const other = local ? 'overflow' : 'local';
        const canRetry = !retried && (other === 'local' || (OVERFLOW && state.overflowHealthy));
        if (!local) state.overflowHealthy = false;
        if (canRetry) {
          if (local) state.fallbacks += 1;
          attempt(other, true);
          return;
        }
        reject(error);
      });
      upstream.end();
    };
    attempt(pickRoute(req, pathname), false);
  });
}

/** Start (or join) the single upstream fetch for `key`; stores cacheable results. */
function refresh(key, req, pathname, search, leaderRes) {
  const running = flights.get(key);
  if (running) return running;
  const flight = fetchEntry(req, pathname, search, leaderRes)
    .then((entry) => {
      if (entry.uncacheable) {
        if (entry.neverStorable) {
          if (uncacheablePaths.size > 500) uncacheablePaths.clear();
          uncacheablePaths.set(pathname, Date.now() + UNCACHEABLE_MS);
        }
      } else if (entry.body.length <= CACHE_MAX_ENTRY) {
        cache.set(key, entry);
      }
      return entry;
    })
    .finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
}

function sendEntry(res, entry, label) {
  if (res.headersSent) return;
  const headers = {
    ...entry.headers,
    'content-length': String(entry.body.length),
    age: String(Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000))),
    'x-pokoin-origin': entry.origin,
    'x-pokoin-edge-cache': label,
  };
  res.writeHead(entry.status, headers);
  res.end(entry.body);
}

function serveCacheable(req, res, key, pathname, search) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now < hit.freshUntil) {
    state.hits += 1;
    sendEntry(res, hit, 'HIT');
    return;
  }
  if (hit && now < hit.staleUntil) {
    state.hits += 1;
    sendEntry(res, hit, 'STALE');
    refresh(key, req, pathname, search, null).catch(() => {});
    return;
  }
  state.misses += 1;
  const leader = !flights.has(key);
  refresh(key, req, pathname, search, leader ? res : null).then(
    (entry) => {
      if (!entry.uncacheable) {
        sendEntry(res, entry, leader ? 'MISS' : 'COALESCED');
      } else if (!leader) {
        forwardApi(req, res, pathname, search);
      }
    },
    () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('Bad Gateway');
    },
  );
}

function proxy(req, res) {
  const incoming = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = rewritePath(incoming.pathname);
  const sitemap = sitemapFile(pathname);
  if (sitemap && (req.method === 'GET' || req.method === 'HEAD')) {
    sendSitemap(req, res, sitemap);
    return;
  }
  if (!isApiPath(pathname)) {
    forward(req, res, new URL(CDN), pathname, incoming.search);
    return;
  }
  const key = CACHE_MAX_BYTES > 0 && !knownUncacheable(pathname)
    ? cacheKey(req, pathname, incoming.search)
    : null;
  if (key) serveCacheable(req, res, key, pathname, incoming.search);
  else forwardApi(req, res, pathname, incoming.search);
}

if (require.main === module) {
  if (OVERFLOW) {
    probeOverflow();
    setInterval(probeOverflow, PROBE_MS).unref();
  }
  setInterval(() => {
    if (state.overflowServed || state.hits || state.misses || state.fallbacks) {
      console.log(`pokoin-api-edge minute: cache hits=${state.hits} misses=${state.misses} entries=${cache.map.size} mb=${(cache.bytes / 1048576).toFixed(1)} overflow=${state.overflowServed} fallbacks=${state.fallbacks} healthy=${state.overflowHealthy}`);
      state.overflowServed = 0;
      state.hits = 0;
      state.misses = 0;
      state.fallbacks = 0;
    }
  }, 60_000).unref();
  http.createServer(proxy).listen(PORT, BIND, () => {
    console.log(`pokoin-api-edge bind=${BIND} port=${PORT} api=${API} cdn=${CDN} seo=${SEO_DIR} overflow=${OVERFLOW || 'off'} localMax=${LOCAL_MAX} cacheMb=${CACHE_MAX_BYTES / 1048576}`);
  });
}

module.exports = { chooseApiOrigin, cachePolicy, cacheKey, ResponseCache, isApiPath, rewritePath };
