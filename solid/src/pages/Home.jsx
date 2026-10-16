import { createEffect, createMemo, createSignal, createStore, For, onSettled, reconcile, Repeat, Show, snapshot, untrack } from 'solid-js';
import {
  attachRecentsToHome,
  fetchCard,
  fetchCardTiles,
  fetchExpansion,
  fetchExpansions,
  fetchHome,
  fetchHomeRail,
  fillMissingLastMedianPrices,
  mergeHomeRail,
  setSlug,
  warmupSearchBar,
} from '@market/api.js';
import { ASSET_COVERAGE_LINE } from '@market/buyer-protection.js';
import { fetchRail, RAIL, tileHasName } from '@market/lists.js';
import { isSetDeskCard } from '@market/search-filters.js';
import { game, gameHref, isPokemonGame } from '@market/game.js';
import { HOME_BROWSE_BLOCK, createEnglishBrowseState, fillEnglishBrowse } from '@market/home-browse.js';
import { readHomeVectorCache, scheduleHomeVectorCacheWrite } from '@market/home-cache.js';
import { tilePricePkn } from '@market/pkn.js';
import {
  RECENT_MAX,
  pruneUnresolvedRecents,
  readRecentCardIds,
  readRecentTiles,
  rememberRecentTiles,
} from '@market/recents.js';
import {
  RECENT_RAIL_SHOWN,
  refreshRecentTiles,
  refreshTile,
  stableRecentIds,
  syncRecentAccount,
} from '@market/recents-rail.js';
import { Action, track } from '@market/track.js';
import { isOriginDownError, publicErrorMessage } from '@market/working-page.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import Carousel, { SkeletonTile } from '../components/Carousel.jsx';
import PromoCarousel from '../components/PromoCarousel.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { loadAuth } from '../stores/auth.js';
import { authSession } from '../stores/session.js';

// Pure helpers.
function cardsForIds(cards, ids) {
  const byId = new Map((cards || []).map((card) => [String(card.id), card]));
  return (ids || []).map((id) => byId.get(String(id))).filter(tileHasName).filter(isSetDeskCard);
}

function spotlightBrowse(payload) {
  return cardsForIds(payload?.cards, payload?.sections?.spotlightIds);
}

function paintHome(payload, recentIds, extraCards = []) {
  return attachRecentsToHome(payload, recentIds, extraCards);
}

function localExtras(tiles = []) {
  return [...readRecentTiles(), ...tiles];
}

function seedHome(cached) {
  const ids = readRecentCardIds();
  const extras = localExtras();
  if (cached) return paintHome(cached, ids, extras);
  if (!extras.length) return null;
  return paintHome({ cards: [], sections: {} }, ids, extras);
}

function railsReady(payload) {
  const sections = payload?.sections || {};
  return Boolean(sections.newArrivalIds?.length || sections.bestSellerIds?.length || sections.featuredIds?.length);
}

function recentsNeedingTiles(payload, ids) {
  const byId = new Map((payload?.cards || []).map((card) => [String(card.id), card]));
  return (ids || []).filter((id) => {
    const card = byId.get(String(id));
    return !tileHasName(card) || tilePricePkn(card) == null;
  });
}

/** `extras(tiles)`: the rail's own tiles plus `tiles` (the page's railExtras). */
async function fillMissingRecents(payload, ids, extras = localExtras) {
  const first = paintHome(payload, ids, extras());
  const need = recentsNeedingTiles(first, ids);
  if (!need.length) return first;
  // A tile already on screen only takes the read's price and stock (refreshTile).
  const painted = new Map((first.cards || []).map((card) => [String(card.id), card]));
  const fetched = await fetchCardTiles(need).catch(() => []);
  const tiles = fetched.map((tile) => refreshTile(painted.get(String(tile.id)), tile));
  rememberRecentTiles(tiles);
  const filled = paintHome(payload, ids, extras(tiles));
  const still = recentsNeedingTiles(filled, ids).filter((id) => {
    const card = (filled.cards || []).find((row) => String(row.id) === String(id));
    return !tileHasName(card);
  });
  if (!still.length) return filled;
  const rows = await Promise.all(
    still.slice(0, 8).map((id) => fetchCard(id).then((row) => row?.card || null).catch(() => null)),
  );
  const hydrated = rows.filter(Boolean);
  rememberRecentTiles(hydrated);
  const next = paintHome(payload, ids, extras([...tiles, ...hydrated]));
  const resolved = (next.sections?.recentlySeenIds || []).filter((id) => {
    const card = (next.cards || []).find((row) => String(row.id) === String(id));
    return tileHasName(card);
  });
  if (resolved.length !== ids.length) {
    // Forget only the ids that did not resolve: `ids` is the rail's order, not the stored list.
    const shown = new Set(resolved.map(String));
    const failed = new Set(ids.map(String).filter((id) => !shown.has(id)));
    pruneUnresolvedRecents(readRecentCardIds().filter((id) => !failed.has(id)));
    return paintHome(payload, resolved, extras([...tiles, ...hydrated]));
  }
  return next;
}

/**
 * The landing as the visitor left it, kept for a short while: Back from a card
 * desk repaints the same rails and the same browse grid from memory instead of
 * fetching every rail again and drawing a different grid under the restored
 * scroll position. After HOME_KEEP_MS the next visit loads fresh.
 */
const HOME_KEEP_MS = 120_000;
let kept = null;

/**
 * Marketplace landing. The home vector lives in a
 * store reconciled by card id: a priced refresh or a late rail patches the
 * tiles whose fields changed instead of re-rendering every rail.
 */

function freshKept(entry, gameId) {
  return entry && entry.site === gameId && Date.now() - entry.at < HOME_KEEP_MS ? entry : null;
}

function seedFor(gameId, preserved) {
  const restored = freshKept(preserved, gameId) || freshKept(kept, gameId);
  const nextPayload = restored
    ? paintHome(restored.payload, readRecentCardIds(), localExtras())
    : seedHome(readHomeVectorCache(gameId));
  const ids = readRecentCardIds();
  const seen = nextPayload?.sections?.recentlySeenIds || [];
  const restoredBrowse = restored?.browse || null;
  const english = gameId === 'pokemon';
  return {
    restored,
    payload: nextPayload,
    loadedAt: restored?.at || 0,
    recentPending: ids.length > 0 && seen.length < ids.length,
    browse: restoredBrowse,
    browseLoading: restoredBrowse ? false : english,
    browseHasMore: restoredBrowse ? restoredBrowse.hasMore : english,
    railsSettled: Boolean(nextPayload && railsReady(nextPayload)),
    english,
  };
}

export default function Home() {
  const site = () => game();
  const englishBrowse = () => isPokemonGame();
  const initial = seedFor(untrack(() => site().id));
  let payload = initial.payload;
  let loadedAt = initial.loadedAt;
  const [home, setHome] = createStore({ cards: payload?.cards || [], sections: payload?.sections || {} });
  const [error, setError] = createSignal('');
  const [recentPending, setRecentPending] = createSignal(initial.recentPending);
  const [browse, setBrowse] = createStore({ cards: initial.browse?.cards || [] });
  const [browseHasMore, setBrowseHasMore] = createSignal(initial.browseHasMore);
  const [browseLoading, setBrowseLoading] = createSignal(initial.browseLoading);
  const [browseMoreBusy, setBrowseMoreBusy] = createSignal(false);
  // Every rail keeps its skeleton until ALL rail requests settle: hiding an empty
  // rail as soon as another one lands, then showing it again, shifted the page
  // whenever rails arrived out of order (React Home has the same latent CLS).
  const [railsSettled, setRailsSettled] = createSignal(initial.railsSettled);
  let browseState = initial.browse?.state || null;
  let browseLoaded = Boolean(initial.browse);
  let generation = 0;
  const stale = (gen) => gen !== generation;

  // Recently seen as painted: its order and its tiles. Every later paint keeps
  // both, so a refresh (account sync, a late rail, new prices) patches tiles in
  // place and appends new ones at the end; it never reorders or blanks the rail.
  // A TCG switch commits that game's seed, which resets both.
  let recentOrder = [];
  let recentTiles = [];
  function noteRecents(next) {
    recentOrder = (next?.sections?.recentlySeenIds || []).map(String);
    const byId = new Map((next?.cards || []).map((card) => [String(card.id), card]));
    recentTiles = recentOrder.map((id) => byId.get(id)).filter(Boolean);
  }
  noteRecents(payload);

  /** The ids to paint: the rail's own order, then stored ids new to it. */
  const recentIds = () => stableRecentIds(recentOrder, readRecentCardIds()).slice(0, RECENT_MAX);
  /** Tiles to paint them with: the painted ones, the stored copy over them, then `tiles`. */
  const railExtras = (tiles = []) => [...recentTiles, ...readRecentTiles(), ...tiles];
  /**
   * Prices the page found for tiles stored without one (last median, a rail's
   * price) go into the stored copy, so the next visit paints them at once.
   * Stored prices are left alone: the background refresh owns those.
   */
  function storeRail(gameId) {
    const stored = new Map(readRecentTiles(gameId).map((tile) => [String(tile.id), tile]));
    const priced = recentTiles
      .slice(0, RECENT_RAIL_SHOWN)
      .filter((card) => tilePricePkn(card) != null && tilePricePkn(stored.get(String(card.id))) == null);
    if (priced.length) rememberRecentTiles(priced, gameId);
  }

  function commit(next) {
    payload = next;
    noteRecents(next);
    setHome((draft) => {
      reconcile(next?.cards || [], 'id')(draft.cards);
      draft.sections = next?.sections || {};
    });
  }

  function setBrowseCards(cards) {
    setBrowse((draft) => {
      reconcile(cards, 'id')(draft.cards);
    });
  }

  function rememberKept(gameId) {
    kept = loadedAt && payload ? {
      site: gameId,
      at: loadedAt,
      payload,
      browse: browseLoaded && browseState
        ? { cards: snapshot(browse.cards).map((card) => ({ ...card })), state: browseState, hasMore: browseHasMore() }
        : null,
    } : null;
  }

  function applySeed(gameId, preserved) {
    const next = seedFor(gameId, preserved);
    payload = next.payload;
    loadedAt = next.loadedAt;
    commit(next.payload);
    setError('');
    setRecentPending(next.recentPending);
    browseState = next.browse?.state || null;
    browseLoaded = Boolean(next.browse);
    setBrowseCards(next.browse?.cards || []);
    setBrowseHasMore(next.browseHasMore);
    setBrowseLoading(next.browseLoading);
    setBrowseMoreBusy(false);
    setRailsSettled(next.railsSettled);
    return next;
  }

  async function applyRailsVector(data, gen, gameId) {
    if (stale(gen) || !data) return null;
    scheduleHomeVectorCacheWrite(gameId, data);
    const painted = paintHome(data, recentIds(), railExtras());
    commit(painted);
    return painted;
  }

  async function loadPokemonRails(gen, gameId) {
    let vector = payload && railsReady(payload)
      ? { source: 'pi', cards: payload.cards || [], sections: { ...(payload.sections || {}) } }
      : { source: 'pi', cards: [], sections: {} };
    let any = false;
    // Serialize merges so parallel rail responses cannot clobber each other.
    let paintChain = Promise.resolve();
    const paintRail = (rail) => {
      paintChain = paintChain.then(async () => {
        if (stale(gen) || !rail?.cards?.length) return;
        any = true;
        vector = mergeHomeRail(vector, rail);
        await applyRailsVector(vector, gen, gameId);
      });
      return paintChain;
    };
    await Promise.all([
      fetchHomeRail('newCards').then(paintRail),
      fetchHomeRail('bestSellers').then(paintRail),
      fetchHomeRail('spotlight').then(paintRail),
      fetchRail(RAIL.spotlight).then((rail) => paintRail(rail && { ...rail, sectionKey: 'spotlightIds', limit: 16 })),
    ]);
    await paintChain;
    if (stale(gen)) return vector;
    setRailsSettled(true);
    if (!any) return fetchHome(recentIds());
    return vector;
  }

  async function loadHome(gen) {
    const gameId = game().id;
    const english = gameId === 'pokemon';
    try {
      const data = await (english ? loadPokemonRails(gen, gameId) : fetchHome(recentIds()));
      if (stale(gen)) return;
      setRailsSettled(true);
      const painted = (await applyRailsVector(data, gen, gameId)) || paintHome(data, recentIds(), railExtras());
      if (stale(gen)) return;
      // Network-only warmup: the suggest engine loads on search intent, not here.
      warmupSearchBar({ engine: false });
      let next = painted;
      if (!recentsNeedingTiles(painted, recentIds()).length) {
        setRecentPending(false);
      } else {
        next = await fillMissingRecents(data, recentIds(), railExtras);
        if (stale(gen)) return;
        commit(next);
        setRecentPending(false);
      }
      const priced = await fillMissingLastMedianPrices(next.cards || []);
      if (stale(gen)) return;
      next = { ...next, cards: priced };
      scheduleHomeVectorCacheWrite(gameId, next);
      commit(next);
      storeRail(gameId);
      loadedAt = Date.now();
      await refreshRailQuietly(gen, gameId);
    } catch (err) {
      if (stale(gen)) return;
      setError(isOriginDownError(err, err?.status, err?.message)
        ? 'Marketplace home failed.'
        : publicErrorMessage(err, 'Marketplace home failed.'));
      setRecentPending(false);
      setRailsSettled(true);
    }
  }

  /** Signed-in buyers also see recents from other devices (account history). */
  async function syncAccountRecents(gen) {
    if (!authSession()?.uid) return;
    const gameId = untrack(() => site().id);
    await loadAuth().catch(() => null);
    if (stale(gen)) return;
    const synced = await syncRecentAccount({ gameId }).catch(() => null);
    if (stale(gen) || !synced || !payload) return;
    // Painted tiles keep their place; ids from other devices join at the end.
    const ids = recentIds();
    const next = paintHome(payload, ids, railExtras());
    commit(next);
    if (!ids.length || !recentsNeedingTiles(next, ids).length) {
      setRecentPending(false);
      storeRail(gameId);
      return;
    }
    setRecentPending(true);
    const filled = await fillMissingRecents(payload || next, ids, railExtras);
    if (stale(gen)) return;
    const priced = await fillMissingLastMedianPrices(filled.cards || []);
    if (stale(gen)) return;
    commit({ ...filled, cards: priced });
    setRecentPending(false);
    storeRail(gameId);
  }

  async function loadEnglishBrowse(gen) {
    try {
      const data = await fetchExpansions({ limit: 500 });
      if (stale(gen)) return;
      browseState = createEnglishBrowseState(data.expansions || data.sets || []);
      const next = await fillEnglishBrowse(browseState, { fetchExpansionPage: fetchExpansion });
      if (stale(gen)) return;
      const filled = next.cards.length ? next.cards : spotlightBrowse(payload);
      setBrowseCards(filled);
      setBrowseHasMore(next.hasMore && next.cards.length > 0);
      if (!filled.length) return;
      browseLoaded = next.cards.length > 0;
      const priced = await fillMissingLastMedianPrices(filled);
      if (!stale(gen)) setBrowseCards(priced);
    } catch (_) {
      if (stale(gen)) return;
      const fallback = spotlightBrowse(payload);
      if (fallback.length) setBrowseCards(fallback);
      setBrowseHasMore(false);
    } finally {
      if (!stale(gen)) setBrowseLoading(false);
    }
  }

  async function loadMoreEnglish() {
    const gen = generation;
    if (!browseState || browseMoreBusy() || stale(gen)) return;
    setBrowseMoreBusy(true);
    try {
      const next = await fillEnglishBrowse(browseState, { fetchExpansionPage: fetchExpansion });
      if (stale(gen)) return;
      const shown = browse.cards.length;
      setBrowse((draft) => {
        draft.cards.push(...next.cards);
      });
      setBrowseHasMore(next.hasMore);
      const priced = await fillMissingLastMedianPrices(next.cards);
      if (stale(gen)) return;
      const byId = new Map(priced.map((card) => [String(card.id), card]));
      setBrowseCards(snapshot(browse.cards).map((card) => byId.get(String(card.id)) || card));
      if (next.cards[0]) {
        track(Action.loadMore, next.cards[0], { query: 'home-english', resultCount: shown + next.cards.length });
      }
    } finally {
      if (!stale(gen)) setBrowseMoreBusy(false);
    }
  }

  /** A restored landing only needs the cards opened since (Recently seen). */
  async function refreshRecents(gen) {
    const gameId = untrack(() => site().id);
    const ids = recentIds();
    if (recentsNeedingTiles(payload, ids).length) {
      const filled = await fillMissingRecents(payload, ids, railExtras).catch(() => null);
      if (stale(gen)) return;
      if (filled) commit(filled);
      storeRail(gameId);
    }
    setRecentPending(false);
    await refreshRailQuietly(gen, gameId);
  }

  /**
   * Behind the painted rail: refetch this game's stale stored tiles, then patch
   * what changed. The stored copy may also have moved under the page (the App
   * warm-up), so compare the repaint rather than trusting the refresh result.
   */
  async function refreshRailQuietly(gen, gameId) {
    await refreshRecentTiles({ gameId });
    if (stale(gen) || !payload) return;
    const next = paintHome(payload, recentIds(), railExtras());
    const byId = new Map((next.cards || []).map((card) => [String(card.id), card]));
    const tiles = (next.sections?.recentlySeenIds || []).map((id) => byId.get(String(id)));
    if (JSON.stringify(tiles) !== JSON.stringify(recentTiles)) commit(next);
  }

  function startLoads(gen, seeded) {
    if (seeded.restored) refreshRecents(gen);
    else loadHome(gen);
    syncAccountRecents(gen);
    if (seeded.english && !seeded.browse) loadEnglishBrowse(gen);
  }

  onSettled(() => {
    const gen = generation;
    startLoads(gen, initial);
    return () => {
      generation += 1;
      rememberKept(seenGame);
    };
  });

  // Same route match across games, so this component stays mounted. Drop the
  // previous game's in-flight responses, paint that game's kept rails or its
  // vector cache, and run the same loaders as the first visit.
  let seenGame = initial.restored?.site || untrack(() => site().id);
  createEffect(() => site().id, (id) => {
    if (id === seenGame) return;
    const prev = seenGame;
    seenGame = id;
    const preserved = freshKept(kept, id);
    rememberKept(prev);
    generation += 1;
    startLoads(generation, applySeed(id, preserved));
  }, { defer: true });

  const sections = createMemo(() => {
    const cards = home.cards;
    const ids = home.sections || {};
    const spotlight = cardsForIds(cards, ids.spotlightIds);
    return {
      recentlySeen: cardsForIds(cards, ids.recentlySeenIds).slice(0, 20),
      newCards: cardsForIds(cards, ids.newArrivalIds),
      bestSellers: cardsForIds(cards, ids.bestSellerIds),
      featured: cardsForIds(cards, ids.featuredIds),
      spotlight: spotlight.length ? spotlight : cards,
    };
  });

  const loading = () => !railsReady(home) && !error();
  const railPending = () => !railsSettled() && !error();
  const newSet = () => sections().newCards[0]?.set || sections().newCards[0]?.set_name;
  const mega = () => sections().newCards[0] || sections().spotlight[0] || browse.cards[0];
  const gridCards = () => (englishBrowse() ? browse.cards : sections().spotlight);
  const gridLoading = () => (englishBrowse() ? browseLoading() && !browse.cards.length : loading());
  const description = () => (site().id === 'pokemon'
    ? 'Buy and sell Pokémon TCG cards in PKN. Browse Pokémon, sets, eras, artists, and listings.'
    : `Buy and sell ${site().name} cards in PKN.`);

  return (
    <div class="page home" aria-busy={loading() || recentPending() ? 'true' : undefined}>
      <SeoHead
        title={site().title}
        description={description()}
        canonical="/marketplace"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Pokoin',
          url: 'https://pokoin.com/',
          potentialAction: {
            '@type': 'SearchAction',
            target: `https://pokoin.com${gameHref('/marketplace/search')}?q={search_term_string}`,
            'query-input': 'required name=search_term_string',
          },
        }}
      />
      <Show when={error()}><p class="status error">{error()}</p></Show>
      <Show when={site().features?.promoCarousel}><PromoCarousel /></Show>

      <Carousel
        title="Recently seen"
        cards={sections().recentlySeen}
        placeholders={recentPending() && !sections().recentlySeen.length ? 8 : 0}
        eagerLimit={6}
      />
      <Carousel
        title="New cards"
        cards={sections().newCards}
        href={newSet() ? `/marketplace/sets/${setSlug(newSet())}` : undefined}
        placeholders={!sections().newCards.length && railPending() ? 8 : 0}
        eagerLimit={8}
      />
      <Carousel
        title="Best sellers"
        cards={sections().bestSellers}
        placeholders={!sections().bestSellers.length && railPending() ? 8 : 0}
      />
      <Carousel
        title="Spotlight"
        cards={sections().featured}
        placeholders={!sections().featured.length && railPending() ? 8 : 0}
      />

      <a class="callout protect-callout" href="/protection">
        {ASSET_COVERAGE_LINE}
        <span>Buyer protection →</span>
      </a>

      <a class="callout" href="/mypokoin" onClick={() => track(Action.sell, mega() || { id: '703382', name: 'sell' })}>
        Sell your cards for PKN
        <span>Get started →</span>
      </a>

      <section>
        <div class="carousel-head">
          <h2>Marketplace</h2>
        </div>
        <CardSelectGrid class="grid" cards={gridLoading() ? [] : gridCards()}>
          <Show
            when={!gridLoading()}
            fallback={<Repeat count={englishBrowse() ? HOME_BROWSE_BLOCK : 12}>{() => <SkeletonTile />}</Repeat>}
          >
            <For each={gridCards()}>
              {(card, index) => <CardTile card={card} rank={index()} eagerLimit={0} />}
            </For>
          </Show>
        </CardSelectGrid>
        <Show when={englishBrowse() && browseHasMore()}>
          <button class="more" type="button" onClick={loadMoreEnglish} disabled={browseMoreBusy()}>
            {browseMoreBusy() ? 'Loading…' : 'Show more'}
          </button>
        </Show>
      </section>
    </div>
  );
}
