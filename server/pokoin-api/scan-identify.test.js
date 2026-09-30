'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const TARGET = path.resolve(__dirname, 'scan-identify.js');

function worker(name, { status = 200, delayMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, xff: req.headers['x-forwarded-for'], type: req.headers['content-type'], body: Buffer.concat(chunks).toString() });
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ worker: name, matches: [{ name: 'Pikachu' }] }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function load(env) {
  Object.assign(process.env, env);
  delete require.cache[TARGET];
  return require(TARGET);
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = body ? JSON.parse(String(body)) : null; this.done = true; },
  };
}

const photo = (query = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'multipart/form-data; boundary=x', 'cf-connecting-ip': '203.0.113.7' },
  query,
  rawBody: Buffer.from('--x\r\nfake photo\r\n--x--'),
});

test('nezopt answers first; query, client IP and the photo pass through', async () => {
  const gpu = await worker('nezopt');
  const pi = await worker('pi');
  const mod = load({ SCAN_PRIMARY_URL: gpu.url, SCAN_FALLBACK_URL: pi.url });
  const res = response();
  await mod(photo({ catalog: 'pokemon_western', live: '1', top_k: '8', evil: 'x' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-scan-worker'], 'nezopt');
  assert.equal(res.body.worker, 'nezopt');
  assert.equal(gpu.seen[0].url, '/identify?catalog=pokemon_western&top_k=8&live=1');
  assert.equal(gpu.seen[0].xff, '203.0.113.7');
  assert.match(gpu.seen[0].type, /multipart\/form-data/);
  assert.match(gpu.seen[0].body, /fake photo/);
  assert.equal(pi.seen.length, 0);
  gpu.server.close(); pi.server.close();
});

test('nezopt down, erroring or slow → the Pi answers, then nezopt is skipped briefly', async () => {
  const pi = await worker('pi');
  let mod = load({ SCAN_PRIMARY_URL: 'http://127.0.0.1:1', SCAN_FALLBACK_URL: pi.url, SCAN_PRIMARY_COOLDOWN_MS: '60000' });
  let res = response();
  await mod(photo(), res);
  assert.equal(res.headers['x-scan-worker'], 'pi');

  const broken = await worker('nezopt', { status: 500 });
  mod = load({ SCAN_PRIMARY_URL: broken.url });
  res = response();
  await mod(photo(), res);
  assert.equal(res.headers['x-scan-worker'], 'pi');
  res = response();
  await mod(photo(), res);
  assert.equal(broken.seen.length, 1, 'cool-down skips nezopt after a failure');

  const slow = await worker('nezopt', { delayMs: 500 });
  mod = load({ SCAN_PRIMARY_URL: slow.url, SCAN_PRIMARY_TIMEOUT_MS: '100' });
  res = response();
  await mod(photo(), res);
  assert.equal(res.headers['x-scan-worker'], 'pi');
  pi.server.close(); broken.server.close(); slow.server.close();
});

test('both workers down → 503; empty upload → 400; wrong method → 405', async () => {
  const mod = load({ SCAN_PRIMARY_URL: 'http://127.0.0.1:1', SCAN_FALLBACK_URL: 'http://127.0.0.1:2' });
  let res = response();
  await mod(photo(), res);
  assert.equal(res.statusCode, 503);
  res = response();
  await mod({ method: 'POST', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 400);
  res = response();
  await mod({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('health reports both workers without falling back', async () => {
  const pi = await worker('pi');
  const mod = load({ SCAN_PRIMARY_URL: 'http://127.0.0.1:1', SCAN_FALLBACK_URL: pi.url });
  const res = response();
  await mod.health({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.workers.nezopt.ok, false);
  assert.equal(res.body.workers.pi.ok, true);
  pi.server.close();
});

test('the Pi server hands rawBody routes the request stream: it is read and forwarded', async () => {
  const { Readable } = require('node:stream');
  const gpu = await worker('nezopt');
  const mod = load({ SCAN_PRIMARY_URL: gpu.url, SCAN_FALLBACK_URL: 'http://127.0.0.1:2' });
  const req = Readable.from([Buffer.from('--x\r\nstreamed photo\r\n--x--')]);
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, query: {} });
  const res = response();
  await mod(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(gpu.seen[0].body, /streamed photo/);
  gpu.server.close();
});
