'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '_pipeline_health.js'), 'utf8');

function loadProbe({ url, status = 200, error, stall = false } = {}) {
  const calls = [];
  function transport(protocol) {
    return { get(target, onResponse) {
      const req = new EventEmitter();
      req.destroy = () => { calls.push({ destroyed: true }); };
      calls.push({ protocol, target });
      if (!stall) process.nextTick(() => {
        if (error) {
          req.emit('error', { code: error });
          return;
        }
        const res = new EventEmitter();
        res.statusCode = status;
        onResponse(res);
        res.emit('data', Buffer.from('{"ok":true}'));
        res.emit('end');
      });
      return req;
    } };
  }
  class Client {
    async connect() {}
    async query() { return { rows: [{ ok: 1 }] }; }
    async end() {}
  }
  const modules = {
    http: transport('http'),
    https: transport('https'),
    pg: { Client },
    './_marketplace_db': { marketplaceDatabaseUrl: () => 'postgres://localhost/catalog' },
    './_valkey': { command: async () => 'PONG' },
    './_meili_client': { meiliConfigured: () => true, meiliHealth: async () => ({ status: 'available' }) },
    './_public_error': { sanitizeCheckError: value => String(value).toLowerCase() },
  };
  const env = { PIPELINE_HEALTH_TIMEOUT_MS: '20', MARKETPLACE_DATABASE_SSL: '0' };
  if (url) env.POKOIN_CDN_HEALTH_URL = url;
  const sandbox = {
    module: { exports: {} },
    process: { env },
    setTimeout,
    clearTimeout,
    require: name => {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
      return modules[name];
    },
  };
  vm.runInNewContext(source, sandbox, { filename: '_pipeline_health.js' });
  return { helper: sandbox.module.exports, calls };
}

test('Pi default CDN probe keeps the local HTTP origin', async () => {
  const { helper, calls } = loadProbe();
  assert.equal((await helper.probeCdn()).ok, true);
  assert.equal(calls[0].protocol, 'http');
  assert.equal(calls[0].target, 'http://127.0.0.1:18081/health');
});

for (const protocol of ['http', 'https']) {
  const url = `${protocol}://cdn.example/health`;
  test(`${protocol} CDN success selects the correct transport`, async () => {
    const { helper, calls } = loadProbe({ url });
    assert.equal((await helper.probeCdn()).ok, true);
    assert.equal(calls[0].protocol, protocol);
    assert.equal(calls[0].target, url);
  });

  test(`${protocol} CDN non-success keeps pipeline health red`, async () => {
    const { helper } = loadProbe({ url, status: 503 });
    const result = await helper.pipelineHealth();
    assert.equal(result.ok, false);
    assert.equal(result.checks.cdn.error, 'http_503');
    for (const dependency of ['postgres', 'valkey', 'meili']) {
      assert.equal(result.checks[dependency].ok, true);
    }
  });

  test(`${protocol} CDN connection errors remain visible`, async () => {
    const { helper } = loadProbe({ url, error: 'ECONNREFUSED' });
    const result = await helper.probeCdn();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'econnrefused');
  });

  test(`${protocol} CDN timeouts destroy the request`, async () => {
    const { helper, calls } = loadProbe({ url, stall: true });
    const result = await helper.probeCdn();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'timeout');
    assert.equal(calls.at(-1).destroyed, true);
  });
}

test('remote HTTPS CDN succeeds with all four pipeline checks active', async () => {
  const { helper } = loadProbe({ url: 'https://cdn.pokoin.com/health' });
  const result = await helper.pipelineHealth();
  assert.equal(result.ok, true);
  for (const dependency of ['postgres', 'valkey', 'meili', 'cdn']) {
    assert.equal(result.checks[dependency].ok, true);
  }
});

test('overflow manifest probes the remote CDN without skipping a dependency', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '../../infra/k3s/pokoin-overflow.yaml'), 'utf8');
  assert.match(manifest, /name: POKOIN_CDN_HEALTH_URL, value: "https:\/\/cdn\.pokoin\.com\/health"/);
  assert.match(manifest, /name: PIPELINE_HEALTH_TIMEOUT_MS, value: "2000"/);
  assert.doesNotMatch(manifest, /PIPELINE_HEALTH_SKIP/);
});
