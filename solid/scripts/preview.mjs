#!/usr/bin/env node
/**
 * Local production-shaped preview of either UI, for parity checks and the
 * React-vs-Solid benchmarks:
 *
 *   node solid/scripts/preview.mjs --ui solid|react --port 28510 [--react-dist dir] [--solid-dist dir]
 *
 * Serves the built apps the way Cloudflare does: /market/* from market/dist,
 * /market/s/* from solid/dist/s, /home/* and root icons from home/, every SPA
 * route as the chosen UI's index.html, hashed assets immutable, brotli when
 * the browser asks. The browser talks to https://api.pokoin.com directly
 * (CORS allows non-pokoin origins without credentials), exactly as in production.
 *
 *   node solid/scripts/preview.mjs --dist-web <dir> --port 28520
 *
 * serves a full build-web.sh output instead (React/Solid switch shell): files
 * from <dir>, SPA routes as market/app.html, and the `/*` headers of
 * <dir>/_headers (CSP included) on HTML responses.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const UI = arg('ui', 'solid');
const PORT = Number(arg('port', 28510));
const HOST = arg('host', '0.0.0.0');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// --react-dist lets the baseline (an origin/main build) be served the same way.
const reactDist = path.resolve(arg('react-dist', path.join(repo, 'market/dist')));
const solidDist = path.resolve(arg('solid-dist', path.join(repo, 'solid/dist')));
const homeDir = path.join(repo, 'home');
const distWeb = arg('dist-web', '') ? path.resolve(arg('dist-web', '')) : '';
const shell = distWeb
  ? path.join(distWeb, 'market', 'app.html')
  : path.join(UI === 'react' ? reactDist : solidDist, 'index.html');

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

function resolveFile(pathname) {
  if (distWeb) {
    const file = path.join(distWeb, pathname);
    return file.startsWith(distWeb) && path.extname(pathname) ? file : null;
  }
  if (pathname.startsWith('/market/s/')) return path.join(solidDist, pathname.slice('/market/'.length));
  if (pathname.startsWith('/market/')) return path.join(reactDist, pathname.slice('/market/'.length));
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

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolveFile(pathname);
  const shortLink = pathname.match(/^\/(\d+)(?:\/[^/]+)?$/);
  if (shortLink) {
    res.writeHead(302, { Location: `/marketplace/en/cards/${shortLink[1]}` });
    res.end();
    return;
  }
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    send(req, res, file, { immutable: /\/(assets|s)\//.test(pathname) });
    return;
  }
  if (file || path.extname(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  send(req, res, shell);
}).listen(PORT, HOST, () => {
  console.log(`preview ${distWeb ? 'dist-web' : UI} on http://${HOST}:${PORT} (shell ${path.relative(repo, shell)})`);
});
