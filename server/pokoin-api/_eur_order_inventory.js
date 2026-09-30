'use strict';

/**
 * Inventory lifecycle for EUR (Stripe Checkout) marketplace orders.
 *
 *   create session  → reserve: marketplace_user_listings qty-- / sold_out (same
 *                     SQL as the PKN path), order.inventory.state = reserved
 *   paid webhook    → commit the hold, then the PKN fulfilment pieces once:
 *                     seller ownership, linked CardTrader decrement,
 *                     CardTrader buy-through, seller emails, native sale rows
 *   expired/cancel  → release: put the quantity back, order cancelled/expired
 *
 * The Postgres decrement happens before Stripe is opened, so a listing can
 * never be paid for twice. Every step is idempotent on the order doc so
 * Stripe retries and the sweeper can re-run it safely.
 */

const CHECKOUT_HOLD_SECONDS = 31 * 60; // Stripe minimum expires_at is 30 minutes.
const STALE_PENDING_MS = 35 * 60 * 1000;
const FULFILLMENT_LEASE_MS = 10 * 60 * 1000;

const PAID_STATUSES = new Set(['paid', 'escrow', 'released', 'partially_refunded']);
// A hold may only be released while the buyer has not paid.
const RELEASABLE_STATUSES = new Set(['pending_stripe', 'expired', 'cancelled', 'failed']);

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function msFrom(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function defaultDeps() {
  // Lazy: marketplace-orders pulls Firebase/Postgres helpers that only exist
  // inside the API image. Tests inject their own deps.
  const orders = require('./marketplace-orders');
  const { sendSellerSaleNotificationsForPaidOrder } = require('./_marketplace_sale_notifications');
  const { recordNativeSales } = require('./_native_sales');
  return {
    ...orders.fulfillment,
    sendSellerSaleNotificationsForPaidOrder,
    recordNativeSales,
  };
}

function withDeps(deps) {
  return deps || defaultDeps();
}

/** Firestore-safe copy of one decremented listing (no undefined). */
function inventoryLine(entry = {}) {
  return {
    listingId: cleanText(entry.listingId, 160),
    quantity: Number(entry.quantity) || 0,
    cardId: cleanText(entry.cardId, 120),
    sellerUid: cleanText(entry.sellerUid, 160),
    sourceListingId: cleanText(entry.sourceListingId, 160),
    source: cleanText(entry.source, 80),
    remainingQuantity: Number(entry.remainingQuantity) || 0,
    unitPricePkn: Number(entry.unitPricePkn) || 0,
    external: entry.external === true,
  };
}

/**
 * Re-price every cart row from Postgres and take the stock.
 * Throws 409 when a listing is gone or its ask changed (nothing stays held).
 */
async function reserveEurCheckoutItems({ rawItems, deps }) {
  const d = withDeps(deps);
  const raw = Array.isArray(rawItems) ? rawItems : [];
  const items = d.normalizedItems(raw).map((item) => ({ ...item, fulfillmentMode: 'physical' }));
  if (!items.length || items.length !== raw.length) {
    throw httpError(400, 'Every cart row needs a listing, seller, quantity and price.', 'invalid_cart');
  }
  await d.verifyCardTraderLiveItems(items);
  const decremented = await d.verifyAndDecrementListings(items);
  const byListing = new Map(decremented.map((entry) => [entry.listingId, entry]));
  const priced = items.map((item) => {
    const entry = byListing.get(item.listingId) || {};
    const unit = Number(entry.unitPricePkn) || item.unitPricePkn;
    return {
      ...item,
      card: { ...item.card, id: cleanText(entry.cardId || item.card?.id, 120) },
      unitPricePkn: unit,
      totalPricePkn: unit * item.quantity,
    };
  });
  return { items: priced, lines: decremented.map(inventoryLine) };
}

/** Undo a reservation that never reached Firestore (session create failed). */
async function rollbackReservation({ lines, deps }) {
  const d = withDeps(deps);
  const held = (lines || []).filter((line) => !line.external);
  if (!held.length) return;
  await d.restoreListingQuantities(held).catch((error) => {
    console.error('eur checkout reservation rollback failed', error);
  });
}

/**
 * Put held stock back and close the unpaid order. Never touches a paid order.
 * Idempotent: the Firestore transaction flips inventory.state exactly once.
 */
async function releaseEurReservation({
  admin,
  firestore,
  orderId,
  reason = 'expired',
  paymentStatus = 'expired',
  extraReleasable = [],
  deps,
  now = Date.now(),
}) {
  const ref = firestore.collection('orders').doc(orderId);
  const releasable = new Set([...RELEASABLE_STATUSES, ...extraReleasable]);
  const stamp = admin.firestore.FieldValue.serverTimestamp();
  let lines = null;
  let outcome = 'noop';
  let heldPkn = 0;
  let buyerUid = '';
  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      outcome = 'missing';
      return;
    }
    const order = snap.data() || {};
    if (!releasable.has(cleanText(order.paymentStatus, 40))) {
      outcome = 'not_releasable';
      return;
    }
    const inventory = order.inventory || {};
    const next = {
      paymentStatus,
      status: 'cancelled',
      fulfillmentStatus: 'cancelled',
      cancelReason: cleanText(reason, 80),
      cancelledAt: stamp,
      updatedAt: stamp,
    };
    if (inventory.state === 'reserved') {
      lines = Array.isArray(inventory.lines) ? inventory.lines : [];
      next.inventory = {
        ...inventory,
        state: 'released',
        releasedAt: nowIso(now),
        releaseReason: cleanText(reason, 80),
      };
    }
    // A held PKN balance discount goes back to the buyer's balance.
    if (order.pknDiscount && order.pknDiscount.state === 'held' && Number(order.pknDiscount.pkn) > 0) {
      next.pknDiscount = {
        ...order.pknDiscount,
        state: 'released',
        releasedAt: nowIso(now),
      };
      heldPkn = Math.trunc(Number(order.pknDiscount.pkn)) || 0;
      buyerUid = cleanText(order.buyerUid, 160);
    }
    outcome = lines ? 'released' : 'closed';
    transaction.set(ref, next, { merge: true });
  });
  if (heldPkn > 0 && buyerUid) {
    try {
      await firestore.collection('balances').doc(buyerUid).update({
        availablePkn: admin.firestore.FieldValue.increment(heldPkn),
        updatedAt: stamp,
      });
    } catch (error) {
      // The order already says released — ops can re-credit from pknDiscount.pkn.
      await ref.set({
        pknDiscount: { restoreError: cleanText(error.message, 500) },
        updatedAt: stamp,
      }, { merge: true }).catch(() => {});
      console.error('pkn discount release failed', { orderId, heldPkn, message: error.message });
    }
  }
  if (lines && lines.length) {
    const d = withDeps(deps);
    try {
      await d.restoreListingQuantities(lines.filter((line) => !line.external));
    } catch (error) {
      await ref.set({
        inventory: { restoreError: cleanText(error.message, 500) },
        updatedAt: stamp,
      }, { merge: true }).catch(() => {});
      throw error;
    }
  }
  return { orderId, outcome, lines: lines ? lines.length : 0 };
}

async function markStep(ref, admin, patch) {
  await ref.set({
    fulfillment: patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Commit the hold and run PKN-path fulfilment once for a paid EUR order.
 * Each step records itself on order.fulfillment so a retry resumes.
 */
async function fulfillPaidEurOrder({
  admin,
  firestore,
  orderId,
  deps,
  now = Date.now(),
}) {
  const d = withDeps(deps);
  const ref = firestore.collection('orders').doc(orderId);
  const stamp = admin.firestore.FieldValue.serverTimestamp();
  let order = null;
  let skip = '';
  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      skip = 'missing';
      return;
    }
    order = snap.data() || {};
    if (!PAID_STATUSES.has(cleanText(order.paymentStatus, 40))) {
      skip = 'not_paid';
      return;
    }
    const fulfillment = order.fulfillment || {};
    if (fulfillment.state === 'done' || fulfillment.state === 'conflict') {
      skip = 'done';
      return;
    }
    if (fulfillment.state === 'running' && now - msFrom(fulfillment.startedAt) < FULFILLMENT_LEASE_MS) {
      skip = 'running';
      return;
    }
    transaction.set(ref, {
      fulfillment: { ...fulfillment, state: 'running', startedAt: nowIso(now) },
      updatedAt: stamp,
    }, { merge: true });
  });
  if (skip) return { orderId, skipped: skip };

  const fulfillment = order.fulfillment || {};
  let inventory = order.inventory || {};

  // 1. Commit the stock. A hold that was already released (or a legacy order
  //    with no hold) must take the stock again, or it is flagged for refund.
  if (inventory.state !== 'committed') {
    if (inventory.state !== 'reserved') {
      try {
        const retaken = await reserveEurCheckoutItems({ rawItems: order.items || [], deps: d });
        inventory = { ...inventory, lines: retaken.lines, retakenAt: nowIso(now) };
      } catch (error) {
        await ref.set({
          inventory: { ...inventory, state: 'conflict', conflictError: cleanText(error.message, 500) },
          fulfillment: { ...fulfillment, state: 'conflict', finishedAt: nowIso(now) },
          fulfillmentStatus: 'needs_refund',
          updatedAt: stamp,
        }, { merge: true });
        console.error('eur order paid but stock is gone', { orderId, message: error.message });
        return { orderId, conflict: true };
      }
    }
    inventory = { ...inventory, state: 'committed', committedAt: nowIso(now) };
    await ref.set({ inventory, updatedAt: stamp }, { merge: true });
  }

  const lines = (Array.isArray(inventory.lines) ? inventory.lines : []).filter((line) => !line.external);
  const steps = { ...(fulfillment.steps || {}) };
  const ownershipDone = new Set(fulfillment.ownershipDone || []);
  const cardTraderDone = new Set(fulfillment.cardTraderDone || []);
  const failures = [];

  // 2. Seller no longer owns the sold quantity (per line so retries never double-decrement).
  for (const line of lines) {
    if (ownershipDone.has(line.listingId)) continue;
    const result = await d.syncSellerOwnershipAfterPhysicalSale({ admin, firestore, decremented: [line] })
      .catch((error) => ({ ok: false, error: error.message }));
    if (result?.ok === false) failures.push(`ownership:${line.listingId}`);
    else ownershipDone.add(line.listingId);
  }
  // 3. Linked CardTrader product loses the same quantity.
  for (const line of lines) {
    if (cardTraderDone.has(line.listingId)) continue;
    const result = await d.syncCardTraderAfterPokoinSale({ admin, firestore, decremented: [line] })
      .catch((error) => ({ ok: false, error: error.message }));
    if (result?.ok === false) failures.push(`cardtrader_sync:${line.listingId}`);
    else cardTraderDone.add(line.listingId);
  }
  await markStep(ref, admin, {
    ...fulfillment,
    state: 'running',
    ownershipDone: [...ownershipDone],
    cardTraderDone: [...cardTraderDone],
    steps,
  });

  const orderData = { ...order, paymentStatus: order.paymentStatus || 'paid' };

  // 4. CardTrader buy-through for live CT rows (own per-product markers).
  if (steps.cardTraderBuy !== 'done') {
    const result = await d.buyCardTraderItemsForPaidOrder({ admin, firestore, orderId, orderData })
      .catch((error) => ({ ok: false, error: error.message }));
    if (result?.ok === false) failures.push('cardtrader_buy');
    else steps.cardTraderBuy = 'done';
  }
  // 5. Seller sale emails (own claim markers).
  if (steps.notifications !== 'done') {
    const result = await d.sendSellerSaleNotificationsForPaidOrder({ admin, firestore, orderId, orderData })
      .catch((error) => ({ ok: false, error: error.message }));
    if (result?.ok === false) failures.push('notifications');
    else steps.notifications = 'done';
  }
  // 6. Native sold history rows (doc id per order line → idempotent).
  if (steps.sales !== 'done') {
    const result = await d.recordNativeSales({ admin, firestore, orderId, order: orderData })
      .catch((error) => ({ ok: false, error: error.message }));
    if (result?.ok === false) failures.push('sales');
    else steps.sales = 'done';
  }

  const done = failures.length === 0;
  await ref.set({
    fulfillment: {
      ...fulfillment,
      state: done ? 'done' : 'partial',
      ownershipDone: [...ownershipDone],
      cardTraderDone: [...cardTraderDone],
      steps,
      failures,
      finishedAt: nowIso(now),
    },
    ...(order.fulfillmentStatus === 'pending' || !order.fulfillmentStatus
      ? { fulfillmentStatus: 'awaiting_shipment' }
      : {}),
    updatedAt: stamp,
  }, { merge: true });
  return { orderId, done, failures };
}

function sessionIsPaid(session = {}) {
  return session.status === 'complete' && session.payment_status !== 'unpaid';
}

/**
 * Buyer came back from Stripe with Cancel (or pressed Cancel on Orders):
 * close the Stripe session first so it can never be paid, then release.
 */
async function cancelPendingEurOrder({
  admin,
  firestore,
  stripe,
  orderId,
  uid,
  deps,
  onPaid,
}) {
  const ref = firestore.collection('orders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Marketplace order was not found.');
  const order = snap.data() || {};
  if (order.uid !== uid && order.buyerUid !== uid) {
    throw httpError(403, 'You cannot cancel this order.');
  }
  if (PAID_STATUSES.has(order.paymentStatus)) {
    throw httpError(409, 'This order is already paid.', 'already_paid');
  }
  if (order.paymentStatus !== 'pending_stripe') {
    return { orderId, outcome: 'already_closed', paymentStatus: order.paymentStatus };
  }
  const sessionId = cleanText(order.stripeCheckoutSessionId, 200);
  if (sessionId) {
    try {
      await stripe.checkout.sessions.expire(sessionId);
    } catch (error) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (sessionIsPaid(session)) {
        if (onPaid) await onPaid(session);
        throw httpError(409, 'Stripe already took this payment — the order is paid.', 'already_paid');
      }
      if (session.status !== 'expired') throw error;
    }
  }
  return releaseEurReservation({
    admin,
    firestore,
    orderId,
    reason: 'cancelled_by_buyer',
    paymentStatus: 'cancelled',
    deps,
  });
}

/**
 * Safety net (timer): close stale pending_stripe orders, recover paid
 * sessions whose webhook was missed, and resume partial fulfilment.
 */
async function sweepEurOrders({
  admin,
  firestore,
  stripe,
  deps,
  onPaid,
  now = Date.now(),
  staleMs = STALE_PENDING_MS,
  dryRun = false,
  log = console,
}) {
  const results = [];
  const pending = await firestore.collection('orders').where('paymentStatus', '==', 'pending_stripe').get();
  for (const doc of pending.docs) {
    const order = doc.data() || {};
    const orderId = doc.id;
    const holdEnds = msFrom(order.inventory?.expiresAt);
    const created = msFrom(order.createdAt);
    const stale = (holdEnds && now > holdEnds) || (created && now - created > staleMs);
    if (!stale) continue;
    const row = { orderId, action: 'none' };
    try {
      const sessionId = cleanText(order.stripeCheckoutSessionId, 200);
      if (!sessionId) {
        row.action = 'release_no_session';
        if (!dryRun) {
          await releaseEurReservation({ admin, firestore, orderId, reason: 'session_missing', deps, now });
        }
      } else {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (sessionIsPaid(session)) {
          row.action = 'recover_paid';
          if (!dryRun && onPaid) await onPaid(session);
        } else if (session.status === 'complete') {
          row.action = 'processing';
        } else if (
          session.status === 'open'
          && now < Number(session.expires_at || 0) * 1000
          && order.inventory?.state === 'reserved'
        ) {
          row.action = 'still_open';
        } else {
          // Expired, or a legacy session (pre-hold, Stripe's 24h default) that
          // could still be paid while its cards stay on sale to everyone else.
          row.action = 'release_expired';
          if (!dryRun) {
            if (session.status === 'open') await stripe.checkout.sessions.expire(sessionId);
            await releaseEurReservation({ admin, firestore, orderId, reason: 'expired', deps, now });
          }
        }
      }
    } catch (error) {
      row.action = 'error';
      row.error = cleanText(error.message, 300);
    }
    results.push(row);
    log.log('eur order sweep', row);
  }

  const unfinished = await firestore.collection('orders')
    .where('fulfillment.state', 'in', ['running', 'partial'])
    .get();
  for (const doc of unfinished.docs) {
    const row = { orderId: doc.id, action: 'resume_fulfillment' };
    if (!dryRun) {
      const result = await fulfillPaidEurOrder({ admin, firestore, orderId: doc.id, deps, now })
        .catch((error) => ({ error: error.message }));
      Object.assign(row, result);
    }
    results.push(row);
    log.log('eur order sweep', row);
  }
  return {
    ok: results.every((row) => row.action !== 'error' && !row.error),
    results,
  };
}

module.exports = {
  CHECKOUT_HOLD_SECONDS,
  FULFILLMENT_LEASE_MS,
  PAID_STATUSES,
  STALE_PENDING_MS,
  cancelPendingEurOrder,
  fulfillPaidEurOrder,
  inventoryLine,
  releaseEurReservation,
  reserveEurCheckoutItems,
  rollbackReservation,
  sessionIsPaid,
  sweepEurOrders,
};
