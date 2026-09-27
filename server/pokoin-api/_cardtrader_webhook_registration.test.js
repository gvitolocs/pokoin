'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  registerSellerWebhook,
  registeredWebhookUrl,
  webhookRegistrationMatches,
} = require('./_cardtrader_webhook_registration');

test('CardTrader webhook registration must echo the exact seller-scoped URL', () => {
  const expected = 'https://api.pokoin.com/api/cardtrader-webhook/firebase-uid';
  assert.equal(registeredWebhookUrl({ webhook_url: expected }), expected);
  assert.equal(registeredWebhookUrl({ app: { webhookUrl: expected } }), expected);
  assert.equal(webhookRegistrationMatches({ webhook_url: expected }, expected), true);
  assert.equal(webhookRegistrationMatches({ webhook_url: '' }, expected), false);
  assert.equal(webhookRegistrationMatches({ webhook_url: `${expected}/wrong` }, expected), false);
});

test('registration persists verified webhook health', async (t) => {
  const originalFetch = global.fetch;
  const originalBase = process.env.CARDTRADER_WEBHOOK_BASE_URL;
  const expected = 'https://api.pokoin.com/api/cardtrader-webhook/firebase-uid';
  const writes = [];
  t.after(() => {
    global.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.CARDTRADER_WEBHOOK_BASE_URL;
    else process.env.CARDTRADER_WEBHOOK_BASE_URL = originalBase;
  });
  process.env.CARDTRADER_WEBHOOK_BASE_URL = 'https://api.pokoin.com';
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ webhook_url: expected }),
  });
  const result = await registerSellerWebhook({
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'now' } } },
    firestore: {
      collection: () => ({
        doc: () => ({ set: async (payload) => writes.push(payload) }),
      }),
    },
    token: 'token',
    uid: 'firebase-uid',
  });
  assert.equal(result.webhookUrl, expected);
  assert.equal(writes[0].webhookRegistration.ok, true);
  assert.equal(writes[0].webhookRegistration.url, expected);
});
