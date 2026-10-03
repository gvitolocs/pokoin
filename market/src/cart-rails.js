// Data behind the /cart page: live re-check of every cart row against its
// card's listings (Amazon's "reflects each item's most recent price"), and
// the rails — recently viewed, watchlist, Buy it again, more from sellers.

import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import {
  fetchAccountAddresses,
  fetchCardTiles,
  fetchListings,
  fetchSellerByUsername,
  peekRecentTile,
  readRecentCardIds,
  readWatchlistIds,
} from './api.js';
import { firestore, useAuth } from './auth.jsx';
import { fetchRecommendations } from './cart-api.js';
import { buyAgainCards, isSelected, liveMessages } from './cart-model.js';
import { sellerHandle } from './listing-meta.js';
import { countryFromLocale } from './pkn.js';
import { syncRemoteRecentCardIds } from './recents.js';
import { SHIP_TO_COUNTRIES } from './ship-countries.js';
import { fetchSpeciesCards } from './species-cards.js';

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
        const list = Array.isArray(data?.addresses) ? data.addresses : [];
        const preferred = list.find((row) => row.isDefault) || list[0];
        setFromAccount(String(preferred?.countryCode || '').toUpperCase());
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);
  if (fromAccount) return { country: fromAccount, saved: true };
  const locale = countryFromLocale();
  const known = SHIP_TO_COUNTRIES.some((row) => row.code === locale);
  return { country: known ? locale : 'DK', saved: false };
}

/** Listings per card for the re-check; fewer rows back means the whole book. */
export const LIVE_LIMIT = 200;
const LIVE_WIDTH = 4;
const RECHECK_AFTER_MS = 2 * 60 * 1000;

async function runPool(list, width, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const item = list[cursor];
      cursor += 1;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, () => worker()));
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

  const ids = useMemo(() => [...new Set(
    [...(items || []), ...(saved || [])].map((row) => String(row.cardId || '')).filter(Boolean),
  )].slice(0, 80), [items, saved]);
  const key = ids.join(',');

  useEffect(() => {
    const todo = ids.filter((id) => !asked.current.has(id));
    if (!todo.length) return;
    for (const id of todo) asked.current.add(id);
    lastCheck.current = Date.now();
    setChecking((n) => n + todo.length);
    void runPool(todo, LIVE_WIDTH, async (id) => {
      let data = null;
      try {
        data = await fetchListings(id, { limit: LIVE_LIMIT, fresh: true });
      } catch (_) {
        data = null;
      }
      if (!mounted.current) return;
      setChecking((n) => Math.max(0, n - 1));
      if (!data) {
        asked.current.delete(id);
        return;
      }
      const listings = Array.isArray(data.listings) ? data.listings : [];
      const entry = { listings, complete: listings.length < LIVE_LIMIT, at: Date.now() };
      const rows = itemsRef.current.filter((row) => String(row.cardId) === id);
      const notes = liveMessages(rows, entry, { excludeSellerUid });
      setLive((current) => ({ ...current, [id]: entry }));
      if (notes.length) {
        setMessages((current) => [
          ...current.filter((note) => !notes.some((next) => next.id === note.id)),
          ...notes,
        ]);
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

function named(card) {
  return Boolean(card && String(card.name || '').trim());
}

/**
 * Catalogue tiles for card ids, in that order. The tile API only knows part
 * of the catalogue, so a miss falls back to this browser's recent-tile cache
 * and then to `fallback` rows ({ id, name, canonicalPath }) — a name is
 * enough for CardArt to find the catalogue scan.
 */
export function useCardTiles(ids, fallback = null) {
  const wanted = useMemo(() => (ids || []).map(String).filter(Boolean).slice(0, 24), [ids]);
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
    const settle = (cards) => {
      if (cancelled) return;
      const byId = new Map((cards || []).map((card) => [String(card.id), card]));
      const spare = new Map((fallbackRef.current || []).map((card) => [String(card.id), card]));
      const ordered = wanted
        .map((id) => [byId.get(id), peekRecentTile(id), spare.get(id)].find(named))
        .filter(Boolean);
      // Ids the tile endpoint rewrote (provisional → public) still show up.
      const extra = (cards || []).filter((card) => named(card) && !wanted.includes(String(card.id)));
      setState({ key, cards: [...ordered, ...extra] });
    };
    fetchCardTiles(wanted).then(settle, () => settle([]));
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
    getDocs(query(collection(firestore, 'orders'), where('uid', '==', uid)))
      .then((snap) => {
        if (cancelled) return;
        const orders = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        setState({ uid, cards: buyAgainCards(orders) });
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
  const sellers = useMemo(() => {
    const out = [];
    const seen = new Set();
    const ranked = [...(groups || [])].sort((a, b) => b.subtotalPkn - a.subtotalPkn);
    for (const group of ranked) {
      const handle = sellerHandle({
        sellerUsername: group.sellerUsername,
        sellerName: group.sellerName,
      });
      const lower = handle.toLowerCase();
      if (!handle || seen.has(lower)) continue;
      seen.add(lower);
      out.push({ key: group.key, handle, sellerUid: group.sellerUid });
      if (out.length >= max) break;
    }
    return out;
  }, [groups, max]);
  const key = sellers.map((row) => row.handle).join(',');
  const [shelves, setShelves] = useState({});
  useEffect(() => {
    let cancelled = false;
    for (const seller of sellers) {
      if (shelves[seller.handle]) continue;
      fetchSellerByUsername(seller.handle, { limit: perSeller })
        .then((data) => {
          if (cancelled) return;
          const listings = Array.isArray(data?.listings) ? data.listings : [];
          setShelves((current) => ({ ...current, [seller.handle]: listings }));
        })
        .catch(() => {
          if (!cancelled) setShelves((current) => ({ ...current, [seller.handle]: [] }));
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
  const names = useMemo(() => {
    const out = [];
    for (const card of cards || []) {
      const name = String(card?.name || '').trim();
      if (name && !out.some((seen) => seen.toLowerCase() === name.toLowerCase())) out.push(name);
      if (out.length >= 2) break;
    }
    return out;
  }, [cards]);
  const key = names.join('|');
  const [state, setState] = useState({ key: '', cards: [] });
  useEffect(() => {
    if (!key) {
      setState({ key: '', cards: [] });
      return undefined;
    }
    let cancelled = false;
    Promise.all(names.map((name) => fetchSpeciesCards(name, { limit: perName }).catch(() => [])))
      .then((lists) => {
        if (cancelled) return;
        const seen = new Set();
        const merged = [];
        for (let at = 0; at < perName; at += 1) {
          for (const list of lists) {
            const card = list[at];
            const id = String(card?.id || card?.card_id || '');
            if (!id || seen.has(id) || !named(card)) continue;
            seen.add(id);
            merged.push(card);
          }
        }
        setState({ key, cards: merged });
      });
    return () => { cancelled = true; };
    // `names` is captured through `key`.
  }, [key, perName]);
  const skip = new Set((exclude || []).map(String));
  return {
    names,
    cards: (state.key === key ? state.cards : []).filter((card) => !skip.has(String(card.id))),
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
  const cart = useMemo(() => [...new Set((items || []).map((row) => String(row.cardId || '')).filter(Boolean))], [items]);
  const sellers = useMemo(() => [...new Set((items || [])
    .filter(isSelected)
    .map((row) => String(row.sellerUid || ''))
    .filter(Boolean))], [items]);
  const listings = useMemo(() => (items || []).map((row) => String(row.listingId || '')).filter(Boolean), [items]);
  const key = [cart.join(','), sellers.join(','), (recentIds || []).slice(0, 24).join(','), (watchIds || []).slice(0, 24).join(','), signedIn ? 'in' : 'out'].join('|');
  const inputs = useRef({});
  inputs.current = { cart, sellers, listings, recentIds, watchIds };
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
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, signedIn, getBearer]);

  return state;
}
