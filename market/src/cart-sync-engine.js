// Signed-in cart sync engine, framework-free: the browser cart (localStorage,
// instant) and the account cart (GET/PUT /api/marketplace-cart-sync) kept in
// step, so the same cart, Saved for later and gift flag follow the buyer
// across devices. Signed out, or with the API unreachable, the cart simply
// stays local. React drives it from cart-sync.js, Solid from its cart store.

import { fetchAccountCart, saveAccountCart } from './cart-api.js';
import { cartSignature, mergeCartStates } from './cart-model.js';

const SYNC_KEY = 'pokoin.cartSync';
const SAVE_DELAY_MS = 800;

function readMeta() {
  try {
    const meta = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    return meta && typeof meta === 'object' ? meta : {};
  } catch (_) {
    return {};
  }
}

function writeMeta(meta) {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(meta));
  } catch (_) {
    /* private mode: sync state lives in memory */
  }
}

/**
 * @param {object} opts
 * @param {() => {items, saved, gift}} opts.state the current local cart
 * @param {(state: {items, saved, gift}) => void} opts.apply replace local state
 * @param {(rows: Array) => Array} opts.normalize server rows → cart rows
 * @param {() => Promise<string>} opts.bearer a token, or '' (never throws)
 */
export function createAccountCartSync({ state, apply, normalize, bearer }) {
  let syncedSig = null;
  let readyFor = '';
  let timer = 0;
  let saving = false;
  let again = false;

  function remoteState(cart) {
    return {
      items: normalize(cart?.items || []),
      saved: normalize(cart?.saved || []),
      gift: Boolean(cart?.gift),
      rev: Number(cart?.rev) || 0,
    };
  }

  function adopt(next) {
    if (cartSignature(next) !== cartSignature(state())) apply(next);
    syncedSig = cartSignature(next);
  }

  async function flush(owner) {
    if (!owner || readyFor !== owner) return;
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    try {
      const token = await bearer();
      if (!token) return;
      const current = state();
      const sig = cartSignature(current);
      if (sig === syncedSig) return;
      const meta = readMeta();
      try {
        const cart = await saveAccountCart(token, { ...current, baseRev: Number(meta.rev) || 0 });
        syncedSig = sig;
        writeMeta({ uid: owner, rev: Number(cart?.rev) || 0, dirty: cartSignature(state()) !== sig });
      } catch (error) {
        if (error.status !== 409 || !error.body?.cart) {
          writeMeta({ ...meta, uid: owner, dirty: true });
          return;
        }
        // Another device saved first: fold our edits into theirs, save once more.
        const remote = remoteState(error.body.cart);
        const { state: merged } = mergeCartStates(state(), remote, { uid: owner, rev: meta.rev, dirty: true }, owner);
        adopt(merged);
        try {
          const cart = await saveAccountCart(token, { ...merged, baseRev: remote.rev });
          writeMeta({ uid: owner, rev: Number(cart?.rev) || 0, dirty: false });
        } catch (_) {
          writeMeta({ uid: owner, rev: remote.rev, dirty: true });
        }
      }
    } finally {
      saving = false;
      if (again) {
        again = false;
        schedule(owner);
      }
    }
  }

  function schedule(owner) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void flush(owner);
    }, SAVE_DELAY_MS);
  }

  /** First exchange for this account: fetch, merge or adopt, save if needed. Returns cancel. */
  function begin(uid) {
    readyFor = '';
    if (!uid) return () => {};
    let cancelled = false;
    (async () => {
      const token = await bearer();
      if (!token || cancelled) return;
      let cart;
      try {
        cart = await fetchAccountCart(token);
      } catch (_) {
        return; // API missing or offline: the cart stays local this visit.
      }
      if (cancelled) return;
      const remote = remoteState(cart);
      const meta = readMeta();
      const { state: merged, save } = mergeCartStates(state(), remote, meta, uid);
      adopt(merged);
      readyFor = uid;
      if (save) {
        writeMeta({ uid, rev: remote.rev, dirty: true });
        syncedSig = null;
        void flush(uid);
        return;
      }
      writeMeta({ uid, rev: Math.max(remote.rev, meta.uid === uid ? Number(meta.rev) || 0 : 0), dirty: false });
    })();
    return () => {
      cancelled = true;
    };
  }

  /** Every later edit (add, qty, tick, save for later, live price patch): save soon. */
  function changed(uid) {
    if (!uid || readyFor !== uid) return;
    if (cartSignature(state()) === syncedSig) return;
    writeMeta({ ...readMeta(), uid, dirty: true });
    schedule(uid);
  }

  /** Back online / back on the tab with unsaved edits: try again. Returns cleanup. */
  function watch(uid) {
    if (!uid) return () => {};
    const retry = () => {
      if (document.visibilityState === 'hidden') return;
      if (readMeta().dirty) schedule(uid);
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
      window.clearTimeout(timer);
    };
  }

  return { begin, changed, watch };
}
