'use strict';

/**
 * Fulfill EUR marketplace orders after Stripe Checkout.
 * Called from stripe-webhook when metadata.kind === marketplace_order_eur.
 */

async function handleMarketplaceOrderPaid({ admin, stripe, session }) {
  const orderId = String(session.metadata?.pokoinOrderId || '').trim();
  const uid = String(session.metadata?.pokoinUid || '').trim();
  if (!orderId || session.metadata?.kind !== 'marketplace_order_eur') {
    return null;
  }

  const firestore = admin.firestore();
  const orderRef = firestore.collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) {
    const error = new Error(`Order ${orderId} not found for Stripe session.`);
    error.statusCode = 404;
    throw error;
  }
  const order = snap.data() || {};
  if (order.paymentStatus === 'paid' || order.stripePaidSessionId === session.id) {
    return { orderId, duplicate: true };
  }

  const expected = Number(order.totalEURCents);
  const paid = Number(session.amount_total);
  if (Number.isFinite(expected) && Number.isFinite(paid) && expected !== paid) {
    const error = new Error(`Stripe amount ${paid} does not match order ${expected}.`);
    error.statusCode = 409;
    throw error;
  }
  if (uid && order.buyerUid && uid !== order.buyerUid) {
    const error = new Error('Stripe session uid does not match order buyer.');
    error.statusCode = 403;
    throw error;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  let stripeChargeId = '';
  const paymentIntentId = session.payment_intent
    ? (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id)
    : '';
  if (paymentIntentId && stripe?.paymentIntents?.retrieve) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
      const latest = pi.latest_charge;
      stripeChargeId = typeof latest === 'string' ? latest : String(latest?.id || '');
    } catch (_) {
      // Charge id is optional at webhook time; releaseSellerTransfers can re-fetch.
    }
  }

  await orderRef.set({
    paymentStatus: 'paid',
    status: 'paid',
    paidAt: now,
    updatedAt: now,
    stripePaidSessionId: session.id,
    stripePaymentIntentId: paymentIntentId || '',
    ...(stripeChargeId ? { stripeChargeId } : {}),
  }, { merge: true });

  // Per-seller Connect Transfers after delivery confirmation (multi-seller loop).
  return { orderId, duplicate: false, deferredTransfers: true };
}

async function releaseSellerTransfers({ admin, stripe, orderId }) {
  const firestore = admin.firestore();
  const orderRef = firestore.collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) {
    const error = new Error('Order not found.');
    error.statusCode = 404;
    throw error;
  }
  const order = snap.data() || {};
  if (order.transfersReleased === true) {
    return { orderId, duplicate: true };
  }
  if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'escrow') {
    const error = new Error('Order is not paid.');
    error.statusCode = 409;
    throw error;
  }

  const shipments = Array.isArray(order.shipments) ? order.shipments : [];
  const transferIds = [];
  let sourceTransaction = String(order.stripeChargeId || '').trim();
  if (!sourceTransaction && order.stripePaymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(String(order.stripePaymentIntentId), {
      expand: ['latest_charge'],
    });
    const latest = pi.latest_charge;
    sourceTransaction = typeof latest === 'string' ? latest : String(latest?.id || '');
  }

  for (const shipment of shipments) {
    const amount = Number(shipment.sellerTransferCents) || 0;
    const account = String(shipment.stripeConnectAccountId || '');
    if (amount < 1 || !account) continue;
    const body = {
      amount,
      currency: 'eur',
      destination: account,
      transfer_group: orderId,
      metadata: {
        pokoinOrderId: orderId,
        sellerId: String(shipment.sellerId || ''),
      },
    };
    // Tie each seller Transfer to the single Checkout charge (Stripe Separate Charges and Transfers).
    if (sourceTransaction) body.source_transaction = sourceTransaction;
    const transfer = await stripe.transfers.create(body, {
      idempotencyKey: `pokoin-transfer-${orderId}-${shipment.sellerId}`,
    });
    transferIds.push(transfer.id);
  }

  await orderRef.set({
    transfersReleased: true,
    transferIds,
    escrowReleasedAt: admin.firestore.FieldValue.serverTimestamp(),
    paymentStatus: 'released',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { orderId, transferIds, duplicate: false };
}

module.exports = {
  handleMarketplaceOrderPaid,
  releaseSellerTransfers,
};
