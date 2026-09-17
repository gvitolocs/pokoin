import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { fetchSearch, fetchSellerByUsername, fetchSuggest } from '../api.js';
import { isPokemonGame } from '../game.js';
import { takeHotSearchPage } from '../search-hot.js';
import {
  fetchSetAwareCards,
  isNumberAwareQuery,
  isSetAwareQuery,
  isSetOnlyQuery,
  parseTypedQuery,
  printingMatchesNumberFilter,
  typedMeiliQuery,
} from '../suggest-rank.js';
import { useSearchLang } from '../locale.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk } from '../components/Desk.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SearchTabs from '../components/SearchTabs.jsx';
import SearchToolbar from '../components/SearchToolbar.jsx';
import {
  filterSearchCards,
  searchRarity,
  searchSet,
  uniqueSearchOptions,
} from '../search-filters.js';
import { normalizeSearchTab, searchFetchOptions, searchHref, uniqueSellers } from '../search-kind.js';
import { parseResolutionParam, resolveSuggestQuery } from '../suggest-resolve.js';
import { sellerHref } from '../listing-meta.js';
import { rememberPageView, restoredPageView } from '../scroll-restore.js';

/** Artist rows carry display names; the resolved param carries slugs. */
function normalizeArtistName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export default function Search() {
  const location = useLocation();
  const navType = useNavigationType();
  const restored = restoredPageView(navType, location.key, `${location.pathname}${location.search}`);
  const [params, setParams] = useSearchParams();
  const typedQuery = (params.get('q') || params.get('query') || '').trim();
  const tab = normalizeSearchTab(params.get('tab'));
  const parsed = parseTypedQuery(typedQuery);
  const setAware = isPokemonGame()
    && (isSetAwareQuery(parsed) || isSetOnlyQuery(parsed))
    && tab !== 'users';
  const query = setAware
    ? typedQuery
    : (isPokemonGame()
      ? typedMeiliQuery(typedQuery)
      : typedQuery);
  const lang = useSearchLang();
  // Resolver parity: the popup may hand over its winning hypothesis
  // (`resolved=artist:yuka-morii~name:Pikachu`). Re-resolving the same raw
  // query locally gives the artist display names so the rows — which carry
  // `artist` from marketplace_search_candidates — can be filtered client-side,
  // and the fetch runs on the corrected name text instead of the raw typo.
  const resolvedParamRaw = (params.get('resolved') || '').trim();
  const localResolved = useMemo(
    () => (isPokemonGame() && typedQuery && resolvedParamRaw ? resolveSuggestQuery(typedQuery) : null),
    [typedQuery, resolvedParamRaw],
  );
  const artistEntities = useMemo(() => {
    if (!resolvedParamRaw || !localResolved?.best) {
      return [];
    }
    const want = new Set(parseResolutionParam(resolvedParamRaw).artists);
    if (!want.size) {
      return [];
    }
    return localResolved.best.entities.artist.filter((entity) => entity.slug && want.has(entity.slug));
  }, [resolvedParamRaw, localResolved]);
  const artistNames = useMemo(
    () => new Set(artistEntities.map((entity) => normalizeArtistName(entity.display))),
    [artistEntities],
  );
  const fetchQuery = artistEntities.length && localResolved?.correctedQuery
    ? localResolved.correctedQuery
    : query;
  const [cards, setCards] = useState([]);
  const [sellers, setSellers] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rarity, setRarity] = useState(() => String(restored?.rarity || ''));
  const [setName, setSetName] = useState(() => String(restored?.setName || ''));
  const [sort, setSort] = useState(() => restored?.sort || 'match');
  const skipFilterReset = useRef(Boolean(restored));

  function setTab(next) {
    const kind = normalizeSearchTab(next);
    if (kind === tab) {
      return;
    }
    const nextParams = new URLSearchParams(params);
    if (kind === 'singles') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', kind);
    }
    setLoading(true);
    setCards([]);
    setSellers([]);
    setError('');
    setParams(nextParams, { replace: true });
  }

  useEffect(() => {
    document.title = query ? `${query} · Search | Pokoin` : 'Search · Pokoin';
    let cancelled = false;
    if (skipFilterReset.current) {
      skipFilterReset.current = false;
    } else {
      setRarity('');
      setSetName('');
      setSort('match');
    }
    setSellers([]);
    const fetchOpts = searchFetchOptions(tab);
    const hot = setAware || tab === 'users' ? null : takeHotSearchPage(fetchQuery, lang, tab);
    function apply(data, totalHits) {
      if (cancelled) {
        return;
      }
      const next = data?.cards || [];
      setCards(next);
      setHasMore(setAware || tab === 'users' ? false : Boolean(data?.hasMore));
      setError('');
      if (totalHits != null) {
        setTotal(Number(totalHits) || 0);
      } else if (setAware) {
        setTotal(next.length);
      }
      if (next[0]) {
        track(Action.searchSubmit, next[0], { query, resultCount: next.length });
      }
      setLoading(false);
    }
    if (tab === 'users') {
      setLoading(true);
      setCards([]);
      setTotal(0);
      fetchSellerByUsername(typedQuery, { limit: 48 })
        .then((data) => {
          if (cancelled) {
            return;
          }
          const listings = Array.isArray(data?.listings) ? data.listings : [];
          const people = uniqueSellers(listings, typedQuery);
          setSellers(people);
          setTotal(people.length);
          setError('');
          setLoading(false);
        })
        .catch((err) => {
          if (!cancelled) {
            setSellers([]);
            // The API validates usernames with a 400 "Seller username is
            // invalid." — a term that cannot be a username is the same
            // no-match outcome as 404, not a failure worth a red banner.
            const noSeller = err?.status === 404
              || (err?.status === 400 && /invalid/i.test(err?.message || ''))
              || /not found/i.test(err?.message || '');
            setError(noSeller ? '' : (err.message || 'Search failed.'));
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }
    if (hot?.data) {
      apply(hot.data, hot.count);
    } else {
      setLoading(true);
      setCards([]);
      setTotal(hot?.count || 0);
      const pending = setAware
        ? fetchSetAwareCards(parsed, { fetchSearch, lang }).then((rows) => ({
          cards: rows,
          hasMore: false,
        }))
        : (hot?.promise || fetchSearch({ query: fetchQuery, offset: 0, limit: 48, lang, ...fetchOpts }));
      pending
        .then((data) => {
          if (data) {
            apply(data, setAware ? data.cards?.length : hot?.count);
            return;
          }
          if (cancelled) {
            return;
          }
          return fetchSearch({ query: fetchQuery, offset: 0, limit: 48, lang, ...fetchOpts }).then((fresh) => apply(fresh, hot?.count));
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err.message || 'Search failed.');
            setLoading(false);
          }
        });
    }
    if (!setAware && tab === 'singles' && fetchQuery.length >= 2 && !(hot?.count > 0)) {
      fetchSuggest(fetchQuery, { limit: 1, lang })
        .then((suggest) => {
          if (!cancelled) {
            setTotal(Number(suggest?.count) || 0);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [query, fetchQuery, lang, tab, typedQuery]);

  useEffect(() => {
    rememberPageView(location.key, { rarity, setName, sort });
  }, [location.key, rarity, setName, sort]);

  const rarities = useMemo(() => uniqueSearchOptions(cards, searchRarity), [cards]);
  const sets = useMemo(() => uniqueSearchOptions(cards, searchSet), [cards]);
  const shown = useMemo(() => {
    if (tab === 'users') {
      return [];
    }
    let rows = filterSearchCards(cards, {
      type: tab === 'product' ? 'sealed' : 'singles',
      rarity,
      set: setName,
      sort,
    });
    if (artistNames.size) {
      rows = rows.filter((card) => artistNames.has(normalizeArtistName(card.artist)));
    }
    if (sort !== 'match' || !isNumberAwareQuery(parsed)) {
      return rows;
    }
    return [...rows].sort((left, right) => {
      const leftHit = printingMatchesNumberFilter(left, parsed) ? 0 : 1;
      const rightHit = printingMatchesNumberFilter(right, parsed) ? 0 : 1;
      return leftHit - rightHit;
    });
  }, [cards, tab, rarity, setName, sort, typedQuery, artistNames]);
  const filtersOn = rarity || setName || artistEntities.length > 0 || sort !== 'match';

  function clearResolved() {
    const nextParams = new URLSearchParams(params);
    nextParams.delete('resolved');
    setParams(nextParams, { replace: true });
  }

  async function loadMore() {
    if (setAware || tab === 'users') {
      return;
    }
    const data = await fetchSearch({
      query,
      offset: cards.length,
      limit: 48,
      lang,
      ...searchFetchOptions(tab),
    });
    const extra = data.cards || [];
    setCards((current) => [...current, ...extra]);
    setHasMore(Boolean(data.hasMore));
    if (extra[0]) {
      track(Action.loadMore, extra[0], { query, resultCount: cards.length + extra.length });
    }
  }

  function clearFilters() {
    setRarity('');
    setSetName('');
    setSort('match');
  }

  const emptyTitle = tab === 'users'
    ? 'No sellers match'
    : (tab === 'product' ? 'No products match' : 'No matches');
  const emptyLede = tab === 'users'
    ? 'Try an exact seller username.'
    : 'Try a collector number, a set name, or a shorter card name.';

  return (
    <div className="page desk" aria-busy={loading ? 'true' : undefined}>
      <SeoHead
        title={query ? `${query} · Search | Pokoin` : 'Search · Pokoin'}
        description={query ? `Search results for ${query} on Pokoin.` : 'Search Pokémon cards on Pokoin.'}
        canonical="/marketplace/search"
        noindex
      />
      <h1 className="sr-only">{query || 'Search'}</h1>
      <SearchTabs value={tab} onChange={setTab} />
      <div className="shop-toolbar search-toolbar">
        <p className="result-count">
          {loading
            ? 'Searching…'
            : (tab === 'users'
              ? (sellers.length
                ? <><strong>{sellers.length.toLocaleString('en-US')}</strong> sellers</>
                : 'No sellers match that search.')
              : (!cards.length
                ? (tab === 'product' ? 'No products match that search.' : 'No cards match that search.')
                : (filtersOn
                  ? <><strong>{shown.length.toLocaleString('en-US')}</strong> matching</>
                  : (total || !hasMore
                    ? <><strong>{(total || cards.length).toLocaleString('en-US')}</strong> results</>
                    : 'Searching…'))))}
        </p>
        {tab !== 'users' && artistEntities.length ? (
          <div className="search-resolved">
            {artistEntities.map((entity) => (
              <button
                key={entity.slug}
                type="button"
                className="search-chip"
                onClick={clearResolved}
                title="Remove artist filter"
              >
                By {entity.display} ✕
              </button>
            ))}
          </div>
        ) : null}
        {tab !== 'users' ? (
          <SearchToolbar
            sort={sort}
            onSort={setSort}
            rarity={rarity}
            onRarity={setRarity}
            rarities={rarities}
            setName={setName}
            onSet={setSetName}
            sets={sets}
            filtersOn={filtersOn}
            onClear={clearFilters}
          />
        ) : null}
      </div>
      <Alert>{error}</Alert>
      {tab === 'users' ? (
        !loading && !sellers.length && !error ? (
          <EmptyDesk title={emptyTitle} lede={emptyLede}>
            <Link className="btn" to="/marketplace">Browse marketplace</Link>
          </EmptyDesk>
        ) : (
          <ul className="seller-results">
            {sellers.map((seller) => (
              <li key={seller.id}>
                <Link className="seller-result" to={sellerHref({ sellerName: seller.username })}>
                  <span className="suggest-user-mark" aria-hidden="true">
                    {seller.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{seller.name}</strong>
                    {seller.count ? (
                      <em>{seller.count} listing{seller.count === 1 ? '' : 's'}</em>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : !loading && !cards.length && !error ? (
        <EmptyDesk title={emptyTitle} lede={emptyLede}>
          <Link className="btn" to="/marketplace">Browse marketplace</Link>
        </EmptyDesk>
      ) : !loading && cards.length && !shown.length ? (
        <EmptyDesk title="No cards match those filters" lede="Clear a filter to see more of this search.">
          <button className="btn" type="button" onClick={clearFilters}>Clear filters</button>
        </EmptyDesk>
      ) : (
        <div className="grid">
          {loading
            ? Array.from({ length: 24 }, (_, index) => <SkeletonTile key={index} />)
            : shown.map((card, index) => (
                <CardTile key={card.id} card={card} rank={index} />
              ))}
        </div>
      )}
      {hasMore && tab !== 'users' ? (
        <button className="more" type="button" onClick={loadMore}>Load more</button>
      ) : null}
    </div>
  );
}
