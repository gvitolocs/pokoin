import { createEffect, createMemo, createSignal, For, Match, Show, Switch, untrack } from 'solid-js';
import { fetchPriceChecksByGame, imageSrc } from '@market/api.js';
import {
  filterInventoryRows,
  groupInventoryStacks,
  groupInventoryTitles,
  INVENTORY_SORTS,
  inventoryFacets,
  inventoryListingHref,
  inventoryRowDate,
  listingBox,
  sortInventoryRows,
  summarizeLiveInventory,
} from '@market/inventory-listings.js';
import { game } from '@market/game.js';
import { gamePrices, inventoryMarketLabel, inventoryMarketValue, priceCheckGroups } from '@market/inventory-price.js';
import { conditionChipSrc, conditionShort, conditionTone, listingLanguageFlag } from '@market/listing-meta.js';
import ScanImage from '../ScanImage.jsx';
import { getBearer } from '../../stores/auth.js';
import RowThumb from './RowThumb.jsx';

const STATUS_CHIPS = [
  { id: '', label: 'All' },
  { id: 'active', label: 'Live' },
  { id: 'paused', label: 'Paused' },
];

// TCGplayer retains its source USD quotes separately from PKN asks.
const PRICER_SOURCES = [
  { id: 'pokoin', label: 'Pokoin', enabled: true },
  { id: 'cardtrader', label: 'CardTrader', enabled: true },
  { id: 'ebay', label: 'eBay', enabled: false },
  { id: 'tcgplayer', label: 'TCGPlayer · USD', enabled: true },
];

const SORT_LABELS = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  'price-up': 'Price low → high',
  'price-down': 'Price high → low',
  'qty-down': 'Qty high → low',
  name: 'Name A → Z',
};

const BOARD_MODES = [['table', 'Table'], ['stacks', 'Stacks'], ['titles', 'Titles'], ['grid', 'Grid']];

/** One mode from the two older keys. Grid only applied when the table view was on. */
function readBoardMode() {
  let view = 'table';
  let layout = 'list';
  try {
    const stored = localStorage.getItem('pokoin.invView');
    if (stored === 'stacks' || stored === 'titles' || stored === 'table' || stored === 'grid') view = stored;
    if (localStorage.getItem('pokoin.invLayout') === 'grid') layout = 'grid';
  } catch (_) { /* private mode */ }
  if (view === 'grid' || (layout === 'grid' && view === 'table')) return 'grid';
  return view;
}

function writeBoardMode(next) {
  try {
    if (next === 'grid') {
      localStorage.setItem('pokoin.invLayout', 'grid');
      localStorage.setItem('pokoin.invView', 'table');
    } else {
      localStorage.setItem('pokoin.invLayout', 'list');
      localStorage.setItem('pokoin.invView', next);
    }
  } catch (_) { /* private mode */ }
}

// Market comps of the rows on screen outlive a remount (tab switch, back
// from a card desk): the column paints with the board instead of "…".
const PRICE_MEMO_MS = 10 * 60_000;
const priceMemo = new Map();

/**
 * The price checks of the rows on screen, one per game: card ids are per game,
 * and a Riftbound or Magic card read from the Pokémon catalog has no comp.
 */
function priceRequest(source, rows) {
  const games = priceCheckGroups(rows, game().id);
  return { games, count: games.reduce((sum, group) => sum + group.items.length, 0), key: `${source}|${JSON.stringify(games)}` };
}

function memoPrices(key) {
  const hit = priceMemo.get(key);
  return hit && Date.now() - hit.at < PRICE_MEMO_MS ? hit.prices : null;
}

function rememberPrices(key, prices) {
  priceMemo.delete(key);
  priceMemo.set(key, { prices, at: Date.now() });
  while (priceMemo.size > 24) priceMemo.delete(priceMemo.keys().next().value);
}

const qty = (row) => Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0);
const paused = (row) => String(row?.status || '').toLowerCase() === 'paused';

function MarketCell(props) {
  return (
    <Switch fallback={<span class="inv-mkt" title={props.value.title}>{inventoryMarketLabel(props.value)}</span>}>
      <Match when={props.pending}><span class="inv-mkt is-pending">…</span></Match>
      <Match when={props.value == null}><span class="inv-mkt is-none">—</span></Match>
    </Switch>
  );
}

function StatTile(props) {
  return (
    <div class={['inv-stat', props.tone ? `is-${props.tone}` : '']}>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function RowStatus(props) {
  return (
    <Show when={String(props.status || 'active').toLowerCase() === 'paused'} fallback={<span class="inv-status is-live">Live</span>}>
      <span class="inv-status is-paused">Paused</span>
    </Show>
  );
}

function CondChip(props) {
  return (
    <img
      class={`shop-cond is-${conditionTone(props.condition)}`}
      src={conditionChipSrc(props.condition)}
      alt={conditionShort(props.condition) || 'NM'}
      title={props.titled ? conditionShort(props.condition) || 'NM' : undefined}
      width={props.width || '34'}
      height={props.height || '24'}
      loading="lazy"
    />
  );
}

/**
 * Storage-box link inside a table row anchor. Its own component, so the
 * nested anchor is inserted into the row after parsing, as React did.
 */
function ListingTile(props) {
  const row = () => props.row;
  const setName = () => String(row()?.setName || row()?.set_name || '').trim();
  const collector = () => String(row()?.collectorNumber || row()?.collector_number || '').trim();
  const src = () => imageSrc({
    id: row()?.cardId || row()?.card_id,
    imageUrl: row()?.cardImageUrl || row()?.card_image_url || '',
    heroImageUrl: row()?.cardImageUrl || row()?.card_image_url || '',
  }, 'hero');
  return (
    <a class="collection-tile" href={inventoryListingHref(row())} draggable="false">
      <ScanImage class="collection-tile-art" letterClass="collection-tile-art scan-letter" src={src()} label={row()?.cardName || row()?.name || 'Listing'} alt={row()?.cardName || 'Listing'} />
      <span class="collection-tile-body">
        <strong class="thread-title">{row()?.cardName || row()?.name || 'Listing'}</strong>
        <span class="thread-meta">{[setName(), collector() ? `#${collector()}` : ''].filter(Boolean).join(' · ')}</span>
        <span class="collection-tile-price">{props.formatPrice(row()?.pricePkn ?? row()?.price_pkn)}</span>
        <RowStatus status={row()?.status} />
      </span>
    </a>
  );
}

function LocLink(props) {
  const box = () => listingBox(props.loc) || props.loc;
  return (
    <a class="inv-loc" href={`/mypokoin/location/${encodeURIComponent(box())}`} title={`Everything stored in ${box()}`}>
      {props.loc}
    </a>
  );
}

/**
 * PowerTools-style listing manager for the MyPokoin desk:
 * summary tiles, a filter rail
 * and a dense thumbnail table, or stacks / titles groupings.
 */
export default function InventoryBoard(props) {
  const [query, setQuery] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [condition, setCondition] = createSignal('');
  const [language, setLanguage] = createSignal('');
  const [sort, setSort] = createSignal('price-down');
  const [mode, setMode] = createSignal(readBoardMode());
  function chooseMode(next) {
    setMode(next);
    writeBoardMode(next);
  }
  const [pricerSource, setPricerSource] = createSignal(props.defaultSource || '');
  let pricerChosen = false;
  // A cached book can paint before seller preferences arrive.
  createEffect(() => props.defaultSource, (source) => {
    if (!pricerChosen && source) setPricerSource(source);
  });
  function choosePricer(id) {
    pricerChosen = true;
    setPricerSource(pricerSource() === id ? '' : id);
  }
  const pricerOn = () => Boolean(pricerSource()) || Boolean(props.autoMarketColumn);

  const facets = createMemo(() => inventoryFacets(props.rows));
  const summary = createMemo(() => summarizeLiveInventory(props.rows));
  const view = createMemo(() => sortInventoryRows(
    filterInventoryRows(props.rows, { query: query(), status: status(), condition: condition(), language: language() }),
    sort(),
  ));
  // Filter the full book, but mount only one page, as the seller shop does.
  const [page, setPage] = createSignal(() => {
    query(); status(); condition(); language(); sort(); mode();
    return 1;
  });
  let board;
  function choosePage(next) {
    setPage(next);
    board?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  const pageSize = 50;
  const entries = createMemo(() => mode() === 'stacks' ? groupInventoryStacks(view())
    : mode() === 'titles' ? groupInventoryTitles(view()) : view());
  const totalPages = () => Math.max(1, Math.ceil(entries().length / pageSize));
  const safePage = () => Math.min(page(), totalPages());
  const pageEntries = createMemo(() => entries().slice((safePage() - 1) * pageSize, safePage() * pageSize));
  const visibleRows = () => mode() === 'stacks' || mode() === 'titles'
    ? pageEntries().flatMap((group) => group.postings) : pageEntries();
  const pausedCount = () => props.rows.filter(paused).length;
  const firstPrices = untrack(() => (pricerOn() ? priceRequest(pricerSource(), visibleRows()) : null));
  const [prices, setPrices] = createSignal((firstPrices && memoPrices(firstPrices.key)) || {});
  const [pricesPending, setPricesPending] = createSignal(false);
  let pricesKey = firstPrices && memoPrices(firstPrices.key) ? firstPrices.key : '';
  const market = (row) => inventoryMarketValue(gamePrices(prices(), row, game().id), row, pricerSource());

  // Market comps for the current filtered rows while a pricer source is on.
  createEffect(
    () => (pricerOn() ? { source: pricerSource(), rows: visibleRows() } : null),
    (input) => {
      if (!input) {
        pricesKey = '';
        return undefined;
      }
      const { games, count, key } = priceRequest(input.source, input.rows);
      if (!count) return undefined;
      if (pricesKey === key) return undefined;
      const remembered = memoPrices(key);
      if (remembered) {
        pricesKey = key;
        setPrices(remembered);
        return undefined;
      }
      let cancelled = false;
      setPricesPending(true);
      (async () => {
        try {
          const token = await getBearer();
          // One game failing leaves only its own rows without a comp.
          const answers = Object.entries(await fetchPriceChecksByGame(games, token));
          if (!cancelled) {
            const byGame = Object.fromEntries(answers.filter(([, value]) => value));
            pricesKey = answers.every(([, value]) => value) ? key : '';
            if (pricesKey) rememberPrices(key, byGame);
            setPrices(byGame);
          }
        } catch {
          if (!cancelled) pricesKey = '';
        } finally {
          if (!cancelled) setPricesPending(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  );

  return (
    <section class="inv-board" aria-label="My listings" ref={(node) => { board = node; }}>
      <div class="mypokoin-panel-head">
        <div>
          <h2>Live listings</h2>
          <p class="mypokoin-help">Search the book, then open a card to edit the ask.</p>
        </div>
        <a class="btn" href="/inventory/scan">Scan cards</a>
      </div>
      <Show when={props.showSummary !== false}>
        <div class="inv-summary">
          <StatTile value={summary().listings.toLocaleString('en-US')} label="Live listings" />
          <StatTile value={summary().cards.toLocaleString('en-US')} label="Cards in stock" />
          <StatTile value={props.formatPrice(summary().listedPkn)} label="Total asking" tone="gold" />
          <StatTile value={pausedCount().toLocaleString('en-US')} label="Paused" />
        </div>
      </Show>

      <div class="inv-rail">
        <input
          class="inv-search"
          type="search"
          placeholder="Search name, set, collector…"
          value={query()}
          onInput={(event) => setQuery(event.target.value)}
          aria-label="Search listings"
        />
        <div class="inv-layout" role="group" aria-label="Listing view">
          <For each={BOARD_MODES}>
            {([id, label]) => (
              <button type="button" class={{ on: mode() === id }} aria-pressed={mode() === id} onClick={() => chooseMode(id)}>
                {label}
              </button>
            )}
          </For>
        </div>
        <div class="inv-chips" role="group" aria-label="Status filter">
          <For each={STATUS_CHIPS}>
            {(chip) => (
              <button type="button" class={['inv-chip', { on: status() === chip.id }]} onClick={() => setStatus(chip.id)}>
                {chip.label}
              </button>
            )}
          </For>
        </div>
        <Show when={facets().conditions.length > 1}>
          <select class="inv-select" value={condition()} onChange={(event) => setCondition(event.target.value)} aria-label="Condition">
            <option value="">Any condition</option>
            <For each={facets().conditions}>{(key) => <option value={key}>{conditionShort(key) || key}</option>}</For>
          </select>
        </Show>
        <Show when={facets().languages.length > 1}>
          <select class="inv-select" value={language()} onChange={(event) => setLanguage(event.target.value)} aria-label="Language">
            <option value="">Any language</option>
            <For each={facets().languages}>{(key) => <option value={key}>{key}</option>}</For>
          </select>
        </Show>
        <select class="inv-select inv-sort" value={sort()} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
          <For each={INVENTORY_SORTS}>{(key) => <option value={key}>{SORT_LABELS[key] || key}</option>}</For>
        </select>
        <span class="inv-pricer" role="group" aria-label="Pricer source">
          <span class="inv-pricer-label">Pricer</span>
          <For each={PRICER_SOURCES}>
            {(source) => (
              <button
                type="button"
                class={['inv-chip', 'inv-src', { on: pricerSource() === source.id }]}
                disabled={!source.enabled}
                title={source.enabled ? `Market ${source.label} prices` : `${source.label} prices are not connected yet`}
                onClick={() => choosePricer(source.id)}
              >
                {source.label}
              </button>
            )}
          </For>
        </span>
      </div>

      <Switch>
        <Match when={mode() === 'stacks'}>
          <div class="loc-list">
            <For each={pageEntries()}>
              {(stack) => (
                <div class="loc-stack">
                  <div class="loc-stack-head">
                    <a class="inv-card" href={inventoryListingHref(stack)}>
                      <RowThumb row={stack} />
                      <span class="inv-card-txt">
                        <strong>{stack.cardName}</strong>
                        <span class="inv-card-sub">
                          {stack.setName}{stack.collectorNumber ? `${stack.setName ? ' · ' : ''}#${stack.collectorNumber}` : ''}
                        </span>
                      </span>
                    </a>
                    <span class="loc-stack-meta">
                      <CondChip condition={stack.condition} />
                      <span class="loc-count">
                        <strong>{stack.postingCount}</strong>
                        {' '}
                        {stack.postingCount === 1 ? 'posting' : 'postings'}
                        {' · '}
                        {stack.copies} {stack.copies === 1 ? 'copy' : 'copies'}
                      </span>
                    </span>
                  </div>
                  <div class="loc-postings">
                    <For each={stack.postings}>
                      {(row) => (
                        <a class="loc-posting" href={inventoryListingHref(row)}>
                          <span class="loc-posting-date">{inventoryRowDate(row) || '—'}</span>
                          <span class="inv-qty num">{qty(row)}×</span>
                          <span class="inv-price num">{props.formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
                          <Show when={pricerOn()}><MarketCell value={market(row)} pending={pricesPending()} /></Show>
                          <span class={['inv-status', paused(row) ? 'is-paused' : 'is-live']}>{paused(row) ? 'Paused' : 'Live'}</span>
                        </a>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Match>
        <Match when={mode() === 'titles'}>
          <div class="loc-list">
            <For each={pageEntries()}>
              {(group) => (
                <div class="loc-stack">
                  <div class="loc-stack-head">
                    <span class="inv-card">
                      <RowThumb row={group.postings[0]} />
                      <span class="inv-card-txt">
                        <strong>{group.title}</strong>
                        <span class="inv-card-sub">
                          {group.printings} {group.printings === 1 ? 'printing' : 'printings'}
                          {' · '}
                          {group.postingCount} {group.postingCount === 1 ? 'posting' : 'postings'}
                          {' · '}
                          {group.copies} {group.copies === 1 ? 'copy' : 'copies'}
                          {' · '}
                          asking {props.formatPrice(group.askingPkn)}
                        </span>
                      </span>
                    </span>
                  </div>
                  <div class="loc-postings">
                    <For each={group.postings}>
                      {(row) => {
                        const setName = String(row?.setName || row?.set_name || '').trim();
                        const collector = String(row?.collectorNumber || row?.collector_number || '').trim();
                        const flag = listingLanguageFlag(row?.language);
                        return (
                          <a class="loc-posting" href={inventoryListingHref(row)}>
                            <RowThumb row={row} />
                            <span class="inv-card-txt">
                              <strong>{setName || group.title}</strong>
                              <span class="inv-card-sub">
                                {collector ? `#${collector}` : ''}
                                {flag ? `${collector ? ' · ' : ''}${flag.code.toUpperCase()}` : ''}
                              </span>
                            </span>
                            <CondChip condition={row?.condition} />
                            <span class="inv-qty num">{qty(row)}×</span>
                            <span class="inv-price num">{props.formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
                            <Show when={pricerOn()}><MarketCell value={market(row)} pending={pricesPending()} /></Show>
                            <span class={['inv-status', paused(row) ? 'is-paused' : 'is-live']}>{paused(row) ? 'Paused' : 'Live'}</span>
                          </a>
                        );
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Match>
        <Match when={mode() === 'grid'}>
          <Show when={view().length} fallback={<p class="inv-empty">No listings match the current filters.</p>}>
            <div class="collection-tile-grid inv-grid">
              <For each={pageEntries()}>{(row) => <ListingTile row={row} formatPrice={props.formatPrice} />}</For>
            </div>
          </Show>
        </Match>
        <Match when={true}>
          <div class={['inv-table', { 'has-mkt': pricerOn() }]}>
            <div class="inv-head" aria-hidden="true">
              <span>Card</span>
              <span>Cond</span>
              <span>Lang</span>
              <span class="num">Qty</span>
              <span class="num">Price</span>
              <Show when={pricerOn()}>
                <span class="num inv-mkt-head">
                  {PRICER_SOURCES.find((source) => source.id === pricerSource())?.label}
                  {' '}
                  market
                </span>
              </Show>
              <span>Status</span>
              <span>Listed</span>
              <span />
            </div>
            <For each={pageEntries()}>
              {(row) => {
                const setName = String(row?.setName || row?.set_name || '').trim();
                const collector = String(row?.collectorNumber || row?.collector_number || '').trim();
                const loc = String(row?.location || '').trim();
                const flag = listingLanguageFlag(row?.language);
                return (
                  <a class="inv-row" href={inventoryListingHref(row)}>
                    <span class="inv-card">
                      <RowThumb row={row} />
                      <span class="inv-card-txt">
                        <strong>{row?.cardName || row?.name || 'Listing'}</strong>
                        <span class="inv-card-sub">
                          {setName}{collector ? `${setName ? ' · ' : ''}#${collector}` : ''}
                          <Show when={loc}><LocLink loc={loc} /></Show>
                        </span>
                      </span>
                    </span>
                    <span class="inv-cond">
                      <CondChip condition={row?.condition} titled width="40" height="28" />
                    </span>
                    <span class="inv-lang">
                      <Show when={flag} fallback={<span class="inv-flag is-empty" />}>
                        <img class="inv-flag" src={flag.src} alt={flag.code} title={flag.code.toUpperCase()} width="18" height="18" loading="lazy" />
                      </Show>
                      <span class="inv-lang-code">{flag ? flag.code.toUpperCase() : '—'}</span>
                    </span>
                    <span class="inv-qty num">{qty(row)}</span>
                    <span class="inv-price num">{props.formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
                    <Show when={pricerOn()}><MarketCell value={market(row)} pending={pricesPending()} /></Show>
                    <span><RowStatus status={row?.status} /></span>
                    <span class="inv-date">{inventoryRowDate(row) || '—'}</span>
                    <span class="inv-chev" aria-hidden="true">›</span>
                  </a>
                );
              }}
            </For>
            <Show when={!view().length}>
              <p class="inv-empty">No listings match the current filters.</p>
            </Show>
          </div>
        </Match>
      </Switch>
      <Show when={entries().length > pageSize}>
        <nav class="seller-pager" aria-label="Inventory pages">
          <button type="button" class="btn ghost" disabled={safePage() <= 1}
            onClick={() => choosePage(safePage() - 1)}>Previous</button>
          <span class="seller-pager-status" aria-live="polite">
            Page {safePage()} / {totalPages()} · {view().length} listings
          </span>
          <button type="button" class="btn ghost" disabled={safePage() >= totalPages()}
            onClick={() => choosePage(safePage() + 1)}>Next</button>
        </nav>
      </Show>
    </section>
  );
}
