const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} = require('./_cardtrader_crypto');
const {
  cardTraderRequest,
  importDryRunSummary,
  normalizeInfo,
  safeInfoMetadata,
  validateCardTraderToken,
} = require('./_cardtrader_client');
const {
  safeStatusFromDoc,
  storeConnectedIntegration,
} = require('./_cardtrader_integration');
const { linkedListingPredicate } = require('./cardtrader-clean-listings')._test;

const testKey = Buffer.alloc(32, 7).toString('base64');

test('CardTrader secrets encrypt and decrypt with AES-256-GCM', () => {
  const encrypted = encryptSecret('ct_secret_token', testKey);

  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.notEqual(encrypted.ciphertext, 'ct_secret_token');
  assert.equal(decryptSecret(encrypted, testKey), 'ct_secret_token');
});

test('CardTrader encryption key must be exactly 32 bytes', () => {
  assert.equal(parseEncryptionKey(testKey).length, 32);
  assert.throws(
    () => parseEncryptionKey('short-key'),
    /must decode to exactly 32 bytes/,
  );
  assert.throws(
    () => parseEncryptionKey(''),
    /CARDTRADER_TOKEN_ENCRYPTION_KEY is not configured/,
  );
});

test('CardTrader metadata redaction omits token and webhook secret', () => {
  const info = normalizeInfo({
    user: { id: 123, email: 'SELLER@EXAMPLE.COM', username: 'seller' },
    app: { id: 'app-1', name: 'Pokoin' },
    scopes: ['read', 'write'],
    shared_secret: 'webhook-secret',
  });
  const safe = safeInfoMetadata(info);

  assert.equal(info.sharedSecret, 'webhook-secret');
  assert.equal(safe.user.email, 'seller@example.com');
  assert.equal(safe.sharedSecret, undefined);
  assert.equal(safe.token, undefined);
});

test('CardTrader status payload never exposes encrypted secrets', () => {
  const status = safeStatusFromDoc({
    exists: true,
    data: () => ({
      enabled: true,
      encryptedToken: { ciphertext: 'hidden' },
      encryptedSharedSecret: { ciphertext: 'hidden-too' },
      metadata: { user: { id: 'ct-user' } },
      connectedAt: { toDate: () => new Date('2026-05-22T08:00:00.000Z') },
    }),
  });

  assert.equal(status.connected, true);
  assert.deepEqual(status.metadata, { user: { id: 'ct-user' } });
  assert.equal(status.encryptedToken, undefined);
  assert.equal(status.encryptedSharedSecret, undefined);
  assert.equal(status.connectedAt, '2026-05-22T08:00:00.000Z');
});

test('CardTrader store helper writes encrypted integration fields only', async () => {
  const originalKey = process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY;
  process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY = testKey;
  let stored = null;
  const firestore = {
    collection: (name) => {
      assert.equal(name, 'seller_integrations');
      return {
        doc: (id) => {
          assert.equal(id, 'firebase-uid__cardtrader');
          return {
            set: async (payload) => {
              stored = payload;
            },
          };
        },
      };
    },
  };
  const admin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'server-now',
      },
    },
  };

  try {
    await storeConnectedIntegration({
      admin,
      firestore,
      uid: 'firebase-uid',
      email: 'seller@example.com',
      token: 'ct_live_token',
      info: normalizeInfo({ shared_secret: 'webhook-secret' }),
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY = originalKey;
    }
  }

  assert.equal(stored.enabled, true);
  assert.equal(stored.encryptedToken.ciphertext.includes('ct_live_token'), false);
  assert.equal(stored.encryptedSharedSecret.ciphertext.includes('webhook-secret'), false);
  assert.equal(stored.token, undefined);
  assert.equal(stored.sharedSecret, undefined);
});

test('CardTrader request sends bearer token and parses JSON', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.cardtrader.com/api/v2/info');
    assert.equal(options.headers.Authorization, 'Bearer ct_token');
    return {
      ok: true,
      status: 200,
      text: async () => '{"user":{"id":"ct-user"}}',
    };
  };

  const payload = await cardTraderRequest('/info', 'ct_token');
  assert.deepEqual(payload, { user: { id: 'ct-user' } });
});

test('CardTrader token validation maps unauthorized without leaking token', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":"bad token"}',
  });

  await assert.rejects(
    validateCardTraderToken('ct_token_long_enough'),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /rejected this API token/);
      assert.equal(error.message.includes('ct_token_long_enough'), false);
      return true;
    },
  );
});

test('CardTrader import dry-run summary exposes safe counts and samples', () => {
  const summary = importDryRunSummary([
    {
      id: 1,
      blueprint_id: 274416,
      name: 'Mew ex',
      quantity: 2,
      price_cents: 1234,
      private_note: 'not returned',
    },
  ]);

  assert.equal(summary.productCount, 1);
  assert.deepEqual(summary.sample, [
    {
      id: '1',
      blueprintId: '274416',
      name: 'Mew ex',
      quantity: 2,
      priceCents: 1234,
      state: '',
    },
  ]);
});

test('CardTrader linked listing cleanup is scoped to CardTrader sources', () => {
  const predicate = linkedListingPredicate();

  assert.match(predicate, /source/);
  assert.match(predicate, /source_listing_id/);
  assert.match(predicate, /cardtrader/);
  assert.match(predicate, /ct:%/);
  assert.doesNotMatch(predicate, /pokoin_user_listing/);
});

test('CardTrader webhook URL registration uses seller uid', async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    calls.push({ url, method: options?.method, body: options?.body });
    return {
      ok: true,
      status: 200,
      text: async () => '{"webhook_url":"https://api.pokoin.com/api/cardtrader-webhook/uid"}',
    };
  };
  const { registerSellerWebhook } = require('./cardtrader-connect')._test;
  const original = process.env.CARDTRADER_WEBHOOK_BASE_URL;
  process.env.CARDTRADER_WEBHOOK_BASE_URL = 'https://api.pokoin.com';
  try {
    await registerSellerWebhook('ct_token', 'uid');
  } finally {
    if (original === undefined) delete process.env.CARDTRADER_WEBHOOK_BASE_URL;
    else process.env.CARDTRADER_WEBHOOK_BASE_URL = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cardtrader.com/api/v2/app');
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].body, /cardtrader-webhook\/uid/);
});
