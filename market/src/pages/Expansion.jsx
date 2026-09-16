import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom';
import { fetchExpansion, fetchExpansionCards, peekExpansion, prettySlug } from '../api.js';
import { Action, track } from '../track.js';
import { printFlagFromNationality } from '../locale.js';
import CardTile from '../components/CardTile.jsx';
import CardArt from '../components/CardArt.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { filterExpansionCards, isSetDeskCard, searchPrintLang, searchRarity, uniqueSearchOptions } from '../search-filters.js';
import { defaultExpansionSort, expansionTilesReady, hasOfficialSetList } from '../set-official-lists.js';
import {
  firstSetPreviewCount,
  nextSetPreviewCount,
  setDeskSkeletonCount,
} from '../set-desk-preview.js';
import { expansionSymbolSrc, eraHref, tcgEra } from '../set-logos.js';
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
    const cached = peekExpansion({ slug, limit: 48, offset: 0 });
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
  const [previewCount, setPreviewCount] = useState(() => Number(restoredHere?.previewCount) || 0);
  const suppressPreviewReset = useRef(Boolean(restoredHere));

  useEffect(() => {
    let cancelled = false;
    const cached = peekExpansion({ slug, limit: 48, offset: 0 });
    setPayload(expansionTilesReady(cached, slug, cached?.expansion?.name) ? cached : null);
    const saved = restoredPageView(navType, location.key, `${location.pathname}${location.search}`);
    const hydrate = saved?.slug === slug ? saved : null;
    if (hydrate) {
      suppressPreviewReset.current = true;
      setQuery(String(hydrate.query || ''));
      setSort(hydrate.sort || defaultExpansionSort(slug));
      setRarity(String(hydrate.rarity || ''));
      setLanguage(String(hydrate.language || ''));
      setReverse(hydrate.reverse || 'any');
      setFirstEdition(hydrate.firstEdition || 'any');
      setListed(hydrate.listed || 'any');
      setPreviewCount(Number(hydrate.previewCount) || 0);
    } else {
      suppressPreviewReset.current = false;
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
      limit: 48,
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
        if (expansionTilesReady(data, slug, data?.expansion?.name)) {
          setPayload(data);
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
      limit: 48,
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
  const printFlag = printFlagFromNationality(payload?.expansion?.nationality);
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
  const walkSkeletons = setDeskSkeletonCount(payload?.expansion);
  const previewCards = loading ? [] : shown.slice(0, previewCount);
  const pendingSkeletons = loading
    ? walkSkeletons
    : Math.max(0, shown.length - previewCards.length);

  useEffect(() => {
    if (suppressPreviewReset.current) {
      return;
    }
    setPreviewCount(firstSetPreviewCount(shown.length));
  }, [slug, sort, query, rarity, language, reverse, firstEdition, listed]);

  useEffect(() => {
    if (!tilesReady || !shown.length) {
      return;
    }
    setPreviewCount((current) => {
      const saved = suppressPreviewReset.current ? Number(restoredHere?.previewCount) || 0 : 0;
      const next = Math.max(current, saved, firstSetPreviewCount(shown.length));
      return Math.min(next, shown.length);
    });
    if (suppressPreviewReset.current) {
      suppressPreviewReset.current = false;
    }
  }, [tilesReady, shown.length, restoredHere?.previewCount]);

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
      previewCount,
    });
  }, [location.key, slug, query, sort, rarity, language, reverse, firstEdition, listed, previewCount]);

  useEffect(() => {
    if (loading || previewCount >= shown.length) {
      return undefined;
    }
    const advance = () => {
      setPreviewCount((current) => nextSetPreviewCount(current, shown.length));
    };
    // Sentinel sits in the first rows after the current batch. Observing it
    // with a fat rootMargin mounted the rest of the set in one frame. One
    // extra batch per scroll; skeletons stay until the user moves.
    window.addEventListener('scroll', advance, { passive: true, once: true });
    return () => window.removeEventListener('scroll', advance);
  }, [loading, previewCount, shown.length]);

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
              Language
              <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                <option value="">Any</option>
                {langs.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="sort">
            Rarity
            <select value={rarity} onChange={(event) => setRarity(event.target.value)}>
              <option value="">Any</option>
              {rarities.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="sort">
            Reverse
            <select value={reverse} onChange={(event) => setReverse(event.target.value)}>
              <option value="any">Any</option>
              <option value="yes">Reverse</option>
              <option value="no">Not reverse</option>
            </select>
          </label>
          <label className="sort">
            First edition
            <select value={firstEdition} onChange={(event) => setFirstEdition(event.target.value)}>
              <option value="any">Any</option>
              <option value="yes">1st Ed.</option>
              <option value="no">Unlimited</option>
            </select>
          </label>
          <label className="sort">
            Listed
            <select value={listed} onChange={(event) => setListed(event.target.value)}>
              <option value="any">Any</option>
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
        <div className={view === 'list' ? 'grid is-list' : 'grid'}>
          {loading
            ? Array.from({ length: walkSkeletons }, (_, index) => (
                <SkeletonTile key={`walk-${index}`} layout={view} />
              ))
            : (
              <>
                {previewCards.map((card, index) => (
                  <CardTile key={card.id} card={card} rank={index} layout={view} />
                ))}
                {previewCount < shown.length ? (
                  <div className="set-preview-sentinel" aria-hidden="true" />
                ) : null}
                {Array.from({ length: pendingSkeletons }, (_, index) => (
                  <SkeletonTile
                    key={`preview-${shown[previewCount + index]?.id || index}`}
                    layout={view}
                  />
                ))}
              </>
            )}
        </div>
      )}
      {payload?.hasMore && !query.trim() && !loading ? (
        <button className="more" type="button" onClick={loadMore}>Load more</button>
      ) : null}
    </div>
  );
}
