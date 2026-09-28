'use strict';

/**
 * EUR marketplace Checkout Session (Stripe Connect).
 * POST /api/create-order-checkout-session
 *
 * Body: { items, shippingAddressId }
 * Recalculates quote server-side, freezes order, creates Checkout Session.
 */

const Stripe = require('stripe');
const path = require('path');
const crypto = require('node:crypto');
const { quoteCheckout, normalizeCountry, httpError, eurCentsFromPkn } = require('./_checkout_core');
const { encryptAddressPayload, decryptAddressPayload } = require('./_address_crypto');

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

const { getFirebaseAdmin, verifyBearerToken } = requireHelper('_firebase');

function siteUrl() {
  return String(process.env.PUBLIC_SITE_URL || 'https://pokoin.com').replace(/\/$/, '');
}

function stripeClient() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    const error = new Error('Stripe is not configured yet.');
    error.statusCode = 500;
    throw error;
  }
  const options = process.env.STRIPE_API_VERSION ? { apiVersion: process.env.STRIPE_API_VERSION } : {};
  return new Stripe(secret, options);
}

async function assertSellersReady(firestore, sellerIds) {
  const origins = {};
  const accounts = {};
  for (const sellerId of sellerIds) {
    const snap = await firestore.collection('users').doc(sellerId).get();
    const data = snap.exists ? snap.data() || {} : {};
    const from = normalizeCountry(data.shipFromCountry);
    if (!from) {
      throw httpError(409, `Seller ${sellerId} must set shipFromCountry before EUR checkout.`, 'missing_ship_from');
    }
    if (data.stripeConnectStatus !== 'READY' || !data.stripeConnectAccountId) {
      throw httpError(409, `Seller ${sellerId} Stripe Connect is not READY.`, 'stripe_connect_not_ready');
    }
    origins[sellerId] = from;
    accounts[sellerId] = String(data.stripeConnectAccountId);
  }
  return { origins, accounts };
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
    const stripe = stripeClient();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: 'Cart items required.' });
    }

    const addressId = String(body.shippingAddressId || '').trim();
    if (!addressId) {
      return res.status(400).json({ error: 'shippingAddressId required.', code: 'address_required' });
    }
    const addressRef = firestore.collection('users').doc(decoded.uid).collection('shipping_addresses').doc(addressId);
    const addressSnap = await addressRef.get();
    if (!addressSnap.exists) {
      return res.status(404).json({ error: 'Shipping address not found.' });
    }
    const addressData = addressSnap.data() || {};
    const toCountry = normalizeCountry(addressData.countryCode);
    const plain = decryptAddressPayload(addressData.encryptedPayload);
    const snapshotEncrypted = encryptAddressPayload({
      ...plain,
      countryCode: toCountry,
      sourceAddressId: addressId,
    });

    const sellerIds = [...new Set(items.map((row) => String(row.sellerUid || '').trim()).filter(Boolean))];
    const { origins, accounts } = await assertSellersReady(firestore, sellerIds);
    const tracked = body.tracked !== false && body.shippingTracked !== false
      && String(body.shippingService || '').toLowerCase() !== 'untracked';
    const quote = quoteCheckout({ items, sellerOrigins: origins, toCountry, tracked });

    if (!quote.grandTotalCents || quote.grandTotalCents < 50) {
      return res.status(400).json({ error: 'Order total too small for Stripe Checkout.' });
    }

    const orderId = `eur_${crypto.randomBytes(12).toString('hex')}`;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const shipments = quote.shipments.map((shipment) => ({
      sellerId: shipment.sellerId,
      sellerName: shipment.sellerName || '',
      stripeConnectAccountId: accounts[shipment.sellerId],
      fromCountry: shipment.fromCountry,
      toCountry: shipment.toCountry,
      cardCount: shipment.cardCount,
      packageTier: shipment.packageTier,
      shippingRateId: shipment.rateId,
      shippingAmountEURCents: shipment.amountCents,
      itemsSubtotalCents: shipment.itemsSubtotalCents,
      // Seller settlement = items − 3% platform fee + shipping for their parcel.
      sellerTransferCents: Math.max(
        0,
        Math.round(shipment.itemsSubtotalCents * 0.97) + shipment.amountCents,
      ),
      quoteCreatedAt: new Date().toISOString(),
      serviceName: shipment.serviceName,
    }));

    // One Checkout line per seller shipment so Stripe shows the multi-seller split.
    // Platform still takes one charge; Connect Transfers go out per seller later.
    const lineItems = shipments.map((shipment, index) => {
      const unitAmount = Number(shipment.itemsSubtotalCents || 0) + Number(shipment.shippingAmountEURCents || 0);
      const sellerLabel = String(shipment.sellerName || shipment.sellerId || `Seller ${index + 1}`).slice(0, 80);
      return {
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: unitAmount,
          product_data: {
            name: `Shipment from ${sellerLabel}`,
            description: [
              `${shipment.cardCount} card(s)`,
              shipment.fromCountry && shipment.toCountry
                ? `${shipment.fromCountry}→${shipment.toCountry}`
                : '',
              shipment.serviceName || '',
            ].filter(Boolean).join(' · ').slice(0, 200),
          },
        },
      };
    });
    const lineTotal = lineItems.reduce((sum, row) => sum + Number(row.price_data.unit_amount || 0), 0);
    if (lineTotal !== quote.grandTotalCents) {
      throw httpError(500, 'Shipment line items do not sum to checkout total.', 'checkout_line_mismatch');
    }

    await firestore.collection('orders').doc(orderId).set({
      uid: decoded.uid,
      buyerUid: decoded.uid,
      buyerEmail: String(body.buyerEmail || decoded.email || '').slice(0, 240),
      currency: 'EUR',
      paymentMethod: 'stripe',
      items: items.map((row) => ({
        listingId: String(row.listingId || ''),
        sellerUid: String(row.sellerUid || ''),
        quantity: Number(row.quantity || row.qty) || 1,
        unitPricePkn: Number(row.unitPricePkn || row.pricePkn) || 0,
        unitPriceEURCents: eurCentsFromPkn(Number(row.unitPricePkn || row.pricePkn) || 0),
        totalPricePkn: (Number(row.unitPricePkn || row.pricePkn) || 0) * (Number(row.quantity || row.qty) || 1),
        card: row.card || { id: row.cardId, name: row.name },
        fulfillmentMode: 'physical',
      })),
      shipments,
      itemsSubtotalCents: quote.itemsSubtotalCents,
      shippingTotalCents: quote.shippingTotalCents,
      totalEURCents: quote.grandTotalCents,
      shippingAddressId: addressId,
      shippingAddressSnapshotEncrypted: snapshotEncrypted,
      shippingAddressCountryCode: toCountry,
      sellerUids: sellerIds,
      status: 'pending',
      paymentStatus: 'pending_stripe',
      fulfillmentStatus: 'pending',
      fulfillmentMode: 'physical',
      createdAt: now,
      updatedAt: now,
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: decoded.email || undefined,
      success_url: `${siteUrl()}/orders?eur_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl()}/checkout?cancelled=1`,
      line_items: lineItems,
      payment_intent_data: {
        transfer_group: orderId,
        metadata: {
          pokoinOrderId: orderId,
          pokoinUid: decoded.uid,
          kind: 'marketplace_order_eur',
          sellerCount: String(shipments.length),
        },
      },
      metadata: {
        pokoinOrderId: orderId,
        pokoinUid: decoded.uid,
        kind: 'marketplace_order_eur',
        amountCents: String(quote.grandTotalCents),
        sellerCount: String(shipments.length),
      },
    });

    await firestore.collection('orders').doc(orderId).set({
      stripeCheckoutSessionId: session.id,
      updatedAt: now,
    }, { merge: true });

    return res.status(200).json({
      orderId,
      checkoutUrl: session.url,
      sessionId: session.id,
      amountTotalCents: quote.grandTotalCents,
      currency: 'EUR',
      quote,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('create-order-checkout-session', error.message);
    return res.status(status).json({ error: error.message || 'Checkout session failed.', code: error.code });
  }
};

module.exports._test = { assertSellersReady, eurCentsFromPkn };
