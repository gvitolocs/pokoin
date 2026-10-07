'use strict';

const { decryptSecret, encryptSecret } = require('./_cardtrader_crypto');

const COLLECTION = 'seller_integrations';

function integrationDocId(uid, provider) {
  return `${uid}__${provider}`;
}

function timestampToIso(value) {
  return value?.toDate?.().toISOString?.() || null;
}

function safeStatus(provider, doc) {
  if (!doc || !doc.exists) {
    return {
      provider,
      connected: false,
      state: 'disconnected',
      metadata: null,
      connectedAt: null,
      updatedAt: null,
      lastPolledAt: null,
      webhook: null,
      inventorySync: null,
      disconnectedAt: null,
    };
  }
  const data = doc.data() || {};
  const enabled = data.enabled === true;
  const state = enabled ? (data.state || 'connected') : (data.state || 'disconnected');
  return {
    provider,
    connected: enabled && state === 'connected',
    state,
    metadata: enabled ? data.metadata || null : null,
    connectedAt: timestampToIso(data.connectedAt),
    updatedAt: timestampToIso(data.updatedAt),
    lastPolledAt: timestampToIso(data.lastPolledAt),
    webhook: data.webhookRegistration || null,
    inventorySync: data.inventorySync || null,
    disconnectedAt: timestampToIso(data.disconnectedAt),
  };
}

async function readIntegration(firestore, uid, provider) {
  return firestore.collection(COLLECTION).doc(integrationDocId(uid, provider)).get();
}

function serverTimestamp(admin) {
  return admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date().toISOString();
}

async function storeIntegration({ admin, firestore, uid, provider, email, secrets = {}, metadata = {}, state = 'connected' }) {
  const now = serverTimestamp(admin);
  const ref = firestore.collection(COLLECTION).doc(integrationDocId(uid, provider));
  let prior = {};
  try {
    const existing = await ref.get();
    prior = existing?.exists ? existing.data() || {} : {};
  } catch (_) {
    prior = {};
  }
  const encryptedSecrets = {};
  for (const [name, value] of Object.entries(secrets)) {
    encryptedSecrets[name] = encryptSecret(value);
  }
  const payload = {
    uid,
    provider,
    userEmail: email || '',
    enabled: true,
    state,
    metadata: {
      ...(prior.metadata || {}),
      ...metadata,
    },
    encryptedSecrets,
    connectedAt: prior.connectedAt || now,
    updatedAt: now,
    disconnectedAt: null,
  };
  await ref.set(payload, { merge: true });
  return payload;
}

async function decryptSecrets(firestore, uid, provider) {
  const doc = await readIntegration(firestore, uid, provider);
  if (!doc.exists || doc.data()?.enabled !== true) {
    const error = new Error(`${provider} is not connected for this seller.`);
    error.statusCode = 404;
    error.code = 'platform_not_connected';
    throw error;
  }
  const data = doc.data() || {};
  const encryptedSecrets = data.encryptedSecrets || {};
  const result = {};
  for (const [name, encrypted] of Object.entries(encryptedSecrets)) {
    try {
      result[name] = decryptSecret(encrypted);
    } catch (_) {
      result[name] = '';
    }
  }
  return result;
}

async function setOAuthState(firestore, provider, state, expiresAt, uid) {
  const ref = firestore.collection(COLLECTION).doc(integrationDocId(uid, provider));
  await ref.set({
    oauthState: state,
    oauthStateExpiresAt: expiresAt.toISOString ? expiresAt.toISOString() : String(expiresAt),
  }, { merge: true });
}

async function findByOAuthState(firestore, provider, state) {
  const snap = await firestore.collection(COLLECTION)
    .where('provider', '==', provider)
    .where('oauthState', '==', state)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data() || {};
  if (data.oauthStateExpiresAt) {
    const expires = new Date(data.oauthStateExpiresAt);
    if (!isNaN(expires.getTime()) && expires < new Date()) {
      return null;
    }
  }
  return { doc, data };
}

async function clearOAuthState(firestore, docRef) {
  await docRef.set({ oauthState: null, oauthStateExpiresAt: null }, { merge: true });
}

async function patchIntegration(firestore, uid, provider, patch) {
  const ref = firestore.collection(COLLECTION).doc(integrationDocId(uid, provider));
  const now = new Date().toISOString();
  await ref.set({ ...patch, updatedAt: now }, { merge: true });
}

async function disconnectIntegration({ admin, firestore, uid, provider }) {
  const now = serverTimestamp(admin);
  const ref = firestore.collection(COLLECTION).doc(integrationDocId(uid, provider));
  await ref.set({
    enabled: false,
    state: 'disconnected',
    encryptedSecrets: null,
    oauthState: null,
    oauthStateExpiresAt: null,
    disconnectedAt: now,
    updatedAt: now,
  }, { merge: true });
}

async function listEnabledIntegrations(firestore) {
  const snap = await firestore.collection(COLLECTION)
    .where('enabled', '==', true)
    .get();
  const results = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.provider === 'cardtrader' || data.provider === 'powertools') continue;
    if (data.enabled === true) {
      results.push({ id: doc.id, ...data });
    }
  }
  return results;
}

module.exports = {
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
};