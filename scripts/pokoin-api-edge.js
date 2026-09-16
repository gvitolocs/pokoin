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

function proxy(req, res) {
  const incoming = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = rewritePath(incoming.pathname);
  const sitemap = sitemapFile(pathname);
  if (sitemap && (req.method === 'GET' || req.method === 'HEAD')) {
    sendSitemap(req, res, sitemap);
    return;
  }
  const origin = new URL(pickOrigin(pathname));
  const headers = { ...req.headers, host: origin.host };
  delete headers.connection;
  const upstream = http.request(
    {
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method: req.method,
      path: pathname + incoming.search,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Bad Gateway');
  });
  req.pipe(upstream);
}

http.createServer(proxy).listen(PORT, BIND, () => {
  console.log(`pokoin-api-edge bind=${BIND} port=${PORT} api=${API} cdn=${CDN} seo=${SEO_DIR}`);
});
