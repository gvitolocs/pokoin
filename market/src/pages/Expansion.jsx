import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom';
import { EXPANSION_PAGE, fetchExpansion, fetchExpansionCards, peekExpansion, prettySlug } from '../api.js';
import { Action, track } from '../track.js';
import { resolveExpansionNationality } from '../expansion-print.js';
import { printFlagFromNationality } from '../locale.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import CardArt from '../components/CardArt.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { filterExpansionCards, isSetDeskCard, searchPrintLang, searchRarity, uniqueSearchOptions } from '../search-filters.js';
import { defaultExpansionSort, expansionTilesReady, hasOfficialSetList } from '../set-official-lists.js';
import { setDeskSkeletonCount } from '../set-desk-preview.js';
import { bundleReference, writeListingDrag } from '../chat-listing.js';
import { expansionLogoSrc, expansionSymbolSrc, eraHref, tcgEra } from '../set-logos.js';
import { setSeoTitle } from '../seo.js';
import { rememberPageView, restoredPageView } from '../scroll-restore.js';

const VIEW_KEY = 'pokoin.expansionView';

function readView() {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === 'list' || stored === 'grid') {
      return stored;
    }
  } catch {
    /* private mode */
  }
  return 'grid';
}

function GridIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor">
      <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.2" />
      <rect x="11" y="2.5" width="6.5" height="6.5" rx="1.2" />
      <rect x="2.5" y="11" width="6.5" height="6.5" rx="1.2" />
      <rect x="11" y="11" width="6.5" height="6.5" rx="1.2" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor">
      <rect x="2.5" y="3.2" width="4.2" height="3.6" rx="0.8" />
      <rect x="8.2" y="3.8" width="9.3" height="2.4" rx="0.8" />
      <rect x="2.5" y="8.2" width="4.2" height="3.6" rx="0.8" />
      <rect x="8.2" y="8.8" width="9.3" height="2.4" rx="0.8" />
      <rect x="2.5" y="13.2" width="4.2" height="3.6" rx="0.8" />
      <rect x="8.2" y="13.8" width="9.3" height="2.4" rx="0.8" />
    </svg>
  );
}

export default function Expansion() {
  const { slug } = useParams();
  const location = useLocation();
  const navType = useNavigationType();
  const restored = restoredPageView(navType, location.key, `${location.pathname}${location.search}`);
  const restoredHere = restored?.slug === slug ? restored : null;
  const [payload, setPayload] = useState(() => {
    const cached = peekExpansion({ slug, limit: EXPANSION_PAGE, offset: 0 });
    return expansionTilesReady(cached, slug, cached?.expansion?.name) ? cached : null;
  });
  const [error, setError] = useState('');
  const [query, setQuery] = useState(() => String(restoredHere?.query || ''));
  const [sort, setSort] = useState(() => restoredHere?.sort || defaultExpansionSort(slug));
  const [rarity, setRarity] = useState(() => String(restoredHere?.rarity || ''));
  const [language, setLanguage] = useState(() => String(restoredHere?.language || ''));
  const [reverse, setReverse] = useState(() => restoredHere?.reverse || 'any');
  const [firstEdition, setFirstEdition] = useState(() => restoredHere?.firstEdition || 'any');
  const [listed, setListed] = useState(() => restoredHere?.listed || 'any');
  const [view, setView] = useState(readView);

  useEffect(() => {
    let cancelled = false;
    const cached = peekExpansion({ slug, limit: EXPANSION_PAGE, offset: 0 });
    setPayload(expansionTilesReady(cached, slug, cached?.expansion?.name) ? cached : null);
    const saved = restoredPageView(navType, location.key, `${location.pathname}${location.search}`);
    const hydrate = saved?.slug === slug ? saved : null;
    if (hydrate) {
      setQuery(String(hydrate.query || ''));
      setSort(hydrate.sort || defaultExpansionSort(slug));
      setRarity(String(hydrate.rarity || ''));
      setLanguage(String(hydrate.language || ''));
      setReverse(hydrate.reverse || 'any');
      setFirstEdition(hydrate.firstEdition || 'any');
      setListed(hydrate.listed || 'any');
    } else {
      setQuery('');
      setSort(defaultExpansionSort(slug));
      setRarity('');
      setLanguage('');
      setReverse('any');
      setFirstEdition('any');
      setListed('any');
    }
    fetchExpansion({
      slug,
      limit: EXPANSION_PAGE,
      offset: 0,
      onUpdate: (data) => {
        if (cancelled || !data) {
          return;
        }
        document.title = setSeoTitle(data.expansion?.name || prettySlug(slug));
        if (expansionTilesReady(data, slug, data.expansion?.name)) {
          setPayload(data);
          return;
        }
        setPayload({
          expansion: data.expansion || null,
          cards: [],
          hasMore: true,
        });
      },
    })
      .then((data) => {
        if (cancelled) {
          return;
        }
        document.title = setSeoTitle(data?.expansion?.name || prettySlug(slug));
        setError('');
        const shortPage = (data?.cards?.length || 0) > 0 && data.cards.length < EXPANSION_PAGE;
        if (shortPage || expansionTilesReady(data, slug, data?.expansion?.name)) {
          setPayload(shortPage ? { ...data, hasMore: false } : data);
          // A snapshot is the whole set; only a live first page walks on.
          if (shortPage || data?.fromSnapshot) return null;
        } else {
          setPayload({
            expansion: data?.expansion || null,
            cards: [],
            hasMore: true,
          });
        }
        return fetchExpansionCards({ slug, expansionName: data?.expansion?.name });
      })
      .then((full) => {
        if (cancelled || !full?.cards?.length) {
          return;
        }
        setPayload({
          ...(full || {}),
          cards: full.cards,
          hasMore: Boolean(full.hasMore),
          expansion: full.expansion,
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Expansion failed.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function loadMore() {
    const data = await fetchExpansion({
      slug,
      expansionName: payload?.expansion?.name,
      limit: EXPANSION_PAGE,
      offset: (payload?.cards || []).length,
    });
    const extra = data.cards || [];
    setPayload((current) => {
      const cardCount = Number(
        current?.expansion?.cardCount ||
        data?.expansion?.cardCount ||
        current?.total ||
        data?.total ||
        0,
      );
      return {
        ...data,
        cards: [...(current?.cards || []), ...extra],
        total: cardCount || current?.total || data?.total,
        expansion: {
          ...(current?.expansion || {}),
          ...(data.expansion || {}),
          ...(cardCount > 0 ? { cardCount } : {}),
        },
      };
    });
    if (extra[0]) {
      track(Action.loadMore, extra[0], { query: slug });
    }
  }

  function changeView(next) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* private mode */
    }
  }

  function clearFilters() {
    setQuery('');
    setSort(defaultExpansionSort(slug));
    setRarity('');
    setLanguage('');
    setReverse('any');
    setFirstEdition('any');
    setListed('any');
  }

  const name = payload?.expansion?.name || prettySlug(slug);
  const tilesReady = expansionTilesReady(payload, slug, name);
  const loading = !error && !tilesReady;
  const cards = payload?.cards || [];
  const symbol = expansionSymbolSrc(payload?.expansion || { slug });
  const wordmark = expansionLogoSrc(payload?.expansion || { slug, name });
  const printFlag = printFlagFromNationality(resolveExpansionNationality({
    ...(payload?.expansion || {}),
    slug,
    name,
  }));
  const fallbackLang = searchPrintLang({ nationality: payload?.expansion?.nationality });
  const deskCards = useMemo(() => cards.filter(isSetDeskCard), [cards]);
  const rarities = useMemo(() => uniqueSearchOptions(deskCards, searchRarity), [deskCards]);
  const langs = useMemo(() => {
    const fromCards = uniqueSearchOptions(deskCards, searchPrintLang);
    return fromCards.length ? fromCards : (fallbackLang ? [fallbackLang] : []);
  }, [deskCards, fallbackLang]);
  const shown = useMemo(
    () => filterExpansionCards(deskCards, {
      query,
      sort,
      rarity,
      language,
      fallbackLang,
      reverse,
      firstEdition,
      listed,
      expansionSlug: slug,
      expansionName: name,
    }),
    [deskCards, query, sort, rarity, language, fallbackLang, reverse, firstEdition, listed, slug, name],
  );
  const defaultSort = defaultExpansionSort(slug, name);
  const officialSort = hasOfficialSetList(slug, name);
  const deskTotal = useMemo(
    () => filterExpansionCards(deskCards, {
      sort: defaultSort,
      expansionSlug: slug,
      expansionName: name,
    }).length,
    [deskCards, slug, name, defaultSort],
  );
  const filtersOn = Boolean(query.trim())
    || rarity
    || language
    || reverse !== 'any'
    || firstEdition !== 'any'
    || listed !== 'any'
    || sort !== defaultSort;
  const eraName = tcgEra(payload?.expansion || { slug, name, set: name });
  const eraPath = eraName ? eraHref(eraName) : '';
  const lede = loading
    ? 'Loading cards…'
    : `${(deskTotal || shown.length).toLocaleString()} cards${eraName ? ` in ${eraName}` : ''}.`;
  // Skeletons only while the set is really loading, at most three rows. Loaded
  // cards always render (images are loading="lazy"); off-screen tiles skip
  // layout via content-visibility (.set-desk .grid > .tile).
  const walkSkeletons = Math.min(21, setDeskSkeletonCount(payload?.expansion, 14));

  useEffect(() => {
    rememberPageView(location.key, {
      slug,
      query,
      sort,
      rarity,
      language,
      reverse,
      firstEdition,
      listed,
    });
  }, [location.key, slug, query, sort, rarity, language, reverse, firstEdition, listed]);

  return (
    <div className="page desk set-desk" aria-busy={loading ? 'true' : undefined}>
      <SeoHead
        title={setSeoTitle(name)}
        description={lede}
        canonical={`/marketplace/sets/${slug}`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Sets', href: '/marketplace/sets' },
        eraName && eraPath ? { name: eraName, href: eraPath } : null,
        { name },
      ]} />
      <PageHead
        kicker="Set"
        title={name}
        lede={lede}
        printFlag={printFlag}
      >
        {wordmark ? (
          <img
            className="set-wordmark"
            src={wordmark}
            alt=""
            draggable
            onDragStart={(event) => writeListingDrag(event, bundleReference({
              kind: 'expansion',
              slug,
              name,
              imageUrl: wordmark,
              path: `/marketplace/sets/${slug}`,
            }))}
          />
        ) : null}
        {symbol ? (
          <span className="set-shortcut is-on set-sym-wrap" aria-hidden="true">
            <CardArt className="set-sym set-shortcut-sym" src={symbol} alt="" fallback="hide" />
          </span>
        ) : null}
      </PageHead>
      <form
        className="set-browse"
        onSubmit={(event) => event.preventDefault()}
        aria-label="Search and filter this set"
      >
        <div className="set-browse-bar">
          <label className="set-search">
            <span className="sr-only">Search this set</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this set…"
              autoComplete="off"
              enterKeyHint="search"
            />
            <span className="set-search-go" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M12.4 12.4 17 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
          </label>
          <label className="sort">
            Sort by
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              {officialSort ? <option value="official">Official</option> : null}
              <option value="number">Number</option>
              <option value="name">Name (A → Z)</option>
              <option value="price-asc">Price: low</option>
              <option value="price-desc">Price: high</option>
            </select>
          </label>
          <div className="set-view" role="group" aria-label="View">
            <button
              type="button"
              className={view === 'grid' ? 'on' : ''}
              aria-pressed={view === 'grid'}
              aria-label="Grid view"
              onClick={() => changeView('grid')}
            >
              <GridIcon />
            </button>
            <button
              type="button"
              className={view === 'list' ? 'on' : ''}
              aria-pressed={view === 'list'}
              aria-label="List view"
              onClick={() => changeView('list')}
            >
              <ListIcon />
            </button>
          </div>
        </div>
        <div className="set-filters">
          {langs.length ? (
            <label className="sort">
              <span className="set-filter-name">Language</span>
              <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                <option value="">Any language</option>
                {langs.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="sort">
            <span className="set-filter-name">Rarity</span>
            <select value={rarity} onChange={(event) => setRarity(event.target.value)}>
              <option value="">Any rarity</option>
              {rarities.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="sort">
            <span className="set-filter-name">Reverse</span>
            <select value={reverse} onChange={(event) => setReverse(event.target.value)}>
              <option value="any">Reverse: any</option>
              <option value="yes">Reverse</option>
              <option value="no">Not reverse</option>
            </select>
          </label>
          <label className="sort">
            <span className="set-filter-name">First edition</span>
            <select value={firstEdition} onChange={(event) => setFirstEdition(event.target.value)}>
              <option value="any">1st Ed.: any</option>
              <option value="yes">1st Ed.</option>
              <option value="no">Unlimited</option>
            </select>
          </label>
          <label className="sort">
            <span className="set-filter-name">Listed</span>
            <select value={listed} onChange={(event) => setListed(event.target.value)}>
              <option value="any">Listed: any</option>
              <option value="yes">Has PKN</option>
              <option value="no">No price</option>
            </select>
          </label>
          {filtersOn ? (
            <button className="linkish" type="button" onClick={clearFilters}>
              Clear
            </button>
          ) : null}
        </div>
        <p className="result-count">
          {loading
            ? 'Loading…'
            : (
              <>
                <strong>{shown.length.toLocaleString()}</strong>
                {filtersOn ? ' matching' : ` of ${deskTotal.toLocaleString()}`}
              </>
            )}
        </p>
      </form>
      <Alert>{error}</Alert>
      {!loading && deskCards.length && !shown.length ? (
        <EmptyDesk title="No cards match" lede="Clear a filter or try a shorter name or collector number.">
          <button className="btn" type="button" onClick={clearFilters}>Clear filters</button>
        </EmptyDesk>
      ) : (
        <CardSelectGrid className={view === 'list' ? 'grid is-list' : 'grid'} cards={loading ? [] : shown}>
          {loading
            ? Array.from({ length: walkSkeletons }, (_, index) => (
                <SkeletonTile key={`walk-${index}`} layout={view} />
              ))
            : (
              <>
                {shown.map((card, index) => (
                  <CardTile key={card.id} card={card} rank={index} layout={view} eagerLimit={14} />
                ))}
              </>
            )}
        </CardSelectGrid>
      )}
      {payload?.hasMore && !query.trim() && !loading ? (
        <button className="more" type="button" onClick={loadMore}>Load more</button>
      ) : null}
    </div>
  );
}
