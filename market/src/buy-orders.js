// BuySell: standing buy offers ("buy orders") on a card. Client calls for
// /api/marketplace-buy-orders plus the pure helpers the card tile and the
// BuySell page share. docs/BUYSELL.md has the rules.

import { getJson } from './api.js';
import { CONDITIONS, LIST_LANGS } from './card-desk.js';
import { fiatFromPkn, formatFiatFromPkn, formatPkn, listingPriceToPkn } from './pkn.js';
import { priceInputFromPkn } from './seller-currency.js';

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
export const MAX_BUY_ORDER_PRICE_PKN = 1_000_000_000;
/** The language codes the API accepts (price_export::LANGUAGES): the listing form's list. */
export const BUY_ORDER_LANGS = LIST_LANGS;

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

/**
 * The last book each card answered with, kept on the device so a reload paints
 * the offer bar and the Buy offers cell at once instead of after the request.
 * The book is public (it never names a buyer) and is always asked for again;
 * the stored copy only fills the moment before that answer. Bounded: the 40
 * most recent cards, each for 30 minutes.
 */
export const BOOK_CACHE_KEY = 'pokoin.buybook.v1';
const BOOK_CACHE_MAX = 40;
const BOOK_CACHE_MS = 30 * 60 * 1000;

function bookStore(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (_) {
    return null;
  }
}

function readBookEntries(store) {
  try {
    const all = JSON.parse(store.getItem(BOOK_CACHE_KEY) || '{}');
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch (_) {
    return {};
  }
}

/** The stored book for `cardId`, or null when there is none or it is too old. */
export function readBookCache(cardId, { storage, now = Date.now() } = {}) {
  const store = bookStore(storage);
  const id = String(cardId || '');
  if (!store || !id) return null;
  const hit = readBookEntries(store)[id];
  if (!hit || !Array.isArray(hit.book)) return null;
  const age = now - Number(hit.at);
  return age >= 0 && age < BOOK_CACHE_MS ? hit.book : null;
}

/** Remembers `book` for `cardId`, dropping the oldest cards past the cap. */
export function writeBookCache(cardId, book, { storage, now = Date.now() } = {}) {
  const store = bookStore(storage);
  const id = String(cardId || '');
  if (!store || !id || !Array.isArray(book)) return;
  try {
    const all = readBookEntries(store);
    all[id] = { at: now, book };
    const kept = Object.keys(all)
      .sort((a, b) => Number(all[b]?.at) - Number(all[a]?.at))
      .slice(0, BOOK_CACHE_MAX);
    store.setItem(BOOK_CACHE_KEY, JSON.stringify(Object.fromEntries(kept.map((key) => [key, all[key]]))));
  } catch (_) { /* a full or blocked store only costs the instant paint */ }
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

/**
 * The most a seller may write to the buyer with a sale, counted in Unicode code
 * points (`buyerMessageLength`), which is also what the API counts.
 */
export const BUYER_MESSAGE_MAX = 240;
const BUYER_MESSAGE_TOO_LONG = "That note is too long or has characters we can't send.";

/** What the API is sent and what the counter counts: Windows and old-Mac breaks (CRLF and a lone CR) folded to LF like the server, ends trimmed. */
function buyerMessageText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

/** Control characters that survive as line breaks only: a tab or a NUL is not sendable. */
const BUYER_MESSAGE_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/** The note's length as the API counts it: code points, so an emoji is 1 and not 2. */
export function buyerMessageLength(text) {
  return [...buyerMessageText(text)].length;
}

/** '' when the note can be sent, else the sentence the form shows. */
export function buyerMessageError(text) {
  const note = buyerMessageText(text);
  if (!note) return '';
  if ([...note].length > BUYER_MESSAGE_MAX || BUYER_MESSAGE_CONTROL.test(note)) return BUYER_MESSAGE_TOO_LONG;
  return '';
}

/** `body` plus `buyer_message`, only when there is actually something to send. */
function withBuyerMessage(body, text) {
  const note = buyerMessageText(text);
  if (note) body.buyer_message = note;
  return body;
}

/**
 * Seller accepts an offer: lists their card at the offer price. `buyerMessage`
 * is the seller's optional note to the buyer; a blank one is not sent at all.
 */
export function sellIntoBuyOrder(id, quantity, token, buyerMessage = '') {
  return getJson(orderPath(id, '/sell'), authed(token, {
    method: 'POST',
    body: JSON.stringify(withBuyerMessage({ quantity }, buyerMessage)),
  }));
}

/**
 * Seller sells into Pokoin's starting offer: lists their card at 1 PKN and
 * tells Pokoin. `sale` names the card and the facets, since there is no order.
 */
export function sellToHouse(sale, token) {
  return getJson(`${BASE}/house/sell`, authed(token, {
    method: 'POST',
    body: JSON.stringify(withBuyerMessage({
      card_id: String(sale.cardId || ''),
      condition: sale.condition,
      language: sale.language,
      reverse: Boolean(sale.reverse),
      first_edition: Boolean(sale.firstEdition),
      quantity: Number(sale.quantity) || 1,
      card_name: sale.card?.name || '',
      card_image_url: sale.card?.imageUrl || '',
      set_name: sale.card?.set || '',
      collector_number: sale.card?.number || '',
    }, sale.buyerMessage)),
  }));
}

/** `codes` the form may offer: upper-case, unique and accepted by the API. */
export function offerLanguages(codes) {
  const seen = new Set();
  for (const code of Array.isArray(codes) ? codes : []) {
    const upper = String(code || '').trim().toUpperCase();
    if (BUY_ORDER_LANGS.includes(upper)) seen.add(upper);
  }
  return [...seen];
}

/** The public display name sent as `buyer_name`; '' when the account only has the seller fallback. */
export function buyerNameOf(name) {
  const text = String(name || '').trim();
  return text === 'Pokoin seller' ? '' : text;
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

/** Mirrors the server rules. `days` is required: a number, or null for until cancelled. */
export function validateBuyOrder(input = {}) {
  const errors = {};
  if (!String(input.card_id ?? input.cardId ?? '').trim()) errors.card_id = 'Pick a card.';
  if (!CONDITION_VALUES.includes(input.condition)) errors.condition = 'Choose a condition.';
  if (!BUY_ORDER_LANGS.includes(String(input.language || '').toUpperCase())) errors.language = 'Choose a language.';
  const price = Number(input.price_pkn);
  if (!Number.isFinite(price) || price <= 0 || price > MAX_BUY_ORDER_PRICE_PKN) errors.price_pkn = 'Enter a price above 0 PKN.';
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BUY_ORDER_QUANTITY) {
    errors.quantity = `Choose 1 to ${MAX_BUY_ORDER_QUANTITY} copies.`;
  }
  if (!BUY_ORDER_DAYS.some((row) => row.value === input.days)) errors.days = 'Choose how long the offer stays open.';
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
  invalid_card: 'Pick a card.',
  invalid_body: 'That request was not understood. Reload the page and try again.',
  invalid_cursor: 'The list moved on. Reload to see the latest offers.',
  invalid_sort: 'That sort is not available.',
  not_editable: 'This offer is closed, so it can no longer be changed.',
  quantity_below_filled: 'Sellers have already listed more copies than that. Choose a higher number.',
  buy_order_changed: 'The buyer changed the price a moment ago. Check the new price and try again.',
  invalid_buyer_message: "That note is too long or has characters we can't send.",
  nothing_to_update: 'Nothing was changed.',
  rate_limited: 'Too many changes in a short time. Wait a minute and try again.',
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

/** The smallest step above an offer: 1% rounded up to a whole PKN, at least 1 PKN (1 PKN is EUR 0.005). */
export function beatStepPkn(pricePkn) {
  const price = Number(pricePkn);
  if (!Number.isFinite(price) || price <= 0) return 1;
  return Math.max(1, Math.ceil(price * 0.01));
}

/** The form's starting price for a selection: one step above the best offer, '' when there is none. */
export function offerPrefill(bid) {
  const price = Number(bid?.best_price_pkn);
  if (!Number.isFinite(price) || price <= 0) return '';
  return String(price + beatStepPkn(price));
}

/**
 * Every card starts with an offer: Pokoin's own 1 PKN. It is the floor the bar
 * shows (in the visitor's currency) when no buyer has posted one, so the bar
 * never says "no offers" and Beat offer always has a price to beat.
 */
export const HOUSE_OFFER_PKN = 1;

/**
 * `bid` when a buyer's offer exists for the selection, else the house offer.
 * The house row names no order (`best_order_id`), so nothing can be sold into it.
 */
export function withHouseOffer(bid) {
  const price = Number(bid?.best_price_pkn);
  if (bid && Number.isFinite(price) && price > 0) return bid;
  return { best_price_pkn: HOUSE_OFFER_PKN, quantity: 0, orders: 0, house: true };
}

/**
 * What the card-page offer bar says for one selection (`bid` is selectionBid()):
 * `button` is the right segment, `title` the hover/aria text on the price part.
 */
export function offerBarModel(bid) {
  const price = Number(bid?.best_price_pkn);
  if (!bid || !Number.isFinite(price) || price <= 0) {
    return { hasOffer: false, button: 'Make offer', title: 'No offers yet' };
  }
  if (bid.house) {
    return { hasOffer: true, house: true, button: 'Beat offer', title: `Pokoin's starting offer: ${HOUSE_OFFER_PKN} PKN` };
  }
  const wanted = Number(bid.quantity) || 0;
  const buyers = Number(bid.orders) || 0;
  return {
    hasOffer: true,
    button: 'Beat offer',
    title: `${wanted} wanted · ${buyers} ${buyers === 1 ? 'buyer' : 'buyers'}`,
  };
}

/** The visitor's offer settings before they change anything: 1 copy, the desk's condition and language, 30 days. */
export function defaultOfferSettings({ condition, language } = {}) {
  return {
    quantity: '1',
    condition: CONDITION_VALUES.includes(condition) ? condition : 'NM',
    language: BUY_ORDER_LANGS.includes(String(language || '').toUpperCase()) ? String(language).toUpperCase() : 'EN',
    days: String(DEFAULT_BUY_ORDER_DAYS),
    reverse: false,
    firstEdition: false,
  };
}

/**
 * An offer can be under a cent (1 PKN is half a cent), and two decimals would
 * show 1 PKN and 2 PKN as the same "$0.01". Below ten euro cents (20 PKN), in
 * whatever currency it is shown, the amount keeps up to four decimals: 0.005,
 * 0.01, 0.0375. Null for PKN, for no price, and for larger amounts, which keep
 * the usual two decimals.
 */
function smallFiat(pricePkn, code) {
  if (code === 'PKN') return null;
  const amount = fiatFromPkn(pricePkn, code);
  const eur = fiatFromPkn(pricePkn, 'EUR');
  if (amount == null || eur == null || eur >= 0.1) return null;
  return String(Number(amount.toFixed(4)));
}

/** A price in the currency the offer form uses: "2.64 DKK" for a local currency, "120 PKN" for PKN; '' when there is none. */
export function offerPriceLabel(pricePkn, currency = 'PKN') {
  const code = String(currency || 'PKN').toUpperCase();
  if (code === 'PKN') return formatPkn(pricePkn);
  const small = smallFiat(pricePkn, code);
  if (small == null) return formatFiatFromPkn(pricePkn, code);
  if (code === 'DKK') return `${small} DKK`;
  return code === 'USD' ? `$${small}` : `€${small}`;
}

/**
 * What the price field holds for a PKN price in the visitor's currency. The same
 * helper the listing form fills its price input with (priceInputFromPkn), with
 * the sub-cent precision of offerPriceLabel so 1 PKN is not typed back as 2.
 */
export function offerPriceInput(pricePkn, currency = 'PKN') {
  const code = String(currency || 'PKN').toUpperCase();
  return smallFiat(pricePkn, code) ?? priceInputFromPkn(pricePkn, code);
}

/** The unit the offer form prices in: the visitor's local currency, or PKN when they chose it (or have no currency yet). */
export const OFFER_UNIT_KEY = 'pokoin.offer.unit';
export function offerUnit(choice, localCurrency) {
  const local = String(localCurrency || '').toUpperCase();
  if (String(choice || '').toUpperCase() === 'PKN' || !local) return 'PKN';
  return local;
}

/**
 * The unit a surface that did not open the offer form shows prices in: the same
 * device choice the popup writes, so a Quick Sell dialog and that popup agree.
 */
export function storedOfferUnit(localCurrency, { storage } = {}) {
  let choice = '';
  try {
    const store = storage || (typeof localStorage === 'undefined' ? null : localStorage);
    choice = store ? store.getItem(OFFER_UNIT_KEY) || '' : '';
  } catch (_) {
    choice = '';
  }
  return offerUnit(choice, localCurrency);
}

/**
 * What the visitor typed, in their currency, as the `price_pkn` the API takes:
 * the listing form's own conversion (listingPriceToPkn), null when it is not a price.
 */
export function offerPricePkn(raw, currency = 'PKN') {
  return listingPriceToPkn(raw, String(currency || 'PKN').toUpperCase());
}

/** The PKN price Beat offer posts: one step above the best offer; null when there is no offer. */
export function beatPricePkn(bid) {
  const price = Number(bid?.best_price_pkn);
  if (!Number.isFinite(price) || price <= 0) return null;
  return price + beatStepPkn(price);
}

/** The exact sentence on Beat offer: "Offer 2.64 DKK for 1 copy, Near Mint, EN, 30 days". */
export function offerSummary(pricePkn, settings, currency = 'PKN') {
  const copies = Number(settings?.quantity) || 1;
  const condition = CONDITIONS.find((row) => row.value === settings?.condition)?.label || settings?.condition || '';
  const days = BUY_ORDER_DAYS.find((row) => String(row.value) === String(settings?.days))?.label || `${settings?.days} days`;
  const parts = [`${copies} ${copies === 1 ? 'copy' : 'copies'}`, condition, String(settings?.language || ''), days];
  if (settings?.reverse) parts.push('Reverse');
  if (settings?.firstEdition) parts.push('1st Ed.');
  return `Offer ${offerPriceLabel(pricePkn, currency)} for ${parts.join(', ')}`;
}

/** The POST body for an offer. `card` carries the display fields the book keeps. */
export function offerBody({ cardId, pricePkn, settings, buyerName = '', card = {} }) {
  return {
    card_id: String(cardId || ''),
    condition: settings.condition,
    language: settings.language,
    reverse: Boolean(settings.reverse),
    first_edition: Boolean(settings.firstEdition),
    price_pkn: pricePkn,
    quantity: Number(settings.quantity),
    days: settings.days === 'null' ? null : Number(settings.days),
    buyer_name: buyerName,
    card_name: card.name || '',
    card_image_url: card.imageUrl || '',
    set_name: card.set || '',
    collector_number: card.number || '',
  };
}
