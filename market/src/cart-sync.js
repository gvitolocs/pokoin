// Signed-in cart sync: the browser cart (localStorage, instant) and the
// account cart (GET/PUT /api/marketplace-cart-sync) kept in step, so the same
// cart, Saved for later and gift flag follow the buyer across devices.
// Signed out, or with the API unreachable, the cart simply stays local.

import { useEffect, useRef } from 'react';
import { useAuth } from './auth.jsx';
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
  const syncedSig = useRef(null);
  const readyFor = useRef('');
  const timer = useRef(0);
  const saving = useRef(false);
  const again = useRef(false);

  function remoteState(cart) {
    return {
      items: normalizeRef.current(cart?.items || []),
      saved: normalizeRef.current(cart?.saved || []),
      gift: Boolean(cart?.gift),
      rev: Number(cart?.rev) || 0,
    };
  }

  function adopt(state) {
    if (cartSignature(state) !== cartSignature(stateRef.current)) applyRef.current(state);
    syncedSig.current = cartSignature(state);
  }

  async function flush(owner) {
    if (!owner || readyFor.current !== owner) return;
    if (saving.current) {
      again.current = true;
      return;
    }
    saving.current = true;
    try {
      const token = await bearer(bearerRef.current);
      if (!token) return;
      const state = stateRef.current;
      const sig = cartSignature(state);
      if (sig === syncedSig.current) return;
      const meta = readMeta();
      try {
        const cart = await saveAccountCart(token, { ...state, baseRev: Number(meta.rev) || 0 });
        syncedSig.current = sig;
        writeMeta({ uid: owner, rev: Number(cart?.rev) || 0, dirty: cartSignature(stateRef.current) !== sig });
      } catch (error) {
        if (error.status !== 409 || !error.body?.cart) {
          writeMeta({ ...meta, uid: owner, dirty: true });
          return;
        }
        // Another device saved first: fold our edits into theirs, save once more.
        const remote = remoteState(error.body.cart);
        const { state: merged } = mergeCartStates(stateRef.current, remote, { uid: owner, rev: meta.rev, dirty: true }, owner);
        adopt(merged);
        try {
          const cart = await saveAccountCart(token, { ...merged, baseRev: remote.rev });
          writeMeta({ uid: owner, rev: Number(cart?.rev) || 0, dirty: false });
        } catch (_) {
          writeMeta({ uid: owner, rev: remote.rev, dirty: true });
        }
      }
    } finally {
      saving.current = false;
      if (again.current) {
        again.current = false;
        schedule(owner);
      }
    }
  }

  function schedule(owner) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void flush(owner);
    }, SAVE_DELAY_MS);
  }

  // First exchange for this account: fetch, merge or adopt, save if needed.
  useEffect(() => {
    readyFor.current = '';
    if (!uid) return undefined;
    let cancelled = false;
    (async () => {
      const token = await bearer(bearerRef.current);
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
      const { state, save } = mergeCartStates(stateRef.current, remote, meta, uid);
      adopt(state);
      readyFor.current = uid;
      if (save) {
        writeMeta({ uid, rev: remote.rev, dirty: true });
        syncedSig.current = null;
        void flush(uid);
        return;
      }
      writeMeta({ uid, rev: Math.max(remote.rev, meta.uid === uid ? Number(meta.rev) || 0 : 0), dirty: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [uid]);

  // Every later edit (add, qty, tick, save for later, live price patch): save soon.
  useEffect(() => {
    if (!uid || readyFor.current !== uid) return undefined;
    if (cartSignature({ items, saved, gift }) === syncedSig.current) return undefined;
    writeMeta({ ...readMeta(), uid, dirty: true });
    schedule(uid);
    return undefined;
  }, [uid, items, saved, gift]);

  // Back online / back on the tab with unsaved edits: try again.
  useEffect(() => {
    if (!uid) return undefined;
    const retry = () => {
      if (document.visibilityState === 'hidden') return;
      if (readMeta().dirty) schedule(uid);
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
      window.clearTimeout(timer.current);
    };
  }, [uid]);
}
