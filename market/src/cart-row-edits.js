// Cart row edits beyond add / quantity / remove (undo, swap, ticks, the
// saved-for-later move, the Stripe checkout bookkeeping). Kept out of
// cart-rows.js, which the header's cart loads on the first paint.

import { listingStock, nextCartQty } from './cart-qty.js';
import { CART_MAX, writeCartFlag } from './cart-rows.js';

/** Undo for Delete: the row goes back where it was. */
export function restoreCartRow(current, row, index = 0) {
  if (!row?.id || current.some((item) => item.id === row.id)) return current;
  const at = Math.max(0, Math.min(current.length, Number(index) || 0));
  return [...current.slice(0, at), row, ...current.slice(at)].slice(0, CART_MAX);
}

/** Undo for Delete all: the whole cart comes back, merged with anything added since. */
export function restoreCartRows(current, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = new Set(current.map((row) => row.id));
  return [...current, ...list.filter((row) => row?.id && !ids.has(row.id))].slice(0, CART_MAX);
}

/** Swap a row for another copy (cheaper or still in stock), keeping its place and tick. */
export function replaceCartRow(current, id, next) {
  if (!next?.id) return current;
  const index = current.findIndex((row) => row.id === id);
  if (index < 0) return current;
  const old = current[index];
  const stock = listingStock(next);
  const swapped = {
    ...next,
    qty: Math.max(1, Math.min(stock, Number(old.qty) || 1)),
    selected: true,
    addedPricePkn: Number(old.addedPricePkn || old.pricePkn) || next.pricePkn,
    addedAt: old.addedAt || next.addedAt,
  };
  const rest = current.filter((row, at) => at !== index);
  const twin = rest.find((row) => row.id === swapped.id);
  if (twin) {
    return rest.map((row) => (row.id === swapped.id
      ? { ...row, qty: nextCartQty(row.qty, swapped.qty, listingStock(row)), selected: true }
      : row));
  }
  return [...rest.slice(0, index), swapped, ...rest.slice(index)];
}

export function selectCartRow(current, id, on) {
  return current.map((row) => (row.id === id ? { ...row, selected: Boolean(on) } : row));
}

/** A sold-out copy stays unticked: checkout would refuse it. */
export function selectAllCartRows(current, on) {
  return current.map((row) => ({ ...row, selected: Boolean(on) && !row.unavailable }));
}

/** A saved row moving back to the cart: a twin gains qty, else it goes on top. */
export function moveSavedIntoCart(current, row) {
  const twin = current.find((item) => item.id === row.id);
  if (twin) {
    return current.map((item) => (item.id === row.id
      ? { ...item, qty: nextCartQty(item.qty, row.qty, listingStock(item)), selected: true }
      : item));
  }
  return [{ ...row, selected: !row.unavailable }, ...current].slice(0, CART_MAX);
}

/** Merge { country?, service? } into the buyer's shipping choice (the same object when nothing changed). */
export function mergeShippingChoice(current, patch) {
  const next = { ...current, ...(patch || {}) };
  if (next.country === current.country && next.service === current.service) return current;
  return { country: String(next.country || '').toUpperCase(), service: String(next.service || '') };
}

export const PENDING_CHECKOUT_KEY = 'pokoin.cartCheckout';
const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Row ids a Stripe checkout took to the payment page; settled on /orders?eur_session. */
export function readPendingCheckoutIds(now = Date.now()) {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_CHECKOUT_KEY) || 'null');
    if (!parsed || !Array.isArray(parsed.ids)) return [];
    if (!(now - Number(parsed.at || 0) < PENDING_TTL_MS)) return [];
    return parsed.ids.map(String);
  } catch (_) {
    return [];
  }
}

/** Stripe leaves the SPA: remember which rows that payment covers. */
export function writePendingCheckout(ids) {
  const list = (ids || []).map(String).filter(Boolean);
  writeCartFlag(PENDING_CHECKOUT_KEY, list.length ? JSON.stringify({ ids: list, at: Date.now() }) : '');
}
