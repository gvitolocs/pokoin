import { createMemo, createSignal, createStore, For, onSettled, reconcile, Repeat, Show, snapshot } from 'solid-js';
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
import { game, isPokemonGame } from '@market/game.js';
import { HOME_BROWSE_BLOCK, createEnglishBrowseState, fillEnglishBrowse } from '@market/home-browse.js';
import { readHomeVectorCache, writeHomeVectorCache } from '@market/home-cache.js';
import { tilePricePkn } from '@market/pkn.js';
import {
  pruneUnresolvedRecents,
  readRecentCardIds,
  readRecentTiles,
  rememberRecentTiles,
  syncRemoteRecentCardIds,
} from '@market/recents.js';
import { Action, track } from '@market/track.js';
import { isOriginDownError, publicErrorMessage } from '@market/working-page.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import Carousel, { SkeletonTile } from '../components/Carousel.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { loadAuth } from '../stores/auth.js';
import { authSession } from '../stores/session.js';

// Same pure helpers as market/src/pages/Home.jsx.
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

async function fillMissingRecents(payload, ids, already = []) {
  const first = paintHome(payload, ids, localExtras(already));
  const need = recentsNeedingTiles(first, ids);
  if (!need.length) return first;
  const tiles = await fetchCardTiles(need).catch(() => []);
  rememberRecentTiles(tiles);
  const filled = paintHome(payload, ids, localExtras([...already, ...tiles]));
  const still = recentsNeedingTiles(filled, ids).filter((id) => {
    const card = (filled.cards || []).find((row) => String(row.id) === String(id));
    return !tileHasName(card);
  });
  if (!still.length) return filled;
  const extras = await Promise.all(
    still.slice(0, 8).map((id) => fetchCard(id).then((row) => row?.card || null).catch(() => null)),
  );
  const hydrated = extras.filter(Boolean);
  rememberRecentTiles(hydrated);
  const next = paintHome(payload, ids, localExtras([...already, ...tiles, ...hydrated]));
  const resolved = (next.sections?.recentlySeenIds || []).filter((id) => {
    const card = (next.cards || []).find((row) => String(row.id) === String(id));
    return tileHasName(card);
  });
  if (resolved.length !== ids.length) {
    pruneUnresolvedRecents(resolved);
    return paintHome(payload, resolved, localExtras([...already, ...tiles, ...hydrated]));
  }
  return next;
}

/**
 * Marketplace landing (market/src/pages/Home.jsx). The home vector lives in a
 * store reconciled by card id: a priced refresh or a late rail patches the
 * tiles whose fields changed instead of re-rendering every rail.
 */
export default function Home() {
  const site = game();
  const englishBrowse = isPokemonGame();
  let payload = seedHome(readHomeVectorCache(site.id));
  const [home, setHome] = createStore({ cards: payload?.cards || [], sections: payload?.sections || {} });
  const [error, setError] = createSignal('');
  const [recentPending, setRecentPending] = createSignal((() => {
    const ids = readRecentCardIds();
    const seen = payload?.sections?.recentlySeenIds || [];
    return ids.length > 0 && seen.length < ids.length;
  })());
  const [browse, setBrowse] = createStore({ cards: [] });
  const [browseHasMore, setBrowseHasMore] = createSignal(englishBrowse);
  const [browseLoading, setBrowseLoading] = createSignal(englishBrowse);
  const [browseMoreBusy, setBrowseMoreBusy] = createSignal(false);
  let browseState = null;
  let disposed = false;

  function commit(next) {
    payload = next;
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

  async function applyRailsVector(data) {
    if (disposed || !data) return null;
    writeHomeVectorCache(site.id, data);
    const painted = paintHome(data, readRecentCardIds(), localExtras());
    commit(painted);
    return painted;
  }

  async function loadPokemonRails() {
    let vector = payload && railsReady(payload)
      ? { source: 'pi', cards: payload.cards || [], sections: { ...(payload.sections || {}) } }
      : { source: 'pi', cards: [], sections: {} };
    let any = false;
    // Serialize merges so parallel rail responses cannot clobber each other.
    let paintChain = Promise.resolve();
    const paintRail = (rail) => {
      paintChain = paintChain.then(async () => {
        if (disposed || !rail?.cards?.length) return;
        any = true;
        vector = mergeHomeRail(vector, rail);
        await applyRailsVector(vector);
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
    if (!any) return fetchHome(readRecentCardIds());
    return vector;
  }

  async function loadHome() {
    try {
      const data = await (englishBrowse ? loadPokemonRails() : fetchHome(readRecentCardIds()));
      if (disposed) return;
      const painted = (await applyRailsVector(data)) || paintHome(data, readRecentCardIds(), localExtras());
      warmupSearchBar();
      let next = painted;
      if (!recentsNeedingTiles(painted, readRecentCardIds()).length) {
        setRecentPending(false);
      } else {
        next = await fillMissingRecents(data, readRecentCardIds());
        if (disposed) return;
        commit(next);
        setRecentPending(false);
      }
      const priced = await fillMissingLastMedianPrices(next.cards || []);
      if (disposed) return;
      next = { ...next, cards: priced };
      writeHomeVectorCache(site.id, next);
      commit(next);
    } catch (err) {
      if (disposed) return;
      setError(isOriginDownError(err, err?.status, err?.message)
        ? 'Marketplace home failed.'
        : publicErrorMessage(err, 'Marketplace home failed.'));
      setRecentPending(false);
    }
  }

  /** Signed-in buyers also see recents from other devices (account history). */
  async function syncAccountRecents() {
    if (!authSession()?.uid) return;
    await loadAuth().catch(() => null);
    const ids = await syncRemoteRecentCardIds().catch(() => null);
    if (disposed || !ids || !payload) return;
    const next = paintHome(payload, ids, localExtras());
    commit(next);
    if (!ids.length || !recentsNeedingTiles(next, ids).length) {
      setRecentPending(false);
      return;
    }
    setRecentPending(true);
    const filled = await fillMissingRecents(payload || next, ids);
    if (disposed) return;
    const priced = await fillMissingLastMedianPrices(filled.cards || []);
    commit({ ...filled, cards: priced });
    setRecentPending(false);
  }

  async function loadEnglishBrowse() {
    try {
      const data = await fetchExpansions({ limit: 500 });
      if (disposed) return;
      browseState = createEnglishBrowseState(data.expansions || data.sets || []);
      const next = await fillEnglishBrowse(browseState, { fetchExpansionPage: fetchExpansion });
      if (disposed) return;
      const filled = next.cards.length ? next.cards : spotlightBrowse(payload);
      setBrowseCards(filled);
      setBrowseHasMore(next.hasMore && next.cards.length > 0);
      if (!filled.length) return;
      const priced = await fillMissingLastMedianPrices(filled);
      if (!disposed) setBrowseCards(priced);
    } catch (_) {
      if (disposed) return;
      const fallback = spotlightBrowse(payload);
      if (fallback.length) setBrowseCards(fallback);
      setBrowseHasMore(false);
    } finally {
      if (!disposed) setBrowseLoading(false);
    }
  }

  async function loadMoreEnglish() {
    if (!browseState || browseMoreBusy()) return;
    setBrowseMoreBusy(true);
    try {
      const next = await fillEnglishBrowse(browseState, { fetchExpansionPage: fetchExpansion });
      const shown = browse.cards.length;
      setBrowse((draft) => {
        draft.cards.push(...next.cards);
      });
      setBrowseHasMore(next.hasMore);
      const priced = await fillMissingLastMedianPrices(next.cards);
      const byId = new Map(priced.map((card) => [String(card.id), card]));
      setBrowseCards(snapshot(browse.cards).map((card) => byId.get(String(card.id)) || card));
      if (next.cards[0]) {
        track(Action.loadMore, next.cards[0], { query: 'home-english', resultCount: shown + next.cards.length });
      }
    } finally {
      setBrowseMoreBusy(false);
    }
  }

  onSettled(() => {
    loadHome();
    syncAccountRecents();
    if (englishBrowse) loadEnglishBrowse();
    return () => {
      disposed = true;
    };
  });

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
  const newSet = () => sections().newCards[0]?.set || sections().newCards[0]?.set_name;
  const mega = () => sections().newCards[0] || sections().spotlight[0] || browse.cards[0];
  const gridCards = () => (englishBrowse ? browse.cards : sections().spotlight);
  const gridLoading = () => (englishBrowse ? browseLoading() && !browse.cards.length : loading());

  return (
    <div class="page home" aria-busy={loading() || recentPending() ? 'true' : undefined}>
      <SeoHead
        title={site.title}
        description="Buy and sell Pokémon TCG cards in PKN. Browse Pokémon, sets, eras, artists, and listings."
        canonical="/marketplace"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Pokoin',
          url: 'https://pokoin.com/',
          potentialAction: {
            '@type': 'SearchAction',
            target: 'https://pokoin.com/marketplace/search?q={search_term_string}',
            'query-input': 'required name=search_term_string',
          },
        }}
      />
      <Show when={error()}><p class="status error">{error()}</p></Show>

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
        placeholders={!sections().newCards.length && loading() ? 8 : 0}
        eagerLimit={8}
      />
      <Carousel
        title="Best sellers"
        cards={sections().bestSellers}
        placeholders={!sections().bestSellers.length && loading() ? 8 : 0}
      />
      <Carousel
        title="Spotlight"
        cards={sections().featured}
        placeholders={!sections().featured.length && loading() ? 8 : 0}
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
        <CardSelectGrid class="grid">
          <Show
            when={!gridLoading()}
            fallback={<Repeat count={englishBrowse ? HOME_BROWSE_BLOCK : 12}>{() => <SkeletonTile />}</Repeat>}
          >
            <For each={gridCards()}>
              {(card, index) => <CardTile card={card} rank={index()} eagerLimit={0} />}
            </For>
          </Show>
        </CardSelectGrid>
        <Show when={englishBrowse && browseHasMore()}>
          <button class="more" type="button" onClick={loadMoreEnglish} disabled={browseMoreBusy()}>
            {browseMoreBusy() ? 'Loading…' : 'Show more'}
          </button>
        </Show>
      </section>
    </div>
  );
}
