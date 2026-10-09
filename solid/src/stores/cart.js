import { createSignal } from 'solid-js';
import { cartTotals } from '@market/cart-model.js';
import {
  addCartRow,
  CART_KEY as SHARED_CART_KEY,
  CART_MAX,
  dropSavedRow,
  readCartRows,
  SAVED_KEY,
  SAVED_MAX,
  writeCartRows,
} from '@market/cart-rows.js';

/** Same browser keys as market/src/cart.jsx — both UIs read one cart. */
export const CART_KEY = SHARED_CART_KEY;

function readRows(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter((row) => row && row.id) : [];
  } catch (_) {
    return [];
  }
}

const [items, setItems] = createSignal(readRows(CART_KEY));

if (typeof window !== 'undefined') {
  // Another tab (or the React UI) changed the cart.
  window.addEventListener('storage', (event) => {
    if (event.key === CART_KEY || event.key === null) setItems(readRows(CART_KEY));
  });
}

/**
 * Read side of the cart for the header (count) and drops, plus the desk's
 * add-to-cart. The rest of the mutations (qty, remove, account sync) move
 * here with the Cart page migration; until then the React cart owns them and
 * this store follows it through `storage`.
 */
export const cartItems = items;
export const cartCount = () => cartTotals(items()).count;

/**
 * React CartProvider.addItem on the same storage: the row lands in
 * `pokoin.cartItems` (qty topped up for the same listing) and leaves
 * `pokoin.cartSaved`. The React cart merges it with the account cart on load.
 */
export function addCartItem(next) {
  if (!next?.id) return;
  const rows = addCartRow(readCartRows(CART_KEY), next, CART_MAX);
  writeCartRows(CART_KEY, rows, CART_MAX);
  const saved = readCartRows(SAVED_KEY);
  const kept = dropSavedRow(saved, next.id);
  if (kept !== saved) writeCartRows(SAVED_KEY, kept, SAVED_MAX);
  setItems(rows);
}
