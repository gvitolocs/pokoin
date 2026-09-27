'use strict';

/**
 * Periodic safety net for connected CardTrader sellers.
 *
 * Order webhooks are the fast path. This complete-export reconcile is the
 * bounded-delay path when CardTrader did not deliver a webhook or registration
 * temporarily failed. It also repairs the seller app webhook URL every run.
 */

const { getFirebaseAdmin } = require('../server/_firebase');
const { decryptIntegrationToken } = require('./_cardtrader_integration');
const { registerSellerWebhook } = require('./_cardtrader_webhook_registration');
const { reconcileCardTraderInventory } = require('./_cardtrader_inventory_sync');

function sellerNameFromIntegration(data = {}) {
  return String(
    data.metadata?.user?.username
      || data.metadata?.seller?.name
      || data.userEmail
      || 'Pokoin seller',
  ).slice(0, 160);
}

function storedOneDayReady(data = {}) {
  return typeof data.metadata?.oneDayReady === 'boolean'
    ? data.metadata.oneDayReady
    : undefined;
}

async function connectedSellerIntegrations(firestore) {
  const snapshot = await firestore.collection('seller_integrations').get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((row) => row.provider === 'cardtrader' && row.enabled === true && row.uid);
}

async function reconcileAllConnectedSellers({
  admin,
  firestore,
  listIntegrations = connectedSellerIntegrations,
  decryptToken = decryptIntegrationToken,
  registerWebhook = registerSellerWebhook,
  reconcileInventory = reconcileCardTraderInventory,
} = {}) {
  const integrations = await listIntegrations(firestore);
  const results = [];
  for (const integration of integrations) {
    const uid = String(integration.uid || '').trim();
    const row = { uid, webhookOk: false, syncOk: false };
    try {
      const token = await decryptToken(firestore, uid);
      try {
        await registerWebhook({ admin, firestore, token, uid });
        row.webhookOk = true;
      } catch (error) {
        row.webhookError = String(error.message || error).slice(0, 500);
      }
      const sync = await reconcileInventory({
        firestore,
        uid,
        sellerName: sellerNameFromIntegration(integration),
        token,
        oneDayReady: storedOneDayReady(integration),
      });
      row.syncOk = sync?.ok === true && sync?.incomplete !== true;
      row.removed = Number(sync?.summary?.removed || 0);
      row.updated = Number(sync?.summary?.updated || 0);
      row.inventory = Number(sync?.summary?.inventory || 0);
      if (!row.syncOk) row.syncError = String(sync?.error || 'Incomplete inventory export.').slice(0, 500);
    } catch (error) {
      row.syncError = String(error.message || error).slice(0, 500);
    }
    results.push(row);
    console.log('cardtrader periodic seller reconcile', row);
  }
  return {
    ok: results.every((row) => row.webhookOk && row.syncOk),
    sellers: results.length,
    failed: results.filter((row) => !row.webhookOk || !row.syncOk).length,
    results,
  };
}

async function main() {
  const admin = getFirebaseAdmin();
  const result = await reconcileAllConnectedSellers({ admin, firestore: admin.firestore() });
  console.log('cardtrader periodic reconcile complete', {
    ok: result.ok,
    sellers: result.sellers,
    failed: result.failed,
  });
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('cardtrader periodic reconcile failed', { message: error.message });
    process.exitCode = 1;
  });
}

module.exports = {
  connectedSellerIntegrations,
  reconcileAllConnectedSellers,
  sellerNameFromIntegration,
  storedOneDayReady,
};
