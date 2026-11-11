// BuySell: standing buy offers ("buy orders") on a card. Client calls for
// /api/marketplace-buy-orders plus the pure helpers the card tile and the
// BuySell page share. docs/BUYSELL.md has the rules.

import { getJson } from './api.js';
import { CONDITIONS, LIST_LANGS } from './card-desk.js';
import { formatPkn } from './pkn.js';

export const BUY_ORDER_DAYS = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 60, label: '60 days' },
  { value: 90, label: '90 days' },
  { value: null, label: 'Until cancelled' },
];
export const DEFAULT_BUY_ORDER_DAYS = 30;
export const MAX_BUY_ORDER_QUANTITY = 10;

const BASE = '/api/marketplace-buy-orders';
const CONDITION_VALUES = CONDITIONS.map((row) => row.value).filter(Boolean);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function authed(token, extra = {}) {
  return {
    cache: 'no-store',
    ...extra,
    headers: {
      ...(extra.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
    },
  };
}

function orderPath(id, tail = '') {
  return `${BASE}/${encodeURIComponent(String(id || ''))}${tail}`;
}

/** Live offers on one card, grouped by condition / language / reverse / 1st edition. */
export function fetchBuyBook(cardId, options = {}) {
  const params = new URLSearchParams({ card_id: String(cardId || '') });
  return getJson(`${BASE}?${params}`, { cache: 'no-store', signal: options.signal });
}

/** The public board of open offers. `before` is the cursor the last page returned as `next`. */
export function fetchBuyBoard({ limit = 24, sort = 'recent', before = '' } = {}, options = {}) {
  const params = new URLSearchParams({ limit: String(limit), sort });
  if (before) params.set('before', String(before));
  return getJson(`${BASE}/board?${params}`, { cache: 'no-store', signal: options.signal });
}

export function fetchMyBuyOrders(token) {
  return getJson(`${BASE}/mine`, authed(token));
}

/** Open offers that match the caller's active listings. */
export function fetchBuyOrdersForMyListings(token) {
  return getJson(`${BASE}/for-my-listings`, authed(token));
}

export function createBuyOrder(body, token) {
  return getJson(BASE, authed(token, { method: 'POST', body: JSON.stringify(body) }));
}

export function updateBuyOrder(id, body, token) {
  return getJson(orderPath(id), authed(token, { method: 'PATCH', body: JSON.stringify(body) }));
}

export function cancelBuyOrder(id, token) {
  return getJson(orderPath(id), authed(token, { method: 'DELETE' }));
}

/** Seller accepts an offer: lists their card at the offer price. */
export function sellIntoBuyOrder(id, quantity, token) {
  return getJson(orderPath(id, '/sell'), authed(token, {
    method: 'POST',
    body: JSON.stringify({ quantity }),
  }));
}

/** The book row for one facet tuple, or null. */
export function bestBid(book, { condition, language, reverse = false, firstEdition = false } = {}) {
  const lang = String(language || '').toUpperCase();
  const rows = Array.isArray(book) ? book : [];
  return rows.find((row) => row
    && row.condition === condition
    && String(row.language || '').toUpperCase() === lang
    && Boolean(row.reverse) === Boolean(reverse)
    && Boolean(row.first_edition) === Boolean(firstEdition)) || null;
}

/**
 * The offer a visitor sees for a condition and language: the highest price across
 * the reverse / 1st edition variants, with the copies and offers summed.
 */
export function selectionBid(book, { condition, language } = {}) {
  const lang = String(language || '').toUpperCase();
  let top = null;
  let quantity = 0;
  let orders = 0;
  for (const row of Array.isArray(book) ? book : []) {
    if (!row || row.condition !== condition || String(row.language || '').toUpperCase() !== lang) continue;
    const price = Number(row.best_price_pkn);
    if (!Number.isFinite(price)) continue;
    quantity += Number(row.quantity) || 0;
    orders += Number(row.orders) || 0;
    if (!top || price > Number(top.best_price_pkn)) top = row;
  }
  return top ? { ...top, quantity, orders } : null;
}

/** Best price per condition for one language, in CONDITIONS order. */
export function bidsByCondition(book, language) {
  const lang = String(language || '').toUpperCase();
  const best = new Map();
  for (const row of Array.isArray(book) ? book : []) {
    if (!row || String(row.language || '').toUpperCase() !== lang) continue;
    const price = Number(row.best_price_pkn);
    if (!Number.isFinite(price)) continue;
    const seen = best.get(row.condition);
    if (!seen || price > seen.bestPricePkn) {
      best.set(row.condition, { condition: row.condition, bestPricePkn: price, quantity: Number(row.quantity) || 0 });
    }
  }
  return CONDITION_VALUES.filter((value) => best.has(value)).map((value) => best.get(value));
}

const STATE_LABELS = {
  open: 'Open',
  filled: 'Filled',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export function orderStateLabel(state) {
  return STATE_LABELS[String(state || '')] || 'Open';
}

function toMs(value) {
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

/** "3 days left", "Until cancelled" (no expiry), "Expired". */
export function expiryLabel(expiresAt, now = Date.now()) {
  if (expiresAt == null || expiresAt === '') return 'Until cancelled';
  const left = toMs(expiresAt) - toMs(now);
  if (!Number.isFinite(left)) return 'Until cancelled';
  if (left <= 0) return 'Expired';
  if (left >= DAY_MS) {
    const days = Math.floor(left / DAY_MS);
    return `${days} ${days === 1 ? 'day' : 'days'} left`;
  }
  if (left >= HOUR_MS) {
    const hours = Math.floor(left / HOUR_MS);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`;
  }
  return 'Less than an hour left';
}

/** Mirrors the server rules. `days` may be a number or null (until cancelled). */
export function validateBuyOrder(input = {}) {
  const errors = {};
  if (!String(input.card_id ?? input.cardId ?? '').trim()) errors.card_id = 'Pick a card.';
  if (!CONDITION_VALUES.includes(input.condition)) errors.condition = 'Choose a condition.';
  if (!LIST_LANGS.includes(String(input.language || '').toUpperCase())) errors.language = 'Choose a language.';
  const price = Number(input.price_pkn);
  if (!Number.isFinite(price) || price <= 0) errors.price_pkn = 'Enter a price above 0 PKN.';
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BUY_ORDER_QUANTITY) {
    errors.quantity = `Choose 1 to ${MAX_BUY_ORDER_QUANTITY} copies.`;
  }
  const days = input.days === undefined ? DEFAULT_BUY_ORDER_DAYS : input.days;
  if (!BUY_ORDER_DAYS.some((row) => row.value === days)) errors.days = 'Choose how long the offer stays open.';
  return { ok: Object.keys(errors).length === 0, errors };
}

const ERROR_MESSAGES = {
  duplicate_buy_order: 'You already have an open offer for this card, condition and language. Edit it in My offers.',
  too_many_buy_orders: 'You have 100 open offers. Cancel one to make another.',
  own_buy_order: 'This is your own offer. Someone else has to sell into it.',
  not_open: 'This offer is no longer open.',
  quantity_exceeds_remaining: 'The buyer wants fewer copies than that now. Lower the quantity.',
  invalid_price: 'Enter a price above 0 PKN.',
  invalid_quantity: `Choose 1 to ${MAX_BUY_ORDER_QUANTITY} copies.`,
  invalid_days: 'Choose how long the offer stays open.',
  invalid_condition: 'Choose a condition.',
  invalid_language: 'Choose a language.',
  unauthorized: 'Sign in to continue.',
  not_found: 'This offer no longer exists.',
};

/** A plain sentence for an API error code; unknown codes keep the server's own text. */
export function errorMessage(code) {
  const key = String(code?.message ?? code ?? '');
  if (ERROR_MESSAGES[key]) return ERROR_MESSAGES[key];
  if (/^[a-z]+(_[a-z]+)+$/.test(key)) return 'Something went wrong. Try again.';
  return key || 'Something went wrong. Try again.';
}

/** True when the offer is at or above the cheapest listing: the buyer could just buy it. */
export function crossesAsk(pricePkn, lowestAskPkn) {
  const offer = Number(pricePkn);
  const ask = Number(lowestAskPkn);
  return Number.isFinite(offer) && Number.isFinite(ask) && offer > 0 && ask > 0 && offer >= ask;
}

/** "120 PKN" for a price, '' when there is none. */
export function offerPriceLabel(pricePkn) {
  return formatPkn(pricePkn);
}
