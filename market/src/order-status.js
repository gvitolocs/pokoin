// Order status words for Orders and Sold history. An empty cart or a closed
// Stripe tab never means "sold": only paid / escrow / released orders are sales.

const UNPAID = new Set(['pending_stripe', 'processing', 'expired', 'cancelled', 'failed']);
const SOLD = new Set(['paid', 'escrow', 'released', 'partially_refunded']);
const ARCHIVED = new Set(['expired', 'cancelled', 'failed', 'refunded']);

export function isEurOrder(row = {}) {
  return row.currency === 'EUR' || row.paymentMethod === 'stripe';
}

export function isUnpaidOrder(row = {}) {
  return UNPAID.has(String(row.paymentStatus || ''));
}

export function isSoldOrder(row = {}) {
  return SOLD.has(String(row.paymentStatus || ''));
}

/** Expired / cancelled / nulled / fully refunded — hide behind the Archived toggle. */
export function isArchivedOrder(row = {}) {
  if (ARCHIVED.has(String(row.paymentStatus || ''))) return true;
  if (row.fulfillmentStatus === 'cancelled_not_shipped') return true;
  if (row.disputeStatus === 'refunded_not_shipped') return true;
  return false;
}

/** Live = active purchases/sales; archived = expired, cancelled, failed, refunded. */
export function filterOrdersByArchive(rows = [], archived = false) {
  return rows.filter((row) => isArchivedOrder(row) === Boolean(archived));
}

function msFrom(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stripe link still usable: unpaid, hold not expired yet. */
export function canResumePayment(row = {}, now = Date.now()) {
  if (row.paymentStatus !== 'pending_stripe' || !row.stripeCheckoutUrl) return false;
  const ends = msFrom(row.inventory?.expiresAt);
  return ends > now;
}

export function holdMinutesLeft(row = {}, now = Date.now()) {
  const ends = msFrom(row.inventory?.expiresAt);
  if (!ends || ends <= now) return 0;
  return Math.max(1, Math.ceil((ends - now) / 60000));
}

/** { label, tone } — tone is ok | wait | muted | warn. */
export function orderStatus(row = {}) {
  const payment = String(row.paymentStatus || row.status || '');
  if (row.fulfillmentStatus === 'needs_refund') {
    return { label: 'Card no longer available — refund due', tone: 'warn' };
  }
  if (row.disputeStatus === 'open') return { label: 'Dispute open', tone: 'warn' };
  switch (payment) {
    case 'pending_stripe':
      return { label: 'Awaiting payment', tone: 'wait' };
    case 'processing':
      return { label: 'Payment processing', tone: 'wait' };
    case 'expired':
      return { label: 'Expired · not charged', tone: 'muted' };
    case 'cancelled':
      return { label: 'Cancelled · not charged', tone: 'muted' };
    case 'failed':
      return { label: 'Payment failed · not charged', tone: 'muted' };
    case 'escrow':
      return { label: 'Paid · in escrow', tone: 'ok' };
    case 'paid':
      return { label: 'Paid', tone: 'ok' };
    case 'released':
      return { label: 'Completed', tone: 'ok' };
    case 'refunded':
      return { label: 'Refunded', tone: 'muted' };
    default:
      return { label: payment || 'Order', tone: 'muted' };
  }
}

const FULFILLMENT_LABEL = {
  awaiting_shipment: 'to ship',
  shipped: 'shipped',
  delivered: 'delivered',
  awaiting_cardtrader_fulfillment: 'CardTrader fulfilling',
  cancelled_not_shipped: 'not shipped',
  nft_ownership_recorded: 'NFT recorded',
};

export function fulfillmentLabel(row = {}) {
  if (isUnpaidOrder(row) || row.fulfillmentStatus === 'needs_refund') return '';
  return FULFILLMENT_LABEL[row.fulfillmentStatus] || '';
}

/**
 * Buyer sees every order they started. A seller only sees orders that were
 * actually paid — an abandoned Stripe tab is not a sale.
 */
export function visibleOrders(rows = [], uid = '') {
  return rows.filter((row) => {
    const buyer = row.uid === uid || row.buyerUid === uid;
    if (buyer) return true;
    return !isUnpaidOrder(row);
  });
}

/** Refund input → integer amount in the order unit (EUR cents or whole PKN). */
export function refundAmountFromInput(text, currency) {
  const raw = String(text ?? '').trim().replace(',', '.');
  if (!raw) return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) return NaN;
  if (currency === 'EUR') return Math.round(Number(raw) * 100);
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

export function refundInputFromAmount(amount, currency) {
  const n = Number(amount) || 0;
  return currency === 'EUR' ? (n / 100).toFixed(2) : String(Math.trunc(n));
}

export function formatOrderMoney(amount, currency) {
  const n = Number(amount) || 0;
  if (currency === 'EUR') return `€${(n / 100).toFixed(2)}`;
  return `${Math.trunc(n)} PKN`;
}

export function newRefundToken() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `rf${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
