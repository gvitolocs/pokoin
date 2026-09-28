'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'poko-chat.js');

process.env.POKONTACT_SERVICE_TOKEN = 'svc';

// Stubs must stay installed while the handler RUNS (it captures _firebase at
// load and hits the network at call time), so install/restore wrap execution.
function withStubs({ verifyBearerToken = async () => 'fb-1', fetchImpl } = {}, run) {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  Module._load = function load(request, parent, isMain) {
    if (request === './_firebase') {
      return {
        verifyBearerToken,
        authErrorResponse: (error) => ({ statusCode: error.statusCode || 401, body: { error: error.message } }),
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[TARGET];
  (async () => {
    try {
      await run(require(TARGET));
    } finally {
      Module._load = originalLoad;
      globalThis.fetch = originalFetch;
    }
  })();
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('forwards message with Firebase uid as Poko userId and returns the reply', () => withStubs({
  fetchImpl: async (url, options = {}) => {
    const sent = JSON.parse(options.body);
    assert.equal(sent.userId, 'fb-1');
    assert.equal(sent.message, 'hi');
    assert.ok(url.endsWith('/chat'));
    return { ok: true, status: 200, json: async () => ({ ok: true, assistant: 'poko', reply: 'Pong ✨' }) };
  },
}, async (handler) => {
  const res = makeRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer fb-token' },
    body: { message: 'hi', sessionId: 'site-1' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply, 'Pong ✨');
  assert.equal(res.body.assistant, 'poko');
}));

test('requires Firebase auth', () => withStubs({
  verifyBearerToken: async () => '',
}, async (handler) => {
  const anon = makeRes();
  await handler({ method: 'POST', headers: {}, body: { message: 'hi' } }, anon);
  assert.equal(anon.statusCode, 401);
}));

test('requires configured token, POST, and a message', () => withStubs({}, async (handler) => {
  const previous = process.env.POKONTACT_SERVICE_TOKEN;
  try {
    process.env.POKONTACT_SERVICE_TOKEN = '';
    const unconfigured = makeRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { message: 'hi' } }, unconfigured);
    assert.equal(unconfigured.statusCode, 503);
  } finally {
    process.env.POKONTACT_SERVICE_TOKEN = 'svc';
  }

  const wrongMethod = makeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' }, body: null }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const empty = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { message: '  ' } }, empty);
  assert.equal(empty.statusCode, 400);
}));

test('upstream failures become a friendly 502, never the old canned brain', () => withStubs({
  fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
}, async (handler) => {
  const res = makeRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer fb-token' },
    body: { message: 'hello' },
  }, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /Poko is unavailable/);
  assert.ok(!JSON.stringify(res.body).includes('tiny brain'));
}));
