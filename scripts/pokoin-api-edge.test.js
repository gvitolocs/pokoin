'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { chooseApiOrigin, isApiPath } = require('./pokoin-api-edge.js');

const base = { inFlight: 24, localMax: 24, overflowHealthy: true, overflowOrigin: 'http://nezopt:30880' };

test('only saturated GET/HEAD API calls overflow, and only to a healthy nezopt', () => {
  assert.equal(chooseApiOrigin({ ...base, method: 'GET' }), 'overflow');
  assert.equal(chooseApiOrigin({ ...base, method: 'HEAD' }), 'overflow');
  assert.equal(chooseApiOrigin({ ...base, method: 'POST' }), 'local');
  assert.equal(chooseApiOrigin({ ...base, method: 'GET', inFlight: 23 }), 'local');
  assert.equal(chooseApiOrigin({ ...base, method: 'GET', overflowHealthy: false }), 'local');
  assert.equal(chooseApiOrigin({ ...base, method: 'GET', overflowOrigin: '' }), 'local');
  assert.equal(isApiPath('/api/marketplace-suggest'), true);
  assert.equal(isApiPath('/some-image.webp'), false);
});

function server(name, delayMs) {
  const srv = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ served: name, method: req.method }));
    }, delayMs);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function request(port, method = 'GET', pathname = '/api/marketplace-suggest?q=pika') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ origin: res.headers['x-pokoin-origin'], body: JSON.parse(body || '{}') }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

/** Start the real edge; a taken random port makes it exit, so try another. */
async function startEdge(env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, 'pokoin-api-edge.js')], {
      env: { ...process.env, POKOIN_API_EDGE_PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const started = await new Promise((resolve) => {
      child.stdout.once('data', () => resolve(true));
      child.once('exit', () => resolve(false));
    });
    if (started) return { port, child };
  }
  throw new Error('edge did not start');
}

test('under load the edge spills GETs to nezopt and keeps POSTs on the Pi', async () => {
  const pi = await server('pi', 150);
  const nezopt = await server('nezopt', 5);
  const { port, child } = await startEdge({
    POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}`,
    POKOIN_API_OVERFLOW_ORIGIN: `http://127.0.0.1:${nezopt.address().port}`,
    POKOIN_API_LOCAL_MAX: '4',
    POKOIN_API_OVERFLOW_PROBE_MS: '100',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250)); // first probe
    const burst = await Promise.all(Array.from({ length: 12 }, () => request(port)));
    const byOrigin = burst.reduce((acc, row) => ({ ...acc, [row.origin]: (acc[row.origin] || 0) + 1 }), {});
    assert.equal(byOrigin.pi, 4);
    assert.equal(byOrigin.nezopt, 8);
    assert.ok(burst.every((row) => row.body.served === (row.origin === 'nezopt' ? 'nezopt' : 'pi')));

    const writes = await Promise.all(Array.from({ length: 8 }, () => request(port, 'POST', '/api/marketplace-listings')));
    assert.ok(writes.every((row) => row.origin === 'pi'));

    const quiet = await request(port);
    assert.equal(quiet.origin, 'pi');
  } finally {
    child.kill();
    pi.close();
    nezopt.close();
  }
});

test('nezopt down: everything stays on the Pi', async () => {
  const pi = await server('pi', 80);
  const { port, child } = await startEdge({
    POKOIN_API_ORIGIN: `http://127.0.0.1:${pi.address().port}`,
    POKOIN_API_OVERFLOW_ORIGIN: 'http://127.0.0.1:1',
    POKOIN_API_LOCAL_MAX: '2',
    POKOIN_API_OVERFLOW_PROBE_MS: '100',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const burst = await Promise.all(Array.from({ length: 6 }, () => request(port)));
    assert.ok(burst.every((row) => row.origin === 'pi' && row.body.served === 'pi'));
  } finally {
    child.kill();
    pi.close();
  }
});
