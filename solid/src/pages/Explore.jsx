import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { fetchPortfolio, formatPkn, imageSrc } from '@market/api.js';
import { dumpWatchIds, toggleDumpWatch } from '@market/catalog.js';
import { EXPLORE_PAGE as PAGE, exploreLanguages, filterExploreItems } from '@market/explore-filter.js';
import CardArt from '../components/CardArt.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import DumpNav from '../components/DumpNav.jsx';
import { rememberView, restoreScroll, restoredView } from '../lib/scroll-restore.js';

const TYPES = [
  { value: 'all', label: 'All' },
  { value: 'cards', label: 'Cards only' },
  { value: 'sealed', label: 'Sealed only' },
];

function money(value) {
  return formatPkn(value) || '—';
}

/**
 * /marketplace/explore (market/src/pages/Explore.jsx): the Pokoin catalog
 * dump in PKN with a filter rail. Back restores the filters and the shown
 * count (D00005C); the grid grows 48 at a time from a sentinel.
 */
export default function Explore() {
  const location = useLocation();
  const href = untrack(() => `${location.pathname}${location.search}`);
  const restored = restoredView(href);
  const [catalog, setCatalog] = createSignal(null);
  const [error, setError] = createSignal('');
  const [query, setQuery] = createSignal(String(restored?.query || ''));
  const [sort, setSort] = createSignal(restored?.sort || 'value');
  const [type, setType] = createSignal(restored?.type || 'all');
  const [min, setMin] = createSignal(String(restored?.min || ''));
  const [max, setMax] = createSignal(String(restored?.max || ''));
  const [watchOnly, setWatchOnly] = createSignal(Boolean(restored?.watchOnly));
  const [langs, setLangs] = createSignal(new Set(restored?.langs || []));
  // Shown count: a back arrival's own, then one page again after any filter
  // change (a writable memo; the sentinel and form submit write it).
  const [shown, setShown] = createSignal((prev) => {
    query(); sort(); type(); min(); max(); watchOnly(); langs();
    if (prev !== undefined) return PAGE;
    const count = Number(restored?.shown);
    return count > PAGE ? count : PAGE;
  });
  // A saved-id toggle re-reads dumpWatchIds() (localStorage, not reactive).
  const [watchTick, setWatchTick] = createSignal(0);
  let sentinel;
  let disposed = false;
  let stopRestore = () => {};

  document.title = 'Explore · Pokoin';
  fetchPortfolio()
    .then((data) => {
      if (disposed) return;
      setCatalog(() => data);
      queueMicrotask(() => {
        if (!disposed) stopRestore = restoreScroll(href);
      });
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Explore failed.');
    });
  onSettled(() => () => {
    disposed = true;
    stopRestore();
  });

  const langNames = createMemo(() => exploreLanguages(catalog()));
  const watchedIds = createMemo(() => {
    watchTick();
    return new Set(dumpWatchIds());
  });
  const filtered = createMemo(() => filterExploreItems(catalog(), {
    query: query(),
    sort: sort(),
    type: type(),
    min: min(),
    max: max(),
    watchOnly: watchOnly(),
    langs: langs(),
    watched: watchedIds(),
  }));
  const visible = createMemo(() => filtered().slice(0, shown()));

  createEffect(
    () => ({
      shown: shown(),
      query: query(),
      sort: sort(),
      type: type(),
      min: min(),
      max: max(),
      watchOnly: watchOnly(),
      langs: [...langs()],
    }),
    (view) => {
      rememberView(href, view);
    },
  );

  createEffect(
    () => [catalog(), filtered().length, query(), type()],
    ([data, total]) => {
      if (!sentinel || !data) return undefined;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown((current) => Math.min(current + PAGE, total));
        }
      }, { rootMargin: '800px 0px' });
      observer.observe(sentinel);
      return () => observer.disconnect();
    },
  );

  function toggleLang(value) {
    setLangs((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function clearAll() {
    setQuery('');
    setType('all');
    setMin('');
    setMax('');
    setWatchOnly(false);
    setLangs(new Set());
    setSort('value');
  }

  return (
    <Show
      when={!error()}
      fallback={(
        <div class="page desk">
          <PageHead kicker="Market" title="Explore" />
          <DumpNav />
          <Alert message={error()} />
        </div>
      )}
    >
      <div class="page desk port-page">
        <PageHead kicker="Market" title="Explore" lede="Pokoin catalog in PKN. Art from cdn.pokoin.com." />
        <DumpNav />
        <form
          class="shop-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setShown(PAGE);
          }}
        >
          <p class="result-count">
            <Show when={catalog()} fallback="Loading listings…">
              Showing <strong>{visible().length.toLocaleString('en-US')}</strong>
              {' of '}
              {filtered().length.toLocaleString('en-US')}
              {' · '}
              {(catalog().totals.qty || 0).toLocaleString('en-US')} copies
            </Show>
          </p>
          <div class="toolbar-right">
            <input
              class="shop-search"
              type="search"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search listings…"
              aria-label="Search listings"
            />
            <select value={sort()} onChange={(event) => setSort(event.currentTarget.value)} aria-label="Sort">
              <option value="value">Most valuable</option>
              <option value="name">Name</option>
              <option value="qty">Most copies</option>
            </select>
            <button class="btn ghost" type="button" onClick={clearAll}>Clear</button>
          </div>
        </form>
        <div class="explore-layout">
          <aside class="filter-rail" aria-label="Filters">
            <div class="filter-group">
              <span class="filter-label">Watchlist</span>
              <label class="filter-option">
                <input type="checkbox" checked={watchOnly()} onChange={(event) => setWatchOnly(event.currentTarget.checked)} />
                Saved ids only
              </label>
            </div>
            <div class="filter-group">
              <span class="filter-label">Product type</span>
              <For each={TYPES}>
                {(row) => (
                  <label class="filter-option">
                    <input type="radio" name="explore-type" checked={type() === row.value} onChange={() => setType(row.value)} />
                    {row.label}
                  </label>
                )}
              </For>
            </div>
            <div class="filter-group">
              <span class="filter-label">Price (PKN)</span>
              <div class="explore-price">
                <input type="number" min="0" step="1" placeholder="Min" value={min()} onInput={(event) => setMin(event.currentTarget.value)} />
                <span>to</span>
                <input type="number" min="0" step="1" placeholder="Max" value={max()} onInput={(event) => setMax(event.currentTarget.value)} />
              </div>
            </div>
            <Show when={langNames().length}>
              <div class="filter-group">
                <span class="filter-label">Language</span>
                <For each={langNames()}>
                  {(lang) => (
                    <label class="filter-option">
                      <input type="checkbox" checked={langs().has(lang)} onChange={() => toggleLang(lang)} />
                      {lang}
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </aside>
          <section>
            <Show
              when={!(catalog() && !filtered().length)}
              fallback={<EmptyDesk title="No listings match" lede="Clear filters, or list a card from a card desk." />}
            >
              <div class="explore-grid">
                <For each={visible()}>
                  {(item) => (
                    <article class="explore-card">
                      <a href={`/marketplace/portfolio/${item.id}`}>
                        <CardArt src={imageSrc(item, 'hero')} alt="" loading="lazy" />
                        <strong>{item.name}</strong>
                        <span class="muted">{[item.expansion, item.number].filter(Boolean).join(' · ')}</span>
                        <span class="muted">{item.condition || (item.sealed ? 'Sealed' : '—')}{item.qty > 1 ? ` · ×${item.qty}` : ''}</span>
                        <em>{money(item.pricePkn)}</em>
                      </a>
                      <button
                        class={watchedIds().has(String(item.id)) ? 'explore-add on' : 'explore-add'}
                        type="button"
                        aria-label="Save id"
                        onClick={() => {
                          toggleDumpWatch(item.id);
                          setWatchTick((value) => value + 1);
                        }}
                      >
                        +
                      </button>
                    </article>
                  )}
                </For>
              </div>
            </Show>
            <div ref={(node) => { sentinel = node; }} />
          </section>
        </div>
      </div>
    </Show>
  );
}
