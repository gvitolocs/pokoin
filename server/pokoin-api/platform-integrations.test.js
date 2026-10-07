'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

const { createFirestore } = require('./_firestore_fake');
const providers = require('./_platform_providers');
const integrations = require('./_platform_integration');
const { createHandler, OAUTH_PENDING_COLLECTION, REQUESTS_COLLECTION } = require('./platform-integrations')._test;

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function harness({ env = {}, adapter = {}, decoded = { uid: 'seller-1', email: 'seller@example.com' } } = {}) {
  const { firestore } = createFirestore();
  const calls = { enqueue: [], deletedLinks: [], adapter: [] };
  const handler = createHandler({
    verifyBearerToken: async () => decoded,
    getFirebaseAdmin: () => ({ firestore: () => firestore }),
    providers,
    integrations,
    deleteLinksForProvider: async (args) => { calls.deletedLinks.push(args); return 0; },
    getAdapter: () => adapter,
    enqueueLinkAndImport: async (args) => { calls.enqueue.push(args); return { started: true }; },
    env,
    now: () => Date.parse('2026-10-07T10:00:00Z'),
  });
  async function call(method, provider = '', body = {}) {
    const res = response();
    await handler({ method, params: provider ? { provider } : {}, body, headers: {} }, res);
    return res;
  }
  return { firestore, calls, call };
}

const shopifyAdapter = (calls) => ({
  async validate(ctx, input) {
    calls.push(['validate', input]);
    return {
      credentials: { accessToken: input.accessToken, apiSecretKey: input.apiSecretKey },
      metadata: { shopDomain: 'demo.myshopify.com', shopName: 'Demo', locationId: '9' },
    };
  },
  async registerWebhooks(ctx, url) {
    calls.push(['registerWebhooks', url, ctx.credentials.accessToken]);
    return { ids: ['11', '12'] };
  },
  async removeWebhooks(ctx, ids) {
    calls.push(['removeWebhooks', ids, ctx.credentials.accessToken]);
  },
  async listInventory() { return { complete: true, items: [] }; },
});

test('GET lists every provider with safe status and never a secret', async () => {
  const h = harness();
  await integrations.storeIntegration({
    firestore: h.firestore,
    uid: 'seller-1',
    provider: 'shopify',
    secrets: { accessToken: 'shpat_supersecret', apiSecretKey: 'shhh' },
    metadata: { shopName: 'Demo' },
  });
  const res = await h.call('GET');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.providers.map((row) => row.id), providers.PROVIDERS.map((row) => row.id));
  const shopify = res.body.providers.find((row) => row.id === 'shopify');
  assert.equal(shopify.status.connected, true);
  assert.equal(res.body.email, 'seller@example.com');
  const text = JSON.stringify(res.body);
  assert.equal(text.includes('shpat_supersecret'), false);
  assert.equal(text.includes('encryptedSecrets'), false);
  assert.equal(text.includes('ciphertext'), false);
});

test('unknown provider is 404 and an unconfigured provider is 503', async () => {
  const h = harness();
  assert.equal((await h.call('POST', 'nope')).statusCode, 404);
  const cm = await h.call('POST', 'cardmarket');
  assert.equal(cm.statusCode, 503);
  assert.equal(cm.body.code, 'platform_unavailable');
  assert.equal((await h.call('POST', 'tcgplayer', { authCode: 'x' })).statusCode, 503);
});

test('fields connect stores encrypted secrets, registers webhooks and starts the import', async () => {
  const adapterCalls = [];
  const h = harness({ adapter: shopifyAdapter(adapterCalls), env: { POKOIN_PUBLIC_API_BASE: 'https://api.test' } });
  const res = await h.call('POST', 'shopify', {
    shopDomain: 'demo',
    accessToken: 'shpat_supersecret',
    apiSecretKey: 'shhh',
    ignored: 'not a field',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status.connected, true);
  assert.equal(JSON.stringify(res.body).includes('shpat_supersecret'), false);
  assert.deepEqual(adapterCalls[0], ['validate', { shopDomain: 'demo', accessToken: 'shpat_supersecret', apiSecretKey: 'shhh' }]);
  assert.deepEqual(adapterCalls[1], ['registerWebhooks', 'https://api.test/api/platform-webhook/shopify/seller-1', 'shpat_supersecret']);

  const stored = (await integrations.readIntegration(h.firestore, 'seller-1', 'shopify')).data();
  assert.notEqual(stored.encryptedSecrets.accessToken, 'shpat_supersecret');
  assert.deepEqual(await integrations.decryptSecrets(h.firestore, 'seller-1', 'shopify'), {
    accessToken: 'shpat_supersecret',
    apiSecretKey: 'shhh',
  });
  assert.equal(stored.webhookRegistration.ok, true);
  assert.deepEqual(stored.webhookRegistration.ids, ['11', '12']);
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.enqueue[0].provider, 'shopify');
});

test('a failed webhook registration keeps the connection and records the error', async () => {
  const adapterCalls = [];
  const adapter = shopifyAdapter(adapterCalls);
  adapter.registerWebhooks = async () => { throw new Error('webhook quota'); };
  const h = harness({ adapter });
  const res = await h.call('POST', 'shopify', { shopDomain: 'demo', accessToken: 'a', apiSecretKey: 'b' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status.connected, true);
  assert.equal(res.body.status.webhook.ok, false);
  assert.match(res.body.status.webhook.error, /webhook quota/);
});

test('validation errors surface with their status code', async () => {
  const h = harness({
    adapter: {
      async validate() {
        const error = new Error('Shopify rejected the access token.');
        error.statusCode = 401;
        error.code = 'shopify_rejected';
        throw error;
      },
    },
  });
  const res = await h.call('POST', 'shopify', { shopDomain: 'demo', accessToken: 'bad', apiSecretKey: 'x' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'shopify_rejected');
});

test('partner request is pending activation and files a staff request', async () => {
  const h = harness({
    adapter: {
      async validate(ctx, input) {
        return { credentials: { apiKey: input.apiKey }, metadata: { storeId: input.storeId }, state: 'pending_activation' };
      },
    },
  });
  const res = await h.call('POST', 'sortswift', { apiKey: 'partner-key-123', storeId: 'store-9' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status.state, 'pending_activation');
  assert.equal(res.body.status.connected, false);
  const request = (await h.firestore.collection(REQUESTS_COLLECTION).doc('seller-1__sortswift').get()).data();
  assert.equal(request.status, 'pending');
  assert.equal(request.storeId, 'store-9');
  assert.equal(request.email, 'seller@example.com');
});

test('cardmarket connect returns a Pokoin start URL with a one-time state', async () => {
  const h = harness({ env: { CARDMARKET_APP_TOKEN: 'app', CARDMARKET_APP_SECRET: 'secret' } });
  const res = await h.call('POST', 'cardmarket');
  assert.equal(res.statusCode, 200);
  const url = new URL(res.body.redirectUrl);
  assert.equal(url.origin + url.pathname, 'https://api.pokoin.com/api/platform-oauth/cardmarket/start');
  const state = url.searchParams.get('state');
  assert.ok(state.length >= 24);
  const pending = (await h.firestore.collection(OAUTH_PENDING_COLLECTION).doc(state).get()).data();
  assert.equal(pending.uid, 'seller-1');
  assert.equal(pending.provider, 'cardmarket');
  assert.equal(pending.expiresAt, Date.parse('2026-10-07T10:00:00Z') + 10 * 60 * 1000);
});

test('revoke removes webhooks, wipes credentials and drops links', async () => {
  const adapterCalls = [];
  const h = harness({ adapter: shopifyAdapter(adapterCalls) });
  await h.call('POST', 'shopify', { shopDomain: 'demo', accessToken: 'tok', apiSecretKey: 'sec' });
  const res = await h.call('DELETE', 'shopify');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status.connected, false);
  assert.deepEqual(adapterCalls.find((row) => row[0] === 'removeWebhooks'), ['removeWebhooks', ['11', '12'], 'tok']);
  assert.deepEqual(h.calls.deletedLinks, [{ sellerUid: 'seller-1', provider: 'shopify' }]);
  await assert.rejects(() => integrations.decryptSecrets(h.firestore, 'seller-1', 'shopify'));
});

test('a missing bearer is a 401 from the auth helper', async () => {
  const handler = createHandler({
    verifyBearerToken: async () => {
      const error = new Error('Sign in first.');
      error.statusCode = 401;
      throw error;
    },
  });
  const res = response();
  await handler({ method: 'GET', params: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});
