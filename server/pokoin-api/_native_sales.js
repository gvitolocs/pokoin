'use strict';

/**
 * Native Pokoin sales (PKN escrow + EUR Stripe orders).
 *
 * Firestore `marketplace_sales/{orderId}__{listingId}` is one row per paid
 * order line. It is written server-side only when an order becomes paid and is
 * the public "Sold on Pokoin" history for a card desk. It is not the
 * CardTrader inferred_sale comp book (that stays in Postgres).
 *
 * Seller sold history and refunds read the authoritative `orders` doc.
 */

const SALES_COLLECTION = 'marketplace_sales';

// Payment states where the buyer's money is committed to the order.
const SOLD_PAYMENT_STATUSES = new Set(['paid', 'escrow', 'released', 'partially_refunded']);

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function isEurOrder(order = {}) {
  return order.currency === 'EUR' || order.paymentMethod === 'stripe';
}

function orderIsSold(order = {}) {
  return SOLD_PAYMENT_STATUSES.has(cleanText(order.paymentStatus, 40));
}

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function itemQuantity(item = {}) {
  const quantity = Number(item.quantity ?? item.qty ?? 0);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

function itemCardId(item = {}) {
  const card = item.card && typeof item.card === 'object' ? item.card : {};
  return cleanText(item.cardId || card.id, 120);
}

function saleDocId(orderId, listingId) {
  return `${cleanText(orderId, 160)}__${cleanText(listingId, 160)}`.replace(/\//g, '_');
}

/** Public-safe sale rows for one paid order (never buyer identity). */
function saleDocsFromOrder(orderId, order = {}) {
  const eur = isEurOrder(order);
  const rows = [];
  for (const item of Array.isArray(order.items) ? order.items : []) {
    const listingId = cleanText(item.listingId, 160);
    const cardId = itemCardId(item);
    const quantity = itemQuantity(item);
    if (!listingId || !cardId || quantity < 1) continue;
    const card = item.card && typeof item.card === 'object' ? item.card : {};
    rows.push({
      id: saleDocId(orderId, listingId),
      data: {
        orderId: cleanText(orderId, 160),
        listingId,
        cardId,
        cardName: cleanText(card.name || item.cardName, 240),
        sellerUid: cleanText(item.sellerUid, 160),
        sellerName: cleanText(item.sellerName, 120),
        condition: cleanText(item.condition, 40),
        language: cleanText(item.language, 20),
        quantity,
        unitPricePkn: numberValue(item.unitPricePkn),
        ...(eur ? { unitPriceEURCents: Math.round(numberValue(item.unitPriceEURCents)) } : {}),
        currency: eur ? 'EUR' : 'PKN',
        source: 'pokoin',
        fulfillmentMode: cleanText(item.fulfillmentMode || order.fulfillmentMode, 40) || 'physical',
        voided: false,
      },
    });
  }
  return rows;
}

async function recordNativeSales({ admin, firestore, orderId, order }) {
  const rows = saleDocsFromOrder(orderId, order);
  if (!rows.length) return { ok: true, written: 0 };
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = firestore.batch();
  for (const row of rows) {
    batch.set(firestore.collection(SALES_COLLECTION).doc(row.id), {
      ...row.data,
      soldAt: now,
      updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();
  return { ok: true, written: rows.length };
}

const CT_CONDITION_CODES = {
  mint: 'M',
  'near mint': 'NM',
  'slightly played': 'SP',
  'moderately played': 'MP',
  played: 'PL',
  'heavily played': 'HP',
  poor: 'PO',
};

function cardTraderConditionCode(value) {
  const text = cleanText(value, 40);
  return CT_CONDITION_CODES[text.toLowerCase()] || text;
}

/**
 * A real CardTrader sale of a linked Pokoin listing (seller order item),
 * keyed by CardTrader order + order item so webhook and backfill agree.
 */
function cardTraderSaleDoc({ sellerUid, order = {}, item = {}, listing = {} }) {
  const orderId = cleanText(order.id, 40);
  const orderItemId = cleanText(item.id, 40);
  const properties = item.properties && typeof item.properties === 'object' ? item.properties : {};
  const soldAt = toIso(item.created_at) || toIso(order.paid_at) || new Date().toISOString();
  return {
    id: `ct_${orderId}__${orderItemId}`,
    data: {
      orderId: `ct_${orderId}`,
      listingId: cleanText(listing.id, 160),
      cardId: cleanText(listing.card_id, 120),
      cardName: cleanText(item.name, 240),
      sellerUid: cleanText(sellerUid, 160),
      condition: cardTraderConditionCode(properties.condition),
      language: cleanText(properties.pokemon_language || properties.language, 20).toUpperCase(),
      quantity: itemQuantity(item) || 1,
      unitPriceEURCents: Math.round(numberValue(item.seller_price?.cents)),
      currency: 'EUR',
      source: 'cardtrader',
      ctOrderId: orderId,
      ctOrderCode: cleanText(order.code, 40),
      ctOrderItemId: orderItemId,
      ctProductId: cleanText(item.product_id, 40),
      ctOrderState: cleanText(order.state, 40),
      soldAt,
      voided: false,
    },
  };
}

async function recordCardTraderSale({ admin, firestore, sellerUid, order, item, listing }) {
  const row = cardTraderSaleDoc({ sellerUid, order, item, listing });
  await firestore.collection(SALES_COLLECTION).doc(row.id).set({
    ...row.data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, id: row.id };
}

/** Void sale rows so a refunded parcel stops counting as sold. */
async function voidNativeSales({ admin, firestore, orderId, sellerUid = '', reason = '' }) {
  const snap = await firestore.collection(SALES_COLLECTION).where('orderId', '==', orderId).get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  let voided = 0;
  const batch = firestore.batch();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (sellerUid && data.sellerUid !== sellerUid) continue;
    batch.set(doc.ref, { voided: true, voidReason: cleanText(reason, 80), updatedAt: now }, { merge: true });
    voided += 1;
  }
  if (voided) await batch.commit();
  return { ok: true, voided };
}

/** Desk row: date, condition, language, qty, price — no buyer, no order id. */
function publicSaleRow(data = {}) {
  return {
    soldAt: toIso(data.soldAt),
    condition: cleanText(data.condition, 40),
    language: cleanText(data.language, 20),
    quantity: itemQuantity(data),
    unitPricePkn: numberValue(data.unitPricePkn),
    currency: data.currency === 'EUR' ? 'EUR' : 'PKN',
    ...(data.currency === 'EUR' ? { unitPriceEURCents: Math.round(numberValue(data.unitPriceEURCents)) } : {}),
    sellerName: cleanText(data.sellerName, 120),
    source: data.source === 'cardtrader' ? 'cardtrader' : 'pokoin',
  };
}

/** Seller-facing CardTrader sale (refunds happen on CardTrader, not here). */
function sellerCardTraderRow(id, data = {}) {
  return {
    orderId: cleanText(data.orderId, 160) || id,
    source: 'cardtrader',
    currency: 'EUR',
    paymentStatus: data.voided ? 'cancelled' : 'paid',
    fulfillmentStatus: cleanText(data.ctOrderState, 40),
    ctOrderCode: cleanText(data.ctOrderCode, 40),
    soldAt: toIso(data.soldAt),
    items: [{
      listingId: cleanText(data.listingId, 160),
      cardId: cleanText(data.cardId, 120),
      cardName: cleanText(data.cardName, 240),
      condition: cleanText(data.condition, 40),
      language: cleanText(data.language, 20),
      quantity: itemQuantity(data),
      unitPriceEURCents: Math.round(numberValue(data.unitPriceEURCents)),
    }],
    shippingCents: 0,
    gross: Math.round(numberValue(data.unitPriceEURCents) * (itemQuantity(data) || 1)),
    refunded: 0,
    refundable: 0,
    refunds: [],
  };
}

function sortBySoldAtDesc(rows) {
  return [...rows].sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || '')));
}

// ---------------------------------------------------------------------------
// Seller share + partial refunds
// ---------------------------------------------------------------------------

function sellerItems(order = {}, sellerUid) {
  return (Array.isArray(order.items) ? order.items : [])
    .filter((item) => cleanText(item.sellerUid, 160) === sellerUid);
}

function sellerShipment(order = {}, sellerUid) {
  return (Array.isArray(order.shipments) ? order.shipments : [])
    .find((row) => cleanText(row.sellerId, 160) === sellerUid) || null;
}

function refundsForSeller(order = {}, sellerUid) {
  return (Array.isArray(order.refunds) ? order.refunds : [])
    .filter((row) => cleanText(row.sellerUid, 160) === sellerUid && row.status !== 'failed');
}

/**
 * What the seller can still hand back on this order.
 * EUR: their parcel (items + shipping) in cents. PKN: their item total in PKN.
 */
function sellerShare(order = {}, sellerUid) {
  const uid = cleanText(sellerUid, 160);
  const eur = isEurOrder(order);
  const items = sellerItems(order, uid);
  const refunded = refundsForSeller(order, uid)
    .reduce((sum, row) => sum + numberValue(row.amount), 0);
  let gross = 0;
  if (eur) {
    const shipment = sellerShipment(order, uid);
    gross = shipment
      ? Math.round(numberValue(shipment.itemsSubtotalCents) + numberValue(shipment.shippingAmountEURCents))
      : items.reduce((sum, item) => sum + Math.round(numberValue(item.unitPriceEURCents) * itemQuantity(item)), 0);
  } else {
    gross = items.reduce((sum, item) => {
      const explicit = numberValue(item.totalPricePkn, NaN);
      return sum + (Number.isFinite(explicit) && explicit > 0
        ? explicit
        : numberValue(item.unitPricePkn) * itemQuantity(item));
    }, 0);
  }
  return {
    sellerUid: uid,
    currency: eur ? 'EUR' : 'PKN',
    unit: eur ? 'cents' : 'pkn',
    gross,
    refunded,
    refundable: Math.max(0, gross - refunded),
    items,
  };
}

function assertRefundable(order = {}, sellerUid, rawAmount) {
  if (!orderIsSold(order)) {
    throw httpError(409, 'Only paid orders can be refunded.', 'order_not_paid');
  }
  if (!sellerItems(order, sellerUid).length) {
    throw httpError(403, 'You did not sell anything on this order.', 'not_seller');
  }
  const share = sellerShare(order, sellerUid);
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw httpError(400, share.currency === 'EUR'
      ? 'Refund amount must be at least 1 cent.'
      : 'Refund amount must be a whole PKN amount.', 'invalid_amount');
  }
  if (amount > share.refundable) {
    throw httpError(409, 'Refund is larger than what is left of your share of this order.', 'refund_too_large');
  }
  return { amount, share };
}

/** Seller-facing sold history row for one order (their lines only). */
function sellerHistoryRow(orderId, order = {}, sellerUid) {
  const share = sellerShare(order, sellerUid);
  const shipment = sellerShipment(order, sellerUid);
  return {
    orderId,
    currency: share.currency,
    paymentStatus: cleanText(order.paymentStatus, 40),
    fulfillmentStatus: cleanText(order.fulfillmentStatus, 40),
    disputeStatus: cleanText(order.disputeStatus, 40),
    soldAt: toIso(order.paidAt || order.createdAt),
    shippedAt: toIso(order.shippedAt),
    trackingCode: cleanText(order.trackingCode, 80),
    items: share.items.map((item) => ({
      listingId: cleanText(item.listingId, 160),
      cardId: itemCardId(item),
      cardName: cleanText(item.card?.name || item.cardName, 240),
      condition: cleanText(item.condition, 40),
      language: cleanText(item.language, 20),
      quantity: itemQuantity(item),
      unitPricePkn: numberValue(item.unitPricePkn),
      ...(share.currency === 'EUR' ? { unitPriceEURCents: Math.round(numberValue(item.unitPriceEURCents)) } : {}),
    })),
    shippingCents: shipment ? Math.round(numberValue(shipment.shippingAmountEURCents)) : 0,
    gross: share.gross,
    refunded: share.refunded,
    refundable: share.refundable,
    refunds: refundsForSeller(order, sellerUid).map((row) => ({
      amount: numberValue(row.amount),
      reason: cleanText(row.reason, 240),
      status: cleanText(row.status, 40),
      createdAt: toIso(row.createdAt),
    })),
  };
}

module.exports = {
  SALES_COLLECTION,
  SOLD_PAYMENT_STATUSES,
  assertRefundable,
  cardTraderConditionCode,
  cardTraderSaleDoc,
  isEurOrder,
  orderIsSold,
  publicSaleRow,
  recordCardTraderSale,
  recordNativeSales,
  refundsForSeller,
  saleDocId,
  saleDocsFromOrder,
  sellerCardTraderRow,
  sellerHistoryRow,
  sellerShare,
  sellerShipment,
  sortBySoldAtDesc,
  toIso,
  voidNativeSales,
};
