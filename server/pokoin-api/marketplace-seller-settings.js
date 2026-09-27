'use strict';

/**
 * Seller ship-from country + Stripe Connect readiness on users/{uid}.
 * GET  /api/marketplace-seller-settings
 * POST /api/marketplace-seller-settings  { shipFromCountry?, stripeConnectReturn? }
 */

const path = require('path');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

const { getFirebaseAdmin, verifyBearerToken } = requireHelper('_firebase');
const { assertShipFromCountry, normalizeCountry } = require('./_checkout_core');

function profileRef(firestore, uid) {
  return firestore.collection('users').doc(uid);
}

async function readSettings(firestore, uid) {
  const snap = await profileRef(firestore, uid).get();
  const data = snap.exists ? snap.data() || {} : {};
  const shipFromCountry = normalizeCountry(data.shipFromCountry || data.ship_from_country || '');
  return {
    shipFromCountry: shipFromCountry || '',
    stripeConnectAccountId: String(data.stripeConnectAccountId || ''),
    stripeConnectStatus: String(data.stripeConnectStatus || 'not_started'),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();

    if (req.method === 'GET') {
      const settings = await readSettings(firestore, decoded.uid);
      return res.status(200).json(settings);
    }

    const body = req.body || {};
    const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (body.shipFromCountry != null) {
      patch.shipFromCountry = assertShipFromCountry(body.shipFromCountry);
    }
    await profileRef(firestore, decoded.uid).set(patch, { merge: true });
    const settings = await readSettings(firestore, decoded.uid);
    return res.status(200).json(settings);
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || 'Seller settings failed.', code: error.code });
  }
};

module.exports.readSellerSettings = readSettings;
module.exports._test = { readSettings, assertShipFromCountry, normalizeCountry };
