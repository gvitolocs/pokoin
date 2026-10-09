import { createEffect, createRoot, createSignal, runWithOwner } from 'solid-js';
import { cartTotals } from '@market/cart-model.js';
import {
  CART_KEY,
  CART_MAX,
  GIFT_KEY,
  SAVED_KEY,
  SAVED_MAX,
  addCartRow,
  dropSavedRow,
  fromAccountRows,
  readCartGift,
  readCartRows,
  removeCartRow,
  setCartRowQty,
  writeCartFlag,
  writeCartRows,
  writeSavedRows,
} from '@market/cart-rows.js';
import { authUser, getBearer, signedIn } from './auth.js';
import { authSession } from './session.js';

export { CART_KEY };

/**
 * The browser cart (market/src/cart.jsx): same localStorage keys, same row
 * rules (market/src/cart-rows.js), same account-cart sync engine. Plain
 * module variables are the source of truth so a burst of adds in one tick
 * (a dropped artist) folds into one list; the signals publish it and the
 * storage write is coalesced to one per tick, like React's single render.
 */
const browser = typeof window !== 'undefined';
let rows = browser ? readCartRows(CART_KEY) : [];
let savedRows = browser ? readCartRows(SAVED_KEY) : [];
let giftOn = browser ? readCartGift() : false;

const [items, setItems] = createSignal(rows);
const [saved, setSaved] = createSignal(savedRows);
const [gift, setGift] = createSignal(giftOn);

let writeQueued = false;
function persistSoon() {
  if (writeQueued) return;
  writeQueued = true;
  queueMicrotask(() => {
    writeQueued = false;
    writeCartRows(rows);
    writeSavedRows(savedRows);
    writeCartFlag(GIFT_KEY, giftOn ? '1' : '');
  });
}

function commit(nextItems, nextSaved = savedRows, nextGift = giftOn) {
  const changed = nextItems !== rows || nextSaved !== savedRows || nextGift !== giftOn;
  if (!changed) return;
  if (nextItems !== rows) {
    rows = nextItems;
    setItems(() => nextItems);
  }
  if (nextSaved !== savedRows) {
    savedRows = nextSaved;
    setSaved(() => nextSaved);
  }
  if (nextGift !== giftOn) {
    giftOn = nextGift;
    setGift(nextGift);
  }
  persistSoon();
}

if (browser) {
  // Another tab (or the React UI in one) changed the cart.
  window.addEventListener('storage', (event) => {
    if (event.key === CART_KEY || event.key === null) {
      rows = readCartRows(CART_KEY);
      setItems(() => rows);
    }
    if (event.key === SAVED_KEY || event.key === null) {
      savedRows = readCartRows(SAVED_KEY);
      setSaved(() => savedRows);
    }
    if (event.key === GIFT_KEY || event.key === null) {
      giftOn = readCartGift();
      setGift(giftOn);
    }
  });
}

export const cartItems = items;
export const cartSaved = saved;
export const cartGift = gift;
export const cartCount = () => cartTotals(items()).count;

/** useCart().addItem: a copy already in the cart gains qty; a saved copy moves back. */
export function addCartItem(next) {
  if (!next?.id) return;
  commit(addCartRow(rows, next), dropSavedRow(savedRows, next.id));
}

/** useCart().setQty: below 1 removes the row. */
export function setCartQty(id, qty) {
  commit(setCartRowQty(rows, id, qty));
}

/** useCart().removeItem. */
export function removeCartItem(id) {
  commit(removeCartRow(rows, id));
}

// ---------------------------------------------------------------------------
// Account cart sync (market/src/cart-sync.js): same engine, same triggers.
// Started (and its chunk loaded) after the first paint so a signed-in visit
// does not pull Firebase Auth in before the page is up.
let syncStarted = false;

async function bearer() {
  try {
    return (await getBearer()) || '';
  } catch (_) {
    return '';
  }
}

export async function startCartSync() {
  if (syncStarted || !browser) return;
  syncStarted = true;
  const { createAccountCartSync } = await import('@market/cart-sync-engine.js');
  const engine = createAccountCartSync({
    state: () => ({ items: rows, saved: savedRows, gift: giftOn }),
    apply: (state) => commit(
      state.items.slice(0, CART_MAX),
      state.saved.slice(0, SAVED_MAX),
      Boolean(state.gift),
    ),
    normalize: fromAccountRows,
    bearer,
  });
  const uid = () => (signedIn() ? String(authUser()?.uid || authSession()?.uid || '') : '');
  // App-lifetime: detached from whichever owner happened to call this.
  runWithOwner(null, () => createRoot(() => {
    createEffect(uid, (owner) => {
      const cancel = engine.begin(owner);
      const unwatch = engine.watch(owner);
      return () => {
        cancel();
        unwatch();
      };
    });
    createEffect(
      () => [uid(), items(), saved(), gift()],
      ([owner]) => engine.changed(owner),
    );
  }));
}
