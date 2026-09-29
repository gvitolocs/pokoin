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
function chooseApiOrigin({ method, inFlight, localMax, overflowHealthy, overflowOrigin }) {
  const idempotent = method === 'GET' || method === 'HEAD';
  if (overflowOrigin && overflowHealthy && idempotent && inFlight >= localMax) {
    return 'overflow';
  }
  return 'local';
}

const state = { inFlight: 0, overflowHealthy: false, overflowServed: 0 };

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

function forward(req, res, origin, pathname, search, { onDone, onConnectError } = {}) {
  const headers = { ...req.headers, host: origin.host };
  delete headers.connection;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    if (onDone) onDone();
  };
  const upstream = http.request(
    {
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method: req.method,
      path: pathname + search,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
      up.on('end', done);
      up.on('error', done);
    },
  );
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
  return upstream;
}

function forwardApiLocal(req, res, pathname, search, body) {
  state.inFlight += 1;
  res.setHeader('x-pokoin-origin', 'pi');
  const upstream = forward(req, res, new URL(API), pathname, search, {
    onDone: () => { state.inFlight -= 1; },
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
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
    req.pipe(forward(req, res, new URL(CDN), pathname, incoming.search));
    return;
  }
  const route = chooseApiOrigin({
    method: req.method,
    inFlight: state.inFlight,
    localMax: LOCAL_MAX,
    overflowHealthy: state.overflowHealthy,
    overflowOrigin: OVERFLOW,
  });
  if (route === 'overflow') {
    state.overflowServed += 1;
    res.setHeader('x-pokoin-origin', 'nezopt');
    // GET/HEAD carry no body, so a failed connect can safely retry on the Pi.
    const upstream = forward(req, res, new URL(OVERFLOW), pathname, incoming.search, {
      onConnectError: () => {
        state.overflowHealthy = false;
        forwardApiLocal(req, res, pathname, incoming.search, Buffer.alloc(0));
      },
    });
    upstream.end();
    return;
  }
  forwardApiLocal(req, res, pathname, incoming.search);
}

if (require.main === module) {
  if (OVERFLOW) {
    probeOverflow();
    setInterval(probeOverflow, PROBE_MS).unref();
    setInterval(() => {
      if (state.overflowServed) {
        console.log(`pokoin-api-edge overflow served=${state.overflowServed} healthy=${state.overflowHealthy}`);
        state.overflowServed = 0;
      }
    }, 60_000).unref();
  }
  http.createServer(proxy).listen(PORT, BIND, () => {
    console.log(`pokoin-api-edge bind=${BIND} port=${PORT} api=${API} cdn=${CDN} seo=${SEO_DIR} overflow=${OVERFLOW || 'off'} localMax=${LOCAL_MAX}`);
  });
}

module.exports = { chooseApiOrigin, isApiPath, rewritePath };
