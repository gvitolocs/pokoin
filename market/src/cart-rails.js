// Data behind the /cart page: live re-check of every cart row against its
// card's listings (Amazon's "reflects each item's most recent price"), and
// the rails — recently viewed, watchlist, Buy it again, more from sellers.
// React hooks over the shared rules in cart-rails-core.js.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAccountAddresses,
  readRecentCardIds,
  readWatchlistIds,
} from './api.js';
import { useAuth } from './auth.jsx';
import { fetchRecommendations } from './cart-api.js';
import { liveMessages } from './cart-model.js';
import {
  LIVE_WIDTH,
  RECHECK_AFTER_MS,
  RECOMMENDATIONS_DEBOUNCE_MS,
  deliveryCountryFrom,
  fetchBuyAgain,
  fetchInspired,
  fetchLiveEntry,
  fetchShelfListings,
  fetchTilesSafe,
  inspiredNames,
  liveCardIds,
  mergeLiveNotes,
  orderCardTiles,
  preferredAddressCountry,
  recommendationInputs,
  runPool,
  shelfSellers,
  tileIds,
  withoutIds,
} from './cart-rails-core.js';
import { syncRemoteRecentCardIds } from './recents.js';

export { LIVE_LIMIT } from './cart-rails-core.js';

/**
 * Amazon's "Deliver to …": the default saved address country (masked list,
 * no street data), else the browser locale — the country checkout quotes first.
 */
export function useDeliveryCountry({ signedIn, getBearer }) {
  const [fromAccount, setFromAccount] = useState('');
  useEffect(() => {
    if (!signedIn) {
      setFromAccount('');
      return undefined;
    }
    let cancelled = false;
    getBearer()
      .then((token) => (token ? fetchAccountAddresses(token, { reveal: false }) : null))
      .then((data) => {
        if (cancelled) return;
        setFromAccount(preferredAddressCountry(data));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);
  return deliveryCountryFrom(fromAccount);
}

/**
 * Re-check cart and saved rows against live listings once per card per
 * visit (and again when the tab comes back after a while). Patches land
 * through `applyLive`; price/stock/sold-out changes on cart rows become
 * Amazon-style "Important messages".
 */
export function useCartLive({ items, saved, applyLive, excludeSellerUid = '' }) {
  const [live, setLive] = useState({});
  const [checking, setChecking] = useState(0);
  const [messages, setMessages] = useState([]);
  const [round, setRound] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const applyRef = useRef(applyLive);
  applyRef.current = applyLive;
  const asked = useRef(new Set());
  const mounted = useRef(true);
  const lastCheck = useRef(0);

  // StrictMode re-runs this after a fake unmount, so set the flag on mount too.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const ids = useMemo(() => liveCardIds(items, saved), [items, saved]);
  const key = ids.join(',');

  useEffect(() => {
    const todo = ids.filter((id) => !asked.current.has(id));
    if (!todo.length) return;
    for (const id of todo) asked.current.add(id);
    lastCheck.current = Date.now();
    setChecking((n) => n + todo.length);
    void runPool(todo, LIVE_WIDTH, async (id) => {
      const entry = await fetchLiveEntry(id);
      if (!mounted.current) return;
      setChecking((n) => Math.max(0, n - 1));
      if (!entry) {
        asked.current.delete(id);
        return;
      }
      const rows = itemsRef.current.filter((row) => String(row.cardId) === id);
      const notes = liveMessages(rows, entry, { excludeSellerUid });
      setLive((current) => ({ ...current, [id]: entry }));
      if (notes.length) {
        setMessages((current) => mergeLiveNotes(current, notes));
      }
      applyRef.current(id, entry, { excludeSellerUid });
    });
    // `round` re-runs the check after the tab was away for a while.
  }, [key, round, excludeSellerUid]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck.current < RECHECK_AFTER_MS) return;
      asked.current.clear();
      setRound((n) => n + 1);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return {
    live,
    checking: checking > 0,
    messages,
    dismiss(id) {
      setMessages((current) => current.filter((note) => note.id !== id));
    },
    /** A deleted or swapped row's notes no longer apply. */
    dismissRow(rowId) {
      setMessages((current) => current.filter((note) => note.rowId !== rowId));
    },
  };
}

/**
 * Catalogue tiles for card ids, in that order (orderCardTiles: tile API, then
 * this browser's recent-tile cache, then `fallback` rows).
 */
export function useCardTiles(ids, fallback = null) {
  const wanted = useMemo(() => tileIds(ids), [ids]);
  const key = wanted.join(',');
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const [state, setState] = useState({ key: '', cards: [] });
  useEffect(() => {
    if (!key) {
      setState({ key: '', cards: [] });
      return undefined;
    }
    let cancelled = false;
    fetchTilesSafe(wanted).then((cards) => {
      if (cancelled) return;
      setState({ key, cards: orderCardTiles(wanted, cards, fallbackRef.current) });
    });
    return () => { cancelled = true; };
    // `wanted` is captured through `key`.
  }, [key]);
  return { cards: state.key === key ? state.cards : [], loading: Boolean(key) && state.key !== key };
}

/** Recently viewed ids: this browser first, the account's list once signed in. */
export function useRecentIds(signedIn) {
  const [ids, setIds] = useState(() => readRecentCardIds());
  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    syncRemoteRecentCardIds()
      .then((next) => {
        if (!cancelled && Array.isArray(next) && next.length) setIds(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [signedIn]);
  return ids;
}

export function useWatchlistIds() {
  const [ids] = useState(() => readWatchlistIds());
  return ids;
}

/** Cards from the signed-in buyer's paid orders, newest first. */
export function useBuyAgain(uid) {
  const [state, setState] = useState({ uid: '', cards: [] });
  useEffect(() => {
    if (!uid) {
      setState({ uid: '', cards: [] });
      return undefined;
    }
    let cancelled = false;
    fetchBuyAgain(uid)
      .then((cards) => {
        if (!cancelled) setState({ uid, cards });
      })
      .catch(() => {
        if (!cancelled) setState({ uid, cards: [] });
      });
    return () => { cancelled = true; };
  }, [uid]);
  return { cards: state.uid === uid ? state.cards : [], loading: Boolean(uid) && state.uid !== uid };
}

/**
 * Other listings from the sellers already in the cart — the cards that ride
 * in a parcel you are paying shipping for anyway. Biggest parcels first.
 */
export function useSellerShelves(groups, { max = 2, perSeller = 24 } = {}) {
  const sellers = useMemo(() => shelfSellers(groups, max), [groups, max]);
  const key = sellers.map((row) => row.handle).join(',');
  const [shelves, setShelves] = useState({});
  useEffect(() => {
    let cancelled = false;
    for (const seller of sellers) {
      if (shelves[seller.handle]) continue;
      fetchShelfListings(seller.handle, perSeller).then((listings) => {
        if (!cancelled) setShelves((current) => ({ ...current, [seller.handle]: listings }));
      });
    }
    return () => { cancelled = true; };
    // Re-run only when the set of sellers changes.
  }, [key]);
  return sellers.map((seller) => ({ ...seller, listings: shelves[seller.handle] || null }));
}

/**
 * "Inspired by your browsing history": other printings of the last two
 * Pokémon you looked at, interleaved, minus what you already saw or carry.
 */
export function useInspired(cards, { exclude = [], perName = 12 } = {}) {
  const names = useMemo(() => inspiredNames(cards), [cards]);
  const key = names.join('|');
  const [state, setState] = useState({ key: '', cards: [] });
  useEffect(() => {
    if (!key) {
      setState({ key: '', cards: [] });
      return undefined;
    }
    let cancelled = false;
    fetchInspired(names, perName).then((merged) => {
      if (!cancelled) setState({ key, cards: merged });
    });
    return () => { cancelled = true; };
    // `names` is captured through `key`.
  }, [key, perName]);
  return {
    names,
    cards: withoutIds(state.key === key ? state.cards : [], exclude),
  };
}

/**
 * Personal rails from GET /api/marketplace-recommendations: the cart, this
 * browser's recently viewed and watchlist, plus (signed in) the account's own
 * cart, history and orders. `status` is 'loading' | 'ready' | 'failed' —
 * the page keeps its client-side rails until 'ready', and for good on 'failed'.
 */
export function useRecommendations({ items, recentIds, watchIds }) {
  const { signedIn, getBearer } = useAuth();
  const latest = recommendationInputs({ items, recentIds, watchIds, signedIn });
  const { key } = latest;
  const inputs = useRef(latest);
  inputs.current = latest;
  const [state, setState] = useState({ key: '', status: 'loading', rails: [], personalized: false });

  useEffect(() => {
    const controller = new AbortController();
    // Cart edits come in bursts (qty taps, ticks): wait for them to settle.
    const timer = setTimeout(async () => {
      let token = '';
      if (signedIn) {
        try {
          token = (await getBearer()) || '';
        } catch (_) {
          token = '';
        }
      }
      try {
        const data = await fetchRecommendations({
          token,
          cart: inputs.current.cart,
          recent: inputs.current.recentIds,
          watch: inputs.current.watchIds,
          sellers: inputs.current.sellers,
          listings: inputs.current.listings,
          signal: controller.signal,
        });
        setState({
          key,
          status: 'ready',
          rails: Array.isArray(data?.rails) ? data.rails : [],
          personalized: Boolean(data?.personalized),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => (current.status === 'ready'
          ? current
          : { key, status: 'failed', rails: [], personalized: false }));
      }
    }, RECOMMENDATIONS_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, signedIn, getBearer]);

  return state;
}
