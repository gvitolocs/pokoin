const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { parseEncryptionKey } = require('./_cardtrader_crypto');
const {
  cardTraderWebhookUrlForUid,
  updateAppWebhookUrl,
  validateCardTraderToken,
} = require('./_cardtrader_client');
const {
  decryptIntegrationToken,
  disconnectIntegration,
  readIntegrationDoc,
  safeStatusFromDoc,
  storeConnectedIntegration,
} = require('./_cardtrader_integration');
const { reconcileCardTraderInventory } = require('./_cardtrader_inventory_sync');

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

async function registerSellerWebhook(token, uid) {
  const webhookUrl = cardTraderWebhookUrlForUid(uid);
  if (!webhookUrl) return null;
  return updateAppWebhookUrl(token, webhookUrl);
}

async function clearSellerWebhook(token) {
  try {
    return await updateAppWebhookUrl(token, '');
  } catch (error) {
    console.error('cardtrader clear webhook failed', { message: error.message });
    return null;
  }
}

async function connect(req, decoded, admin, firestore) {
  const token = String(req.body?.token || '').trim();
  parseEncryptionKey();
  const info = await validateCardTraderToken(token);
  await storeConnectedIntegration({
    admin,
    firestore,
    uid: decoded.uid,
    email: decoded.email || '',
    token,
    info,
  });
  try {
    await registerSellerWebhook(token, decoded.uid);
  } catch (error) {
    console.error('cardtrader webhook registration failed', {
      uid: decoded.uid,
      message: error.message,
    });
  }

  // Auth succeeded → keep integration even if initial inventory sync fails.
  let inventorySync = null;
  try {
    const sellerName = info?.user?.username
      || info?.seller?.name
      || decoded.email
      || 'Pokoin seller';
    inventorySync = await reconcileCardTraderInventory({
      firestore,
      uid: decoded.uid,
      sellerName: String(sellerName),
      token,
    });
  } catch (error) {
    console.error('cardtrader initial inventory sync failed', {
      uid: decoded.uid,
      message: error.message,
    });
    inventorySync = {
      ok: false,
      incomplete: true,
      connected: true,
      destructiveSkipped: true,
      error: error.message || 'Initial CardTrader inventory sync failed.',
      summary: null,
    };
  }

  const doc = await readIntegrationDoc(firestore, decoded.uid);
  return { status: safeStatusFromDoc(doc), inventorySync };
}

async function disconnect(decoded, admin, firestore) {
  try {
    const token = await decryptIntegrationToken(firestore, decoded.uid);
    await clearSellerWebhook(token);
  } catch (error) {
    console.error('cardtrader disconnect webhook clear skipped', {
      uid: decoded.uid,
      message: error.message,
    });
  }
  await disconnectIntegration({ admin, firestore, uid: decoded.uid });
  const doc = await readIntegrationDoc(firestore, decoded.uid);
  return safeStatusFromDoc(doc);
}

module.exports = async function handler(req, res) {
  setNoStore(res);
  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();

    if (req.method === 'POST') {
      const result = await connect(req, decoded, admin, firestore);
      return res.status(200).json({
        ok: true,
        status: result.status,
        inventorySync: result.inventorySync || null,
      });
    }

    if (req.method === 'DELETE') {
      const status = await disconnect(decoded, admin, firestore);
      return res.status(200).json({ ok: true, status });
    }

    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('cardtrader-connect failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader connection failed.',
      code: error.code,
    });
  }
};

module.exports._test = { connect, disconnect, registerSellerWebhook, clearSellerWebhook };
