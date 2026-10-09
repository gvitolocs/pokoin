import { createSignal } from 'solid-js';
import { cartTotals } from '@market/cart-model.js';

/** Same browser keys as market/src/cart.jsx — both UIs read one cart. */
export const CART_KEY = 'pokoin.cartItems';

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
 * Read side of the cart for the header (count) and drops. Writes (add, qty,
 * account sync) move here with the Cart page migration; until then the React
 * cart owns mutations and this store follows it through `storage`.
 */
export const cartItems = items;
export const cartCount = () => cartTotals(items()).count;
