#!/usr/bin/env node
// Low-rate public benchmark of api.pokoin.com (see docs/PI_LOAD_TEST.md,
// "Rust era"). Same endpoints as the 2026-09-29 Node load test, but through the
// public edge at low concurrency: production is never load-tested directly.
//
//   node scripts/api-bench.mjs --ids <dir> [--conc 2] [--n 40] [--endpoints a,b] [--out results.json]
//
// <dir> holds cards.txt (public card ids), artists.txt (illustrator names),
// names.txt (card names) and set-urls.txt (sitemap-sets.xml URLs); the SQL that
// builds them is in docs/PI_LOAD_TEST.md. Responses are attributed to the Pi or
// the nezopt overflow by x-pokoin-release.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = arg('base', 'https://api.pokoin.com');
const CONC = Number(arg('conc', 2));
const N = Number(arg('n', 40));
const OUT = arg('out', '');
const ONLY = arg('endpoints', '');
const ids = arg('ids', '.');
const lines = (file) => fs.readFileSync(path.join(ids, file), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

const cards = lines('cards.txt');
const names = lines('names.txt');
const sets = lines('set-urls.txt').map((u) => u.split('/marketplace/sets/')[1]).filter(Boolean);
// Same slug rule as market/src/artist-name.js: accents off, non-alphanumerics to '-'.
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const artists = [...new Set(lines('artists.txt').map(slug).filter(Boolean))];

let seed = 20261010;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (list) => list[Math.floor(rand() * list.length)];
const qs = (o) => new URLSearchParams(o).toString();
const prefix = (name) => name.slice(0, 3 + Math.floor(rand() * 3));

// Paths mirror market/src/api.js.
const ENDPOINTS = {
  'home-rising': () => `/api/marketplace-home?v=rising-month`,
  'artist-summaries': () => `/api/marketplace-artist-cards?${qs({ summaries: '1', limit: '1000' })}`,
  'set-index': () => `/api/marketplace-expansion-page?limit=500`,
  'artist-page': () => `/api/marketplace-artist-cards?${qs({ artistSlug: pick(artists), limit: '120', tiles: '1' })}`,
  'card-page': () => `/api/marketplace-card-page?${qs({ cardId: pick(cards), lang: 'en' })}`,
  'set-page': () => `/api/marketplace-expansion-page?${qs({ slug: pick(sets), limit: '120', offset: '0', productType: 'card' })}`,
  'search-page': () => `/api/marketplace-search-page?${qs({ query: pick(names), limit: '48', offset: '0', includeFacets: '0', lang: 'en', search_language: 'en' })}`,
  'version-set': () => `/api/marketplace-version-set?${qs({ cardId: pick(cards) })}`,
  'native-sales': () => `/api/marketplace-native-sales?${qs({ cardId: pick(cards) })}`,
  'listings-native': () => `/api/marketplace-listings?${qs({ cardId: pick(cards), nativeOnly: '1', limit: '60', _: String(Date.now()) })}`,
  suggest: () => `/api/marketplace-suggest?${qs({ q: prefix(pick(names)), limit: '20', search_language: 'en', print_language: 'all' })}`,
  'card-sales': () => `/api/marketplace-card-sales?${qs({ cardId: pick(cards) })}`,
  'card-url': () => `/api/marketplace-card-url?${qs({ cardId: pick(cards), language: 'en' })}`,
  'token-predict': () => `/api/searchbar-token-predict?${qs({ warmup: '1', limit: '1', search_language: 'en' })}`,
};

async function one(name, urlPath) {
  const t0 = performance.now();
  const sample = { endpoint: name, path: urlPath, status: 0 };
  try {
    const res = await fetch(BASE + urlPath, {
      headers: { 'user-agent': 'pokoin-bench/1.0 (api low-rate, 2026-10-10)', accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    sample.ttfbMs = performance.now() - t0;
    const body = await res.arrayBuffer();
    sample.totalMs = performance.now() - t0;
    sample.status = res.status;
    sample.bytes = body.byteLength;
    sample.release = res.headers.get('x-pokoin-release') || '';
    sample.readCache = res.headers.get('x-pokoin-read-cache') || '';
    sample.cf = res.headers.get('cf-cache-status') || '';
    sample.serverTiming = res.headers.get('server-timing') || '';
  } catch (error) {
    sample.totalMs = performance.now() - t0;
    sample.error = String(error?.name || error);
  }
  return sample;
}

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)).toFixed(1);
};
const count = (list) => list.reduce((acc, v) => ((acc[v || '-'] = (acc[v || '-'] || 0) + 1), acc), {});

async function runEndpoint(name) {
  const gen = ENDPOINTS[name];
  const samples = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < N) {
      next += 1;
      samples.push(await one(name, gen()));
    }
  }));
  const wallMs = performance.now() - start;
  const ok = samples.filter((s) => s.status >= 200 && s.status < 400);
  const total = ok.map((s) => s.totalMs).sort((a, b) => a - b);
  const ttfb = ok.map((s) => s.ttfbMs).sort((a, b) => a - b);
  const bytes = ok.map((s) => s.bytes).sort((a, b) => a - b);
  const origin = (s) => (s.release === 'nez-k3s' ? 'nez' : s.release ? 'pi' : '?');
  const byOrigin = {};
  for (const o of ['pi', 'nez']) {
    const t = ok.filter((s) => origin(s) === o).map((s) => s.totalMs).sort((a, b) => a - b);
    byOrigin[o] = { n: t.length, p50: pct(t, 0.5), p95: pct(t, 0.95) };
  }
  return {
    endpoint: name,
    n: samples.length,
    ok: ok.length,
    reqPerSec: +(samples.length / (wallMs / 1000)).toFixed(1),
    totalMs: { p50: pct(total, 0.5), p95: pct(total, 0.95), max: pct(total, 1) },
    ttfbMs: { p50: pct(ttfb, 0.5), p95: pct(ttfb, 0.95) },
    bytesP50: pct(bytes, 0.5),
    status: count(samples.map((s) => String(s.status || s.error))),
    origin: count(samples.map(origin)),
    byOrigin,
    cf: count(samples.map((s) => s.cf)),
    readCache: count(samples.map((s) => s.readCache)),
    samples,
  };
}

const names_ = ONLY ? ONLY.split(',') : Object.keys(ENDPOINTS);
const results = [];
const startedAt = new Date().toISOString();
for (const name of names_) {
  const r = await runEndpoint(name);
  results.push(r);
  const o = r.byOrigin;
  console.log(
    `${name.padEnd(17)} n=${r.n} ok=${r.ok} ${String(r.reqPerSec).padStart(5)} req/s  p50 ${String(r.totalMs.p50).padStart(7)} ms  p95 ${String(r.totalMs.p95).padStart(7)} ms  `
    + `pi p50 ${o.pi.p50 ?? '-'} (${o.pi.n})  nez p50 ${o.nez.p50 ?? '-'} (${o.nez.n})  cf=${JSON.stringify(r.cf)} rc=${JSON.stringify(r.readCache)} status=${JSON.stringify(r.status)}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ startedAt, base: BASE, conc: CONC, n: N, results }, null, 1));
}
