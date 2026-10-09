// Signed-in cart sync for the React cart: the browser cart (localStorage,
// instant) and the account cart (GET/PUT /api/marketplace-cart-sync) kept in
// step, so the same cart, Saved for later and gift flag follow the buyer
// across devices. Signed out, or with the API unreachable, the cart simply
// stays local. The engine itself is framework-free (cart-sync-engine.js).

import { useEffect, useRef } from 'react';
import { useAuth } from './auth.jsx';
import { createAccountCartSync } from './cart-sync-engine.js';

async function bearer(getBearer) {
  try {
    return (await getBearer()) || '';
  } catch (_) {
    return '';
  }
}

/**
 * @param {object} opts
 * @param {Array} opts.items
 * @param {Array} opts.saved
 * @param {boolean} opts.gift
 * @param {(state: {items, saved, gift}) => void} opts.apply replace local state
 * @param {(rows: Array) => Array} opts.normalize server rows → cart rows
 */
export function useAccountCartSync({ items, saved, gift, apply, normalize }) {
  const { signedIn, user, profile, getBearer } = useAuth();
  const uid = signedIn ? String(user?.uid || profile?.uid || '') : '';
  const stateRef = useRef({ items, saved, gift });
  stateRef.current = { items, saved, gift };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;
  const bearerRef = useRef(getBearer);
  bearerRef.current = getBearer;
  const engine = useRef(null);
  if (!engine.current) {
    engine.current = createAccountCartSync({
      state: () => stateRef.current,
      apply: (state) => applyRef.current(state),
      normalize: (rows) => normalizeRef.current(rows),
      bearer: () => bearer(bearerRef.current),
    });
  }

  // First exchange for this account: fetch, merge or adopt, save if needed.
  useEffect(() => engine.current.begin(uid), [uid]);

  // Every later edit (add, qty, tick, save for later, live price patch): save soon.
  useEffect(() => {
    engine.current.changed(uid);
  }, [uid, items, saved, gift]);

  // Back online / back on the tab with unsaved edits: try again.
  useEffect(() => engine.current.watch(uid), [uid]);
}
