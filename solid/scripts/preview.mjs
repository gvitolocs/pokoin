#!/usr/bin/env node
/**
 * Local production-shaped preview of the SPA, for parity checks and benchmarks:
 *
 *   node solid/scripts/preview.mjs --port 28510 [--dist dir]
 *
 * Serves the built app the way Cloudflare does: /market/* from solid/dist (the
 * Solid build with market/public), /home/* and root icons from home/, every SPA
 * route as index.html, hashed chunks immutable, brotli when the browser asks.
 * The browser talks to https://api.pokoin.com directly (CORS allows non-pokoin
 * origins without credentials), exactly as in production.
 *
 *   node solid/scripts/preview.mjs --dist-web <dir> --port 28520
 *
 * serves a full build-web.sh output instead, as Workers Static Assets would:
 * <dir>/_redirects first (rewrites and redirects, scripts/write-cloudflare-web-routing.mjs),
 * then files with html_handling auto-trailing-slash, else 404 (not_found_handling
 * none). HTML responses carry the `/*` headers of <dir>/_headers (CSP included).
 * GET /api/* and /card-images/* pass through to api.pokoin.com / cdn.pokoin.com
 * like the pokoin-web Worker; any other method is refused.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { applyRedirect } from '../../scripts/write-cloudflare-web-routing.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const PORT = Number(arg('port', 28510));
const HOST = arg('host', '0.0.0.0');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(arg('dist', path.join(repo, 'solid/dist')));
const homeDir = path.join(repo, 'home');
const distWeb = arg('dist-web', '') ? path.resolve(arg('dist-web', '')) : '';
const shell = distWeb ? path.join(distWeb, 'market', 'app.html') : path.join(dist, 'index.html');

/** The `/*` block of a Cloudflare _headers file (applied to HTML responses). */
function siteHeaders() {
  if (!distWeb || !fs.existsSync(path.join(distWeb, '_headers'))) return {};
  const lines = fs.readFileSync(path.join(distWeb, '_headers'), 'utf8').split('\n');
  const start = lines.indexOf('/*');
  const out = {};
  for (let i = start + 1; start >= 0 && i < lines.length && /^\s+\S/.test(lines[i]); i += 1) {
    const [name, ...value] = lines[i].trim().split(':');
    out[name] = value.join(':').trim();
  }
  return out;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.webmanifest': 'application/manifest+json',
};
const ROOT_ICONS = {
  '/favicon.ico': 'favicon.ico', '/favicon-32x32.png': 'favicon-32x32.png', '/favicon-48x48.png': 'favicon-48x48.png',
  '/favicon-96x96.png': 'favicon-96x96.png', '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/pokoin-192.png': 'pokoin-192.png', '/pokoin-512.png': 'logo.png',
};
const brCache = new Map();

/** Static assets lookup with html_handling auto-trailing-slash (/market/app → app.html). */
function distWebFile(pathname) {
  const file = path.join(distWeb, pathname);
  if (!file.startsWith(distWeb)) return null;
  const candidates = pathname.endsWith('/')
    ? [path.join(file, 'index.html')]
    : [file, `${file}.html`, path.join(file, 'index.html')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

/** The pokoin-web Worker's pass-through hops, read-only here. */
const PASS_THROUGH = [
  ['/api/', 'https://api.pokoin.com', (pathname) => pathname],
  ['/card-images/', 'https://cdn.pokoin.com', (pathname) => pathname.slice('/card-images'.length)],
];

async function passThrough(req, res, url) {
  const hop = PASS_THROUGH.find(([prefix]) => url.pathname.startsWith(prefix));
  if (!hop) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('preview is read-only');
    return true;
  }
  const upstream = await fetch(`${hop[1]}${hop[2](url.pathname)}${url.search}`, {
    method: req.method,
    headers: { accept: String(req.headers.accept || '*/*') },
    redirect: 'manual',
  });
  const headers = {};
  for (const name of ['content-type', 'cache-control', 'location']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  const body = req.method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, headers);
  res.end(body || undefined);
  return true;
}

function serveDistWeb(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  const lines = fs.existsSync(path.join(distWeb, '_redirects'))
    ? fs.readFileSync(path.join(distWeb, '_redirects'), 'utf8').split('\n')
    : [];
  const rule = applyRedirect(pathname, lines);
  if (rule && rule.code !== 200) {
    const location = rule.location.includes('?') ? rule.location : `${rule.location}${url.search}`;
    res.writeHead(rule.code, { Location: location });
    res.end();
    return;
  }
  if (rule) pathname = rule.location;
  const file = distWebFile(pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  send(req, res, file, { immutable: pathname.startsWith('/market/s/') });
}

function resolveFile(pathname) {
  if (pathname.startsWith('/market/')) return path.join(dist, pathname.slice('/market/'.length));
  if (pathname.startsWith('/home/')) return path.join(homeDir, pathname.slice('/home/'.length));
  if (ROOT_ICONS[pathname]) return path.join(homeDir, ROOT_ICONS[pathname]);
  if (pathname === '/site.webmanifest') return path.join(repo, 'site.webmanifest');
  return null;
}

function send(req, res, file, { immutable = false } = {}) {
  const ext = path.extname(file);
  const type = TYPES[ext] || 'application/octet-stream';
  let body = fs.readFileSync(file);
  const headers = {
    ...(ext === '.html' ? siteHeaders() : {}),
    'Content-Type': type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
  };
  const compressible = /^(text\/|application\/(json|manifest))/.test(type) || ext === '.svg';
  if (compressible && /\bbr\b/.test(String(req.headers['accept-encoding'] || ''))) {
    // Keyed by mtime too: a rebuild rewrites index.html under the same path.
    const key = `${file}:${fs.statSync(file).mtimeMs}`;
    let packed = brCache.get(key);
    if (!packed) {
      packed = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
      brCache.set(key, packed);
    }
    body = packed;
    headers['Content-Encoding'] = 'br';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (distWeb) {
    try {
      if (!(await passThrough(req, res, url))) serveDistWeb(req, res, url);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(String(error?.message || error));
    }
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
  const file = resolveFile(pathname);
  const shortLink = pathname.match(/^\/(\d+)(?:\/[^/]+)?$/);
  if (shortLink) {
    res.writeHead(302, { Location: `/marketplace/en/cards/${shortLink[1]}` });
    res.end();
    return;
  }
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    send(req, res, file, { immutable: pathname.startsWith('/market/s/') });
    return;
  }
  if (file || path.extname(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  send(req, res, shell);
}).listen(PORT, HOST, () => {
  console.log(`preview on http://${HOST}:${PORT} (shell ${path.relative(repo, shell)})`);
});
