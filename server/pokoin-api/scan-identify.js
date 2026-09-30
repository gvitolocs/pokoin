'use strict';

/**
 * Pokoin card recognition API — one public entry point on the Pi.
 *
 *   POST /api/scan/identify?catalog=&top_k=&live=&multi=&album=   multipart `file`
 *   POST /api/scan/identify-album                                   multipart `file` ×N
 *   GET  /api/scan/catalogs                                         recognition catalogs
 *   GET  /api/scan/health                                           which workers answer
 *
 * The work runs on a recognition worker (server/scan/app.py, YOLO + Milo):
 *   1. nezopt GPU  — SCAN_PRIMARY_URL, default 127.0.0.1:18151 (SSH tunnel
 *      pokoin-scan-pi-tunnel.service from nezopt :8099), ~0.2 s a photo;
 *   2. Pi CPU      — SCAN_FALLBACK_URL, default 127.0.0.1:18150 (container
 *      pokoin-scan), ~2–4 s a photo, used only when nezopt is down or slow.
 * The response is the worker's JSON unchanged plus `X-Scan-Worker`. The
 * client IP is forwarded so the worker's per-IP limit still applies.
 *
 * Used by the website (pokoin.com/cardscan), scan.pokoin.com (Scan Connect)
 * and the app (cardscan.pokoin.com) — see docs/SCAN_API.md.
 */

const http = require('node:http');

const PRIMARY = process.env.SCAN_PRIMARY_URL || 'http://127.0.0.1:18151';
const FALLBACK = process.env.SCAN_FALLBACK_URL || 'http://127.0.0.1:18150';
const PRIMARY_TIMEOUT_MS = Number(process.env.SCAN_PRIMARY_TIMEOUT_MS || 6000);
const FALLBACK_TIMEOUT_MS = Number(process.env.SCAN_FALLBACK_TIMEOUT_MS || 30000);
// After a primary failure, skip it for a short while instead of paying its timeout on every scan.
const PRIMARY_COOLDOWN_MS = Number(process.env.SCAN_PRIMARY_COOLDOWN_MS || 15000);
const QUERY_KEYS = ['catalog', 'top_k', 'live', 'multi', 'album'];

let primaryDownUntil = 0;

function cors(res) {
  // Public, credential-free endpoint: phone pages, the website and the app.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Scan-Worker');
  res.setHeader('Cache-Control', 'no-store');
}

function clientIp(req) {
  const h = req.headers || {};
  const raw = h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '';
  return String(raw).trim();
}

function workerPath(route, query = {}) {
  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    if (query[key] != null && query[key] !== '') params.set(key, String(query[key]).slice(0, 64));
  }
  const qs = params.toString();
  return `${route}${qs ? `?${qs}` : ''}`;
}

/** One HTTP call to a worker → { status, headers, body } or throws. */
function callWorker(base, path, { method = 'GET', body = null, headers = {}, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 502, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('worker timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

/** nezopt first, the Pi's own worker when nezopt fails, times out or answers 5xx. */
async function viaWorkers(path, options, now = Date.now()) {
  const attempts = [];
  if (now >= primaryDownUntil) attempts.push({ name: 'nezopt', base: PRIMARY, timeoutMs: PRIMARY_TIMEOUT_MS });
  attempts.push({ name: 'pi', base: FALLBACK, timeoutMs: FALLBACK_TIMEOUT_MS });
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const out = await callWorker(attempt.base, path, { ...options, timeoutMs: attempt.timeoutMs });
      if (out.status >= 500 && attempt !== attempts[attempts.length - 1]) {
        lastError = new Error(`${attempt.name} answered ${out.status}`);
        if (attempt.name === 'nezopt') primaryDownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
        continue;
      }
      if (attempt.name === 'nezopt') primaryDownUntil = 0;
      return { ...out, worker: attempt.name };
    } catch (error) {
      lastError = error;
      if (attempt.name === 'nezopt') primaryDownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
    }
  }
  throw lastError || new Error('No recognition worker answered.');
}

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // album uploads carry several photos

/** Upload bytes: the server hands rawBody routes the untouched stream. */
async function uploadBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.on !== 'function') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Photo too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, out) {
  res.statusCode = out.status;
  res.setHeader('Content-Type', out.headers['content-type'] || 'application/json');
  res.setHeader('X-Scan-Worker', out.worker);
  res.end(out.body);
}

function makeHandler(route, { method }) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== method) {
      res.setHeader('Allow', `${method}, OPTIONS`);
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Method not allowed.' }));
    }
    const headers = { 'X-Forwarded-For': clientIp(req) };
    let body = null;
    if (method === 'POST') {
      try {
        body = await uploadBody(req);
      } catch (error) {
        res.statusCode = error.statusCode || 400;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: error.message || 'Upload failed.' }));
      }
      if (!body || !body.length) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Send the photo as multipart field "file".' }));
      }
      headers['Content-Type'] = req.headers['content-type'] || 'application/octet-stream';
      headers['Content-Length'] = String(body.length);
    }
    try {
      const out = await viaWorkers(workerPath(route, req.query || {}), { method, body, headers });
      return send(res, out);
    } catch (error) {
      console.error('scan-identify: no worker answered', { route, message: error.message });
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Card recognition is unavailable right now. Try again in a moment.' }));
    }
  };
}

/** GET /api/scan/health — both workers, without falling back. */
async function health(req, res) {
  cors(res);
  const probe = async (base) => {
    const started = Date.now();
    try {
      const out = await callWorker(base, '/health', { timeoutMs: 3000 });
      return { ok: out.status === 200, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error.code || error.message };
    }
  };
  const [nezopt, pi] = await Promise.all([probe(PRIMARY), probe(FALLBACK)]);
  res.statusCode = nezopt.ok || pi.ok ? 200 : 503;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: nezopt.ok || pi.ok, workers: { nezopt, pi } }));
}

const identify = makeHandler('/identify', { method: 'POST' });
module.exports = identify;
module.exports.identify = identify;
module.exports.identifyAlbum = makeHandler('/identify-album', { method: 'POST' });
module.exports.catalogs = makeHandler('/catalogs', { method: 'GET' });
module.exports.health = health;
module.exports._test = {
  workerPath,
  clientIp,
  viaWorkers,
  resetPrimary() { primaryDownUntil = 0; },
};
