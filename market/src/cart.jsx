import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { cartTotals, isSelected, moveRow, patchLiveRows, settleCheckoutRows } from './cart-model.js';
import {
  CART_KEY,
  CART_MAX,
  GIFT_KEY,
  SAVED_KEY,
  SAVED_MAX,
  addCartRow,
  cartItemFromOffer,
  dropSavedRow,
  fromAccountRows,
  readCartGift,
  readCartRows,
  removeCartRow,
  setCartRowQty,
  writeCartFlag,
  writeCartRows,
  writeSavedRows,
} from './cart-rows.js';
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
} from './cart-row-edits.js';
import { useAccountCartSync } from './cart-sync.js';
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

export { cartItemFromOffer };

const readRows = readCartRows;
const writeCart = writeCartRows;
const writeSaved = writeSavedRows;
const writeFlag = writeCartFlag;
const readGift = readCartGift;

function readCart() {
  return readRows(CART_KEY);
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

export { CHECKOUT_SHIPPING_PKN } from './checkout-model.js';

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
        setItems((current) => setCartRowQty(current, id, qty));
      },
      removeItem(id) {
        setItems((current) => removeCartRow(current, id));
      },
      removeItems(ids) {
        const drop = new Set((ids || []).map(String));
        if (!drop.size) return;
        setItems((current) => current.filter((row) => !drop.has(String(row.id))));
      },
      /** Undo for Delete: the row goes back where it was. */
      restoreItem(row, index = 0) {
        if (!row?.id) return;
        setItems((current) => restoreCartRow(current, row, index));
      },
      /** Undo for Delete all: the whole cart comes back, merged with anything added since. */
      restoreAll(rows) {
        setItems((current) => restoreCartRows(current, rows));
      },
      /** Swap a row for another copy (cheaper or still in stock), keeping its place and tick. */
      replaceItem(id, next) {
        if (!next?.id) return;
        setItems((current) => replaceCartRow(current, id, next));
      },
      setSelected(id, on) {
        setItems((current) => selectCartRow(current, id, on));
      },
      selectAll(on) {
        setItems((current) => selectAllCartRows(current, on));
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
        setItems((current) => moveSavedIntoCart(current, row));
      },
      removeSaved(id) {
        setSaved((current) => current.filter((row) => row.id !== id));
      },
      /** Live listings for one card → price, stock, qty cap, sold-out flag on its rows. */
      applyLive(cardId, entry, options = {}) {
        setItems((current) => patchLiveRows(current, cardId, entry, options));
        setSaved((current) => patchLiveRows(current, cardId, entry, options));
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
        setShippingChoiceState((current) => mergeShippingChoice(current, patch));
      },
      /** Stripe leaves the SPA: remember which rows that payment covers. */
      markCheckoutPending(ids) {
        writePendingCheckout(ids);
      },
      /**
       * Paid: drop the rows that checkout sent and keep the unticked ones.
       * Uses the row ids recorded before Stripe, else the paid order's
       * listing ids. Returns false when it had neither to go on.
       */
      settleCheckout({ listingIds = [] } = {}) {
        const rowIds = readPendingCheckoutIds();
        if (!rowIds.length && !(listingIds || []).length) return false;
        setItems((current) => settleCheckoutRows(current, { rowIds, listingIds }));
        writePendingCheckout([]);
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
