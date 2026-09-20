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

async function storeConnectedIntegration({ admin, firestore, uid, email, token, info }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const metadata = safeInfoMetadata(info);
  const payload = {
    uid,
    provider: PROVIDER,
    userEmail: email || '',
    enabled: true,
    metadata,
    encryptedToken: encryptSecret(token),
    encryptedSharedSecret: encryptSecret(info.sharedSecret || ''),
    connectedAt: now,
    updatedAt: now,
    lastValidatedAt: now,
    disconnectedAt: null,
  };
  await firestore.collection(COLLECTION).doc(integrationDocId(uid)).set(payload, { merge: true });
  return payload;
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
  readIntegrationDoc,
  safeStatusFromDoc,
  storeConnectedIntegration,
};
