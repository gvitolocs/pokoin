import { createEffect, createMemo, createSignal, createStore, For, Match, reconcile, Repeat, Show, Switch, untrack } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { fetchSearch, fetchSellerSearchWithAssociates, fetchSuggest } from '@market/api.js';
import { associateRoleLabel } from '@market/associate-roles.js';
import { isPokemonGame } from '@market/game.js';
import { sellerHref } from '@market/listing-meta.js';
import { filterSearchCards, searchRarity, searchSet, uniqueSearchOptions } from '@market/search-filters.js';
import { takeHotSearchPage } from '@market/search-hot.js';
import { marketUrl } from '@market/punchouts.js';
import { normalizeSearchTab, searchFetchOptions, uniqueSellers } from '@market/search-kind.js';
import { cardsForPrint, loadSearchPrintPage } from '@market/search-print.js';
import { Action, track } from '@market/track.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import SearchTabs from '../components/SearchTabs.jsx';
import SearchToolbar from '../components/SearchToolbar.jsx';
import SeoHead from '../components/SeoHead.jsx';
import {
  isPopArrival,
  peekEntryData,
  rememberEntryData,
  rememberView,
  restoreScroll,
  restoredView,
} from '../lib/scroll-restore.js';
import { loadSearchRank, loadSearchResolve, rankModule, resolveModule } from '../lib/search-preload.js';
import { printLang, searchLang } from '../stores/locale.js';

const PAGE = 48;
/** Back without a snapshot re-reads at most this many pages to reach the shown count. */
const RESTORE_PAGES = 10;

/** Artist rows carry display names; the resolved param carries slugs. */
function normalizeArtistName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The route's exact same-predicate total, or null when the payload has
 * none (singles rides the Meili candidates window today). */
function payloadTotal(payload) {
  if (payload?.total == null) {
    return null;
  }
  const total = Number(payload.total);
  return Number.isFinite(total) ? total : null;
}

// Same markup as EmptyDesk / Alert in market/src/components/Desk.jsx. Local
// until the card-desk port lands a shared components/Desk.jsx.
const EMPTY_ICON = 'M7 3h10a2 2 0 0 1 2 2v14l-7-3-7 3V5a2 2 0 0 1 2-2zm0 2v11.2l5-2.1 5 2.1V5H7z';

function EmptyDesk(props) {
  return (
    <div class="empty-desk">
      <div class="empty-art" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path fill="currentColor" d={EMPTY_ICON} />
        </svg>
      </div>
      <p class="empty-title">{props.title}</p>
      <Show when={props.lede}><p class="empty-lede">{props.lede}</p></Show>
      <div class="empty-cta">{props.children}</div>
    </div>
  );
}

function Alert(props) {
  return (
    <Show when={props.children}>
      <p class="desk-alert" role="status">{props.children}</p>
    </Show>
  );
}

/**
 * /marketplace/search (market/src/pages/Search.jsx). Same URL semantics: q,
 * tab (singles / product / users), resolved chips, the print chip and the
 * title language from the header stores. Results live in a store reconciled
 * by card id and the grid is keyed by id, so "Load more" appends tiles and a
 * re-sort moves them instead of rebuilding the grid.
 *
 * First paint after Enter: the header (and this route's preload) prefetched
 * the page into search-hot.js; the results paint from that cache without a
 * request. Back/forward: the entry's results come from an in-memory snapshot
 * (5 min), or are re-read up to the shown count, and the scroll offset is
 * chased as the grid grows (lib/scroll-restore.js).
 */
export default function Search() {
  const location = useLocation();
  const navigate = useNavigate();
  const pokemon = isPokemonGame();
  const params = createMemo(() => new URLSearchParams(location.search));
  const typedQuery = createMemo(() => (params().get('q') || params().get('query') || '').trim());
  const tab = createMemo(() => normalizeSearchTab(params().get('tab')));
  const resolvedParamRaw = createMemo(() => (params().get('resolved') || '').trim());
  // Print filter is Pokémon-only (expansion nationality catalog). Satellite
  // rows ship blank nationality, so a stored "Western print" chip wiped every
  // Yu-Gi-Oh / Magic / … result. Users are people — print never applies.
  const activePrintLang = createMemo(() => (!pokemon || tab() === 'users' ? 'all' : printLang()));
  const href = createMemo(() => `${location.pathname}${location.search}`);

  loadSearchRank();
  createEffect(resolvedParamRaw, (raw) => {
    if (raw) loadSearchResolve();
  });

  const parsed = createMemo(() => {
    const rank = rankModule();
    return rank ? rank.parseTypedQuery(typedQuery()) : null;
  });
  const setAware = createMemo(() => {
    const rank = rankModule();
    const query = parsed();
    return Boolean(pokemon && rank && query && (rank.isSetAwareQuery(query) || rank.isSetOnlyQuery(query)) && tab() !== 'users');
  });
  const localResolved = createMemo(() => {
    const resolver = resolveModule();
    return pokemon && resolver && typedQuery() && resolvedParamRaw() ? resolver.resolveSuggestQuery(typedQuery()) : null;
  });
  // Set chips serialize display names (resolver-owned sets have no slug);
  // they prefill the existing set-name filter.
  const resolvedSetName = createMemo(() => {
    const raw = resolvedParamRaw();
    const resolver = resolveModule();
    if (!raw || !resolver) return '';
    const want = new Set(resolver.parseResolutionParam(raw).sets);
    if (!want.size) return '';
    const sets = localResolved()?.best?.entities.set.map((entity) => entity.display) || [];
    return sets.find((display) => want.has(display)) || [...want][0] || '';
  });
  const artistEntities = createMemo(() => {
    const raw = resolvedParamRaw();
    const resolver = resolveModule();
    const best = localResolved()?.best;
    if (!raw || !resolver || !best) return [];
    const want = new Set(resolver.parseResolutionParam(raw).artists);
    if (!want.size) return [];
    return best.entities.artist.filter((entity) => entity.slug && want.has(entity.slug));
  });
  const artistNames = createMemo(() => new Set(artistEntities().map((entity) => normalizeArtistName(entity.display))));

  // Read before any effect writes this entry: a back arrival's own view, and
  // its results when they answer the same request. Seeding the first render
  // from them paints the grid without a skeleton pass.
  const arrival = untrack(() => {
    const at = href();
    const data = peekEntryData(at);
    const fits = data && data.query === typedQuery() && data.tab === tab()
      && data.lang === searchLang() && data.print === activePrintLang();
    return { href: at, view: restoredView(at), data: fits ? data : null };
  });
  const seed = arrival.data;
  const seedFilters = {
    rarity: String(arrival.view?.rarity || ''),
    setName: String(arrival.view?.setName || ''),
    sort: arrival.view?.sort || 'match',
  };

  // Copies: store writes land in the arrays they wrap, and the snapshot must
  // keep describing its own entry.
  const [results, setResults] = createStore({
    cards: seed && seed.tab !== 'users' ? seed.cards.slice() : [],
    sellers: seed && seed.tab === 'users' ? seed.sellers.slice() : [],
  });
  const [hasMore, setHasMore] = createSignal(Boolean(seed?.hasMore));
  const [total, setTotal] = createSignal(seed?.total || 0);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(!seed);
  const [rarity, setRarity] = createSignal(seedFilters.rarity);
  const [setName, setSetName] = createSignal(seedFilters.setName);
  const [sort, setSort] = createSignal(seedFilters.sort);

  // Plain mirrors of what the store / signals hold: async continuations read
  // them before the next flush, and the back snapshot stores them as-is.
  let cardsNow = seed && seed.tab !== 'users' ? seed.cards : [];
  let sellersNow = seed && seed.tab === 'users' ? seed.sellers : [];
  let moreNow = Boolean(seed?.hasMore);
  let totalNow = seed?.total || 0;
  let filtersNow = seedFilters;
  // Offset into the unfiltered search window. A print chip shortens `cards`,
  // so the next page cannot use cards.length.
  let apiOffset = seed?.apiOffset || 0;
  let run = null;
  let lastHref = null;
  let moreBusy = false;
  let stopRestore = () => {};

  function putCards(next) {
    cardsNow = next;
    setResults((draft) => {
      reconcile(next, 'id')(draft.cards);
    });
  }

  function putSellers(next) {
    sellersNow = next;
    setResults((draft) => {
      reconcile(next, 'id')(draft.sellers);
    });
  }

  function putHasMore(value) {
    moreNow = value;
    setHasMore(value);
  }

  function putTotal(value) {
    totalNow = typeof value === 'function' ? value(totalNow) : value;
    setTotal(totalNow);
  }

  function putFilters(next) {
    filtersNow = { ...filtersNow, ...next };
    setRarity(filtersNow.rarity);
    setSetName(filtersNow.setName);
    setSort(filtersNow.sort);
  }

  /** This entry's view (filters, shown count) and its back snapshot. */
  function saveEntry(state) {
    if (!state || state.cancelled) return;
    rememberView(state.href, { ...filtersNow, loaded: apiOffset });
    rememberEntryData(state.href, {
      ...state.req,
      cards: cardsNow,
      sellers: sellersNow,
      hasMore: moreNow,
      total: totalNow,
      apiOffset,
    });
  }

  function changeFilters(next) {
    putFilters(next);
    if (run) rememberView(run.href, { ...filtersNow });
  }

  const request = createMemo(() => {
    const kind = tab();
    const ready = kind === 'users' || (Boolean(rankModule()) && (!resolvedParamRaw() || Boolean(resolveModule())));
    return {
      query: typedQuery(),
      tab: kind,
      lang: searchLang(),
      print: activePrintLang(),
      ready,
      setAware: ready && setAware(),
      parsed: ready ? parsed() : null,
    };
  }, {
    equals: (a, b) => a.query === b.query && a.tab === b.tab && a.lang === b.lang && a.print === b.print && a.ready === b.ready,
  });

  createEffect(request, (input) => {
    stopRestore();
    if (!input.ready) {
      // A seeded back arrival keeps its grid while the parser loads.
      if (lastHref !== null || !seed) setLoading(true);
      return undefined;
    }
    const current = untrack(href);
    const navigated = current !== lastHref;
    const firstRun = lastHref === null;
    lastHref = current;
    const { parsed: queryParts, setAware: aware, ...req } = input;
    const state = { cancelled: false, href: current, req };
    run = state;
    apiOffset = 0;
    moreBusy = false;
    const pop = navigated && isPopArrival(current);
    const restored = firstRun ? arrival.view : (pop ? restoredView(current) : null);
    putFilters({
      rarity: String(restored?.rarity || ''),
      setName: String(restored?.setName || (firstRun ? untrack(resolvedSetName) : '') || ''),
      sort: restored?.sort || 'match',
    });
    const cleanup = () => {
      state.cancelled = true;
      stopRestore();
    };

    function settled() {
      if (state.cancelled) return;
      saveEntry(state);
      if (!pop) return;
      growTo(state, Number(restored?.loaded) || 0).then(() => {
        if (!state.cancelled) stopRestore = restoreScroll(current);
      });
    }

    const snap = pop ? (firstRun ? arrival.data : peekEntryData(current)) : null;
    if (snap && snap.query === req.query && snap.tab === req.tab && snap.lang === req.lang && snap.print === req.print) {
      apiOffset = snap.apiOffset;
      if (req.tab === 'users') {
        putCards([]);
        putSellers(snap.sellers);
      } else {
        putCards(snap.cards);
      }
      putHasMore(snap.hasMore);
      putTotal(snap.total);
      setError('');
      setLoading(false);
      if (req.tab !== 'users' && snap.cards[0]) {
        track(Action.searchSubmit, snap.cards[0], { query: req.query, resultCount: snap.cards.length });
      }
      stopRestore = restoreScroll(current);
      return cleanup;
    }

    putSellers([]);
    if (req.tab === 'users') {
      setLoading(true);
      putCards([]);
      putHasMore(false);
      putTotal(0);
      fetchSellerSearchWithAssociates(req.query, { limit: PAGE })
        .then((data) => {
          if (state.cancelled) return;
          const listings = Array.isArray(data?.listings) ? data.listings : [];
          const people = uniqueSellers(listings, req.query);
          putSellers(people);
          putTotal(people.length);
          setError('');
          setLoading(false);
          settled();
        })
        .catch((err) => {
          if (state.cancelled) return;
          putSellers([]);
          // The API validates usernames with a 400 "Seller username is
          // invalid." — a term that cannot be a username is the same
          // no-match outcome as 404, not a failure worth a red banner.
          const noSeller = err?.status === 404
            || (err?.status === 400 && /invalid/i.test(err?.message || ''))
            || /not found/i.test(err?.message || '');
          setError(noSeller ? '' : (err.message || 'Search failed.'));
          setLoading(false);
        });
      return cleanup;
    }

    const rank = untrack(rankModule);
    const fetchOpts = { ...searchFetchOptions(req.tab), printLang: req.print };
    const hot = aware ? null : takeHotSearchPage(req.query, req.lang, req.tab, req.print);
    const printFiltered = Boolean(req.print && req.print !== 'all');

    function apply(data, totalHits) {
      if (state.cancelled) return;
      const raw = data?.cards || [];
      const next = printFiltered ? cardsForPrint(raw, req.print) : raw;
      apiOffset = data?.nextOffset != null ? data.nextOffset : raw.length;
      putCards(next);
      putHasMore(aware ? false : Boolean(data?.hasMore));
      setError('');
      // The total travels with the results: totalHits is either the hot
      // payload's total or this response's own total — the same predicate
      // that produced the rows. Never a suggest-side estimate.
      // A print chip is applied here, so the all-print total is the wrong
      // headline. Count the rows this chip kept.
      if (printFiltered) {
        putTotal(next.length);
      } else if (totalHits != null) {
        putTotal(Number(totalHits) || 0);
      } else if (aware) {
        putTotal(next.length);
      } else if (Number.isFinite(Number(data?.total))) {
        putTotal(Number(data.total) || 0);
      }
      if (next[0]) {
        track(Action.searchSubmit, next[0], { query: req.query, resultCount: next.length });
      }
      setLoading(false);
      state.applied = true;
      settled();
    }

    function fetchPage(offset) {
      return fetchSearch({ query: req.query, offset, limit: PAGE, lang: req.lang, ...fetchOpts });
    }

    function deliver(data, totalHits, retried = false) {
      if (state.cancelled) return Promise.resolve();
      if (!data) {
        if (retried) {
          apply({ cards: [], hasMore: false }, 0);
          return Promise.resolve();
        }
        return fetchPage(0).then((fresh) => deliver(fresh, payloadTotal(fresh) ?? hot?.count, true));
      }
      const raw = data.cards || [];
      const kept = printFiltered ? cardsForPrint(raw, req.print) : raw;
      if (printFiltered && !kept.length && data.hasMore && raw.length) {
        return loadSearchPrintPage({ printLang: req.print, offset: raw.length, fetchPage }).then((more) => {
          if (state.cancelled) return;
          apply({ cards: more.cards, hasMore: more.hasMore, nextOffset: more.nextOffset }, more.cards.length);
        });
      }
      apply(data, totalHits);
      return Promise.resolve();
    }

    const fail = (err) => {
      if (state.cancelled) return;
      setError(err?.message || 'Search failed.');
      setLoading(false);
    };

    if (hot?.data) {
      deliver(hot.data, hot.count).catch(fail);
    } else {
      setLoading(true);
      putCards([]);
      putTotal(hot?.count || 0);
      const pending = aware
        ? rank.fetchSetAwareCards(queryParts, { fetchSearch, lang: req.lang }).then((rows) => ({ cards: rows, hasMore: false }))
        : (hot?.promise || fetchPage(0));
      pending
        .then((data) => deliver(data, aware ? data?.cards?.length : (payloadTotal(data) ?? hot?.count)))
        .catch(fail);
    }
    if (!printFiltered && !aware && req.tab === 'singles' && req.query.length >= 2 && !(hot?.count > 0)) {
      // No search-page total for this universe yet (singles rides the Meili
      // candidates window) and no cached count: keep the suggest estimate so
      // the results page still shows a query-scoped number.
      fetchSuggest(req.query, { limit: 1, lang: req.lang, printLang: req.print })
        .then((suggest) => {
          if (state.cancelled) return;
          putTotal(Number(suggest?.count) || 0);
          if (state.applied) saveEntry(state);
        })
        .catch(() => {});
    }
    return cleanup;
  });

  /** Back arrival without a snapshot: re-read pages until the entry's shown count. */
  async function growTo(state, target) {
    for (let pages = 0; pages < RESTORE_PAGES && !state.cancelled && moreNow && apiOffset < target; pages += 1) {
      const before = apiOffset;
      await loadMore();
      if (apiOffset <= before) break;
    }
  }

  const shown = createMemo(() => {
    if (tab() === 'users') return [];
    let rows = filterSearchCards(results.cards, {
      type: tab() === 'product' ? 'sealed' : 'singles',
      rarity: rarity(),
      set: setName(),
      sort: sort(),
    });
    const names = artistNames();
    if (names.size) {
      rows = rows.filter((card) => names.has(normalizeArtistName(card.artist)));
    }
    const rank = rankModule();
    const query = parsed();
    if (sort() !== 'match' || !rank || !rank.isNumberAwareQuery(query)) {
      return rows;
    }
    return [...rows].sort((left, right) => {
      const leftHit = rank.printingMatchesNumberFilter(left, query) ? 0 : 1;
      const rightHit = rank.printingMatchesNumberFilter(right, query) ? 0 : 1;
      return leftHit - rightHit;
    });
  });
  const rarities = createMemo(() => uniqueSearchOptions(results.cards, searchRarity));
  const sets = createMemo(() => uniqueSearchOptions(results.cards, searchSet));
  const filtersOn = () => Boolean(rarity() || setName() || artistEntities().length > 0 || sort() !== 'match');

  function setTab(next) {
    const kind = normalizeSearchTab(next);
    if (kind === tab()) return;
    const nextParams = new URLSearchParams(location.search);
    if (kind === 'singles') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', kind);
    }
    setLoading(true);
    putCards([]);
    putSellers([]);
    setError('');
    const search = nextParams.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
  }

  function clearResolved() {
    const nextParams = new URLSearchParams(location.search);
    nextParams.delete('resolved');
    const search = nextParams.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
  }

  async function loadMore() {
    const state = run;
    if (!state || state.cancelled || moreBusy || state.req.tab === 'users' || untrack(setAware)) return;
    const { query, tab: kind, lang, print } = state.req;
    const printFiltered = Boolean(print && print !== 'all');
    const page = (offset) => fetchSearch({ query, offset, limit: PAGE, lang, printLang: print, ...searchFetchOptions(kind) });
    moreBusy = true;
    try {
      const data = await page(apiOffset);
      if (state.cancelled) return;
      const raw = data.cards || [];
      apiOffset += raw.length;
      let extra = printFiltered ? cardsForPrint(raw, print) : raw;
      let more = Boolean(data.hasMore);
      if (printFiltered && !extra.length && more && raw.length) {
        const rest = await loadSearchPrintPage({ printLang: print, offset: apiOffset, fetchPage: page });
        if (state.cancelled) return;
        extra = rest.cards;
        apiOffset = rest.nextOffset;
        more = rest.hasMore;
      }
      const before = cardsNow.length;
      cardsNow = [...cardsNow, ...extra];
      setResults((draft) => {
        draft.cards.push(...extra);
      });
      putHasMore(more);
      if (printFiltered) putTotal((current) => current + extra.length);
      if (extra[0]) {
        track(Action.loadMore, extra[0], { query, resultCount: before + extra.length });
      }
      saveEntry(state);
    } catch (err) {
      if (!state.cancelled) setError(err?.message || 'Search failed.');
    } finally {
      if (run === state) moreBusy = false;
    }
  }

  function clearFilters() {
    changeFilters({ rarity: '', setName: '', sort: 'match' });
  }

  const emptyTitle = () => (tab() === 'users' ? 'No sellers match' : (tab() === 'product' ? 'No products match' : 'No matches'));
  const emptyLede = () => (tab() === 'users' ? 'Try an exact seller username.' : 'Try a collector number, a set name, or a shorter card name.');

  return (
    <div class="page desk" aria-busy={loading() ? 'true' : undefined}>
      <SeoHead
        title={typedQuery() ? `${typedQuery()} · Search | Pokoin` : 'Search · Pokoin'}
        description={typedQuery() ? `Search results for ${typedQuery()} on Pokoin.` : 'Search Pokémon cards on Pokoin.'}
        canonical="/marketplace/search"
        noindex
      />
      <h1 class="sr-only">{typedQuery() || 'Search'}</h1>
      <SearchTabs value={tab()} onChange={setTab} />
      <div class="shop-toolbar search-toolbar">
        <p class="result-count">
          <Switch fallback={<><strong>{(total() || results.cards.length).toLocaleString('en-US')}</strong> results</>}>
            <Match when={loading()}>Searching…</Match>
            <Match when={tab() === 'users'}>
              <Show when={results.sellers.length} fallback="No sellers match that search.">
                <strong>{results.sellers.length.toLocaleString('en-US')}</strong> sellers
              </Show>
            </Match>
            <Match when={!results.cards.length}>
              {tab() === 'product' ? 'No products match that search.' : 'No cards match that search.'}
            </Match>
            <Match when={filtersOn()}>
              <strong>{shown().length.toLocaleString('en-US')}</strong> matching
            </Match>
          </Switch>
        </p>
        <Show when={tab() !== 'users' && artistEntities().length}>
          <div class="search-resolved">
            <For each={artistEntities()}>
              {(entity) => (
                <button type="button" class="search-chip" onClick={clearResolved} title="Remove artist filter">
                  By {entity.display} ✕
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={tab() !== 'users'}>
          <SearchToolbar
            sort={sort()}
            onSort={(value) => changeFilters({ sort: value })}
            rarity={rarity()}
            onRarity={(value) => changeFilters({ rarity: value })}
            rarities={rarities()}
            setName={setName()}
            onSet={(value) => changeFilters({ setName: value })}
            sets={sets()}
            filtersOn={filtersOn()}
            onClear={clearFilters}
            showPrint={pokemon}
          />
        </Show>
      </div>
      <Alert>{error()}</Alert>
      <Switch
        fallback={(
          <CardSelectGrid class="grid">
            <Show when={!loading()} fallback={<Repeat count={24}>{() => <SkeletonTile />}</Repeat>}>
              <For each={shown()} keyed={(card) => card.id}>
                {(card, index) => <CardTile card={card()} rank={index()} />}
              </For>
            </Show>
          </CardSelectGrid>
        )}
      >
        <Match when={tab() === 'users'}>
          <Show
            when={loading() || results.sellers.length || error()}
            fallback={(
              <EmptyDesk title={emptyTitle()} lede={emptyLede()}>
                <a class="btn" href={marketUrl('/marketplace')}>Browse marketplace</a>
              </EmptyDesk>
            )}
          >
            <ul class="seller-results">
              <For each={results.sellers}>
                {(seller) => (
                  <li>
                    <a class="seller-result" href={marketUrl(sellerHref({ sellerName: seller.username }))}>
                      <span class="suggest-user-mark" aria-hidden="true">{seller.name.slice(0, 1).toUpperCase()}</span>
                      <span>
                        <strong>{seller.name}</strong>
                        <Show when={seller.associateRole}>
                          <span class={['suggest-user-associate-badge', `is-${seller.associateRole}`]}>
                            {associateRoleLabel(seller.associateRole)}
                          </span>
                        </Show>
                        <Show when={seller.count}>
                          <em>{seller.count} listing{seller.count === 1 ? '' : 's'}</em>
                        </Show>
                      </span>
                    </a>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Match>
        <Match when={!loading() && !results.cards.length && !error()}>
          <EmptyDesk title={emptyTitle()} lede={emptyLede()}>
            <a class="btn" href={marketUrl('/marketplace')}>Browse marketplace</a>
          </EmptyDesk>
        </Match>
        <Match when={!loading() && results.cards.length && !shown().length}>
          <EmptyDesk title="No cards match those filters" lede="Clear a filter to see more of this search.">
            <button class="btn" type="button" onClick={clearFilters}>Clear filters</button>
          </EmptyDesk>
        </Match>
      </Switch>
      <Show when={hasMore() && tab() !== 'users'}>
        <button class="more" type="button" onClick={loadMore}>Load more</button>
      </Show>
    </div>
  );
}
