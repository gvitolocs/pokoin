#!/usr/bin/env node
/**
 * pokoin.com on the Pi. Static SPA, crawler HTML, homepage rails, and
 * same-origin /api and /card-images. Cloudflare is only the tunnel.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.POKOIN_WEB_ROOT || '/srv/pokoin/web/current');
const BIND = process.env.POKOIN_WEB_BIND || '127.0.0.1';
const PORT = Number(process.env.POKOIN_WEB_PORT || 18078);
const API = process.env.POKOIN_WEB_API || 'http://127.0.0.1:18079';
const CDN = process.env.POKOIN_WEB_CDN || 'http://127.0.0.1:18081';
const here = path.dirname(fileURLToPath(import.meta.url));
const workersDir = path.resolve(process.env.POKOIN_WORKERS_DIR || path.join(here, '../workers'));

const GAMES = new Set([
  'one-piece', 'riftbound', 'magic', 'yugioh', 'lorcana', 'flesh-and-blood', 'digimon',
  'dragon-ball-super', 'vanguard', 'star-wars', 'union-arena', 'gundam', 'sorcery',
  'palworld', 'cyberpunk', 'weiss-schwarz', 'final-fantasy', 'force-of-will',
  'world-of-warcraft', 'battle-spirits-saga', 'star-wars-destiny', 'dragon-born',
  'my-little-pony', 'the-spoils',
]);

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith('https://api.pokoin.com')) {
    const local = API + url.slice('https://api.pokoin.com'.length);
    if (typeof input === 'string' || input instanceof URL) return originalFetch(local, init);
    return originalFetch(new Request(local, input), init);
  }
  return originalFetch(input, init);
};

const memory = new Map();
globalThis.caches = {
  default: {
    async match(request) {
      const hit = memory.get(request.url);
      return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
    },
    async put(request, response) {
      if (memory.size > 200) memory.delete(memory.keys().next().value);
      memory.set(request.url, {
        status: response.status,
        headers: [...response.headers],
        body: await response.clone().arrayBuffer(),
      });
    },
  },
};

const { handleMarketplaceCardOgRequest } = await import(path.join(workersDir, 'marketplace-card-og.js'));
const { handleMarketplaceHubOgRequest } = await import(path.join(workersDir, 'marketplace-hub-og.js'));
const { handleMarketplaceHomeRequest } = await import(path.join(workersDir, 'marketplace-home.js'));
const {
  isExtensionFramePath,
  allowExtensionDeskFrame,
  satelliteHostRedirect,
} = await import(path.join(workersDir, 'pokoin-origin.js'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.zip': 'application/zip',
  '.map': 'application/json',
};

function hostName(req) {
  return String(req.headers.host || 'pokoin.com').split(':')[0].toLowerCase();
}

function redirect(res, location, status = 301) {
  res.writeHead(status, {
    Location: location,
    'Cache-Control': status === 301 ? 'public, max-age=3600' : 'no-store',
    'x-pokoin-web': 'pi',
  });
  res.end();
}

function hostRedirect(req) {
  const host = hostName(req);
  const url = new URL(req.url || '/', `https://${host}`);
  if (host === 'www.pokoin.com') {
    return `https://pokoin.com${url.pathname}${url.search}`;
  }
  if (host === 'dashboard.pokoin.com') {
    if (url.pathname === '/scan' || url.pathname === '/scan/') return 'https://pokoin.com/dashboard/scan';
    if (url.pathname === '/' || url.pathname === '') return 'https://pokoin.com/dashboard';
  }
  const satellite = satelliteHostRedirect(url);
  if (satellite && host !== 'pokoin.com') return satellite.toString();
  if (host === 'pokoin.com' && /^\/(tests|sanitize|espurr|ocr|artwork|jumbos)(\/|$)/.test(url.pathname)) {
    return `https://test.pokoin.com${url.pathname}${url.search}`;
  }
  return '';
}

function shortlink(pathname) {
  const pathOnly = pathname.replace(/\/$/, '') || '/';
  const match = pathOnly.match(/^\/(\d+)$/)
    || pathOnly.match(/^\/(\d+)\/[^/]+$/)
    || pathOnly.match(/^\/marketplace\/(\d+)$/)
    || pathOnly.match(/^\/marketplace\/(\d+)\/[^/]+$/);
  if (!match) return '';
  return `/marketplace/en/cards/${match[1]}`;
}

function safeFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) return '';
  return full;
}

function cacheControl(filePath) {
  const rel = filePath.slice(ROOT.length);
  if (rel.startsWith(`${path.sep}market${path.sep}assets${path.sep}`)) {
    return 'public, max-age=31536000, immutable';
  }
  if (rel.endsWith('.html') || rel.endsWith(`${path.sep}market${path.sep}index.html`)) {
    return 'public, max-age=0, must-revalidate';
  }
  return 'public, max-age=3600';
}

function sendFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const headers = {
    'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl(filePath),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'x-pokoin-web': 'pi',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function proxy(req, res, target) {
  const url = new URL(req.url || '/', target);
  const headers = { ...req.headers, host: url.host };
  const client = url.protocol === 'https:' ? https : http;
  const upstream = client.request(url, { method: req.method, headers }, (up) => {
    const out = { ...up.headers, 'x-pokoin-web': 'pi' };
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain', 'x-pokoin-web': 'pi' });
    res.end('Bad Gateway');
  });
  req.pipe(upstream);
}

function spaFile(pathname) {
  if (pathname === '/' || pathname === '/landing.html') return path.join(ROOT, 'landing.html');
  if (pathname === '/working' || pathname === '/working/') return path.join(ROOT, 'working.html');
  if (pathname.startsWith('/explorer')) {
    const rest = pathname.slice('/explorer'.length) || '/index.html';
    const file = safeFile(`/explorer${rest.endsWith('/') ? `${rest}index.html` : rest}`);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    return path.join(ROOT, 'explorer', 'index.html');
  }
  return path.join(ROOT, 'market', 'index.html');
}

async function fromWorker(handler, req) {
  const host = hostName(req);
  const request = new Request(`https://${host}${req.url}`, {
    method: req.method,
    headers: req.headers,
  });
  const ctx = { waitUntil(promise) { Promise.resolve(promise).catch(() => {}); } };
  return handler(request, {}, ctx);
}

async function writeWeb(res, response, pathname) {
  const headers = Object.fromEntries(response.headers);
  headers['x-pokoin-web'] = 'pi';
  let body = Buffer.from(await response.arrayBuffer());
  let status = response.status;
  if (pathname && isExtensionFramePath(pathname) && String(headers['content-type'] || '').includes('text/html')) {
    const framed = allowExtensionDeskFrame(new Response(body, { status, headers }));
    body = Buffer.from(await framed.arrayBuffer());
    status = framed.status;
    for (const [key, value] of framed.headers) headers[key] = value;
  }
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const away = hostRedirect(req);
    if (away) return redirect(res, away);
    const url = new URL(req.url || '/', 'https://pokoin.com');
    const pathname = url.pathname;

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-pokoin-web': 'pi' });
      res.end(JSON.stringify({ ok: true, service: 'pokoin-web' }));
      return;
    }

    if (pathname.startsWith('/api/')) {
      const home = await fromWorker(handleMarketplaceHomeRequest, req);
      if (home) return writeWeb(res, home);
      return proxy(req, res, API);
    }
    if (pathname.startsWith('/card-images/')) {
      req.url = pathname.slice('/card-images'.length) + url.search;
      return proxy(req, res, CDN);
    }
    if (pathname.startsWith('/__/auth/') || pathname.startsWith('/__/firebase/')) {
      return proxy(req, res, 'https://pokoin.firebaseapp.com');
    }
    if (pathname === '/cardscan/identify') {
      req.url = `/api/scan/identify${url.search}`;
      return proxy(req, res, API);
    }
    if (pathname.startsWith('/chain/')) {
      return proxy(req, res, 'https://rpc.pokoin.com');
    }

    const card = await fromWorker(handleMarketplaceCardOgRequest, req);
    if (card) return writeWeb(res, card);
    const hub = await fromWorker(handleMarketplaceHubOgRequest, req);
    if (hub) return writeWeb(res, hub);

    if (pathname.startsWith('/brand/')) {
      const branded = safeFile(`/market${pathname}`);
      if (branded && fs.existsSync(branded) && fs.statSync(branded).isFile()) return sendFile(req, res, branded);
    }

    const link = shortlink(pathname);
    if (link && req.method === 'GET') return redirect(res, link, 302);

    const first = pathname.split('/').filter(Boolean)[0] || '';
    const file = safeFile(pathname === '/' ? '/landing.html' : pathname);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(req, res, file);
    if (first === 'home' || pathname.startsWith('/download/')) {
      res.writeHead(404, { 'content-type': 'text/plain', 'x-pokoin-web': 'pi' });
      res.end('Not Found');
      return;
    }
    if (GAMES.has(first) || !path.extname(pathname)) return sendFile(req, res, spaFile(pathname));
    res.writeHead(404, { 'content-type': 'text/plain', 'x-pokoin-web': 'pi' });
    res.end('Not Found');
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain', 'x-pokoin-web': 'pi' });
    res.end('Bad Gateway');
    console.error('pokoin-web-origin', error);
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, BIND, () => {
    console.log(`pokoin-web-origin bind=${BIND} port=${PORT} root=${ROOT}`);
  });
}

export { server, hostRedirect, shortlink, spaFile };
