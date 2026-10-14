import { createEffect, createMemo, createSignal, onSettled, untrack } from 'solid-js';
import { readRecentCardIds, readWatchlistIds } from '@market/api.js';
import { fetchRecommendations } from '@market/cart-api.js';
import { liveMessages } from '@market/cart-model.js';
import {
  LIVE_WIDTH,
  RECHECK_AFTER_MS,
  RECOMMENDATIONS_DEBOUNCE_MS,
  fetchBuyAgain,
  fetchInspired,
  fetchLiveEntry,
  fetchShelfListings,
  fetchTilesSafe,
  inspiredNames,
  liveCardIds,
  mergeLiveNotes,
  orderCardTiles,
  recommendationInputs,
  runPool,
  shelfSellers,
  tileIds,
  withoutIds,
} from '@market/cart-rails-core.js';
import { syncRemoteRecentCardIds } from '@market/recents.js';
import { getBearer, signedIn } from '../stores/auth.js';

/**
 * Solid versions of the /cart data hooks in market/src/cart-rails.js. Inputs
 * are accessors, outputs are accessors; the rules are cart-rails-core.js.
 */

/**
 * React useCartLive: re-check cart and saved rows against live listings once
 * per card per visit (again when the tab returns after a while). Patches go
 * through `applyLive`; changes on cart rows become "Important messages".
 */
export function createCartLive({ items, saved, applyLive, excludeSellerUid }) {
  const [live, setLive] = createSignal({});
  const [checking, setChecking] = createSignal(0);
  const [messages, setMessages] = createSignal([]);
  const [round, setRound] = createSignal(0);
  const asked = new Set();
  let mounted = true;
  let lastCheck = 0;

  onSettled(() => {
    mounted = true;
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck < RECHECK_AFTER_MS) return;
      asked.clear();
      setRound((n) => n + 1);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  const ids = createMemo(() => liveCardIds(items(), saved()), {
    equals: (a, b) => a.join(',') === b.join(','),
  });

  createEffect(
    () => [ids(), round(), excludeSellerUid()],
    ([list, , exclude]) => {
      const todo = list.filter((id) => !asked.has(id));
      if (!todo.length) return;
      for (const id of todo) asked.add(id);
      lastCheck = Date.now();
      setChecking((n) => n + todo.length);
      void runPool(todo, LIVE_WIDTH, async (id) => {
        const entry = await fetchLiveEntry(id);
        if (!mounted) return;
        setChecking((n) => Math.max(0, n - 1));
        if (!entry) {
          asked.delete(id);
          return;
        }
        const rows = untrack(items).filter((row) => String(row.cardId) === id);
        const notes = liveMessages(rows, entry, { excludeSellerUid: exclude });
        setLive((current) => ({ ...current, [id]: entry }));
        if (notes.length) setMessages((current) => mergeLiveNotes(current, notes));
        applyLive(id, entry, { excludeSellerUid: exclude });
      });
    },
  );

  return {
    live,
    checking: () => checking() > 0,
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

/** React useCardTiles: catalogue tiles for card ids, in order (fallback rows for misses). */
export function createCardTiles(ids, fallback = () => null) {
  const wanted = createMemo(() => tileIds(ids()), { equals: (a, b) => a.join(',') === b.join(',') });
  const [state, setState] = createSignal({ key: '', cards: [] });
  createEffect(
    () => wanted().join(','),
    (key) => {
      if (!key) {
        setState({ key: '', cards: [] });
        return undefined;
      }
      let cancelled = false;
      const list = untrack(wanted);
      fetchTilesSafe(list).then((cards) => {
        if (!cancelled) setState({ key, cards: orderCardTiles(list, cards, untrack(fallback)) });
      });
      return () => {
        cancelled = true;
      };
    },
  );
  const key = () => wanted().join(',');
  return {
    cards: () => (state().key === key() ? state().cards : []),
    loading: () => Boolean(key()) && state().key !== key(),
  };
}

/** React useRecentIds: this browser's recently viewed, the account's list once signed in. */
export function createRecentIds() {
  const [ids, setIds] = createSignal(readRecentCardIds());
  createEffect(signedIn, (on) => {
    if (!on) return undefined;
    let cancelled = false;
    syncRemoteRecentCardIds()
      .then((next) => {
        if (!cancelled && Array.isArray(next) && next.length) setIds(() => next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });
  return ids;
}

/** React useWatchlistIds: read once per visit. */
export function readWatchIds() {
  return readWatchlistIds();
}

/** React useBuyAgain: cards from the signed-in buyer's paid orders, newest first. */
export function createBuyAgain(uid) {
  const [state, setState] = createSignal({ uid: '', cards: [] });
  createEffect(uid, (id) => {
    if (!id) {
      setState({ uid: '', cards: [] });
      return undefined;
    }
    let cancelled = false;
    fetchBuyAgain(id)
      .then((cards) => {
        if (!cancelled) setState({ uid: id, cards });
      })
      .catch(() => {
        if (!cancelled) setState({ uid: id, cards: [] });
      });
    return () => {
      cancelled = true;
    };
  });
  return {
    cards: () => (state().uid === uid() ? state().cards : []),
    loading: () => Boolean(uid()) && state().uid !== uid(),
  };
}

/** React useSellerShelves: other listings from the biggest parcels' sellers. */
export function createSellerShelves(groups, { max = 2, perSeller = 24 } = {}) {
  const sellers = createMemo(() => shelfSellers(groups(), max));
  const [shelves, setShelves] = createSignal({});
  createEffect(
    () => sellers().map((row) => row.handle).join(','),
    () => {
      let cancelled = false;
      const have = untrack(shelves);
      for (const seller of untrack(sellers)) {
        if (have[seller.handle]) continue;
        fetchShelfListings(seller.handle, perSeller).then((listings) => {
          if (!cancelled) setShelves((current) => ({ ...current, [seller.handle]: listings }));
        });
      }
      return () => {
        cancelled = true;
      };
    },
  );
  return () => sellers().map((seller) => ({ ...seller, listings: shelves()[seller.handle] || null }));
}

/** React useInspired: other printings of the last two Pokémon looked at. */
export function createInspired(cards, exclude, { perName = 12 } = {}) {
  const names = createMemo(() => inspiredNames(cards()), { equals: (a, b) => a.join('|') === b.join('|') });
  const [state, setState] = createSignal({ key: '', cards: [] });
  createEffect(
    () => names().join('|'),
    (key) => {
      if (!key) {
        setState({ key: '', cards: [] });
        return undefined;
      }
      let cancelled = false;
      fetchInspired(untrack(names), perName).then((merged) => {
        if (!cancelled) setState({ key, cards: merged });
      });
      return () => {
        cancelled = true;
      };
    },
  );
  return {
    names,
    cards: () => withoutIds(state().key === names().join('|') ? state().cards : [], exclude()),
  };
}

/**
 * React useRecommendations: personal rails from GET
 * /api/marketplace-recommendations. `status` is loading | ready | failed —
 * the page keeps its client rails until ready, and for good on failed.
 */
export function createRecommendations({ items, recentIds, watchIds }) {
  const inputs = createMemo(() => recommendationInputs({
    items: items(),
    recentIds: recentIds(),
    watchIds: watchIds(),
    signedIn: signedIn(),
  }));
  const [state, setState] = createSignal({ key: '', status: 'loading', rails: [], personalized: false });
  createEffect(
    () => inputs().key,
    (key) => {
      const controller = new AbortController();
      // Cart edits come in bursts (qty taps, ticks): wait for them to settle.
      const timer = setTimeout(async () => {
        const latest = untrack(inputs);
        let token = '';
        if (untrack(signedIn)) {
          try {
            token = (await getBearer()) || '';
          } catch (_) {
            token = '';
          }
        }
        try {
          const data = await fetchRecommendations({
            token,
            cart: latest.cart,
            recent: latest.recentIds,
            watch: latest.watchIds,
            sellers: latest.sellers,
            listings: latest.listings,
            signal: controller.signal,
          });
          setState({
            key,
            status: 'ready',
            rails: Array.isArray(data?.rails) ? data.rails : [],
            personalized: Boolean(data?.personalized),
          });
        } catch (_) {
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
    },
  );
  return state;
}
