'use strict';

/**
 * Seller ship-from country + Stripe Connect readiness on users/{uid}.
 * GET  /api/marketplace-seller-settings
 * GET  /api/marketplace-seller-settings?sellers=uid1,uid2  → { pknRefused: [{uid,name}] }
 *      (checkout: which sellers in the cart take card payments only)
 * POST /api/marketplace-seller-settings  { shipFromCountry?, acceptsPkn?, stripeConnectReturn? }
 *
 * acceptsPkn=false opts the seller out of PKN payments (_seller_pkn_policy.js).
 *
 * When shipFromCountry is empty, GET seeds it from the request IP country
 * (CF-IPCountry / Vercel / CloudFront) if that ISO code is an allowed sell-from
 * country. Sellers can change it anytime on Profile. Selling still requires a
 * stored shipFromCountry (IP seed or manual).
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
const { shipFromCountryFromRequest } = require('./_client_country');
const { marketplaceWriteQuery } = require('./_marketplace_db');
const { acceptsPknFrom, sellersRefusingPkn } = require('./_seller_pkn_policy');

function profileRef(firestore, uid) {
  return firestore.collection('users').doc(uid);
}

async function stampSellerCountryOnListings(sellerUid, country) {
  const code = normalizeCountry(country);
  if (!sellerUid || !code) return 0;
  try {
    const result = await marketplaceWriteQuery(
      `
        update public.marketplace_user_listings
        set seller_country = $2, updated_at = now()
        where seller_uid = $1
          and coalesce(upper(seller_country), '') is distinct from $2
      `,
      [sellerUid, code],
    );
    return result?.rowCount || 0;
  } catch (_) {
    return 0;
  }
}

async function readSettings(firestore, uid) {
  const snap = await profileRef(firestore, uid).get();
  const data = snap.exists ? snap.data() || {} : {};
  const shipFromCountry = normalizeCountry(data.shipFromCountry || data.ship_from_country || '');
  const source = String(data.shipFromCountrySource || '').trim().toLowerCase();
  return {
    shipFromCountry: shipFromCountry || '',
    shipFromCountrySource: shipFromCountry
      ? (source === 'ip' || source === 'user' ? source : 'user')
      : '',
    stripeConnectAccountId: String(data.stripeConnectAccountId || ''),
    stripeConnectStatus: String(data.stripeConnectStatus || 'not_started'),
    acceptsPkn: acceptsPknFrom(data),
  };
}

async function seedFromIpIfNeeded(firestore, admin, uid, headers) {
  const current = await readSettings(firestore, uid);
  if (current.shipFromCountry) {
    return { ...current, seededFromIp: false };
  }
  const fromIp = shipFromCountryFromRequest(headers || {});
  if (!fromIp) {
    return { ...current, suggestedShipFromCountry: '', seededFromIp: false };
  }
  await profileRef(firestore, uid).set({
    shipFromCountry: fromIp,
    shipFromCountrySource: 'ip',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await stampSellerCountryOnListings(uid, fromIp);
  return {
    ...(await readSettings(firestore, uid)),
    suggestedShipFromCountry: fromIp,
    seededFromIp: true,
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

    const sellersParam = req.query?.sellers
      || new URL(req.url || '/', 'http://local').searchParams.get('sellers');
    if (req.method === 'GET' && sellersParam) {
      const uids = String(sellersParam).split(',');
      return res.status(200).json({ pknRefused: await sellersRefusingPkn(firestore, uids) });
    }

    if (req.method === 'GET') {
      const settings = await seedFromIpIfNeeded(firestore, admin, decoded.uid, req.headers);
      return res.status(200).json(settings);
    }

    const body = req.body || {};
    const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (body.shipFromCountry != null) {
      patch.shipFromCountry = assertShipFromCountry(body.shipFromCountry);
      patch.shipFromCountrySource = 'user';
    }
    if (typeof body.acceptsPkn === 'boolean') {
      patch.acceptsPkn = body.acceptsPkn;
    }
    await profileRef(firestore, decoded.uid).set(patch, { merge: true });
    let listingsStamped = 0;
    if (patch.shipFromCountry) {
      listingsStamped = await stampSellerCountryOnListings(decoded.uid, patch.shipFromCountry);
    }
    const settings = await readSettings(firestore, decoded.uid);
    return res.status(200).json({ ...settings, listingsStamped });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || 'Seller settings failed.', code: error.code });
  }
};

module.exports.readSellerSettings = readSettings;
module.exports.seedFromIpIfNeeded = seedFromIpIfNeeded;
module.exports._test = {
  readSettings,
  assertShipFromCountry,
  normalizeCountry,
  stampSellerCountryOnListings,
  seedFromIpIfNeeded,
  shipFromCountryFromRequest,
};
