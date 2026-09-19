#!/usr/bin/env node
/**
 * Disk CDN — same path/remap contract as pokoin-cdn-card-images Worker.
 * Live origin is the Raspberry Pi tunnel https://cdn.pokoin.com/{key}.
 *
 * Env:
 *   POKOIN_CDN_ROOT  default /home/ubuntu/pokoin-cdn (Pi: /srv/pokoin/card-images/objects)
 *   PORT             default 18090 (Pi: 18081)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const ROOT = path.resolve(process.env.POKOIN_CDN_ROOT || '/home/ubuntu/pokoin-cdn');
const PORT = Number(process.env.PORT || 18090);
const BIND = process.env.POKOIN_CDN_BIND || '127.0.0.1';
const CDN_NAME = process.env.POKOIN_CDN_NAME || 'oracle-peer1';
const INDEX_MS = Number(process.env.POKOIN_CDN_INDEX_MS || 120000);

const SKIP_INDEX_PREFIXES = [
  'originals/',
  'manifests/',
  'previews/',
  'competitive/',
  'one-piece/',
  'riftbound/',
  'artcut/',
  // Multi-game re-import prefixes (docs/MULTIGAME_REIMPORT.md): never index or
  // halve ids under a game prefix — ids collide across games.
  'magic/',
  'yugioh/',
  'lorcana/',
  'flesh-and-blood/',
  'digimon/',
  'dragon-ball-super/',
  'vanguard/',
  'star-wars/',
  'union-arena/',
  'gundam/',
  'sorcery/',
];

const GAME_PREFIX_RE =
  /^(one-piece|riftbound|magic|yugioh|lorcana|flesh-and-blood|digimon|dragon-ball-super|vanguard|star-wars|union-arena|gundam|sorcery)\//i;

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
    key.startsWith('competitive/') ||
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

function homepageJpegKey(requestedKey) {
  const key = String(requestedKey || '').replace(/^\/+/, '');
  if (!/_homepage\.webp$/i.test(key)) return null;
  return key.replace(/_homepage\.webp$/i, '.jpg');
}

function leftoverIdFromKey(requestedKey) {
  const match = String(requestedKey || '').replace(/^\/+/, '').match(/^(?:previews\/)?(\d+)_/);
  return match ? match[1] : '';
}

function halfLeftoverId(id) {
  if (!/^\d+$/.test(id)) return '';
  try {
    const value = BigInt(id);
    if (value > 0n && value % 2n === 0n) return String(value / 2n);
  } catch {
    /* ignore */
  }
  return '';
}

function leftoverLookupIds(requestedKey) {
  const id = leftoverIdFromKey(requestedKey);
  if (!id) return [];
  const ids = [id];
  const half = halfLeftoverId(id);
  // Public id → leftover is fallback only. Requested leftover ct_id stays first
  // so even leftovers (Meloetta 122490) are not halved again to leftover/4.
  if (half) ids.push(half);
  return ids;
}

function leftoverImageSlug(key) {
  const file = String(key || '').replace(/^\/+/, '').replace(/^previews\//, '').split('/').pop() || '';
  return file
    .replace(/_homepage(?=\.(?:webp|jpe?g|png))/i, '')
    .replace(/\.(?:jpe?g|png|webp)$/i, '')
    .replace(/^\d+_/, '')
    .toLowerCase();
}

function leftoverSlugCompatible(requestedSlug, dumpName) {
  const dump = leftoverImageSlug(dumpName);
  const want = String(requestedSlug || '').toLowerCase();
  if (!dump) return false;
  if (!want) return true;
  return want === dump || dump.startsWith(`${want}-`) || want.startsWith(`${dump}-`);
}

function dumpsHaveForeignSlug(files, requestedSlug) {
  return (files || []).some((name) => !leftoverSlugCompatible(requestedSlug, name));
}

function wantsHomepage(requestedKey) {
  return /_homepage\.webp$/i.test(String(requestedKey || ''));
}

function pickLeftoverAlias(files, wantHomepage) {
  const names = [...(files || [])];
  if (!names.length) return null;
  const homepages = names.filter((name) => /_homepage\.webp$/i.test(name));
  const jpegs = names.filter((name) => /\.jpe?g$/i.test(name));
  const shortest = (a, b) => a.length - b.length || a.localeCompare(b);
  if (wantHomepage) {
    if (homepages.length) return homepages.sort(shortest)[0];
    if (jpegs.length) return jpegs.sort(shortest)[0];
  }
  if (jpegs.length) return jpegs.sort(shortest)[0];
  return names.sort(shortest)[0];
}

function skipIndexedKey(name) {
  const key = String(name || '');
  return SKIP_INDEX_PREFIXES.some((prefix) => key.startsWith(prefix) || key.includes(`/${prefix}`));
}

function buildLeftoverIndex(root = ROOT) {
  const byId = new Map();
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return byId;
  }
  for (const name of names) {
    if (skipIndexedKey(name)) continue;
    const match = name.match(/^(\d+)_/);
    if (!match) continue;
    const id = match[1];
    let list = byId.get(id);
    if (!list) {
      list = [];
      byId.set(id, list);
    }
    list.push(name);
  }
  return byId;
}

function candidateKeys(requestedKey) {
  const key = String(requestedKey || '').replace(/^\/+/, '');
  const out = [];
  const add = (value) => {
    if (value && !out.includes(value)) out.push(value);
  };
  const catalog = jpegCatalogKey(key);
  add(key);
  add(catalog);
  const jpeg = homepageJpegKey(key);
  if (jpeg) add(jpeg);
  add(leftoverCdnObjectKey(key));
  add(leftoverCdnObjectKey(catalog));
  if (jpeg) add(leftoverCdnObjectKey(jpeg));
  if (GAME_PREFIX_RE.test(key)) {
    const stem = key
      .replace(/_homepage\.(jpe?g|png|webp)$/i, '')
      .replace(/\.(jpe?g|png|webp)$/i, '');
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      add(`${stem}${ext}`);
    }
  }
  return out;
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

let leftoverIndex = new Map();
let leftoverIndexAt = 0;

function refreshLeftoverIndex(force = false) {
  const now = Date.now();
  if (!force && leftoverIndexAt && now - leftoverIndexAt < INDEX_MS) {
    return leftoverIndex;
  }
  leftoverIndex = buildLeftoverIndex(ROOT);
  leftoverIndexAt = now;
  return leftoverIndex;
}

function statFile(root, key) {
  const full = path.join(root, key);
  if (!full.startsWith(root)) return null;
  try {
    const st = fs.statSync(full);
    if (st.isFile()) return { full, key, size: st.size, mtime: st.mtime };
  } catch {
    /* miss */
  }
  return null;
}

function resolveFile(key, { root = ROOT, index } = {}) {
  const wantHomepage = wantsHomepage(key);
  const slug = leftoverImageSlug(key);
  const requestedId = leftoverIdFromKey(key);
  const halfId = halfLeftoverId(requestedId);
  const byId = index || leftoverIndex;
  const aliasHit = (id) => {
    if (!id) return null;
    const matches = (byId.get(id) || []).filter((name) => leftoverSlugCompatible(slug, name));
    const alias = pickLeftoverAlias(matches, wantHomepage);
    return alias ? statFile(root, alias) : null;
  };
  // Same leftover ct_id wins when its dumps match this slug. Only half (public →
  // leftover) when this id's dumps belong to another card (Net Ball 245292 vs
  // Cyndaquil). Never pick leftover/4 because an even leftover id is still even.
  // If the leftover dump was saved under another card's slug (Metang 321834
  // files are still named great-tusk), serve that dump when half has no match.
  if (requestedId) {
    const sameFiles = byId.get(requestedId) || [];
    const foreign = dumpsHaveForeignSlug(sameFiles, slug);
    if (!foreign) {
      const hit = aliasHit(requestedId);
      if (hit) return hit;
    }
    const halfHit = aliasHit(halfId);
    if (halfHit) return halfHit;
    if (foreign) {
      const hit = aliasHit(requestedId);
      if (hit) return hit;
    }
    const leftoverDump = pickLeftoverAlias(sameFiles, wantHomepage);
    if (leftoverDump) {
      const hit = statFile(root, leftoverDump);
      if (hit) return hit;
    }
    const halfDump = pickLeftoverAlias(byId.get(halfId) || [], wantHomepage);
    if (halfDump) {
      const hit = statFile(root, halfDump);
      if (hit) return hit;
    }
  }
  const candidates = candidateKeys(key);
  const primary = wantHomepage
    ? candidates.filter((name) => /_homepage\.webp$/i.test(name))
    : candidates;
  const fallback = wantHomepage
    ? candidates.filter((name) => !/_homepage\.webp$/i.test(name))
    : [];
  for (const candidate of primary) {
    const hit = statFile(root, candidate);
    if (hit) return hit;
  }
  for (const candidate of fallback) {
    const hit = statFile(root, candidate);
    if (hit) return hit;
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
  res.setHeader('X-Pokoin-CDN', CDN_NAME);
  res.setHeader('X-Pokoin-CDN-Origin', CDN_NAME);
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function createServer() {
  return http.createServer((req, res) => {
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
      res.end(JSON.stringify({
        ok: true,
        root: ROOT,
        host: CDN_NAME,
        indexed: leftoverIndex.size,
        indexAgeMs: leftoverIndexAt ? Date.now() - leftoverIndexAt : null,
      }));
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
      sendHeaders(res, { 'Cache-Control': 'private, no-store' });
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
}

module.exports = {
  leftoverCdnObjectKey,
  jpegCatalogKey,
  homepageJpegKey,
  leftoverLookupIds,
  leftoverSlugCompatible,
  pickLeftoverAlias,
  candidateKeys,
  buildLeftoverIndex,
  resolveFile,
  getObjectKey,
  createServer,
};

if (require.main === module) {
  refreshLeftoverIndex(true);
  setInterval(() => {
    try {
      refreshLeftoverIndex(true);
    } catch (_) {
      /* keep serving the last index */
    }
  }, INDEX_MS).unref();
  const server = createServer();
  server.listen(PORT, BIND, () => {
    console.log(
      `pokoin-oracle-cdn name=${CDN_NAME} root=${ROOT} bind=${BIND} port=${PORT} indexed=${leftoverIndex.size}`,
    );
  });
}
