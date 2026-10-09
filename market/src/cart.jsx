import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { cartTotals, isSelected, moveRow, reconcileRow, settleCheckoutRows } from './cart-model.js';
import { listingStock, nextCartQty } from './cart-qty.js';
import { useAccountCartSync } from './cart-sync.js';
import {
  CART_KEY,
  CART_MAX,
  SAVED_KEY,
  SAVED_MAX,
  addCartRow,
  cartItemFromOffer,
  dropSavedRow,
  readCartRows,
  writeCartRows,
} from './cart-rows.js';
import { repairCartImage } from './cart-image.js';
import {
  readInsurance,
  readPknDiscount,
  readShippingCountry,
  readShippingService,
  writeInsurance,
  writePknDiscount,
  writeShippingCountry,
  writeShippingService,
} from './shipping-choice.js';

// Row shape and add reducer live in cart-rows.js (shared with the Solid UI).
export { cartItemFromOffer };

const GIFT_KEY = 'pokoin.cartGift';
const PENDING_KEY = 'pokoin.cartCheckout';
const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const readRows = readCartRows;

function readCart() {
  return readRows(CART_KEY);
}

/** Account-cart rows from the API back into the browser's row shape. */
function fromAccountRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row && row.id).map((row) => ({
    ...row,
    card: { id: String(row.cardId || ''), name: row.name || 'Card' },
    image: repairCartImage(row) || row.image || '',
  }));
}

function writeCart(items) {
  writeCartRows(CART_KEY, items, CART_MAX);
}

/** Saved for later: same row shape as the cart, same quota guard. */
function writeSaved(items) {
  writeCartRows(SAVED_KEY, items, SAVED_MAX);
}

function writeFlag(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {
    /* private mode: the flag lives in memory this session */
  }
}

function readGift() {
  try {
    return localStorage.getItem(GIFT_KEY) === '1';
  } catch (_) {
    return false;
  }
}

/** Row ids a Stripe checkout took to the payment page; settled on /orders?eur_session. */
function readPendingIds(now = Date.now()) {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (!parsed || !Array.isArray(parsed.ids)) return [];
    if (!(now - Number(parsed.at || 0) < PENDING_TTL_MS)) return [];
    return parsed.ids.map(String);
  } catch (_) {
    return [];
  }
}

/** Snapshot for Poko personal context (no React). Caps at 24 lines. */
export function peekCartItems(limit = 24) {
  if (typeof window === 'undefined') return [];
  return readCart().slice(0, Math.max(1, Math.min(48, Number(limit) || 24))).map((row) => ({
    cardId: String(row.cardId || row.card?.id || ''),
    name: String(row.name || row.card?.name || ''),
    qty: Number(row.qty) || 0,
    pricePkn: Number(row.pricePkn) || 0,
    sellerName: String(row.sellerName || ''),
    condition: String(row.condition || ''),
    language: String(row.language || ''),
  })).filter((row) => row.cardId && row.qty > 0);
}

const CartContext = createContext({
  items: [],
  saved: [],
  count: 0,
  subtotalPkn: 0,
  totalPkn: 0,
  checkoutItems: [],
  checkoutCount: 0,
  checkoutSubtotalPkn: 0,
  canNftOnly: false,
  gift: false,
  useBalance: false,
  shippingChoice: { country: '', service: '' },
  addItem: () => {},
  setQty: () => {},
  removeItem: () => {},
  removeItems: () => {},
  restoreItem: () => {},
  restoreAll: () => {},
  replaceItem: () => {},
  setSelected: () => {},
  selectAll: () => {},
  saveForLater: () => {},
  moveToCart: () => {},
  removeSaved: () => {},
  applyLive: () => {},
  setGift: () => {},
  setInsurance: () => {},
  insurance: false,
  setUseBalance: () => {},
  setShippingChoice: () => {},
  markCheckoutPending: () => {},
  settleCheckout: () => {},
  clear: () => {},
});

export const CHECKOUT_SHIPPING_PKN = 2000;

function patchRows(rows, cardId, entry, options) {
  const id = String(cardId || '');
  let changed = false;
  const next = rows.map((row) => {
    if (String(row.cardId) !== id) return row;
    const { patch } = reconcileRow(row, entry?.listings, { complete: entry?.complete !== false, ...options });
    if (!patch || !Object.keys(patch).length) return row;
    changed = true;
    return { ...row, ...patch };
  });
  return changed ? next : rows;
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => (typeof window === 'undefined' ? [] : readCart()));
  const [saved, setSaved] = useState(() => (typeof window === 'undefined' ? [] : readRows(SAVED_KEY)));
  const [gift, setGiftState] = useState(() => (typeof window === 'undefined' ? false : readGift()));
  const [insurance, setInsuranceState] = useState(() => (typeof window === 'undefined' ? false : readInsurance()));
  const [useBalance, setUseBalanceState] = useState(() => (typeof window === 'undefined' ? false : readPknDiscount()));
  const [shippingChoice, setShippingChoiceState] = useState(() => (
    typeof window === 'undefined'
      ? { country: '', service: '' }
      : { country: readShippingCountry(), service: readShippingService() }
  ));

  useEffect(() => {
    writeCart(items);
  }, [items]);

  useEffect(() => {
    writeSaved(saved);
  }, [saved]);

  useEffect(() => {
    writeFlag(GIFT_KEY, gift ? '1' : '');
  }, [gift]);

  useEffect(() => {
    writeInsurance(insurance);
  }, [insurance]);

  useEffect(() => {
    writePknDiscount(useBalance);
  }, [useBalance]);

  useEffect(() => {
    writeShippingCountry(shippingChoice.country);
    writeShippingService(shippingChoice.service);
  }, [shippingChoice]);

  const applyAccountCart = useCallback((state) => {
    setItems(state.items.slice(0, CART_MAX));
    setSaved(state.saved.slice(0, SAVED_MAX));
    setGiftState(Boolean(state.gift));
  }, []);

  // Signed in: the same cart on every device (no-op signed out or offline).
  useAccountCartSync({ items, saved, gift, apply: applyAccountCart, normalize: fromAccountRows });

  const value = useMemo(() => {
    const totals = cartTotals(items);
    const checkoutItems = items.filter(isSelected);
    const canNftOnly = checkoutItems.length > 0
      && checkoutItems.every((row) => row.nftAvailable || row.reserveAvailable);
    return {
      items,
      saved,
      gift,
      insurance,
      useBalance,
      shippingChoice,
      count: totals.count,
      subtotalPkn: totals.subtotalPkn,
      totalPkn: totals.subtotalPkn,
      // Checkout sends only the ticked rows (Amazon: unticked stays in the basket).
      checkoutItems,
      checkoutCount: totals.selectedCount,
      checkoutSubtotalPkn: totals.selectedSubtotalPkn,
      canNftOnly,
      addItem(next) {
        if (!next?.id) {
          return;
        }
        setItems((current) => addCartRow(current, next));
        // Adding a saved copy moves it back rather than keeping it in both lists.
        setSaved((current) => dropSavedRow(current, next.id));
      },
      setQty(id, qty) {
        setItems((current) => {
          const row = current.find((item) => item.id === id);
          const cap = row ? listingStock(row) : 99;
          const next = Math.max(0, Math.min(cap, Number.parseInt(qty, 10) || 0));
          return next < 1
            ? current.filter((item) => item.id !== id)
            : current.map((item) => (item.id === id ? { ...item, qty: next } : item));
        });
      },
      removeItem(id) {
        setItems((current) => current.filter((row) => row.id !== id));
      },
      removeItems(ids) {
        const drop = new Set((ids || []).map(String));
        if (!drop.size) return;
        setItems((current) => current.filter((row) => !drop.has(String(row.id))));
      },
      /** Undo for Delete: the row goes back where it was. */
      restoreItem(row, index = 0) {
        if (!row?.id) return;
        setItems((current) => {
          if (current.some((item) => item.id === row.id)) return current;
          const at = Math.max(0, Math.min(current.length, Number(index) || 0));
          return [...current.slice(0, at), row, ...current.slice(at)].slice(0, CART_MAX);
        });
      },
      /** Undo for Delete all: the whole cart comes back, merged with anything added since. */
      restoreAll(rows) {
        const list = Array.isArray(rows) ? rows : [];
        setItems((current) => {
          const ids = new Set(current.map((row) => row.id));
          return [...current, ...list.filter((row) => row?.id && !ids.has(row.id))].slice(0, CART_MAX);
        });
      },
      /** Swap a row for another copy (cheaper or still in stock), keeping its place and tick. */
      replaceItem(id, next) {
        if (!next?.id) return;
        setItems((current) => {
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
        });
      },
      setSelected(id, on) {
        setItems((current) => current.map((row) => (
          row.id === id ? { ...row, selected: Boolean(on) } : row
        )));
      },
      selectAll(on) {
        setItems((current) => current.map((row) => ({
          ...row,
          // A sold-out copy stays unticked: checkout would refuse it.
          selected: Boolean(on) && !row.unavailable,
        })));
      },
      saveForLater(id) {
        const moved = moveRow(items, saved, id, SAVED_MAX);
        if (!moved.row) return;
        setItems(moved.from);
        setSaved(moved.to);
      },
      moveToCart(id) {
        const moved = moveRow(saved, [], id);
        if (!moved.row) return;
        const row = moved.row;
        setSaved(moved.from);
        setItems((current) => {
          const twin = current.find((item) => item.id === row.id);
          if (twin) {
            return current.map((item) => (item.id === row.id
              ? { ...item, qty: nextCartQty(item.qty, row.qty, listingStock(item)), selected: true }
              : item));
          }
          return [{ ...row, selected: !row.unavailable }, ...current].slice(0, CART_MAX);
        });
      },
      removeSaved(id) {
        setSaved((current) => current.filter((row) => row.id !== id));
      },
      /** Live listings for one card → price, stock, qty cap, sold-out flag on its rows. */
      applyLive(cardId, entry, options = {}) {
        setItems((current) => patchRows(current, cardId, entry, options));
        setSaved((current) => patchRows(current, cardId, entry, options));
      },
      setGift(on) {
        setGiftState(Boolean(on));
      },
      setInsurance(on) {
        setInsuranceState(Boolean(on));
      },
      /** "Use my site balance as a discount" — checkout starts with its voucher ticked. */
      setUseBalance(on) {
        setUseBalanceState(Boolean(on));
      },
      /** Merge { country?, service? } into the buyer's shipping choice. */
      setShippingChoice(patch) {
        setShippingChoiceState((current) => {
          const next = { ...current, ...(patch || {}) };
          if (next.country === current.country && next.service === current.service) return current;
          return { country: String(next.country || '').toUpperCase(), service: String(next.service || '') };
        });
      },
      /** Stripe leaves the SPA: remember which rows that payment covers. */
      markCheckoutPending(ids) {
        const list = (ids || []).map(String).filter(Boolean);
        writeFlag(PENDING_KEY, list.length ? JSON.stringify({ ids: list, at: Date.now() }) : '');
      },
      /**
       * Paid: drop the rows that checkout sent and keep the unticked ones.
       * Uses the row ids recorded before Stripe, else the paid order's
       * listing ids. Returns false when it had neither to go on.
       */
      settleCheckout({ listingIds = [] } = {}) {
        const rowIds = readPendingIds();
        if (!rowIds.length && !(listingIds || []).length) return false;
        setItems((current) => settleCheckoutRows(current, { rowIds, listingIds }));
        writeFlag(PENDING_KEY, '');
        setGiftState(false);
        return true;
      },
      clear() {
        setItems([]);
      },
    };
  }, [items, saved, gift, insurance, useBalance, shippingChoice]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  return useContext(CartContext);
}
