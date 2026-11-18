#!/usr/bin/env node
/**
 * Carry the previous releases' hashed SPA chunks into a new pokoin-web upload.
 *
 *   node scripts/carry-web-release-chunks.mjs dist-web --release <sha> [--from https://pokoin.com] [--keep 2]
 *
 * A Workers Static Assets version only contains its own files, and every build
 * renames the hashed /market/s/* chunks. Tabs left open on the previous release,
 * and the previous HTML shell that some edges keep serving for a minute or two
 * after `wrangler versions deploy`, then ask the new version for chunks it does
 * not have: 404, "Failed to fetch dynamically imported module", blank page.
 *
 * Each upload therefore also contains the chunks of the last `--keep` releases,
 * downloaded from the live site. market/release-chunks.json records which files
 * each release owns, newest first; the next deploy reads it from the live site.
 * When the live site has no manifest yet, the chunk list is crawled from the
 * live shell (/market/app) and the chunks it imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = 'market/release-chunks.json';
const CHUNK_DIR = 'market/s';
const CONCURRENCY = 8;

/** Files under <dist>/market/s, as paths relative to that directory. */
export function listChunks(dist) {
  const root = path.join(dist, CHUNK_DIR);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

const CHUNK_FILE = '([A-Za-z0-9_$~-][A-Za-z0-9_$~.-]*\\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|gif|wasm))';
// The shell uses /market/s/x.js, chunks import siblings as ./x.js, and
// __vite__mapDeps lists "s/x.js" (relative to the /market/ base).
const REF_RE = new RegExp(`(?:/market/s/|["'\`(]s/|["'\`(]\\./)${CHUNK_FILE}`, 'g');

/** Chunk file names referenced by a shell or chunk body. */
export function chunkRefs(text) {
  const refs = new Set();
  for (const match of String(text || '').matchAll(REF_RE)) refs.add(match[1]);
  return [...refs];
}

/**
 * Which files to carry. `previous` is the live manifest's release list (newest
 * first); the new manifest keeps `keep` of them behind this release.
 */
export function planCarry(own, previous, keep) {
  const ownSet = new Set(own);
  const kept = (previous || []).slice(0, Math.max(0, keep));
  const carry = new Set();
  for (const release of kept) {
    for (const file of release.files || []) if (!ownSet.has(file)) carry.add(file);
  }
  return { kept, carry: [...carry].sort() };
}

function validReleases(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.releases)) return null;
  return manifest.releases
    .filter((row) => row && typeof row.release === 'string' && Array.isArray(row.files))
    .map((row) => ({ release: row.release, files: row.files.filter((file) => typeof file === 'string' && !file.includes('..')) }));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await fn(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * GET a live file. 404 is a normal answer (null); anything else that is not a
 * 200 throws, so a flaky origin fails the deploy instead of silently dropping
 * the safety net.
 */
async function fetchLive(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** First run: every chunk reachable from the live shell. */
async function crawlLive(fetchImpl, from) {
  const shell = await fetchLive(fetchImpl, `${from}/market/app`);
  if (!shell) throw new Error(`GET ${from}/market/app: 404 (no live shell to crawl)`);
  const found = new Map();
  let queue = chunkRefs(shell.toString('utf8'));
  while (queue.length) {
    const batch = queue.filter((file) => !found.has(file));
    queue = [];
    for (const file of batch) found.set(file, null);
    const bodies = await mapLimit(batch, CONCURRENCY, (file) => fetchLive(fetchImpl, `${from}/${CHUNK_DIR}/${file}`));
    batch.forEach((file, i) => {
      found.set(file, bodies[i]);
      if (bodies[i] && /\.(?:js|css)$/.test(file)) queue.push(...chunkRefs(bodies[i].toString('utf8')));
    });
  }
  const files = [...found.keys()].filter((file) => found.get(file)).sort();
  return { releases: [{ release: 'live', files }], bodies: found };
}

export async function carryReleaseChunks({ dist, release, from = 'https://pokoin.com', keep = 2, fetchImpl = fetch, log = console.log }) {
  if (!release) throw new Error('--release <id> is required (the origin/main sha being deployed)');
  const own = listChunks(dist);
  if (!own.length) throw new Error(`${path.join(dist, CHUNK_DIR)} has no chunks; run scripts/build-web.sh first`);
  const base = from.replace(/\/+$/, '');

  let previous = null;
  let bodies = new Map();
  const live = await fetchLive(fetchImpl, `${base}/${MANIFEST}?t=${Date.now()}`);
  if (live) {
    try {
      previous = validReleases(JSON.parse(live.toString('utf8')));
    } catch (_) {
      previous = null;
    }
  }
  if (!previous) {
    log(`carry: no usable ${MANIFEST} on ${base}; crawling the live shell`);
    ({ releases: previous, bodies } = await crawlLive(fetchImpl, base));
  }

  // A redeploy of the same release must not push an older one out.
  previous = previous.filter((row) => row.release !== release);
  const { kept, carry } = planCarry(own, previous, keep);
  const missing = new Set();
  await mapLimit(carry, CONCURRENCY, async (file) => {
    const body = bodies.get(file) || await fetchLive(fetchImpl, `${base}/${CHUNK_DIR}/${file}`);
    if (!body) {
      missing.add(file);
      return;
    }
    const target = path.join(dist, CHUNK_DIR, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  });

  const releases = [
    { release, files: own },
    ...kept.map((row) => ({ release: row.release, files: row.files.filter((file) => !missing.has(file)) })),
  ];
  const manifest = { version: 1, generated: new Date().toISOString(), releases };
  fs.writeFileSync(path.join(dist, MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`);

  const carried = carry.length - missing.size;
  log(`carry: ${own.length} own chunks, ${carried} carried from ${kept.map((row) => row.release).join(', ') || 'nothing'}`
    + (missing.size ? `, ${missing.size} no longer live (skipped)` : ''));
  return { own: own.length, carried, missing: [...missing].sort(), releases: releases.map((row) => row.release) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const dist = path.resolve(args.find((value, i) => !value.startsWith('--') && !String(args[i - 1] || '').startsWith('--')) || 'dist-web');
  carryReleaseChunks({
    dist,
    release: arg('release', ''),
    from: arg('from', 'https://pokoin.com'),
    keep: Number(arg('keep', 2)),
  }).catch((err) => {
    console.error(`carry: ${err.message}`);
    process.exit(1);
  });
}
