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
const { pknBalanceDiscount, quoteCheckout, guardCheckoutQuote, normalizeCountry, httpError, eurCentsFromPkn } = require('./_checkout_core');
const { sellersRefusingPkn } = require('./_seller_pkn_policy');
const { encryptAddressPayload, decryptAddressPayload } = require('./_address_crypto');
const {
  CHECKOUT_HOLD_SECONDS,
  releaseEurReservation,
  reserveEurCheckoutItems,
  rollbackReservation,
} = require('./_eur_order_inventory');

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

async function loadSellerCheckoutContext(firestore, sellerIds) {
  const origins = {};
  const accounts = {};
  for (const sellerId of sellerIds) {
    const snap = await firestore.collection('users').doc(sellerId).get();
    const data = snap.exists ? snap.data() || {} : {};
    const from = normalizeCountry(data.shipFromCountry);
    if (!from) {
      throw httpError(409, `Seller ${sellerId} must set shipFromCountry before EUR checkout.`, 'missing_ship_from');
    }
    origins[sellerId] = from;
    // Connect can be finished later — buyer pay still works; Transfer waits until READY.
    if (data.stripeConnectStatus === 'READY' && data.stripeConnectAccountId) {
      accounts[sellerId] = String(data.stripeConnectAccountId);
    } else {
      accounts[sellerId] = '';
    }
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
    const { origins, accounts } = await loadSellerCheckoutContext(firestore, sellerIds);
    const tracked = body.tracked !== false && body.shippingTracked !== false
      && String(body.shippingService || '').toLowerCase() !== 'untracked';
    // Route/price sanity before touching stock (fails closed on no shipping row).
    const preview = guardCheckoutQuote(
      quoteCheckout({ items, sellerOrigins: origins, toCountry, tracked }),
      { tracked, insurance: body.insurance === true },
    );
    if (!preview.grandTotalCents || preview.grandTotalCents < 50) {
      return res.status(400).json({ error: 'Order total too small for Stripe Checkout.' });
    }

    // Take the stock now (same decrement as the PKN path) and re-price every
    // row from Postgres — client prices never reach Stripe. The order id is
    // the hold key, so it exists before the decrement.
    const orderId = `eur_${crypto.randomBytes(12).toString('hex')}`;
    const reserved = await reserveEurCheckoutItems({ rawItems: items, orderId });
    const orderRef = firestore.collection('orders').doc(orderId);
    let orderWritten = false;
    let quote;
    let session;
    // Read by the success response after this try block: declaring it inside
    // the block threw "pknDiscount is not defined" once Stripe had a session.
    let pknDiscount = { discountPkn: 0, discountEurCents: 0 };
    try {
      quote = guardCheckoutQuote(
        quoteCheckout({ items: reserved.items, sellerOrigins: origins, toCountry, tracked }),
        { tracked, insurance: body.insurance === true },
      );
      const now = admin.firestore.FieldValue.serverTimestamp();
      const holdExpiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_HOLD_SECONDS;
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
      if (quote.insuranceCents > 0) {
        lineItems.push({
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: quote.insuranceCents,
            product_data: {
              name: 'Shipping insurance',
              description: '5% of the card prices. Covers 80% if the parcel is lost.',
            },
          },
        });
      }
      const lineTotal = lineItems.reduce((sum, row) => sum + Number(row.price_data.unit_amount || 0), 0);
      if (lineTotal !== quote.grandTotalCents) {
        throw httpError(500, 'Shipment line items do not sum to checkout total.', 'checkout_line_mismatch');
      }

      // PKN balance as a discount: only lines from sellers who accept PKN are
      // eligible; the card charge keeps a 50-cent floor. Balance debit + order
      // write happen in one transaction — session-create failure releases it.
      const refusing = await sellersRefusingPkn(firestore, sellerIds);
      const refusedUids = new Set(refusing.map((row) => row.uid));
      const balanceRef = firestore.collection('balances').doc(decoded.uid);
      await firestore.runTransaction(async (tx) => {
        const balSnap = await tx.get(balanceRef);
        // Opt-in only: the buyer ticks "use my PKN balance as a discount".
        pknDiscount = pknBalanceDiscount({
          availablePkn: body.usePknDiscount === true && balSnap.exists ? balSnap.data()?.availablePkn : 0,
          items: reserved.items,
          refusedSellerUids: refusedUids,
          grandTotalCents: quote.grandTotalCents,
        });
        const held = pknDiscount.discountPkn > 0
          ? {
            pkn: pknDiscount.discountPkn,
            eurCents: pknDiscount.discountEurCents,
            state: 'held',
            heldAt: new Date().toISOString(),
          }
          : null;
        tx.set(orderRef, {
        uid: decoded.uid,
        buyerUid: decoded.uid,
        buyerEmail: String(body.buyerEmail || decoded.email || '').slice(0, 240),
        currency: 'EUR',
        paymentMethod: 'stripe',
        items: reserved.items.map((row) => ({
          listingId: row.listingId,
          sellerUid: row.sellerUid,
          sellerName: row.sellerName || '',
          quantity: row.quantity,
          unitPricePkn: row.unitPricePkn,
          unitPriceEURCents: eurCentsFromPkn(row.unitPricePkn),
          totalPricePkn: row.unitPricePkn * row.quantity,
          condition: row.condition || '',
          language: row.language || '',
          source: row.source || '',
          sourceListingId: row.sourceListingId || '',
          sourceMetadata: row.sourceMetadata || {},
          card: { id: row.card?.id || '', name: row.card?.name || '' },
          fulfillmentMode: 'physical',
        })),
        shipments,
        itemsSubtotalCents: quote.itemsSubtotalCents,
        shippingTotalCents: quote.shippingTotalCents,
        insuranceCents: quote.insuranceCents || 0,
        totalEURCents: quote.grandTotalCents,
        shippingAddressId: addressId,
        shippingAddressSnapshotEncrypted: snapshotEncrypted,
        shippingAddressCountryCode: toCountry,
        sellerUids: sellerIds,
        status: 'pending',
        paymentStatus: 'pending_stripe',
        fulfillmentStatus: 'pending',
        fulfillmentMode: 'physical',
        // Stock is held for this buyer until Stripe pays or the hold expires.
        inventory: {
          state: 'reserved',
          lines: reserved.lines,
          reservedAt: new Date().toISOString(),
          expiresAt: new Date(holdExpiresAt * 1000).toISOString(),
        },
        createdAt: now,
        updatedAt: now,
        pknDiscount: held,
        });
        if (held) {
          tx.update(balanceRef, {
            availablePkn: pknDiscount.discountPkn
              ? Math.max(0, Number(balSnap.data()?.availablePkn) || 0) - pknDiscount.discountPkn
              : 0,
            updatedAt: now,
          });
        }
      });
      orderWritten = true;

      let discounts;
      if (pknDiscount.discountEurCents > 0) {
        // One-off coupon: the session shows the PKN discount as its own line.
        const coupon = await stripe.coupons.create({
          amount_off: pknDiscount.discountEurCents,
          currency: 'eur',
          duration: 'once',
          name: `PKN balance −${pknDiscount.discountPkn} PKN`,
        });
        discounts = [{ coupon: coupon.id }];
      }
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: decoded.email || undefined,
        expires_at: holdExpiresAt,
        success_url: `${siteUrl()}/orders?eur_session={CHECKOUT_SESSION_ID}&order=${orderId}`,
        cancel_url: `${siteUrl()}/checkout?cancelled=1&order=${orderId}`,
        line_items: lineItems,
        ...(discounts ? { discounts } : {}),
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
          amountCents: String(quote.grandTotalCents - pknDiscount.discountEurCents),
          pknDiscountPkn: String(pknDiscount.discountPkn || 0),
          pknDiscountEurCents: String(pknDiscount.discountEurCents || 0),
          sellerCount: String(shipments.length),
        },
      });

      await orderRef.set({
        stripeCheckoutSessionId: session.id,
        stripeCheckoutUrl: String(session.url || ''),
        updatedAt: now,
      }, { merge: true });
    } catch (error) {
      // Nothing may stay held for a checkout the buyer can never pay.
      if (orderWritten) {
        await releaseEurReservation({
          admin,
          firestore,
          orderId,
          reason: 'session_failed',
          paymentStatus: 'failed',
        }).catch((releaseError) => {
          console.error('create-order-checkout-session release failed', releaseError.message);
        });
      } else {
        await rollbackReservation({ lines: reserved.lines, orderId });
      }
      throw error;
    }

    return res.status(200).json({
      orderId,
      checkoutUrl: session.url,
      sessionId: session.id,
      amountTotalCents: quote.grandTotalCents - pknDiscount.discountEurCents,
      pknDiscount,
      currency: 'EUR',
      quote,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('create-order-checkout-session', error.message);
    return res.status(status).json({ error: error.message || 'Checkout session failed.', code: error.code });
  }
};

module.exports._test = { loadSellerCheckoutContext, assertSellersReady: loadSellerCheckoutContext, eurCentsFromPkn };
