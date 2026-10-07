'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');

const { createFirestore } = require('./_firestore_fake');
const providers = require('./_platform_providers');
const integrations = require('./_platform_integration');
const { createHandler, COOKIE_NAME, PENDING_COLLECTION } = require('./platform-oauth-callback')._test;

const NOW = Date.parse('2026-10-07T10:00:00Z');
const STATE = 'state_abcdefghijklmnopqrstuvwxyz012345';

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function harness({ pending = { uid: 'seller-1', email: 's@example.com', provider: 'cardmarket', expiresAt: NOW + 60_000 }, exchange } = {}) {
  const { firestore } = createFirestore(pending ? { [PENDING_COLLECTION]: { [STATE]: pending } } : {});
  const calls = { exchange: [], enqueue: [] };
  const handler = createHandler({
    getFirebaseAdmin: () => ({ firestore: () => firestore }),
    providers,
    integrations,
    getAdapter: () => ({
      authorizeUrl: () => 'https://api.cardmarket.com/ws/v2.0/authenticate/app-token',
      exchangeRequestToken: exchange || (async (ctx, token) => {
        calls.exchange.push(token);
        return { credentials: { accessToken: 'at', accessSecret: 'as' }, metadata: { username: 'Newisdom' } };
      }),
    }),
    enqueueLinkAndImport: async (args) => { calls.enqueue.push(args); return { started: true }; },
    env: { POKOIN_WEB_BASE: 'https://pokoin.test' },
    now: () => NOW,
  });
  async function call(step, { query = {}, cookie = '' } = {}) {
    const res = response();
    await handler({
      method: 'GET',
      params: { provider: 'cardmarket' },
      path: `/api/platform-oauth/cardmarket/${step}`,
      query,
      headers: cookie ? { cookie } : {},
    }, res);
    return res;
  }
  return { firestore, calls, call };
}

test('start sets the HttpOnly state cookie and redirects to Cardmarket', async () => {
  const h = harness();
  const res = await h.call('start', { query: { state: STATE } });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://api.cardmarket.com/ws/v2.0/authenticate/app-token');
  assert.match(res.headers['Set-Cookie'], new RegExp(`^${COOKIE_NAME}=${STATE}; Path=/api/platform-oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600$`));
  // start does not consume the state; the callback does.
  assert.equal((await h.firestore.collection(PENDING_COLLECTION).doc(STATE).get()).exists, true);
});

test('start with an unknown state goes back to the profile with an error', async () => {
  const h = harness();
  const res = await h.call('start', { query: { state: 'state_unknown_000000000000000000' } });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://pokoin.test/profile?platform=cardmarket&error=state');
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('callback without the cookie is rejected', async () => {
  const h = harness();
  const res = await h.call('callback', { query: { request_token: 'rt' } });
  assert.equal(res.headers.Location, 'https://pokoin.test/profile?platform=cardmarket&error=state');
  assert.equal(h.calls.exchange.length, 0);
});

test('callback with an expired state is rejected and the state is removed', async () => {
  const h = harness({ pending: { uid: 'seller-1', provider: 'cardmarket', expiresAt: NOW - 1 } });
  const res = await h.call('callback', { query: { request_token: 'rt' }, cookie: `${COOKIE_NAME}=${STATE}` });
  assert.equal(res.headers.Location, 'https://pokoin.test/profile?platform=cardmarket&error=state');
  assert.equal((await h.firestore.collection(PENDING_COLLECTION).doc(STATE).get()).exists, false);
  assert.equal(h.calls.exchange.length, 0);
});

test('callback stores the encrypted access token once and redirects connected=1', async () => {
  const h = harness();
  const cookie = `other=1; ${COOKIE_NAME}=${STATE}`;
  const res = await h.call('callback', { query: { request_token: 'request-123' }, cookie });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://pokoin.test/profile?platform=cardmarket&connected=1');
  assert.match(res.headers['Set-Cookie'], /Max-Age=0$/);
  assert.deepEqual(h.calls.exchange, ['request-123']);
  assert.deepEqual(await integrations.decryptSecrets(h.firestore, 'seller-1', 'cardmarket'), {
    accessToken: 'at',
    accessSecret: 'as',
  });
  assert.equal(h.calls.enqueue[0].uid, 'seller-1');

  // The state is single use: a replay cannot connect again.
  const replay = await h.call('callback', { query: { request_token: 'request-456' }, cookie });
  assert.equal(replay.headers.Location, 'https://pokoin.test/profile?platform=cardmarket&error=state');
  assert.deepEqual(h.calls.exchange, ['request-123']);
});

test('a failed token exchange never leaks the upstream message', async () => {
  const h = harness({
    exchange: async () => {
      const error = new Error('MKM said: token secret abc123 invalid');
      error.statusCode = 401;
      throw error;
    },
  });
  const res = await h.call('callback', { query: { request_token: 'rt' }, cookie: `${COOKIE_NAME}=${STATE}` });
  assert.equal(res.headers.Location, 'https://pokoin.test/profile?platform=cardmarket&error=exchange');
  await assert.rejects(() => integrations.decryptSecrets(h.firestore, 'seller-1', 'cardmarket'));
});

test('a provider without OAuth is 404', async () => {
  const handler = createHandler({ providers, getFirebaseAdmin: () => createFirestore().admin });
  const res = response();
  await handler({ method: 'GET', params: { provider: 'shopify' }, path: '/api/platform-oauth/shopify/start', headers: {} }, res);
  assert.equal(res.statusCode, 404);
});
