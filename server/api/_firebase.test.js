'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyBearerToken } = require('./_firebase.js');

function bearerRequest(token, url = '/api/account-addresses?limit=1') {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'GET', url, headers, socket: { remoteAddress: '127.0.0.1' } };
}

function rejectWith(code, message) {
  return async () => {
    throw Object.assign(new Error(message), { code });
  };
}

async function expectAuthError(promise, { status, code }) {
  let error;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected the call to reject');
  assert.equal(error.statusCode, status, `statusCode (got ${error.statusCode})`);
  assert.equal(error.code, code, `code (got ${error.code})`);
  return error;
}

test('missing bearer token is 401 auth/missing-token', async () => {
  const req = bearerRequest(null);
  const error = await expectAuthError(verifyBearerToken(req, { verifyIdToken: () => ({}) }), {
    status: 401,
    code: 'auth/missing-token',
  });
  assert.equal(error.message, 'Missing Pokoin bearer token.');
  assert.equal(req.pokoinAuthFailure, true);
});

test('missing token marks pokoinResponse too', async () => {
  const res = {};
  const req = { ...bearerRequest(null), pokoinResponse: res };
  await assert.rejects(verifyBearerToken(req, { verifyIdToken: () => ({}) }), (err) => err.code === 'auth/missing-token');
  assert.equal(req.pokoinAuthFailure, true);
  assert.equal(res.pokoinAuthFailure, true);
});

test('malformed token (auth/argument-error) is 401 with the generic message', async () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
  const req = bearerRequest(token);
  const error = await expectAuthError(
    verifyBearerToken(req, {
      verifyIdToken: rejectWith(
        'auth/argument-error',
        'Decoding Firebase ID token failed. Expected "pokoin" but got "undefined" for claim "aud". Token: ' + token,
      ),
    }),
    { status: 401, code: 'auth/invalid-token' },
  );
  assert.equal(error.message, 'Invalid or expired sign-in token.');
  assert.ok(!/aud/.test(error.message));
  assert.ok(!/pokoin/.test(error.message));
  assert.ok(!/Decoding/.test(error.message));
  assert.equal(req.pokoinAuthFailure, true);
});

for (const [code, message] of [
  ['auth/argument-error', 'Firebase ID token has invalid signature.'],
  ['auth/argument-error', 'Firebase ID token has incorrect "aud" (audience). Expected "pokoin" but got "other-app".'],
  ['auth/argument-error', 'Firebase ID token has incorrect "iss" (issuer). Expected "https://securetoken.google.com/pokoin" but got "elsewhere".'],
  ['auth/id-token-expired', 'Firebase ID token has expired.'],
  ['auth/id-token-revoked', 'Firebase ID token has been revoked.'],
]) {
test(`firebase auth error ${code} → 401`, async () => {
  const req = bearerRequest('x.y');
  const res = {};
  req.pokoinResponse = res;
  const error = await expectAuthError(verifyBearerToken(req, { verifyIdToken: rejectWith(code, message) }), {
    status: 401,
    code: 'auth/invalid-token',
  });
  assert.equal(error.message, 'Invalid or expired sign-in token.');
  assert.equal(req.pokoinAuthFailure, true);
  assert.equal(res.pokoinAuthFailure, true);
});
}

test('network failure is 503 auth/unavailable and does not mark auth failure', async () => {
  const req = bearerRequest('x.y');
  const res = {};
  req.pokoinResponse = res;
  const error = await expectAuthError(
    verifyBearerToken(req, { verifyIdToken: rejectWith('app/network-error', 'Failed to fetch google certs.') }),
    { status: 503, code: 'auth/unavailable' },
  );
  assert.equal(error.message, 'Sign-in could not be checked right now.');
  assert.equal(req.pokoinAuthFailure, undefined);
  assert.equal(res.pokoinAuthFailure, undefined);
});

test('valid token decodes and passes through', async () => {
  const req = bearerRequest('good.token.here');
  const decoded = { uid: 'u1', firebase: { sign_in_provider: 'google.com' } };
  const result = await verifyBearerToken(req, { verifyIdToken: async () => decoded });
  assert.deepEqual(result, decoded);
  assert.equal(req.pokoinAuthFailure, undefined);
});

test('warn log never contains the token or Authorization header', async () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  const req = bearerRequest(token);
  try {
    await assert.rejects(
      verifyBearerToken(req, {
        verifyIdToken: rejectWith(
          'auth/argument-error',
          `Decoding Firebase ID token failed. Expected "pokoin" but got "undefined". Token: ${token}`,
        ),
      }),
      (err) => err.statusCode === 401,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.length >= 1, 'expected at least one warn');
  for (const args of warnings) {
    const serialized = args.map((arg) => (arg instanceof Error ? arg.message : JSON.stringify(arg))).join(' ');
    assert.ok(!serialized.includes(token), `token leaked in log: ${serialized}`);
    assert.ok(!serialized.includes(`Bearer ${token}`), `Authorization header leaked in log: ${serialized}`);
  }
  const [label, fields] = warnings[0];
  assert.equal(label, 'pokoin auth token rejected');
  assert.ok(!String(fields.reason).includes(token));
  assert.equal(typeof fields.status, 'number');
  assert.ok(typeof fields.path === 'string' && !fields.path.includes('?'));
});
