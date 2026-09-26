const { decryptSecret, encryptSecret } = require('./_cardtrader_crypto');
const { safeInfoMetadata } = require('./_cardtrader_client');

const COLLECTION = 'seller_integrations';
const PROVIDER = 'cardtrader';

function integrationDocId(uid) {
  return `${uid}__${PROVIDER}`;
}

function timestampToIso(value) {
  return value?.toDate?.().toISOString?.() || null;
}

function safeStatusFromDoc(doc) {
  if (!doc || !doc.exists) {
    return {
      connected: false,
      provider: PROVIDER,
      metadata: null,
      connectedAt: null,
      updatedAt: null,
      lastValidatedAt: null,
      disconnectedAt: null,
    };
  }
  const data = doc.data() || {};
  const enabled = data.enabled === true;
  return {
    connected: enabled,
    provider: PROVIDER,
    metadata: enabled ? data.metadata || null : null,
    connectedAt: timestampToIso(data.connectedAt),
    updatedAt: timestampToIso(data.updatedAt),
    lastValidatedAt: timestampToIso(data.lastValidatedAt),
    disconnectedAt: timestampToIso(data.disconnectedAt),
  };
}

async function readIntegrationDoc(firestore, uid) {
  return firestore.collection(COLLECTION).doc(integrationDocId(uid)).get();
}

function stampDay(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date?.getTime?.()) ? '' : date.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : '';
}

async function storeConnectedIntegration({ admin, firestore, uid, email, token, info }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = firestore.collection(COLLECTION).doc(integrationDocId(uid));
  let prior = {};
  try {
    const existing = await ref.get();
    prior = existing?.exists ? existing.data() || {} : {};
  } catch (_) {
    prior = {};
  }
  const metadata = {
    ...(prior.metadata || {}),
    ...safeInfoMetadata(info),
  };
  if (!metadata.firstSyncAt) {
    metadata.firstSyncAt = stampDay(prior.connectedAt) || new Date().toISOString().slice(0, 10);
  }
  const payload = {
    uid,
    provider: PROVIDER,
    userEmail: email || '',
    enabled: true,
    metadata,
    encryptedToken: encryptSecret(token),
    encryptedSharedSecret: encryptSecret(info.sharedSecret || ''),
    connectedAt: prior.connectedAt || now,
    updatedAt: now,
    lastValidatedAt: now,
    disconnectedAt: null,
  };
  await ref.set(payload, { merge: true });
  return payload;
}

/** Records the CardTrader account type a sync detected (1-Day Ready or not). */
async function markOneDayReady(firestore, uid, oneDayReady) {
  if (!firestore || !uid) return;
  const ref = firestore.collection(COLLECTION).doc(integrationDocId(uid));
  let metadata = { oneDayReady: oneDayReady === true };
  try {
    const doc = await ref.get();
    const data = doc?.exists ? doc.data() || {} : {};
    const prior = data.metadata || {};
    metadata = {
      ...prior,
      oneDayReady: oneDayReady === true,
    };
    if (!metadata.firstSyncAt) {
      const day = stampDay(data.connectedAt);
      if (day) metadata.firstSyncAt = day;
    }
  } catch (_) {
    /* a store without get still records the account type */
  }
  await ref.set({ metadata }, { merge: true });
}

/** A connected CardTrader 1-Day Ready account: its stock is CardTrader's, never pushed or listed. */
function isOneDayReadyIntegration(doc) {
  const data = doc?.exists ? doc.data() || {} : {};
  return data.enabled === true && data.metadata?.oneDayReady === true;
}

async function disconnectIntegration({ admin, firestore, uid }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await firestore.collection(COLLECTION).doc(integrationDocId(uid)).set(
    {
      enabled: false,
      encryptedToken: null,
      encryptedSharedSecret: null,
      disconnectedAt: now,
      updatedAt: now,
    },
    { merge: true },
  );
}

async function decryptIntegrationToken(firestore, uid) {
  const doc = await readIntegrationDoc(firestore, uid);
  if (!doc.exists || doc.data()?.enabled !== true || !doc.data()?.encryptedToken) {
    const error = new Error('CardTrader is not connected for this seller.');
    error.statusCode = 404;
    throw error;
  }
  return decryptSecret(doc.data().encryptedToken);
}

async function decryptIntegrationSharedSecret(firestore, uid) {
  const doc = await readIntegrationDoc(firestore, uid);
  if (!doc.exists || doc.data()?.enabled !== true || !doc.data()?.encryptedSharedSecret) {
    const error = new Error('CardTrader webhook secret is not available for this seller.');
    error.statusCode = 404;
    throw error;
  }
  return decryptSecret(doc.data().encryptedSharedSecret);
}

module.exports = {
  COLLECTION,
  PROVIDER,
  decryptIntegrationSharedSecret,
  decryptIntegrationToken,
  disconnectIntegration,
  integrationDocId,
  isOneDayReadyIntegration,
  markOneDayReady,
  readIntegrationDoc,
  safeStatusFromDoc,
  storeConnectedIntegration,
};
