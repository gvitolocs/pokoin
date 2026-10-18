import { createSignal } from 'solid-js';
import { moveRow, patchLiveRows, settleCheckoutRows } from '@market/cart-model.js';
import { isSelected } from '@market/cart-totals.js';
import {
  SAVED_MAX,
} from '@market/cart-rows.js';
import {
  mergeShippingChoice,
  moveSavedIntoCart,
  readPendingCheckoutIds,
  replaceCartRow,
  restoreCartRow,
  restoreCartRows,
  selectAllCartRows,
  selectCartRow,
  writePendingCheckout,
} from '@market/cart-row-edits.js';
import {
  readInsurance,
  readPknDiscount,
  readParcelServices,
  readShippingCountry,
  readShippingService,
  writeInsurance,
  writePknDiscount,
  writeParcelServices,
  writeShippingCountry,
  writeShippingService,
} from '@market/shipping-choice.js';
import { cartItems, updateCart } from './cart.js';

/**
 * Cart actions beyond stores/cart.js for the cart, checkout,
 * shipping and orders pages: row edits beyond add/qty/remove, the buyer's
 * shipping/insurance/balance choices and the Stripe checkout bookkeeping.
 * Kept out of stores/cart.js so the header's cart (first paint) stays small.
 */
const browser = typeof window !== 'undefined';

/** useCart().checkoutItems: only the ticked rows check out; unticked ones stay. */
export const cartCheckoutItems = () => cartItems().filter(isSelected);
/** useCart().canNftOnly: every ticked row can go straight into the collection. */
export function cartCanNftOnly() {
  const rows = cartCheckoutItems();
  return rows.length > 0 && rows.every((row) => row.nftAvailable || row.reserveAvailable);
}

// Buyer choices shared by the cart, /shipping and checkout (market/src/shipping-choice.js).
const [insurance, setInsuranceSignal] = createSignal(browser ? readInsurance() : false);
const [useBalance, setUseBalanceSignal] = createSignal(browser ? readPknDiscount() : false);
let choice = browser
  ? { country: readShippingCountry(), service: readShippingService(), parcels: readParcelServices() }
  : { country: '', service: '', parcels: {} };
const [shippingChoice, setShippingChoiceSignal] = createSignal(choice);

export const cartInsurance = insurance;
export const cartUseBalance = useBalance;
export const cartShippingChoice = shippingChoice;

export function setCartInsurance(on) {
  setInsuranceSignal(Boolean(on));
  writeInsurance(Boolean(on));
}

/** "Use my site balance as a discount" — checkout starts with its voucher ticked. */
export function setCartUseBalance(on) {
  setUseBalanceSignal(Boolean(on));
  writePknDiscount(Boolean(on));
}

/** Merge { country?, service?, parcel?: { key, service } } into the buyer's shipping choice. */
export function setCartShippingChoice(patch) {
  const next = mergeShippingChoice(choice, patch);
  if (next === choice) return;
  choice = next;
  setShippingChoiceSignal(next);
  writeShippingCountry(next.country);
  writeShippingService(next.service);
  writeParcelServices(next.parcels);
}

export function setCartGift(on) {
  updateCart((items, saved) => [items, saved, Boolean(on)]);
}

export function removeCartItems(ids) {
  const drop = new Set((ids || []).map(String));
  if (!drop.size) return;
  updateCart((items) => [items.filter((row) => !drop.has(String(row.id)))]);
}

/** Undo for Delete: the row goes back where it was. */
export function restoreCartItem(row, index = 0) {
  if (!row?.id) return;
  updateCart((items) => [restoreCartRow(items, row, index)]);
}

/** Undo for Delete all. */
export function restoreCartItems(list) {
  updateCart((items) => [restoreCartRows(items, list)]);
}

/** Swap a row for another copy, keeping its place and tick. */
export function replaceCartItem(id, next) {
  if (!next?.id) return;
  updateCart((items) => [replaceCartRow(items, id, next)]);
}

export function selectCartItem(id, on) {
  updateCart((items) => [selectCartRow(items, id, on)]);
}

export function selectAllCartItems(on) {
  updateCart((items) => [selectAllCartRows(items, on)]);
}

export function saveCartItemForLater(id) {
  updateCart((items, saved) => {
    const moved = moveRow(items, saved, id, SAVED_MAX);
    return moved.row ? [moved.from, moved.to] : [items, saved];
  });
}

export function moveSavedToCart(id) {
  updateCart((items, saved) => {
    const moved = moveRow(saved, [], id);
    return moved.row ? [moveSavedIntoCart(items, moved.row), moved.from] : [items, saved];
  });
}

export function removeSavedItem(id) {
  updateCart((items, saved) => [items, saved.filter((row) => row.id !== id)]);
}

/** Live listings for one card → price, stock, qty cap, sold-out flag on its rows. */
export function applyCartLive(cardId, entry, options = {}) {
  updateCart((items, saved) => [patchLiveRows(items, cardId, entry, options), patchLiveRows(saved, cardId, entry, options)]);
}

export function clearCart() {
  updateCart(() => [[]]);
}

/** Stripe leaves the SPA: remember which rows that payment covers. */
export function markCheckoutPending(ids) {
  writePendingCheckout(ids);
}

/**
 * Paid: drop the rows that checkout sent and keep the unticked ones (row ids
 * recorded before Stripe, else the paid order's listing ids). False when it
 * had neither to go on.
 */
export function settleCheckout({ listingIds = [] } = {}) {
  const rowIds = readPendingCheckoutIds();
  if (!rowIds.length && !(listingIds || []).length) return false;
  updateCart((items, saved) => [settleCheckoutRows(items, { rowIds, listingIds }), saved, false]);
  writePendingCheckout([]);
  return true;
}
