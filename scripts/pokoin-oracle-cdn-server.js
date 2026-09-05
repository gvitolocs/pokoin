#!/usr/bin/env node
/**
 * Oracle disk CDN — same path/remap contract as pokoin-cdn-card-images Worker.
 * Public URLs stay https://cdn.pokoin.com/{key} (DNS → this host).
 * Also served on api2.pokoin.com for explicit Oracle origin.
 *
 * Env:
 *   POKOIN_CDN_ROOT  default /home/ubuntu/pokoin-cdn
 *   PORT             default 18090
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const ROOT = path.resolve(process.env.POKOIN_CDN_ROOT || '/home/ubuntu/pokoin-cdn');
const PORT = Number(process.env.PORT || 18090);

function leftoverCdnObjectKey(requestedKey) {
  const key = String(requestedKey || '').replace(/^\/+/, '');
  const match = key.match(/^(previews\/)?(\d+)(_.*)$/);
  if (!match) return null;
  const prefix = match[2];
  if (!/^\d+$/.test(prefix) || prefix.length > 16) return null;
  let value;
  try {
    value = BigInt(prefix);
  } catch {
    return null;
  }
  if (value <= 0n || value % 2n !== 0n) return null;
  const leftover = value / 2n;
  if (leftover <= 0n) return null;
  return `${match[1] || ''}${leftover}${match[3]}`;
}

function keepRawObjectKey(key) {
  return (
    key.startsWith('originals/') ||
    key.startsWith('manifests/') ||
    key.startsWith('previews/') ||
    /_homepage\.webp$/i.test(key)
  );
}

function jpegCatalogKey(requestedKey) {
  const key = String(requestedKey || '').replace(/^\/+/, '');
  if (!key) return null;
  if (keepRawObjectKey(key)) return key;
  if (/\.jpe?g$/i.test(key)) return key;
  return key.replace(/\.(png|webp)$/i, '.jpg');
}

function getObjectKey(urlPath) {
  let key = decodeURIComponent(String(urlPath || '').replace(/^\/+/, ''));
  if (key.startsWith('card-images/')) key = key.slice('card-images/'.length);
  if (!key || key.includes('..')) return null;
  return key;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function resolveFile(key) {
  const candidates = [];
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  const catalog = jpegCatalogKey(key);
  add(catalog);
  add(leftoverCdnObjectKey(catalog));
  add(key);
  for (const candidate of candidates) {
    const full = path.join(ROOT, candidate);
    if (!full.startsWith(ROOT)) continue;
    try {
      const st = fs.statSync(full);
      if (st.isFile()) return { full, key: candidate, size: st.size, mtime: st.mtime };
    } catch {
      /* miss */
    }
  }
  return null;
}

function sendHeaders(res, extra = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Robots-Tag', 'noai, noimageai');
  res.setHeader('X-Pokoin-CDN', 'oracle-peer1');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    sendHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendHeaders(res);
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/health' || url.pathname === '/api/health') {
    sendHeaders(res, { 'Content-Type': 'application/json; charset=utf-8' });
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, root: ROOT, host: 'api2/cdn oracle' }));
    return;
  }

  const key = getObjectKey(url.pathname);
  if (!key) {
    sendHeaders(res);
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const hit = resolveFile(key);
  if (!hit) {
    sendHeaders(res);
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  sendHeaders(res, {
    'Content-Type': contentType(hit.full),
    'Content-Length': String(hit.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Pokoin-CDN-Object-Key': hit.key,
    ...(hit.key !== key ? { 'X-Pokoin-CDN-Mapped-From': key } : {}),
    'Last-Modified': hit.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') {
    res.writeHead(200);
    res.end();
    return;
  }
  res.writeHead(200);
  pipeline(fs.createReadStream(hit.full), res, () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`pokoin-oracle-cdn root=${ROOT} port=${PORT}`);
});
