#!/usr/bin/env node
// Scan Connect delivery latency for docs/SCAN_PERFORMANCE.md: how long a scan
// takes from the phone's POST to the row landing on the desktop's open SSE
// stream, on the real handlers + a throwaway Postgres (no browser, no GPU).
//
//   SCAN_TEST_DATABASE_URL=postgres://postgres:scantest@127.0.0.1:55432/scantest \
//   node scripts/scan-connect-bench-delivery.mjs 120
//
// Env: CARDVAULT_DIR, BENCH_PORT.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projects = path.resolve(here, '..', '..');
const CARDVAULT = process.env.CARDVAULT_DIR || path.join(projects, 'cardvault', 'pokemon_card_vault');
const PORT = Number(process.env.BENCH_PORT || 18991);
const API = `http://127.0.0.1:${PORT}`;
const COUNT = Number(process.argv[2] || 120);
const SELLER = 'bench-seller-000000000001';
const DESK = { authorization: `Bearer seller:${SELLER}`, 'content-type': 'application/json' };

if (!process.env.SCAN_TEST_DATABASE_URL) {
  console.error('SCAN_TEST_DATABASE_URL is required (throwaway database).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = spawn(process.execPath, ['scripts/scan-connect-dev-server.js', '--reset'], {
  cwd: CARDVAULT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SCAN_DEV_FAKE_AUTH: '1', PORT: String(PORT), NODE_ENV: 'development' },
});
const apiLog = [];
api.stdout.on('data', (d) => apiLog.push(String(d)));
api.stderr.on('data', (d) => apiLog.push(String(d)));
process.on('exit', () => api.kill());

async function waitUp() {
  for (let i = 0; i < 200; i += 1) {
    try {
      const res = await fetch(`${API}/api/scan-pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`API did not start:\n${apiLog.join('')}`);
}

const stats = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q) => v[Math.min(v.length - 1, Math.ceil(v.length * q) - 1)];
  return { n: v.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(v[v.length - 1]) };
};

await waitUp();

// Desktop starts a session, phone claims the PIN.
const started = await (await fetch(`${API}/api/scan-session?action=start`, { method: 'POST', headers: DESK, body: '{}' })).json();
const batchId = started.batch.id;
const claimed = await (await fetch(`${API}/api/scan-pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
  body: JSON.stringify({ pin: started.pairing.pin, qr: started.pairing.qrSecret, device: 'bench' }),
})).json();
const PHONE = { authorization: `Scan ${claimed.phoneToken}`, 'content-type': 'application/json' };

// Desktop stream: resolve a waiter as soon as its scanEventId appears in an `items` frame.
const waiters = new Map();
const streamed = new Set();
const ctrl = new AbortController();
const stream = await fetch(`${API}/api/scan-stream?batchId=${batchId}`, { headers: DESK, signal: ctrl.signal });
if (!stream.ok) throw new Error(`stream ${stream.status}`);
(async () => {
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      for (const item of parsed.items || []) {
        const id = item.scanEventId || item.scan_event_id;
        if (!id) continue;
        streamed.add(id);
        const waiter = waiters.get(id);
        if (waiter) { waiters.delete(id); waiter(performance.now()); }
      }
    }
  }
})().catch(() => {});

const HITS = [
  [{ cardId: '253710', score: 0.91 }, { cardId: '246870', score: 0.31 }],   // MATCHED
  [{ cardId: '271680', score: 0.66 }, { cardId: '230126', score: 0.62 }],   // AMBIGUOUS
  [],                                                                       // UNMATCHED
];

const rows = [];
for (let i = 0; i < COUNT; i += 1) {
  const scanEventId = crypto.randomUUID();
  const hits = HITS[i % HITS.length];
  const wait = new Promise((resolve) => waiters.set(scanEventId, resolve));
  const t0 = performance.now();
  const res = await fetch(`${API}/api/scan-phone?action=scan`, {
    method: 'POST',
    headers: PHONE,
    body: JSON.stringify({
      scanEventId,
      clientSequence: i + 1,
      capturedAt: Date.now(),
      clockOffsetMs: 0,
      recognition: { catalog: 'pokemon_generic', hits },
      timings: { captureToRequestMs: 30, identifyMs: 57, attempt: 1 },
    }),
  });
  const ingestMs = performance.now() - t0;
  const body = await res.json();
  const seen = await Promise.race([wait, sleep(5000).then(() => null)]);
  waiters.delete(scanEventId);
  rows.push({
    status: res.status,
    state: body.recognitionState || '',
    ingestMs,
    deliveryMs: seen == null ? null : seen - t0,
  });
  await sleep(280); // the phone's own capture cadence
}

ctrl.abort();
api.kill();

const ok = rows.filter((r) => r.status === 200);
console.log(JSON.stringify({
  requests: COUNT,
  ok: ok.length,
  delivered: rows.filter((r) => r.deliveryMs != null).length,
  ingestMs: stats(ok.map((r) => r.ingestMs)),
  phonePostToDesktopRowMs: stats(rows.map((r) => r.deliveryMs)),
  states: ok.reduce((acc, r) => ({ ...acc, [r.state || '?']: (acc[r.state || '?'] || 0) + 1 }), {}),
}, null, 1));
process.exit(0);
