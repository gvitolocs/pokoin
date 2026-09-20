'use strict';

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { parseEncryptionKey } = require('./_cardtrader_crypto');
const { readIntegrationDoc, safeStatusFromDoc } = require('./_cardtrader_integration');
const {
  readSellerSync,
  reconcileCardTraderInventory,
} = require('./_cardtrader_inventory_sync');

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    parseEncryptionKey();
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();

    if (req.method === 'GET') {
      const doc = await readIntegrationDoc(firestore, decoded.uid);
      const status = safeStatusFromDoc(doc);
      const sync = await readSellerSync(decoded.uid);
      return res.status(200).json({
        ok: true,
        status,
        sync: sync
          ? {
            lastSyncAt: sync.last_sync_at,
            lastSyncOk: sync.last_sync_ok,
            lastSyncIncomplete: sync.last_sync_incomplete,
            lastSyncError: sync.last_sync_error,
            lastCompleteExportAt: sync.last_complete_export_at,
            lastExportProductCount: sync.last_export_product_count,
            summary: sync.last_sync_summary || {},
          }
          : null,
      });
    }

    const doc = await readIntegrationDoc(firestore, decoded.uid);
    const status = safeStatusFromDoc(doc);
    if (!status?.connected) {
      return res.status(400).json({ error: 'Connect CardTrader before syncing inventory.' });
    }

    const sellerName = status?.metadata?.user?.username
      || status?.metadata?.seller?.name
      || decoded.name
      || decoded.email
      || 'Pokoin seller';

    const result = await reconcileCardTraderInventory({
      firestore,
      uid: decoded.uid,
      sellerName: String(sellerName),
    });

    return res.status(200).json({
      ok: result.ok !== false,
      connected: true,
      incomplete: Boolean(result.incomplete),
      destructiveSkipped: Boolean(result.destructiveSkipped),
      error: result.error || null,
      summary: result.summary,
      status,
    });
  } catch (error) {
    console.error('cardtrader-sync failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader sync failed.',
      code: error.code,
    });
  }
};
