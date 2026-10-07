'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// The AES helper reads the key at call time.
process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const { createFirestore } = require('./_firestore_fake');

const {
  COLLECTION,
  integrationDocId,
  readIntegration,
  safeStatus,
  storeIntegration,
  decryptSecrets,
  setOAuthState,
  findByOAuthState,
  clearOAuthState,
  patchIntegration,
  disconnectIntegration,
  listEnabledIntegrations,
} = require('./_platform_integration');

const STATUS_KEYS = [
  'provider',
  'connected',
  'state',
  'metadata',
  'connectedAt',
  'updatedAt',
  'lastPolledAt',
  'webhook',
  'inventorySync',
  'disconnectedAt',
];

function harness() {
  const { admin, firestore } = createFirestore();
  return { admin, firestore };
}

test('integrationDocId keys one document per seller and provider', () => {
  assert.equal(integrationDocId('uid-1', 'shopify'), 'uid-1__shopify');
  assert.equal(COLLECTION, 'seller_integrations');
});

test('storeIntegration encrypts secrets and merges metadata', async () => {
  const { admin, firestore } = harness();
  await storeIntegration({
    admin,
    firestore,
    uid: 'uid-1',
    provider: 'shopify',
    email: 'seller@example.com',
    secrets: { accessToken: 'shpat_secret', apiSecretKey: 'shh_secret' },
    metadata: { shopDomain: 'store.myshopify.com', locationId: '55' },
  });
  const doc = firestore.dump(`${COLLECTION}/uid-1__shopify`);
  assert.equal(doc.enabled, true);
  assert.equal(doc.state, 'connected');
  assert.equal(doc.userEmail, 'seller@example.com');
  assert.equal(doc.metadata.shopDomain, 'store.myshopify.com');
  assert.ok(doc.encryptedSecrets.accessToken.ciphertext);
  assert.ok(doc.encryptedSecrets.apiSecretKey.ciphertext);
  // No plaintext secret anywhere in the stored document.
  assert.equal(JSON.stringify(doc).includes('shpat_secret'), false);
  assert.equal(JSON.stringify(doc).includes('shh_secret'), false);

  // A second connect merges metadata and keeps the original connectedAt.
  const connectedAt = doc.connectedAt;
  await storeIntegration({
    admin,
    firestore,
    uid: 'uid-1',
    provider: 'shopify',
    secrets: { accessToken: 'shpat_second' },
    metadata: { locationName: 'Main' },
  });
  const merged = firestore.dump(`${COLLECTION}/uid-1__shopify`);
  assert.equal(merged.metadata.shopDomain, 'store.myshopify.com');
  assert.equal(merged.metadata.locationName, 'Main');
  assert.equal(new Date(merged.connectedAt).toISOString(), new Date(connectedAt).toISOString());
  assert.ok(merged.encryptedSecrets.accessToken.ciphertext);
});

test('safeStatus describes a missing integration without a secret field', () => {
  const status = safeStatus('shopify', { exists: false });
  assert.deepEqual(Object.keys(status).sort(), [...STATUS_KEYS].sort());
  assert.equal(status.connected, false);
  assert.equal(status.state, 'disconnected');
  assert.equal(status.metadata, null);
});

test('safeStatus never exposes encrypted secrets or a disconnected metadata blob', () => {
  const doc = {
    exists: true,
    data: () => ({
      provider: 'shopify',
      enabled: true,
      state: 'connected',
      metadata: { shopDomain: 'store.myshopify.com' },
      encryptedSecrets: { accessToken: { ciphertext: 'AAAA' } },
      connectedAt: { toDate: () => new Date('2026-10-01T00:00:00Z') },
      updatedAt: { toDate: () => new Date('2026-10-02T00:00:00Z') },
    }),
  };
  const status = safeStatus('shopify', doc);
  assert.deepEqual(Object.keys(status).sort(), [...STATUS_KEYS].sort());
  assert.equal(status.connected, true);
  assert.equal(status.connectedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(JSON.stringify(status).includes('AAAA'), false);
  assert.equal(status.encryptedSecrets, undefined);

  const disabled = safeStatus('shopify', {
    exists: true,
    data: () => ({
      provider: 'shopify',
      enabled: false,
      state: 'connected',
      metadata: { shopDomain: 'store.myshopify.com' },
    }),
  });
  assert.equal(disabled.connected, false);
  assert.equal(disabled.metadata, null);
});

test('decryptSecrets refuses a disconnected seller and round-trips a connected one', async () => {
  const { admin, firestore } = harness();
  await assert.rejects(
    () => decryptSecrets(firestore, 'uid-1', 'shopify'),
    (error) => error.statusCode === 404 && error.code === 'platform_not_connected',
  );

  await storeIntegration({
    admin,
    firestore,
    uid: 'uid-1',
    provider: 'shopify',
    secrets: { accessToken: 'shpat_secret', apiSecretKey: 'shh_secret' },
  });
  const secrets = await decryptSecrets(firestore, 'uid-1', 'shopify');
  assert.deepEqual(secrets, { accessToken: 'shpat_secret', apiSecretKey: 'shh_secret' });
});

test('OAuth state is stored, found once, and expires', async () => {
  const { admin, firestore } = harness();
  await storeIntegration({
    admin,
    firestore,
    uid: 'uid-1',
    provider: 'cardmarket',
    secrets: {},
    metadata: {},
    state: 'pending_activation',
  });
  const before = new Date(Date.now() + 10 * 60 * 1000);
  await setOAuthState(firestore, 'cardmarket', 'state-abc', before, 'uid-1');
  const found = await findByOAuthState(firestore, 'cardmarket', 'state-abc');
  assert.ok(found);
  assert.equal(found.data.uid, 'uid-1');
  assert.equal(await findByOAuthState(firestore, 'cardmarket', 'other'), null);

  // Expired state is not usable.
  await setOAuthState(firestore, 'cardmarket', 'state-old', new Date(Date.now() - 60 * 1000), 'uid-1');
  assert.equal(await findByOAuthState(firestore, 'cardmarket', 'state-old'), null);
});

test('clearOAuthState clears the exact oauthState fields used to look it up', async () => {
  const { admin, firestore } = harness();
  await storeIntegration({ admin, firestore, uid: 'uid-1', provider: 'cardmarket' });
  await setOAuthState(firestore, 'cardmarket', 'state-abc', new Date(Date.now() + 60000), 'uid-1');
  const doc = await readIntegration(firestore, 'uid-1', 'cardmarket');
  await clearOAuthState(firestore, doc.ref);
  const after = firestore.dump(`${COLLECTION}/uid-1__cardmarket`);
  assert.equal(after.oauthState, null);
  assert.equal(after.oauthStateExpiresAt, null);
  assert.equal(await findByOAuthState(firestore, 'cardmarket', 'state-abc'), null);
});

test('patchIntegration merges a patch and stamps updatedAt', async () => {
  const { admin, firestore } = harness();
  await storeIntegration({ admin, firestore, uid: 'uid-1', provider: 'shopify' });
  await patchIntegration(firestore, 'uid-1', 'shopify', { lastPolledAt: '2026-10-03T00:00:00.000Z' });
  const doc = firestore.dump(`${COLLECTION}/uid-1__shopify`);
  assert.equal(doc.lastPolledAt, '2026-10-03T00:00:00.000Z');
  assert.ok(doc.updatedAt);
});

test('disconnectIntegration wipes credentials and oauth state but keeps the doc', async () => {
  const { admin, firestore } = harness();
  await storeIntegration({
    admin,
    firestore,
    uid: 'uid-1',
    provider: 'shopify',
    secrets: { accessToken: 'shpat_secret' },
  });
  await setOAuthState(firestore, 'shopify', 'state-abc', new Date(Date.now() + 60000), 'uid-1');
  await disconnectIntegration({ admin, firestore, uid: 'uid-1', provider: 'shopify' });
  const doc = firestore.dump(`${COLLECTION}/uid-1__shopify`);
  assert.equal(doc.enabled, false);
  assert.equal(doc.state, 'disconnected');
  assert.equal(doc.encryptedSecrets, null);
  assert.equal(doc.oauthState, null);
  assert.ok(doc.disconnectedAt);
});

test('listEnabledIntegrations returns connected sellers and skips cardtrader', async () => {
  const { admin, firestore } = harness();
  await storeIntegration({ admin, firestore, uid: 'uid-1', provider: 'shopify' });
  await storeIntegration({ admin, firestore, uid: 'uid-2', provider: 'tcgplayer' });
  await storeIntegration({ admin, firestore, uid: 'uid-3', provider: 'cardtrader' });
  await storeIntegration({ admin, firestore, uid: 'uid-4', provider: 'powertools' });
  await disconnectIntegration({ admin, firestore, uid: 'uid-4', provider: 'powertools' });
  const rows = await listEnabledIntegrations(firestore);
  assert.deepEqual(rows.map((row) => row.id).sort(), ['uid-1__shopify', 'uid-2__tcgplayer']);
});
