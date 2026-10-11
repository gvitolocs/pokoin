// Row helpers and live order reads for /orders, /bought and /sales, shared by
// the React and Solid pages. Status rules live in order-status.js.

import { formatPkn } from './api.js';
import { formatOrderMoney, isEurOrder } from './order-status.js';

/** YYYY-MM-DD from a Firestore Timestamp, {seconds}, ISO string or ms ('' when unknown). */
export function orderStamp(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString().slice(0, 10);
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString().slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

/** Newest first. */
export function sortOrdersByDate(rows) {
  return [...(rows || [])].sort((a, b) => orderStamp(b.createdAt).localeCompare(orderStamp(a.createdAt)));
}

/** Bought + sold lists, one row per order id, newest first. */
export function mergeOrders(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      byId.set(row.id, row);
    }
  }
  return sortOrdersByDate([...byId.values()]);
}

export function formatEurCents(cents) {
  const n = Number(cents) || 0;
  return `€${(n / 100).toFixed(2)}`;
}

/** The order total in the currency it was paid in. */
export function orderMoneyLabel(row) {
  if (isEurOrder(row)) return formatEurCents(row.totalEURCents);
  return formatPkn(row.totalPkn);
}

/** "Charizard +2", else the order id. */
export function orderItemsTitle(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const first = items[0]?.card?.name || items[0]?.cardName || '';
  if (!first) return row.id;
  const more = items.length - 1;
  return more > 0 ? `${first} +${more}` : first;
}

/** What one order row allows, from the viewer's side. */
export function orderFlags(row, uid) {
  const eur = isEurOrder(row);
  const paid = row.paymentStatus === 'paid' || row.paymentStatus === 'released';
  return {
    buyer: row.uid === uid || row.buyerUid === uid,
    seller: Array.isArray(row.sellerUids) && row.sellerUids.includes(uid),
    eur,
    escrow: row.paymentStatus === 'escrow',
    paid,
    shipped: Boolean(row.shippedAt) || row.fulfillmentStatus === 'shipped' || row.fulfillmentStatus === 'delivered',
    open: row.disputeStatus === 'open',
    refunded: Number(row.refundedTotal) || 0,
    nothingCharged: ['expired', 'cancelled', 'failed'].includes(row.paymentStatus),
  };
}

export function refundedLabel(row, refunded) {
  return refunded > 0 ? ` · ${formatOrderMoney(refunded, isEurOrder(row) ? 'EUR' : 'PKN')} refunded` : '';
}

/** Hold countdowns on unpaid EUR orders tick this often. */
export const ORDER_CLOCK_MS = 30000;

/**
 * Live Firestore `orders` for a uid: `field` is 'uid' (bought) or
 * 'sellerUids' (sold). Returns unsubscribe; Firestore loads on first use.
 */
export function watchOrders(uid, field, { onRows, onError }) {
  let cancelled = false;
  let unsubscribe = null;
  import('./firebase-client.js')
    .then(({ loadFirestore }) => loadFirestore())
    .then(({ firestore, collection, onSnapshot, query, where }) => {
      if (cancelled) return;
      const op = field === 'sellerUids' ? 'array-contains' : '==';
      unsubscribe = onSnapshot(
        query(collection(firestore, 'orders'), where(field, op, uid)),
        (snap) => onRows(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))),
        (err) => onError(err),
      );
    }, (err) => {
      if (!cancelled) onError(err);
    });
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

// --- /sales ---------------------------------------------------------------

export const SALES_SOURCES = [
  { id: 'all', label: 'All sales' },
  { id: 'pokoin', label: 'Pokoin checkout' },
  { id: 'cardtrader', label: 'CardTrader' },
];

export function saleDay(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '—';
}

export function saleTitle(row) {
  const items = row.items || [];
  const first = items[0]?.cardName || 'Card';
  return items.length > 1 ? `${first} +${items.length - 1}` : first;
}

export function saleUnitCount(row) {
  return (row.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

export function saleLineMoney(item, currency) {
  return currency === 'EUR'
    ? formatOrderMoney((Number(item.unitPriceEURCents) || 0) * (Number(item.quantity) || 1), 'EUR')
    : formatOrderMoney((Number(item.unitPricePkn) || 0) * (Number(item.quantity) || 1), 'PKN');
}

/** Sales metrics: live (not cancelled/refunded) sales, cards, EUR/PKN after refunds. */
export function salesTotals(sales) {
  const live = (sales || []).filter((row) => row.paymentStatus !== 'cancelled' && row.paymentStatus !== 'refunded');
  const eur = live.filter((row) => row.currency === 'EUR');
  const pkn = live.filter((row) => row.currency !== 'EUR');
  return {
    count: live.length,
    units: live.reduce((sum, row) => sum + saleUnitCount(row), 0),
    eurNet: eur.reduce((sum, row) => sum + (row.gross - row.refunded), 0),
    pknNet: pkn.reduce((sum, row) => sum + (row.gross - row.refunded), 0),
    eurRefunded: eur.reduce((sum, row) => sum + row.refunded, 0),
    pknRefunded: pkn.reduce((sum, row) => sum + row.refunded, 0),
  };
}

export function salesRefundedLine(totals) {
  return [
    totals.eurRefunded ? formatOrderMoney(totals.eurRefunded, 'EUR') : '',
    totals.pknRefunded ? formatOrderMoney(totals.pknRefunded, 'PKN') : '',
  ].filter(Boolean).join(' · ') || '—';
}

/** Pill for a sale row: CardTrader channel, else the Pokoin order status. */
export function saleStatus(row, orderStatus) {
  if (row.source !== 'cardtrader') return orderStatus(row);
  return {
    label: row.paymentStatus === 'cancelled'
      ? 'Cancelled'
      : (row.channel === '1dr' ? 'CardTrader 1-DR' : 'CardTrader'),
    tone: row.paymentStatus === 'cancelled' ? 'muted' : 'ct',
  };
}

/** A paid Pokoin sale that still needs a tracking code. */
export function saleNeedsShip(row) {
  return row.source !== 'cardtrader'
    && ['paid', 'escrow'].includes(row.paymentStatus)
    && row.fulfillmentStatus !== 'shipped'
    && row.fulfillmentStatus !== 'delivered'
    && !row.shippedAt;
}

/** The sale row after a successful Mark shipped. */
export function shippedSale(row, result, trackingCode) {
  return {
    ...row,
    fulfillmentStatus: result.order?.fulfillmentStatus || 'shipped',
    shippedAt: result.order?.shippedAt || new Date().toISOString(),
    trackingCode: result.order?.trackingCode || trackingCode,
  };
}
