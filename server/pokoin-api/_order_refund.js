'use strict';

/**
 * Seller-initiated partial refunds from the sold history.
 *
 * A seller can hand back any whole amount up to what is left of their share
 * of one order (EUR: their parcel items + shipping, in cents; PKN: their item
 * total). The cap is reserved inside a Firestore transaction, so two clicks
 * or two tabs can never refund more than the share.
 *
 * PKN  escrow   → buyer balance +amount (escrow pays the seller less later)
 *      released → seller balance −amount, buyer +amount (needs seller balance)
 * EUR           → Stripe refund on the order PaymentIntent. Before the seller
 *                 Transfer: that parcel's transfer shrinks. After it: the
 *                 Transfer is reversed by the same amount.
 */

const { assertRefundable, isEurOrder, sellerShare, voidNativeSales } = require('./_native_sales');

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanClientToken(value) {
  const text = cleanText(value, 80);
  return /^[A-Za-z0-9_-]{8,80}$/.test(text) ? text : '';
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function patchRefund(refunds, refundId, patch) {
  return refunds.map((row) => (row.id === refundId ? { ...row, ...patch } : row));
}

async function findSellerTransfer({ stripe, order, orderId, sellerUid }) {
  const known = order.transfersBySeller && order.transfersBySeller[sellerUid];
  if (known) return stripe.transfers.retrieve(String(known));
  if (!Array.isArray(order.transferIds) || !order.transferIds.length) return null;
  const list = await stripe.transfers.list({ transfer_group: orderId, limit: 100 });
  return (list.data || []).find((row) => row.metadata?.sellerId === sellerUid) || null;
}

async function refundSellerShare({
  admin,
  firestore,
  stripe,
  orderId,
  sellerUid,
  amount,
  reason,
  clientToken,
  now = Date.now(),
}) {
  const token = cleanClientToken(clientToken);
  if (!token) throw httpError(400, 'Refund needs a client token.', 'client_token_required');
  const ref = firestore.collection('orders').doc(orderId);
  const stamp = admin.firestore.FieldValue.serverTimestamp();
  const increment = admin.firestore.FieldValue.increment;
  const refundId = `rf_${token}`;

  let order = null;
  let refund = null;
  let duplicate = false;
  let share = null;

  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw httpError(404, 'Marketplace order was not found.');
    order = snap.data() || {};
    const refunds = Array.isArray(order.refunds) ? order.refunds : [];
    const existing = refunds.find((row) => row.id === refundId);
    if (existing) {
      duplicate = true;
      refund = existing;
      return;
    }
    const checked = assertRefundable(order, sellerUid, amount);
    share = checked.share;
    const eur = isEurOrder(order);
    const buyerUid = cleanText(order.buyerUid || order.uid, 160);
    refund = {
      id: refundId,
      sellerUid,
      amount: checked.amount,
      currency: share.currency,
      reason: cleanText(reason, 240),
      status: eur ? 'pending' : 'succeeded',
      clientToken: token,
      createdAt: new Date(now).toISOString(),
    };

    const next = { refunds: [...refunds, refund], updatedAt: stamp };
    if (!eur) {
      const escrow = order.paymentStatus === 'escrow';
      const sellerBalanceRef = firestore.collection('balances').doc(sellerUid);
      if (!escrow) {
        // Seller already got paid: the refund comes out of their balance.
        const sellerBalance = await transaction.get(sellerBalanceRef);
        if (numberValue(sellerBalance.data()?.availablePkn) < checked.amount) {
          throw httpError(409, 'Your PKN balance is too low to refund this amount.', 'seller_balance_low');
        }
        transaction.set(sellerBalanceRef, {
          availablePkn: increment(-checked.amount),
          updatedAt: stamp,
        }, { merge: true });
        transaction.set(firestore.collection('ledger_entries').doc(), {
          uid: sellerUid,
          type: 'marketplace_sale_refund',
          amountPkn: -checked.amount,
          orderId,
          buyerUid,
          createdAt: stamp,
        });
      }
      transaction.set(firestore.collection('balances').doc(buyerUid), {
        availablePkn: increment(checked.amount),
        updatedAt: stamp,
      }, { merge: true });
      transaction.set(firestore.collection('ledger_entries').doc(), {
        uid: buyerUid,
        type: 'marketplace_order_refund',
        amountPkn: checked.amount,
        orderId,
        sellerUid,
        createdAt: stamp,
      });
      next.refundsBySeller = { [sellerUid]: numberValue(order.refundsBySeller?.[sellerUid]) + checked.amount };
      next.refundedTotal = numberValue(order.refundedTotal) + checked.amount;
    }
    transaction.set(ref, next, { merge: true });
  });

  if (duplicate) return { orderId, duplicate: true, refund };

  if (isEurOrder(order)) {
    const paymentIntent = cleanText(order.stripePaymentIntentId, 200);
    let stripeRefund = null;
    try {
      if (!paymentIntent) throw httpError(409, 'This EUR order has no Stripe payment to refund.', 'no_payment_intent');
      stripeRefund = await stripe.refunds.create({
        payment_intent: paymentIntent,
        amount: refund.amount,
        reason: 'requested_by_customer',
        metadata: { pokoinOrderId: orderId, sellerId: sellerUid, pokoinRefundId: refundId },
      }, { idempotencyKey: `pokoin-refund-${orderId}-${refundId}` });
    } catch (error) {
      await firestore.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const refunds = Array.isArray(snap.data()?.refunds) ? snap.data().refunds : [];
        transaction.set(ref, {
          refunds: patchRefund(refunds, refundId, { status: 'failed', error: cleanText(error.message, 300) }),
          updatedAt: stamp,
        }, { merge: true });
      });
      throw httpError(error.statusCode || 502, `Stripe refund failed: ${error.message}`, 'stripe_refund_failed');
    }

    // Seller settlement follows the refund.
    let reversal = null;
    let reversalError = '';
    const transfer = await findSellerTransfer({ stripe, order, orderId, sellerUid }).catch(() => null);
    if (transfer) {
      const reversible = Math.max(0, numberValue(transfer.amount) - numberValue(transfer.amount_reversed));
      const reverseAmount = Math.min(refund.amount, reversible);
      if (reverseAmount > 0) {
        try {
          reversal = await stripe.transfers.createReversal(transfer.id, {
            amount: reverseAmount,
            metadata: { pokoinOrderId: orderId, pokoinRefundId: refundId },
          }, { idempotencyKey: `pokoin-reversal-${orderId}-${refundId}` });
        } catch (error) {
          reversalError = cleanText(error.message, 300);
          console.error('eur refund transfer reversal failed', { orderId, sellerUid, message: error.message });
        }
      }
    }

    await firestore.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const data = snap.data() || {};
      const refunds = Array.isArray(data.refunds) ? data.refunds : [];
      const shipments = Array.isArray(data.shipments) ? data.shipments : [];
      transaction.set(ref, {
        refunds: patchRefund(refunds, refundId, {
          status: 'succeeded',
          stripeRefundId: stripeRefund.id,
          ...(reversal ? { transferReversalId: reversal.id } : {}),
          ...(reversalError ? { transferReversalError: reversalError } : {}),
        }),
        // Not transferred yet → the seller's later Transfer is smaller.
        shipments: transfer ? shipments : shipments.map((row) => (
          cleanText(row.sellerId, 160) === sellerUid
            ? { ...row, refundedCents: numberValue(row.refundedCents) + refund.amount }
            : row
        )),
        refundsBySeller: { [sellerUid]: numberValue(data.refundsBySeller?.[sellerUid]) + refund.amount },
        refundedTotal: numberValue(data.refundedTotal) + refund.amount,
        updatedAt: stamp,
      }, { merge: true });
    });
    refund = { ...refund, status: 'succeeded', stripeRefundId: stripeRefund.id };
  }

  // Whole seller share handed back → those lines stop counting as sold.
  const after = sellerShare({
    ...order,
    refunds: [...(Array.isArray(order.refunds) ? order.refunds : []), refund],
  }, sellerUid);
  if (after.refundable <= 0) {
    await voidNativeSales({ admin, firestore, orderId, sellerUid, reason: 'seller_refunded' }).catch((error) => {
      console.error('native sale void after refund failed', error);
    });
  }
  return { orderId, duplicate: false, refund, refundable: after.refundable, currency: after.currency };
}

module.exports = {
  cleanClientToken,
  refundSellerShare,
};
