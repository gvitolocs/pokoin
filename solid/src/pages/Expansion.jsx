import { createEffect, createMemo, createSignal, For, onSettled, Repeat, Show, untrack } from 'solid-js';
import { useLocation, useParams } from '@solidjs/router';
import { EXPANSION_PAGE, fetchExpansion, fetchExpansionCards, peekExpansion, prettySlug } from '@market/api.js';
import { bundleReference, writeListingDrag } from '@market/chat-listing.js';
import { resolveExpansionNationality } from '@market/expansion-print.js';
import { printFlagFromNationality } from '@market/locale.js';
import { filterExpansionCards, isSetDeskCard, searchPrintLang, searchRarity, uniqueSearchOptions } from '@market/search-filters.js';
import { setSeoTitle } from '@market/seo.js';
import { firstSetPreviewCount, nextSetPreviewCount, setDeskSkeletonCount } from '@market/set-desk-preview.js';
import { expansionLogoSrc, expansionSymbolSrc, eraHref, tcgEra } from '@market/set-logos.js';
import { defaultExpansionSort, expansionTilesReady, hasOfficialSetList } from '@market/set-official-lists.js';
import { Action, track } from '@market/track.js';
import CardArt from '../components/CardArt.jsx';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { afterPaint } from '../lib/after-paint.js';
import { rememberView, restoreScroll, restoredView } from '../lib/scroll-restore.js';
import { syncSelect } from '../lib/select-sync.js';

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

function sameCrumbs(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The payload without its card list (the cards are their own signal). */
function infoOf(payload) {
  if (!payload) return null;
  const { cards: _cards, ...rest } = payload;
  return rest;
}

/**
 * Set desk (market/src/pages/Expansion.jsx). Waits for the whole set walk
 * before painting tiles, then mounts them 12 at a time per scroll; Official
 * order where a printed checklist exists (D00003F). Back restores the
 * filters, view and mounted count of that history entry (D00005C).
 */
function SetDesk(props) {
  const slug = untrack(() => props.slug);
  const location = useLocation();
  const href = untrack(() => `${location.pathname}${location.search}`);
  const restored = restoredView(href);
  const restoredHere = restored?.slug === slug ? restored : null;
  const cached = peekExpansion({ slug, limit: EXPANSION_PAGE, offset: 0 });
  const seed = expansionTilesReady(cached, slug, cached?.expansion?.name) ? cached : null;

  const [info, setInfo] = createSignal(infoOf(seed));
  // Plain rows, not a store: every filter keystroke re-runs filter + sort over
  // the whole set, and store proxies would track each field it reads. The grid
  // is keyed by card id, so a refetched list patches its tiles in place.
  const [cards, setCards] = createSignal(seed?.cards || []);
  // Plain mirrors: Load more reads them before the signals flush.
  let infoNow = infoOf(seed);
  let cardsNow = seed?.cards || [];

  const [error, setError] = createSignal('');
  const [query, setQuery] = createSignal(String(restoredHere?.query || ''));
  const [sort, setSort] = createSignal(restoredHere?.sort || defaultExpansionSort(slug));
  const [rarity, setRarity] = createSignal(String(restoredHere?.rarity || ''));
  const [language, setLanguage] = createSignal(String(restoredHere?.language || ''));
  const [reverse, setReverse] = createSignal(restoredHere?.reverse || 'any');
  const [firstEdition, setFirstEdition] = createSignal(restoredHere?.firstEdition || 'any');
  const [listed, setListed] = createSignal(restoredHere?.listed || 'any');
  const [view, setView] = createSignal(readView());
  let disposed = false;
  let stopRestore = () => {};

  function putPayload(next) {
    infoNow = infoOf(next);
    cardsNow = next?.cards || [];
    setInfo(() => infoNow);
    setCards(() => cardsNow);
  }

  function notReady(data) {
    return { expansion: data?.expansion || null, cards: [], hasMore: true };
  }

  fetchExpansion({
    slug,
    limit: EXPANSION_PAGE,
    offset: 0,
    onUpdate: (data) => {
      if (disposed || !data) {
        return;
      }
      document.title = setSeoTitle(data.expansion?.name || prettySlug(slug));
      putPayload(expansionTilesReady(data, slug, data.expansion?.name) ? data : notReady(data));
    },
  })
    .then((data) => {
      if (disposed) {
        return null;
      }
      document.title = setSeoTitle(data?.expansion?.name || prettySlug(slug));
      setError('');
      const shortPage = (data?.cards?.length || 0) > 0 && data.cards.length < EXPANSION_PAGE;
      if (shortPage || expansionTilesReady(data, slug, data?.expansion?.name)) {
        putPayload(shortPage ? { ...data, hasMore: false } : data);
        if (shortPage) return null;
      } else {
        putPayload(notReady(data));
      }
      return fetchExpansionCards({ slug, expansionName: data?.expansion?.name });
    })
    .then((full) => {
      if (disposed || !full?.cards?.length) {
        return;
      }
      putPayload({
        ...(full || {}),
        cards: full.cards,
        hasMore: Boolean(full.hasMore),
        expansion: full.expansion,
      });
    })
    .catch((err) => {
      if (!disposed) {
        setError(err.message || 'Expansion failed.');
      }
    });

  onSettled(() => () => {
    disposed = true;
    stopRestore();
  });

  async function loadMore() {
    const data = await fetchExpansion({
      slug,
      expansionName: infoNow?.expansion?.name,
      limit: EXPANSION_PAGE,
      offset: cardsNow.length,
    });
    if (disposed) return;
    const extra = data.cards || [];
    const current = infoNow;
    const cardCount = Number(
      current?.expansion?.cardCount ||
      data?.expansion?.cardCount ||
      current?.total ||
      data?.total ||
      0,
    );
    putPayload({
      ...data,
      cards: [...cardsNow, ...extra],
      total: cardCount || current?.total || data?.total,
      expansion: {
        ...(current?.expansion || {}),
        ...(data.expansion || {}),
        ...(cardCount > 0 ? { cardCount } : {}),
      },
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

  const name = () => info()?.expansion?.name || prettySlug(slug);
  const tilesReady = () => expansionTilesReady(info(), slug, name());
  const loading = () => !error() && !tilesReady();
  const symbol = () => expansionSymbolSrc(info()?.expansion || { slug });
  const wordmark = () => expansionLogoSrc(info()?.expansion || { slug, name: name() });
  const printFlag = () => printFlagFromNationality(resolveExpansionNationality({
    ...(info()?.expansion || {}),
    slug,
    name: name(),
  }));
  const fallbackLang = () => searchPrintLang({ nationality: info()?.expansion?.nationality });
  const deskCards = createMemo(() => cards().filter(isSetDeskCard));
  const rarities = createMemo(() => uniqueSearchOptions(deskCards(), searchRarity));
  const langs = createMemo(() => {
    const fromCards = uniqueSearchOptions(deskCards(), searchPrintLang);
    return fromCards.length ? fromCards : (fallbackLang() ? [fallbackLang()] : []);
  });
  const shown = createMemo(() => filterExpansionCards(deskCards(), {
    query: query(),
    sort: sort(),
    rarity: rarity(),
    language: language(),
    fallbackLang: fallbackLang(),
    reverse: reverse(),
    firstEdition: firstEdition(),
    listed: listed(),
    expansionSlug: slug,
    expansionName: name(),
  }));
  const defaultSort = () => defaultExpansionSort(slug, name());
  const officialSort = () => hasOfficialSetList(slug, name());
  const deskTotal = createMemo(() => filterExpansionCards(deskCards(), {
    sort: defaultSort(),
    expansionSlug: slug,
    expansionName: name(),
  }).length);
  const filtersOn = () => Boolean(query().trim())
    || Boolean(rarity())
    || Boolean(language())
    || reverse() !== 'any'
    || firstEdition() !== 'any'
    || listed() !== 'any'
    || sort() !== defaultSort();
  const eraName = () => tcgEra(info()?.expansion || { slug, name: name(), set: name() });
  const eraPath = () => (eraName() ? eraHref(eraName()) : '');
  const lede = () => (loading()
    ? 'Loading cards…'
    : `${(deskTotal() || shown().length).toLocaleString()} cards${eraName() ? ` in ${eraName()}` : ''}.`);
  const walkSkeletons = () => setDeskSkeletonCount(info()?.expansion);

  // Mounted tiles (React previewCount): a filter change starts over at the
  // first batch; once tiles are ready the count is at least the first batch
  // (or a back arrival's saved count); a scroll adds a batch (written below).
  const restoredCount = Number(restoredHere?.previewCount) || 0;
  const filterKey = createMemo(() => [sort(), query(), rarity(), language(), reverse(), firstEdition(), listed()].join('\u0001'));
  let suppressPreviewReset = Boolean(restoredHere);
  let seenFilters;
  const [previewCount, setPreviewCount] = createSignal((prev) => {
    const key = filterKey();
    const ready = tilesReady();
    const total = shown().length;
    let count = prev ?? restoredCount;
    if (seenFilters !== undefined && key !== seenFilters && !suppressPreviewReset) {
      count = firstSetPreviewCount(total);
    }
    seenFilters = key;
    if (ready && total) {
      const saved = suppressPreviewReset ? restoredCount : 0;
      count = Math.min(Math.max(count, saved, firstSetPreviewCount(total)), total);
      suppressPreviewReset = false;
    }
    return count;
  });
  const previewCards = createMemo(() => (loading() ? [] : shown().slice(0, previewCount())));
  const pendingSkeletons = () => (loading()
    ? walkSkeletons()
    : Math.max(0, shown().length - previewCards().length));

  // Back arrival: chase the saved offset once the restored tiles are mounted.
  let restoreArmed = Boolean(restoredHere);
  createEffect(
    () => tilesReady() && shown().length > 0,
    (ready) => {
      if (!ready || !restoreArmed) return;
      restoreArmed = false;
      stopRestore = restoreScroll(href);
    },
  );

  createEffect(
    () => ({
      slug,
      query: query(),
      sort: sort(),
      rarity: rarity(),
      language: language(),
      reverse: reverse(),
      firstEdition: firstEdition(),
      listed: listed(),
      previewCount: previewCount(),
    }),
    (state) => {
      rememberView(href, state);
    },
  );

  // Sentinel sits in the first rows after the current batch. Observing it
  // with a fat rootMargin mounted the rest of the set in one frame. One
  // extra batch per scroll; skeletons stay until the user moves. The
  // listener is armed after paint (React useEffect timing), so a single
  // wheel gesture's burst of scroll events still adds one batch per frame.
  createEffect(
    () => [loading(), previewCount(), shown().length],
    ([busy, count, total]) => {
      if (busy || count >= total) return undefined;
      const advance = () => {
        setPreviewCount((current) => nextSetPreviewCount(current, total));
      };
      const cancel = afterPaint(() => window.addEventListener('scroll', advance, { passive: true, once: true }));
      return () => {
        cancel();
        window.removeEventListener('scroll', advance);
      };
    },
  );

  // One list per distinct trail: SeoCrumbs keys its links by object identity.
  const crumbs = createMemo(() => [
    { name: 'Marketplace', href: '/marketplace' },
    { name: 'Sets', href: '/marketplace/sets' },
    eraName() && eraPath() ? { name: eraName(), href: eraPath() } : null,
    { name: name() },
  ], { equals: sameCrumbs });

  const sortRef = syncSelect(sort, officialSort);
  const languageRef = syncSelect(language, langs);
  const rarityRef = syncSelect(rarity, rarities);

  return (
    <div class="page desk set-desk" aria-busy={loading() ? 'true' : undefined}>
      <SeoHead title={setSeoTitle(name())} description={lede()} canonical={`/marketplace/sets/${slug}`} />
      <SeoCrumbs items={crumbs()} />
      <PageHead kicker="Set" title={name()} lede={lede()} printFlag={printFlag()}>
        <Show when={wordmark()}>
          <img
            class="set-wordmark"
            src={wordmark()}
            alt=""
            draggable="true"
            onDragStart={(event) => writeListingDrag(event, bundleReference({
              kind: 'expansion',
              slug,
              name: name(),
              imageUrl: wordmark(),
              path: `/marketplace/sets/${slug}`,
            }))}
          />
        </Show>
        <Show when={symbol()}>
          <span class="set-shortcut is-on set-sym-wrap" aria-hidden="true">
            <CardArt class="set-sym set-shortcut-sym" src={symbol()} alt="" fallback="hide" />
          </span>
        </Show>
      </PageHead>
      <form
        class="set-browse"
        onSubmit={(event) => event.preventDefault()}
        aria-label="Search and filter this set"
      >
        <div class="set-browse-bar">
          <label class="set-search">
            <span class="sr-only">Search this set</span>
            <input
              type="search"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search this set…"
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
          <label class="sort">
            Sort by
            <select ref={sortRef} onChange={(event) => setSort(event.currentTarget.value)}>
              <Show when={officialSort()}><option value="official">Official</option></Show>
              <option value="number">Number</option>
              <option value="name">Name (A → Z)</option>
              <option value="price-asc">Price: low</option>
              <option value="price-desc">Price: high</option>
            </select>
          </label>
          <div class="set-view" role="group" aria-label="View">
            <button
              type="button"
              class={view() === 'grid' ? 'on' : ''}
              aria-pressed={view() === 'grid' ? 'true' : 'false'}
              aria-label="Grid view"
              onClick={() => changeView('grid')}
            >
              <GridIcon />
            </button>
            <button
              type="button"
              class={view() === 'list' ? 'on' : ''}
              aria-pressed={view() === 'list' ? 'true' : 'false'}
              aria-label="List view"
              onClick={() => changeView('list')}
            >
              <ListIcon />
            </button>
          </div>
        </div>
        <div class="set-filters">
          <Show when={langs().length}>
            <label class="sort">
              <span class="set-filter-name">Language</span>
              <select ref={languageRef} onChange={(event) => setLanguage(event.currentTarget.value)}>
                <option value="">Any language</option>
                <For each={langs()}>{(value) => <option value={value}>{value}</option>}</For>
              </select>
            </label>
          </Show>
          <label class="sort">
            <span class="set-filter-name">Rarity</span>
            <select ref={rarityRef} onChange={(event) => setRarity(event.currentTarget.value)}>
              <option value="">Any rarity</option>
              <For each={rarities()}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
          <label class="sort">
            <span class="set-filter-name">Reverse</span>
            <select value={reverse()} onChange={(event) => setReverse(event.currentTarget.value)}>
              <option value="any">Reverse: any</option>
              <option value="yes">Reverse</option>
              <option value="no">Not reverse</option>
            </select>
          </label>
          <label class="sort">
            <span class="set-filter-name">First edition</span>
            <select value={firstEdition()} onChange={(event) => setFirstEdition(event.currentTarget.value)}>
              <option value="any">1st Ed.: any</option>
              <option value="yes">1st Ed.</option>
              <option value="no">Unlimited</option>
            </select>
          </label>
          <label class="sort">
            <span class="set-filter-name">Listed</span>
            <select value={listed()} onChange={(event) => setListed(event.currentTarget.value)}>
              <option value="any">Listed: any</option>
              <option value="yes">Has PKN</option>
              <option value="no">No price</option>
            </select>
          </label>
          <Show when={filtersOn()}>
            <button class="linkish" type="button" onClick={clearFilters}>
              Clear
            </button>
          </Show>
        </div>
        <p class="result-count">
          <Show when={!loading()} fallback="Loading…">
            <strong>{shown().length.toLocaleString()}</strong>
            {filtersOn() ? ' matching' : ` of ${deskTotal().toLocaleString()}`}
          </Show>
        </p>
      </form>
      <Alert message={error()} />
      <Show
        when={!(!loading() && deskCards().length && !shown().length)}
        fallback={(
          <EmptyDesk title="No cards match" lede="Clear a filter or try a shorter name or collector number.">
            <button class="btn" type="button" onClick={clearFilters}>Clear filters</button>
          </EmptyDesk>
        )}
      >
        <CardSelectGrid class={view() === 'list' ? 'grid is-list' : 'grid'} cards={previewCards()}>
          <Show
            when={!loading()}
            fallback={<Repeat count={walkSkeletons()}>{() => <SkeletonTile layout={view()} />}</Repeat>}
          >
            <For each={previewCards()} keyed={(card) => card.id}>
              {(card, index) => <CardTile card={card()} rank={index()} layout={view()} />}
            </For>
            <Show when={previewCount() < shown().length}>
              <div class="set-preview-sentinel" aria-hidden="true" />
            </Show>
            <Repeat count={pendingSkeletons()}>{() => <SkeletonTile layout={view()} />}</Repeat>
          </Show>
        </CardSelectGrid>
      </Show>
      <Show when={info()?.hasMore && !query().trim() && !loading()}>
        <button class="more" type="button" onClick={loadMore}>Load more</button>
      </Show>
    </div>
  );
}

/** /marketplace/sets/:slug — one desk per slug, so a set never paints another set's state. */
export default function Expansion() {
  const params = useParams();
  return (
    <Show when={params.slug} keyed>
      {(slug) => <SetDesk slug={slug} />}
    </Show>
  );
}
