'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === '../server/_firebase') return { getFirebaseAdmin: () => ({}) };
  if (id === './_cardtrader_integration') return { decryptIntegrationToken: async () => 'token' };
  if (id === './_cardtrader_webhook_registration') return { registerSellerWebhook: async () => ({ ok: true }) };
  if (id === './_cardtrader_inventory_sync') return { reconcileCardTraderInventory: async () => ({ ok: true }) };
  return originalRequire.apply(this, arguments);
};
const {
  connectedSellerIntegrations,
  reconcileAllConnectedSellers,
  sellerNameFromIntegration,
  storedOneDayReady,
} = require('./cardtrader-reconcile-all');
Module.prototype.require = originalRequire;

test('periodic reconcile selects only enabled CardTrader integrations', async () => {
  const firestore = {
    collection: () => ({
      get: async () => ({
        docs: [
          { id: 'a', data: () => ({ uid: 'u1', provider: 'cardtrader', enabled: true }) },
          { id: 'b', data: () => ({ uid: 'u2', provider: 'cardtrader', enabled: false }) },
          { id: 'c', data: () => ({ uid: 'u3', provider: 'other', enabled: true }) },
        ],
      }),
    }),
  };
  const rows = await connectedSellerIntegrations(firestore);
  assert.deepEqual(rows.map((row) => row.uid), ['u1']);
});

test('periodic reconcile repairs webhook and still syncs when repair fails', async () => {
  const calls = [];
  const result = await reconcileAllConnectedSellers({
    admin: {},
    firestore: {},
    listIntegrations: async () => [
      { uid: 'u1', provider: 'cardtrader', enabled: true, metadata: { user: { username: 'seller1' } } },
      { uid: 'u2', provider: 'cardtrader', enabled: true, userEmail: 'seller2@example.com' },
    ],
    decryptToken: async (_, uid) => `token-${uid}`,
    registerWebhook: async ({ uid }) => {
      calls.push(`webhook:${uid}`);
      if (uid === 'u2') throw new Error('temporary webhook failure');
    },
    reconcileInventory: async ({ uid, sellerName, token }) => {
      calls.push(`sync:${uid}:${sellerName}:${token}`);
      return { ok: true, incomplete: false, summary: { inventory: 4, removed: uid === 'u2' ? 1 : 0 } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.sellers, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].syncOk, true);
  assert.equal(result.results[1].webhookOk, false);
  assert.ok(calls.includes('sync:u2:seller2@example.com:token-u2'));
});

test('seller name prefers CardTrader username without exposing integration secrets', () => {
  assert.equal(sellerNameFromIntegration({ metadata: { user: { username: 'redshakkio' } } }), 'redshakkio');
  assert.equal(sellerNameFromIntegration({ userEmail: 'seller@example.com' }), 'seller@example.com');
});

test('periodic reconcile revalidates account type when legacy metadata has no flag', () => {
  assert.equal(storedOneDayReady({ metadata: { oneDayReady: true } }), true);
  assert.equal(storedOneDayReady({ metadata: { oneDayReady: false } }), false);
  assert.equal(storedOneDayReady({ metadata: {} }), undefined);
});
