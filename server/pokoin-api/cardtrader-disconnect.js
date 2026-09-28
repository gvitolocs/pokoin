const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { decryptIntegrationToken, disconnectIntegration, readIntegrationDoc, safeStatusFromDoc } = require('./_cardtrader_integration');
const { updateAppWebhookUrl } = require('./_cardtrader_client');
const { hideImportedCardTraderListings } = require('./_cardtrader_inventory_sync');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    try {
      const token = await decryptIntegrationToken(firestore, decoded.uid);
      await updateAppWebhookUrl(token, '');
    } catch (error) {
      console.error('cardtrader-disconnect webhook clear skipped', {
        uid: decoded.uid,
        message: error.message,
      });
    }
    await disconnectIntegration({ admin, firestore, uid: decoded.uid });
    // Without the token Pokoin can no longer see CardTrader sales, so stock
    // mirrored from CardTrader must not stay for sale here (oversell). Pokoin
    // only; CardTrader and the seller's own Pokoin listings are untouched.
    // Reconnecting re-imports them with fresh quantities and prices.
    let hiddenListings = 0;
    try {
      hiddenListings = await hideImportedCardTraderListings(decoded.uid, { keepSoldOut: true });
    } catch (error) {
      console.error('cardtrader-disconnect hide imported listings failed', {
        uid: decoded.uid,
        message: error.message,
      });
    }
    console.log('cardtrader-disconnect', { uid: decoded.uid, hiddenListings });
    const doc = await readIntegrationDoc(firestore, decoded.uid);
    return res.status(200).json({ ok: true, status: safeStatusFromDoc(doc), hiddenListings });
  } catch (error) {
    console.error('cardtrader-disconnect failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader disconnect failed.',
      code: error.code,
    });
  }
};
