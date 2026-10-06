'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '_pipeline_health.js'), 'utf8');

function fakeRedis(reply) {
  return {
    connect() {
      const socket = new EventEmitter();
      socket.destroy = () => { socket.destroyed = true; };
      socket.write = () => {
        process.nextTick(() => {
          if (reply instanceof Error) socket.emit('error', reply);
          else socket.emit('data', Buffer.from(reply));
        });
      };
      process.nextTick(() => {
        if (!(reply instanceof Error)) socket.emit('connect');
      });
      return socket;
    },
  };
}

function loadProbe({ url, status = 200, error, stall = false, redisReply = '+PONG\r\n' } = {}) {
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
  const env = { PIPELINE_HEALTH_TIMEOUT_MS: '20', MARKETPLACE_DATABASE_SSL: '0', REDIS_PORT: '6380' };
  const modules = {
    http: transport('http'),
    https: transport('https'),
    pg: { Client },
    './_marketplace_db': { marketplaceDatabaseUrl: () => 'postgres://localhost/catalog' },
    'node:net': fakeRedis(redisReply),
    './_public_error': { sanitizeCheckError: value => String(value).toLowerCase() },
  };
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

  test(`${protocol} CDN non-success stays degraded and does not fail readiness`, async () => {
    const { helper } = loadProbe({ url, status: 503 });
    const result = await helper.readiness();
    assert.equal(result.ok, true);
    assert.equal(result.checks.cdn.ok, false);
    assert.equal(result.checks.cdn.error, 'http_503');
    assert.equal(result.checks.cdn.role, 'degraded');
    for (const dependency of ['postgres', 'redis']) {
      assert.equal(result.checks[dependency].ok, true);
    }
    assert.equal(JSON.stringify(result.retired), JSON.stringify(['meili']));
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

test('redis health is a dedicated PING and does not publish another reply', async () => {
  const stolen = '{"displayName":"RotationMotionTCG","username":"redshakkio"}';
  const { helper } = loadProbe({ redisReply: `+OK\r\n${stolen}\r\n` });
  const result = await helper.probeRedis();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unexpected');
  assert.equal(JSON.stringify(result).includes('redshakkio'), false);
  assert.equal(helper.redisTarget().port, 6380);
});

test('readiness requires postgres and redis; liveness does not probe them', async () => {
  const { helper } = loadProbe({ url: 'https://cdn.pokoin.com/health' });
  const live = helper.liveness();
  assert.equal(live.ok, true);
  assert.equal(live.live, true);
  assert.equal(live.checks, undefined);
  const result = await helper.pipelineHealth();
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  for (const dependency of ['postgres', 'redis', 'cdn']) {
    assert.equal(result.checks[dependency].ok, true);
  }
  assert.equal(result.checks.meili, undefined);
});

test('overflow manifest probes the remote CDN without skipping a dependency', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '../../infra/k3s/pokoin-overflow.yaml'), 'utf8');
  assert.match(manifest, /name: POKOIN_CDN_HEALTH_URL, value: "https:\/\/cdn\.pokoin\.com\/health"/);
  assert.match(manifest, /name: PIPELINE_HEALTH_TIMEOUT_MS, value: "2000"/);
  assert.doesNotMatch(manifest, /PIPELINE_HEALTH_SKIP/);
});
