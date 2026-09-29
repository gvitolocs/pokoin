// Profile dashboard: seller setup checklist and order activity, derived from
// the same status payloads and Firestore order rows the settings panels use.

import { isSoldOrder, isUnpaidOrder, orderStatus } from './order-status.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function msFrom(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Seller setup rows in the order a seller needs them: ship-from country gates
 * the first listing and Stripe onboarding; CardTrader is an optional import.
 * A null input means that status is still loading.
 */
export function sellerSetupSteps({ shipFromCountry = null, stripe = null, cardTrader = null } = {}) {
  const stripeStatus = String(stripe?.stripeConnectStatus || 'not_started');
  const steps = [
    {
      key: 'country',
      label: 'Ship-from country',
      loading: shipFromCountry == null,
      done: Boolean(shipFromCountry),
    },
    {
      key: 'stripe',
      label: 'Stripe payouts',
      loading: stripe == null,
      done: stripe?.ready === true,
      started: stripe != null && stripe.ready !== true && stripeStatus !== 'not_started',
    },
    {
      key: 'cardtrader',
      label: 'CardTrader',
      loading: cardTrader == null,
      done: cardTrader?.connected === true,
    },
  ];
  const done = steps.filter((step) => step.done).length;
  return { steps, done, total: steps.length };
}

/** Title for an order row: first card name, "+N" for the rest. */
export function orderTitle(row = {}) {
  const items = Array.isArray(row.items) ? row.items : [];
  const first = items[0]?.card?.name || items[0]?.cardName || '';
  if (!first) return 'Order';
  const more = items.length - 1;
  return more > 0 ? `${first} +${more}` : first;
}

function orderMoney(row = {}) {
  if (row.currency === 'EUR' || row.paymentMethod === 'stripe') {
    return { currency: 'EUR', amount: Number(row.totalEURCents) || 0 };
  }
  return { currency: 'PKN', amount: Math.trunc(Number(row.totalPkn) || 0) };
}

/**
 * Recent orders (bought + sold) and the selling snapshot for Profile.
 * Sellers only count paid orders; an abandoned Stripe tab is never a sale.
 */
export function orderActivity(rows = [], uid = '', { now = Date.now(), limit = 5 } = {}) {
  const byId = new Map();
  for (const row of rows || []) {
    if (row?.id) byId.set(row.id, row);
  }
  const recent = [];
  let toShip = 0;
  let sales30d = 0;
  let salesEurCents30d = 0;
  let salesPkn30d = 0;
  for (const row of byId.values()) {
    const buyer = row.uid === uid || row.buyerUid === uid;
    const seller = !buyer && Array.isArray(row.sellerUids) && row.sellerUids.includes(uid);
    if (!buyer && !seller) continue;
    if (seller && isUnpaidOrder(row)) continue;
    const at = msFrom(row.createdAt);
    if (seller && isSoldOrder(row)) {
      if (row.fulfillmentStatus === 'awaiting_shipment') toShip += 1;
      if (at && now - at <= 30 * DAY_MS) {
        sales30d += 1;
        const money = orderMoney(row);
        if (money.currency === 'EUR') salesEurCents30d += money.amount;
        else salesPkn30d += money.amount;
      }
    }
    recent.push({
      id: row.id,
      role: buyer ? 'bought' : 'sold',
      title: orderTitle(row),
      money: orderMoney(row),
      status: orderStatus(row),
      at,
    });
  }
  recent.sort((a, b) => b.at - a.at);
  return {
    recent: recent.slice(0, limit),
    total: recent.length,
    toShip,
    sales30d,
    salesEurCents30d,
    salesPkn30d,
  };
}

/** "2h ago", "Yesterday", "Sep 27" — short enough for an activity row. */
export function timeAgo(at, now = Date.now()) {
  if (!at) return '';
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}
