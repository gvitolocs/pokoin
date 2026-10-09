import { createEffect, createMemo, createSignal, For, Match, onSettled, Repeat, Show, Switch, untrack } from 'solid-js';
import { useLocation, useParams } from '@solidjs/router';
import { albumShadeStyle } from '@market/art-shade.js';
import { fetchArtist, fetchArtistSummaries, imageSrc, peekArtist } from '@market/api.js';
import { artistDeskIsUnknown, artistNameFromSlug } from '@market/artist-name.js';
import { artistCardCount } from '@market/browse-hubs.js';
import { addCatalogCards } from '@market/cart-add.js';
import { bundleReference, preloadDragImage, writeListingDrag } from '@market/chat-listing.js';
import { ARTIST_PRINT_FLAGS, flagSrc } from '@market/locale.js';
import { isEnglishFlavorName } from '@market/ocr-artists.js';
import {
  albumTileKey,
  filterSearchCards,
  groupArtworkRows,
  searchRarity,
  searchSet,
  uniqueSearchOptions,
} from '@market/search-filters.js';
import { artistSeoTitle } from '@market/seo.js';
import { ArtistPileTile, ArtworkPileOverlay } from '../components/ArtworkPile.jsx';
import CardArt from '../components/CardArt.jsx';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SearchToolbar from '../components/SearchToolbar.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { afterPaint } from '../lib/after-paint.js';
import { rememberView, restoreScroll, restoredView } from '../lib/scroll-restore.js';
import { addCartItem } from '../stores/cart.js';

const ALBUM_PAGE = 24;
const PRELOAD_AHEAD = 20;
/** First pokedex page. SQL already returns this order, so it can paint before the rest. */
const ARTIST_FIRST = 48;

const PALETTE_PATH = 'M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z';

function hrefNow(location) {
  return untrack(() => `${location.pathname}${location.search}`);
}

/** /marketplace/:lang/artists — illustrator album tiles with a name filter. */
function ArtistsIndex(props) {
  const location = useLocation();
  const href = hrefNow(location);
  const restored = restoredView(href);
  const [artists, setArtists] = createSignal(null);
  const [error, setError] = createSignal('');
  const [query, setQuery] = createSignal(String(restored?.query || ''));
  let disposed = false;
  let stopRestore = () => {};

  document.title = artistSeoTitle('');
  fetchArtistSummaries({ limit: 1000 })
    .then((data) => {
      if (disposed) return;
      setArtists(() => data.artists || data.summaries || []);
      queueMicrotask(() => {
        if (!disposed) stopRestore = restoreScroll(href);
      });
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Artists failed.');
    });
  onSettled(() => () => {
    disposed = true;
    stopRestore();
  });

  createEffect(query, (value) => {
    rememberView(href, { query: value });
  });

  const shown = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return (artists() || []).filter((row) => {
      if (!needle) return true;
      const name = `${row.name || row.artist || row.slug || ''}`.toLowerCase();
      return name.includes(needle);
    });
  });

  return (
    <div class="page desk">
      <SeoHead
        title={artistSeoTitle('')}
        description="Pokémon illustrators from leftover printings, including CLIP reprints of the same artwork."
        canonical={`/marketplace/${props.lang}/artists`}
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
      <form class="shop-toolbar" onSubmit={(event) => event.preventDefault()}>
        <p class="result-count">
          <Show when={artists() != null} fallback="Loading…">
            <strong>{shown().length}</strong> artists
          </Show>
        </p>
        <input
          class="shop-search"
          type="search"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter artists…"
          aria-label="Filter artists"
        />
      </form>
      <Alert message={error()} />
      <Show when={artists() == null && !error()}>
        <div class="grid album-grid artist-index-grid" aria-hidden="true">
          <Repeat count={12}>{() => <SkeletonTile album />}</Repeat>
        </div>
      </Show>
      <Switch>
        <Match when={artists() && !shown().length}>
          <EmptyDesk title="No artist summaries" lede="Open an illustrator from a card desk, or clear the filter." />
        </Match>
        <Match when={artists()}>
          <div class="grid album-grid artist-index-grid">
            <For each={shown()}>
              {(row, index) => {
                const slug = row.slug || row.artistSlug;
                const name = row.name || row.artist || slug;
                const art = row.imageUrl || row.profileImageUrl || '';
                const count = artistCardCount(row);
                return (
                  <Show when={slug}>
                    <a
                      class="tile artist-tile tile-cut tile-album"
                      draggable="true"
                      href={`/marketplace/${props.lang}/artists/${slug}`}
                      style={albumShadeStyle(row)}
                      onDragStart={(event) => writeListingDrag(event, bundleReference({
                        kind: 'artist',
                        slug,
                        name,
                        imageUrl: art,
                        path: `/marketplace/${props.lang}/artists/${slug}`,
                      }))}
                    >
                      <span class="tile-art">
                        <Show when={art} fallback={<span class="tile-ph" />}>
                          <CardArt
                            src={art}
                            alt=""
                            cut
                            full
                            card={row}
                            loading={index() < 8 ? 'eager' : 'lazy'}
                            fetchPriority={index() < 4 ? 'high' : undefined}
                          />
                        </Show>
                      </span>
                      <div class="tile-meta">
                        <strong>{name}</strong>
                        <em class="tile-id">{count ? `${count} cards` : 'Illustrator'}</em>
                      </div>
                    </a>
                  </Show>
                );
              }}
            </For>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

function PrintFlagButton(props) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed == null ? undefined : (props.pressed ? 'true' : 'false')}
      aria-label={props.row.label}
      title={props.row.label}
      onClick={() => props.onPick(props.row.code)}
    >
      <img src={flagSrc(props.row.flag)} alt="" width="32" height="32" />
    </button>
  );
}

/** Same-artwork tile identity: a pile by its artwork key, a single printing by its album key. */
function groupTileKey(group) {
  return group.cards.length > 1 ? `pile:${group.key}` : `card:${albumTileKey(group.cards[0])}`;
}

/**
 * Artist desk: every leftover printing credited to the illustrator, as album
 * crops (D00003G / D00004F), Pokédex order by default with same-artwork
 * reprints piled at their oldest expansion (D00002K / D00003I), and the
 * Western / JP+KO / CN / ID print flags (D000056).
 */
function ArtistDesk(props) {
  const slug = untrack(() => props.slug);
  const lang = untrack(() => props.lang);
  const location = useLocation();
  const href = hrefNow(location);
  const restored = restoredView(href);
  const restoredHere = restored?.slug === slug ? restored : null;
  const cached = peekArtist(slug, 5000) || peekArtist(slug, ARTIST_FIRST);
  const [payload, setPayload] = createSignal(cached);
  const [restPending, setRestPending] = createSignal(!peekArtist(slug, 5000));
  const [error, setError] = createSignal('');
  const [query, setQuery] = createSignal(String(restoredHere?.query || ''));
  const [type, setType] = createSignal(restoredHere?.type || 'singles');
  const [rarity, setRarity] = createSignal(String(restoredHere?.rarity || ''));
  const [setName, setSetName] = createSignal(String(restoredHere?.setName || ''));
  const [sort, setSort] = createSignal(restoredHere?.sort || 'pokedex');
  const [print, setPrint] = createSignal(restoredHere?.print || 'western');
  const [cartBusy, setCartBusy] = createSignal(false);
  const [cartNote, setCartNote] = createSignal('');
  const [pile, setPile] = createSignal(null);
  // Album tiles shown: a back arrival's own count, then one page again after
  // any filter change (a writable memo; the scroll sentinel writes it).
  const [shown, setShown] = createSignal((prev) => {
    print(); type(); rarity(); setName(); sort(); query();
    if (prev !== undefined) return ALBUM_PAGE;
    const count = Number(restoredHere?.shown);
    return count > ALBUM_PAGE ? count : ALBUM_PAGE;
  });
  const [cover, setCover] = createSignal('');
  let sentinel;
  let disposed = false;
  let stopRestore = () => {};
  let restoreArmed = Boolean(restoredHere);
  // Plain mirror: two responses can land before the signal flushes.
  let payloadNow = cached;

  const stubName = artistNameFromSlug(slug);
  const firstPaint = isEnglishFlavorName(stubName) ? 'Artist' : stubName;

  fetchArtistSummaries({ limit: 1000 }).then((data) => {
    const row = (data?.artists || []).find((item) => item.slug === slug);
    const src = row?.imageUrl || '';
    if (disposed) return;
    setCover(src);
    if (src) preloadDragImage(src);
  }).catch(() => {});

  document.title = artistSeoTitle(firstPaint);
  let painted = Boolean(cached?.cards?.length);
  function paintArtist(data, { replace = false } = {}) {
    if (disposed || !data) return;
    if (data.cards?.length) painted = true;
    if (replace || (payloadNow?.cards?.length || 0) <= (data.cards?.length || 0)) {
      payloadNow = data;
      setPayload(() => data);
    }
    document.title = artistDeskIsUnknown(data) ? 'Artist · Pokoin' : artistSeoTitle(data.artist?.name || firstPaint);
    setError('');
  }
  if (!peekArtist(slug, 5000)) {
    fetchArtist(slug, { limit: ARTIST_FIRST })
      .then((data) => paintArtist(data))
      .catch(() => {});
  }
  fetchArtist(slug, { limit: 5000 })
    .then((data) => {
      paintArtist(data, { replace: true });
      if (!disposed) setRestPending(false);
    })
    .catch((err) => {
      if (disposed) return;
      setRestPending(false);
      if (!painted) setError(err.message || 'Artist failed.');
    });

  onSettled(() => () => {
    disposed = true;
    stopRestore();
  });

  createEffect(
    () => ({
      slug,
      shown: shown(),
      query: query(),
      type: type(),
      rarity: rarity(),
      setName: setName(),
      sort: sort(),
      print: print(),
    }),
    (view) => {
      rememberView(href, view);
    },
  );

  const allCards = () => payload()?.cards;
  const regionCards = createMemo(() => filterSearchCards(allCards(), { print: print() }));
  const rarities = createMemo(() => uniqueSearchOptions(regionCards(), searchRarity));
  const sets = createMemo(() => uniqueSearchOptions(regionCards(), searchSet));
  const cards = createMemo(() => filterSearchCards(allCards(), {
    type: type(),
    rarity: rarity(),
    set: setName(),
    sort: sort(),
    query: query(),
    print: print(),
    expandPokedexPairs: sort() === 'pokedex',
  }));
  const uniqueCardCount = createMemo(() => new Set(cards().map((card) => card.id || card.card_id)).size);
  // Same-artwork printings pile into one tile; pagination counts tiles.
  const groups = createMemo(() => groupArtworkRows(cards()));
  const visibleGroups = createMemo(() => groups().slice(0, shown()));
  const visibleCards = createMemo(() => visibleGroups().flatMap((group) => group.cards));

  // Back arrival: chase the saved offset once the album has tiles to scroll to.
  createEffect(
    () => groups().length > 0,
    (ready) => {
      if (!ready || !restoreArmed) return;
      restoreArmed = false;
      stopRestore = restoreScroll(href);
    },
  );

  // React useEffect lifetime: a watcher is armed after paint and torn down
  // after the next paint, so the observer callback queued by the scroll that
  // crossed the threshold still lands (one more batch). That keeps the
  // sentinel below the viewport; once it is on screen it becomes the scroll
  // anchor (the album grid opts out of anchoring) and every batch yanks the
  // page down to it.
  createEffect(
    () => [shown(), groups().length],
    ([count, total]) => {
      if (count >= total) return undefined;
      let release = null;
      const cancel = afterPaint(() => {
        release = watchSentinel(total);
      });
      return () => {
        cancel();
        if (release) afterPaint(release);
      };
    },
  );

  /** Grow the album while its sentinel is within 800 px below the viewport. */
  function watchSentinel(total) {
    const node = sentinel;
    if (!node?.isConnected) return () => {};
    let last = 0;
    // A task, like React's render of a setState from a native listener: the
    // frame's intersection step still measures the pre-append layout, so a
    // scroll that crosses the threshold queues the observer's batch too.
    const grow = () => {
      window.setTimeout(() => setShown((current) => Math.min(current + ALBUM_PAGE, total)), 0);
    };
    // Append while the sentinel is still ahead. Once it sits above the
    // viewport, new rows reflow the dense grid and the page yanks.
    const ahead = (rect) => rect && rect.bottom >= 0 && rect.top <= window.innerHeight + 800;
    const check = () => {
      if (ahead(node.getBoundingClientRect())) grow();
    };
    const onScroll = () => {
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      check();
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => ahead(entry.boundingClientRect))) grow();
    }, { rootMargin: '800px 0px' });
    observer.observe(node);
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }

  createEffect(
    () => [groups(), visibleGroups().length],
    ([list, next]) => {
      if (!list.length) return;
      for (const group of list.slice(next, next + PRELOAD_AHEAD)) {
        const src = imageSrc(group.cards[0], 'hero');
        if (!src) continue;
        const img = new Image();
        img.decoding = 'async';
        img.src = src;
      }
    },
  );

  const unknown = () => artistDeskIsUnknown(payload());
  const name = () => (unknown() ? '' : (payload()?.artist?.name || payload()?.name || firstPaint));
  const total = () => Number(payload()?.artist?.cardCount || allCards()?.length || 0);
  const filtersOn = () => type() !== 'singles' || Boolean(rarity()) || Boolean(setName())
    || sort() !== 'pokedex' || print() !== 'western' || Boolean(query().trim());
  const sortNote = () => (sort() === 'pokedex' ? ' · Sorted by Pokédex' : '');

  // One list per distinct trail: SeoCrumbs keys its links by object identity.
  const crumbs = createMemo(() => [
    { name: 'Marketplace', href: '/marketplace' },
    { name: 'Artists', href: `/marketplace/${lang}/artists` },
    { name: name() || 'Artist' },
  ], { equals: (a, b) => a[2].name === b[2].name });

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

  async function addArtistToCart() {
    const list = cards();
    if (cartBusy() || !list.length) return;
    setCartBusy(true);
    setCartNote('');
    try {
      const added = await addCatalogCards(list, addCartItem);
      setCartNote(
        added
          ? `Added ${added} listed card${added === 1 ? '' : 's'} to cart`
          : 'No listed copies for these printings',
      );
    } catch (_) {
      setCartNote('Could not add cards to cart');
    } finally {
      setCartBusy(false);
    }
  }

  return (
    <Show
      when={!unknown()}
      fallback={(
        <div class="page desk">
          <EmptyDesk title="No illustrator" lede="That URL is not a leftover artist. Open the catalog.">
            <a class="btn" href={`/marketplace/${lang}/artists`}>Artists</a>
          </EmptyDesk>
        </div>
      )}
    >
      <div class="page desk artist-desk">
        <SeoHead
          title={artistSeoTitle(name())}
          description={`${name()} Pokémon cards and values. ${total() ? `${total()} leftover printings.` : 'Illustrator gallery from the Pokoin catalog.'}`}
          canonical={`/marketplace/${lang}/artists/${slug}`}
        />
        <SeoCrumbs items={crumbs()} />
        <PageHead
          kicker={<a class="page-kicker-link" href={`/marketplace/${lang}/artists`}>Artist</a>}
          title={(
            <>
              <svg class="page-title-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                <path fill="currentColor" d={PALETTE_PATH} />
              </svg>
              <span
                draggable="true"
                onDragStart={(event) => writeListingDrag(event, bundleReference({
                  kind: 'artist',
                  slug,
                  name: name(),
                  imageUrl: cover(),
                  path: `/marketplace/${lang}/artists/${slug}`,
                }))}
              >{name()}</span>
            </>
          )}
        />
        <form
          class="set-browse artist-browse"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Search and filter this artist"
        >
          <div class="set-browse-bar">
            <div class="artist-print-flags" role="group" aria-label="Print region">
              <For each={ARTIST_PRINT_FLAGS}>
                {(row) => <PrintFlagButton row={row} pressed={print() === row.code} onPick={changePrint} />}
              </For>
            </div>
            <button
              type="button"
              class="btn ghost artist-add-cart"
              disabled={cartBusy() || !cards().length}
              onClick={() => void addArtistToCart()}
              title="Add listed copies of these printings to the cart"
            >
              {cartBusy() ? 'Adding…' : 'Add all to cart'}
            </button>
            <Show when={cartNote()}><span class="artist-cart-note" role="status">{cartNote()}</span></Show>
            <label class="set-search">
              <span class="sr-only">Search this artist</span>
              <input
                type="search"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search this artist…"
                autocomplete="off"
                enterkeyhint="search"
              />
              <span class="set-search-go" aria-hidden="true">
                <svg viewBox="0 0 20 20">
                  <circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" stroke-width="1.8" />
                  <path d="M12.4 12.4 17 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
              </span>
            </label>
            <SearchToolbar
              compact
              sort={sort()}
              onSort={setSort}
              type={type()}
              onType={setType}
              rarity={rarity()}
              onRarity={setRarity}
              rarities={rarities()}
              setName={setName()}
              onSet={setSetName}
              sets={sets()}
              filtersOn={filtersOn()}
              onClear={clearFilters}
            />
          </div>
          <p class="result-count">
            <Switch fallback="Loading…">
              <Match when={payload() && !allCards()?.length}>No cards for this artist.</Match>
              <Match when={payload() && filtersOn()}>
                <strong>{uniqueCardCount()}</strong> matching{sortNote()}
              </Match>
              <Match when={payload()}>
                <strong>{uniqueCardCount()}</strong> {uniqueCardCount() === 1 ? 'card' : 'cards'}
                {total() > uniqueCardCount() ? ` of ${total()}` : ''}{sortNote()}
              </Match>
            </Switch>
          </p>
        </form>
        <Alert message={error()} />
        <Show
          when={!(payload() && allCards()?.length && !cards().length)}
          fallback={(
            <EmptyDesk title="No cards match those filters" lede="Clear a filter or try a shorter name or set.">
              <button class="btn" type="button" onClick={clearFilters}>Clear filters</button>
            </EmptyDesk>
          )}
        >
          <CardSelectGrid class="grid album-grid" cards={payload() ? visibleCards() : []}>
            <Show
              when={payload() || error()}
              fallback={<Repeat count={12}>{() => <SkeletonTile album />}</Repeat>}
            >
              <For each={visibleGroups()} keyed={groupTileKey}>
                {(group, index) => (untrack(() => group().cards.length > 1)
                  // The key says pile or single, so the choice never changes for a row.
                  ? <ArtistPileTile group={group()} rank={index()} onOpen={(next) => setPile(() => next)} />
                  : <CardTile card={group().cards[0]} rank={index()} cut />)}
              </For>
            </Show>
            <Show when={payload() && restPending() && !filtersOn()}>
              <Repeat count={8}>{() => <SkeletonTile album />}</Repeat>
            </Show>
          </CardSelectGrid>
        </Show>
        <Show when={payload() && shown() < groups().length}>
          <div ref={(node) => { sentinel = node; }} class="album-scroll-sentinel" aria-hidden="true" />
        </Show>
        <Show when={payload() && shown() >= groups().length && total() > uniqueCardCount() && type() === 'singles' && !rarity() && !setName() && !query().trim()}>
          <div class="album-other-prints">
            <p>{total() - uniqueCardCount()} more cards on the other prints</p>
            <div class="artist-print-flags" role="group" aria-label="Other print regions">
              <For each={ARTIST_PRINT_FLAGS.filter((row) => row.code !== print())}>
                {(row) => <PrintFlagButton row={row} onPick={changePrint} />}
              </For>
            </div>
          </div>
        </Show>
        <Show when={pile()} keyed>
          {(group) => <ArtworkPileOverlay group={group} artistName={name()} onClose={() => setPile(null)} />}
        </Show>
      </div>
    </Show>
  );
}

/** /marketplace/:lang/artists(/:artistSlug) (market/src/pages/Artist.jsx). */
export default function Artist() {
  const params = useParams();
  const lang = () => params.lang || 'en';
  return (
    <Show when={params.artistSlug && `${lang()}:${params.artistSlug}`} keyed fallback={<ArtistsIndex lang={lang()} />}>
      {(key) => <ArtistDesk lang={key.slice(0, key.indexOf(':'))} slug={key.slice(key.indexOf(':') + 1)} />}
    </Show>
  );
}
