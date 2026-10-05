'use strict';

/**
 * POST /api/marketplace-checkout-quote
 * Body: {
 *   items: [{listingId, sellerUid, qty|quantity, pricePkn|unitPricePkn}],
 *   shippingAddressId?,  // preferred — toCountry from saved address
 *   toCountry?,          // preview when no address yet (buyer locale / draft)
 *   shippingService?, tracked?
 * }
 * Server resolves seller origins from profile (user-set or IP-seeded) + rates.
 * Never trusts client shipping cents.
 */

const path = require('path');
const { quoteCheckout, guardCheckoutQuote, normalizeCountry, httpError } = require('./_checkout_core');
const { decryptAddressPayload } = require('./_address_crypto');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

const { getFirebaseAdmin, verifyBearerToken } = requireHelper('_firebase');

async function sellerOrigin(firestore, sellerId, fallback) {
  const snap = await firestore.collection('users').doc(sellerId).get();
  const fromProfile = normalizeCountry(snap.exists ? snap.data()?.shipFromCountry : '');
  if (fromProfile) return fromProfile;
  const listingCountry = normalizeCountry(fallback);
  if (listingCountry) return listingCountry;
  throw httpError(409, `Seller ${sellerId} has no shipFromCountry.`, 'missing_ship_from');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: 'Cart items required.' });
    }

    const addressId = String(body.shippingAddressId || '').trim();
    let toCountry = '';
    if (addressId) {
      const addressRef = firestore.collection('users').doc(decoded.uid).collection('shipping_addresses').doc(addressId);
      const addressSnap = await addressRef.get();
      if (!addressSnap.exists) {
        return res.status(404).json({ error: 'Shipping address not found.' });
      }
      const addressData = addressSnap.data() || {};
      toCountry = normalizeCountry(addressData.countryCode);
      if (!toCountry) {
        return res.status(400).json({ error: 'Address countryCode invalid.' });
      }
      // Decrypt only to confirm payload exists for the owner — not logged.
      decryptAddressPayload(addressData.encryptedPayload);
    } else {
      toCountry = normalizeCountry(body.toCountry);
      if (!toCountry) {
        return res.status(400).json({
          error: 'shippingAddressId or toCountry required.',
          code: 'address_required',
        });
      }
    }

    const sellerIds = [...new Set(items.map((row) => String(row.sellerUid || '').trim()).filter(Boolean))];
    const sellerOrigins = {};
    for (const sellerId of sellerIds) {
      const sample = items.find((row) => String(row.sellerUid) === sellerId);
      sellerOrigins[sellerId] = await sellerOrigin(
        firestore,
        sellerId,
        sample?.shipFromCountry || sample?.sellerCountry,
      );
    }

    const tracked = body.tracked !== false && body.shippingTracked !== false
      && String(body.shippingService || '').toLowerCase() !== 'untracked';

    const quote = guardCheckoutQuote(
      quoteCheckout({ items, sellerOrigins, toCountry, tracked }),
      { tracked, insurance: body.insurance === true },
    );
    return res.status(200).json({
      ...quote,
      sellerOrigins,
      shippingAddressId: addressId || null,
      toCountry,
      tracked,
      preview: !addressId,
      quotedAt: new Date().toISOString(),
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('checkout-quote', error.code || error.message);
    return res.status(status).json({
      error: error.message || 'Quote failed.',
      code: error.code,
      meta: error.meta || undefined,
    });
  }
};
