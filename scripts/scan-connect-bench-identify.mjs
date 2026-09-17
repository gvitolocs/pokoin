#!/usr/bin/env node
// Recognition latency for docs/SCAN_PERFORMANCE.md: the phone's live identify
// request (≤960 px JPEG q0.72, catalog pokemon_generic, live=1, top_k=3) against
// the real BattleScan service, one request at a time with the phone's 280 ms
// cadence so a real user scanning is never pushed into `busy`.
//
//   node scripts/scan-connect-bench-identify.mjs http://127.0.0.1:8099 60
//   node scripts/scan-connect-bench-identify.mjs https://cardscan.pokoin.com 30

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projects = path.resolve(here, '..', '..');
const require = createRequire(path.join(projects, 'cardvault', 'pokemon_card_vault', 'package.json'));
const sharp = require('sharp');

const base = (process.argv[2] || 'http://127.0.0.1:8099').replace(/\/$/, '');
const count = Number(process.argv[3] || 60);
const dir = path.join(projects, 'BattleScan', 'images');
const photos = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();

const frames = [];
for (const name of photos) {
  const t0 = performance.now();
  const jpeg = await sharp(path.join(dir, name)).rotate().resize(960, 960, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
  frames.push({ name, jpeg, encodeMs: performance.now() - t0 });
}

const rows = [];
for (let i = 0; i < count; i += 1) {
  const frame = frames[i % frames.length];
  const body = new FormData();
  body.append('file', new Blob([frame.jpeg], { type: 'image/jpeg' }), 'card.jpg');
  const url = `${base}/identify?catalog=pokemon_generic&multi=0&live=1&top_k=3`;
  const t0 = performance.now();
  const res = await fetch(url, { method: 'POST', body });
  const data = await res.json();
  const ms = performance.now() - t0;
  rows.push({
    photo: frame.name,
    status: res.status,
    busy: data.busy === true,
    ms: Math.round(ms),
    serverDetectMs: data.detect_ms ?? null,
    serverIdentifyMs: data.identify_ms ?? null,
    top: data.top1 ? { id: data.top1.public_id, score: data.top1.score } : null,
    worker: data.worker || '',
  });
  await new Promise((r) => setTimeout(r, 280));
}

const ok = rows.filter((r) => r.status === 200 && !r.busy);
const stats = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, p50: v[Math.floor(v.length / 2)], p95: v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)], max: v[v.length - 1] };
};
const summary = {
  base,
  requests: rows.length,
  busy: rows.filter((r) => r.busy).length,
  errors: rows.filter((r) => r.status !== 200).length,
  roundTripMs: stats(ok.map((r) => r.ms)),
  serverDetectMs: stats(ok.map((r) => r.serverDetectMs)),
  serverIdentifyMs: stats(ok.map((r) => r.serverIdentifyMs)),
  encodeMs: stats(frames.map((f) => Math.round(f.encodeMs))),
  frameBytes: frames.map((f) => [f.name, f.jpeg.length]),
  worker: [...new Set(rows.map((r) => r.worker))],
  firstRows: rows.slice(0, 6),
};
console.log(JSON.stringify(summary, null, 1));
