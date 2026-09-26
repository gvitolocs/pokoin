import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom';
import { albumShadeStyle } from '../art-shade.js';
import { fetchArtist, fetchArtistSummaries, imageSrc, peekArtist } from '../api.js';
import { bundleReference, preloadDragImage, writeListingDrag } from '../chat-listing.js';
import { artistDeskIsUnknown, artistNameFromSlug } from '../artist-name.js';
import { isEnglishFlavorName } from '../ocr-artists.js';
import CardArt from '../components/CardArt.jsx';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SearchToolbar from '../components/SearchToolbar.jsx';
import { artistSeoTitle } from '../seo.js';
import { ARTIST_PRINT_FLAGS, flagSrc } from '../locale.js';
import {
  albumTileKey,
  filterSearchCards,
  searchRarity,
  searchSet,
  uniqueSearchOptions,
} from '../search-filters.js';
import { rememberPageView, restoredPageView } from '../scroll-restore.js';

const ALBUM_PAGE = 24;
const PRELOAD_AHEAD = 20;

function artistCardCount(row) {
  return Number(row?.count || row?.cardCount || 0);
}

function ArtistsIndex() {
  const { lang = 'en' } = useParams();
  const location = useLocation();
  const navType = useNavigationType();
  const restored = restoredPageView(navType, location.key, `${location.pathname}${location.search}`);
  const [artists, setArtists] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(() => String(restored?.query || ''));

  useEffect(() => {
    document.title = artistSeoTitle('');
    let cancelled = false;
    fetchArtistSummaries({ limit: 1000 })
      .then((data) => {
        if (!cancelled) setArtists(data.artists || data.summaries || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Artists failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    rememberPageView(location.key, { query });
  }, [location.key, query]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (artists || []).filter((row) => {
      if (!needle) return true;
      const name = `${row.name || row.artist || row.slug || ''}`.toLowerCase();
      return name.includes(needle);
    });
  }, [artists, query]);

  return (
    <div className="page desk">
      <SeoHead
        title={artistSeoTitle('')}
        description="Pokémon illustrators from leftover printings, including CLIP reprints of the same artwork."
        canonical={`/marketplace/${lang}/artists`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Artists' },
      ]} />
      <PageHead
        kicker="Catalog"
        title="Pokémon Card Artists"
        lede="Pokémon illustrators from leftover printings, including CLIP reprints of the same artwork."
      />
      <form className="shop-toolbar" onSubmit={(event) => event.preventDefault()}>
        <p className="result-count">
          {artists == null ? 'Loading…' : <><strong>{shown.length}</strong> artists</>}
        </p>
        <input
          className="shop-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter artists…"
          aria-label="Filter artists"
        />
      </form>
      <Alert>{error}</Alert>
      {artists == null && !error ? (
        <div className="grid album-grid artist-index-grid" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} album />)}
        </div>
      ) : null}
      {artists && !shown.length ? (
        <EmptyDesk title="No artist summaries" lede="Open an illustrator from a card desk, or clear the filter." />
      ) : artists ? (
        <div className="grid album-grid artist-index-grid">
          {shown.map((row, index) => {
            const slug = row.slug || row.artistSlug;
            const name = row.name || row.artist || slug;
            const art = row.imageUrl || row.profileImageUrl || '';
            const count = artistCardCount(row);
            if (!slug) return null;
            return (
              <Link
                className="tile artist-tile tile-cut tile-album"
                key={slug}
                draggable
                to={`/marketplace/${lang}/artists/${slug}`}
                style={albumShadeStyle(row)}
                onDragStart={(event) => writeListingDrag(event, bundleReference({
                  kind: 'artist',
                  slug,
                  name,
                  imageUrl: art,
                  path: `/marketplace/${lang}/artists/${slug}`,
                }))}
              >
                <span className="tile-art">
                  {art ? (
                    <CardArt
                      src={art}
                      alt=""
                      cut
                      full
                      card={row}
                      loading={index < 8 ? 'eager' : 'lazy'}
                      fetchPriority={index < 4 ? 'high' : undefined}
                    />
                  ) : <span className="tile-ph" />}
                </span>
                <div className="tile-meta">
                  <strong>{name}</strong>
                  <em className="tile-id">{count ? `${count} cards` : 'Illustrator'}</em>
                </div>
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ArtistDesk() {
  const { lang = 'en', artistSlug } = useParams();
  const location = useLocation();
  const navType = useNavigationType();
  const restored = restoredPageView(navType, location.key, `${location.pathname}${location.search}`);
  const restoredHere = restored?.slug === artistSlug ? restored : null;
  const [payload, setPayload] = useState(() => peekArtist(artistSlug, 5000));
  const [error, setError] = useState('');
  const [query, setQuery] = useState(() => String(restoredHere?.query || ''));
  const [type, setType] = useState(() => restoredHere?.type || 'singles');
  const [rarity, setRarity] = useState(() => String(restoredHere?.rarity || ''));
  const [setName, setSetName] = useState(() => String(restoredHere?.setName || ''));
  const [sort, setSort] = useState(() => restoredHere?.sort || 'pokedex');
  const [print, setPrint] = useState(() => restoredHere?.print || 'western');
  const [shown, setShown] = useState(() => {
    const count = Number(restoredHere?.shown);
    return count > ALBUM_PAGE ? count : ALBUM_PAGE;
  });
  const sentinel = useRef(null);
  const suppressShownReset = useRef(Boolean(restoredHere));

  const stubName = artistNameFromSlug(artistSlug);
  const firstPaint = isEnglishFlavorName(stubName) ? 'Artist' : stubName;
  const [cover, setCover] = useState('');
  useEffect(() => {
    let live = true;
    fetchArtistSummaries({ limit: 1000 }).then((data) => {
      const row = (data?.artists || []).find((item) => item.slug === artistSlug);
      const src = row?.imageUrl || '';
      if (!live) return;
      setCover(src);
      if (src) preloadDragImage(src);
    }).catch(() => {});
    return () => { live = false; };
  }, [artistSlug]);

  useEffect(() => {
    const saved = restoredPageView(navType, location.key, `${location.pathname}${location.search}`);
    const hydrate = saved?.slug === artistSlug ? saved : null;
    const cached = peekArtist(artistSlug, 5000);
    setError('');
    setPayload(cached);
    if (hydrate) {
      suppressShownReset.current = true;
      setQuery(String(hydrate.query || ''));
      setType(hydrate.type || 'singles');
      setRarity(String(hydrate.rarity || ''));
      setSetName(String(hydrate.setName || ''));
      setSort(hydrate.sort || 'pokedex');
      setPrint(hydrate.print || 'western');
      setShown(Math.max(ALBUM_PAGE, Number(hydrate.shown) || ALBUM_PAGE));
    } else {
      suppressShownReset.current = false;
      setQuery('');
      setType('singles');
      setRarity('');
      setSetName('');
      setSort('pokedex');
      setPrint('western');
      setShown(ALBUM_PAGE);
    }
    document.title = artistSeoTitle(firstPaint);
    let cancelled = false;
    fetchArtist(artistSlug, { limit: 5000 })
      .then((data) => {
        if (cancelled) return;
        setPayload(data);
        if (artistDeskIsUnknown(data)) {
          document.title = 'Artist · Pokoin';
        } else {
          document.title = artistSeoTitle(data.artist?.name || firstPaint);
        }
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Artist failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [artistSlug, firstPaint, location.key, navType]);

  useEffect(() => {
    rememberPageView(location.key, {
      slug: artistSlug,
      shown,
      query,
      type,
      rarity,
      setName,
      sort,
      print,
    });
  }, [location.key, artistSlug, shown, query, type, rarity, setName, sort, print]);

  const allCards = payload?.cards;
  const regionCards = useMemo(
    () => filterSearchCards(allCards, { print }),
    [allCards, print],
  );
  const rarities = useMemo(() => uniqueSearchOptions(regionCards, searchRarity), [regionCards]);
  const sets = useMemo(() => uniqueSearchOptions(regionCards, searchSet), [regionCards]);
  const cards = useMemo(
    () => filterSearchCards(allCards, {
      type,
      rarity,
      set: setName,
      sort,
      query,
      print,
      expandPokedexPairs: sort === 'pokedex',
    }),
    [allCards, type, rarity, setName, sort, query, print],
  );
  const uniqueCardCount = useMemo(
    () => new Set(cards.map((card) => card.id || card.card_id)).size,
    [cards],
  );
  const visibleCards = cards.slice(0, shown);

  useEffect(() => {
    if (suppressShownReset.current) {
      suppressShownReset.current = false;
      return;
    }
    setShown(ALBUM_PAGE);
  }, [print, type, rarity, setName, sort, query]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || shown >= cards.length) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown((current) => Math.min(current + ALBUM_PAGE, cards.length));
      }
    }, { rootMargin: '800px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, cards.length]);

  useEffect(() => {
    if (!cards.length) return undefined;
    const next = visibleCards.length;
    const upcoming = cards.slice(next, next + PRELOAD_AHEAD);
    for (const card of upcoming) {
      const src = imageSrc(card, 'hero');
      if (!src) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    }
    return undefined;
  }, [cards, visibleCards.length]);

  const unknown = artistDeskIsUnknown(payload);
  const name = unknown ? '' : (payload?.artist?.name || payload?.name || firstPaint);
  const total = Number(payload?.artist?.cardCount || allCards?.length || 0);
  const filtersOn = type !== 'singles' || rarity || setName || sort !== 'pokedex' || print !== 'western' || Boolean(query.trim());

  function clearFilters() {
    setQuery('');
    setType('singles');
    setRarity('');
    setSetName('');
    setSort('pokedex');
    setPrint('western');
  }

  function changePrint(code) {
    setPrint(code);
    setRarity('');
    setSetName('');
  }

  if (unknown) {
    return (
      <div className="page desk">
        <EmptyDesk
          title="No illustrator"
          lede="That URL is not a leftover artist. Open the catalog."
        >
          <Link className="btn" to={`/marketplace/${lang}/artists`}>Artists</Link>
        </EmptyDesk>
      </div>
    );
  }

  return (
    <div className="page desk artist-desk">
      <SeoHead
        title={artistSeoTitle(name)}
        description={`${name} Pokémon cards and values. ${total ? `${total} leftover printings.` : 'Illustrator gallery from the Pokoin catalog.'}`}
        canonical={`/marketplace/${lang}/artists/${artistSlug}`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Artists', href: `/marketplace/${lang}/artists` },
        { name: name || 'Artist' },
      ]} />
      <PageHead
        kicker={(
          <Link className="page-kicker-link" to={`/marketplace/${lang}/artists`}>
            Artist
          </Link>
        )}
        title={(
          <>
            <svg className="page-title-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
              />
            </svg>
            <span
              draggable
              onDragStart={(event) => writeListingDrag(event, bundleReference({
                kind: 'artist',
                slug: artistSlug,
                name,
                imageUrl: cover,
                path: `/marketplace/${lang}/artists/${artistSlug}`,
              }))}
            >{name}</span>
          </>
        )}
      >
        <div className="set-browse-bar">
          <div className="artist-print-flags" role="group" aria-label="Print region">
            {ARTIST_PRINT_FLAGS.map((row) => (
              <button
                key={row.code}
                type="button"
                aria-pressed={print === row.code}
                aria-label={row.label}
                title={row.label}
                onClick={() => changePrint(row.code)}
              >
                <img src={flagSrc(row.flag)} alt="" width="32" height="32" />
              </button>
            ))}
          </div>
          <label className="set-search">
            <span className="sr-only">Search this artist</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this artist…"
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
          <SearchToolbar
            compact
            sort={sort}
            onSort={setSort}
            type={type}
            onType={setType}
            rarity={rarity}
            onRarity={setRarity}
            rarities={rarities}
            setName={setName}
            onSet={setSetName}
            sets={sets}
            filtersOn={filtersOn}
            onClear={clearFilters}
          />
        </div>
      </PageHead>
      <form
        className="set-browse artist-browse"
        onSubmit={(event) => event.preventDefault()}
        aria-label="Search and filter this artist"
      >
        <p className="result-count">
          {payload
            ? (allCards?.length
              ? (filtersOn
                ? <><strong>{uniqueCardCount}</strong> matching</>
                : <><strong>{uniqueCardCount}</strong> cards{total > uniqueCardCount ? ` of ${total}` : ''}</>)
              : 'No cards for this artist.')
            : 'Loading…'}
        </p>
      </form>
      <Alert>{error}</Alert>
      {payload && allCards?.length && !cards.length ? (
        <EmptyDesk title="No cards match those filters" lede="Clear a filter or try a shorter name or set.">
          <button className="btn" type="button" onClick={clearFilters}>Clear filters</button>
        </EmptyDesk>
      ) : (
        <CardSelectGrid className="grid album-grid" cards={payload ? visibleCards : []}>
          {!payload && !error
            ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} album />)
            : visibleCards.map((card, index) => (
                <CardTile key={albumTileKey(card)} card={card} rank={index} cut />
              ))}
        </CardSelectGrid>
      )}
      {payload && shown < cards.length ? (
        <div ref={sentinel} className="album-scroll-sentinel" aria-hidden="true" />
      ) : null}
    </div>
  );
}

export default function Artist() {
  const { artistSlug } = useParams();
  return artistSlug ? <ArtistDesk /> : <ArtistsIndex />;
}
