import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { fetchPriceCheck } from '@market/api.js';
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
import { inventoryMarketLabel, inventoryMarketValue } from '@market/inventory-price.js';
import { conditionChipSrc, conditionShort, conditionTone, listingLanguageFlag } from '@market/listing-meta.js';
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

const VIEWS = [['table', 'Table'], ['stacks', 'Stacks'], ['titles', 'Titles']];

function readView() {
  try {
    return localStorage.getItem('pokoin.invView') || 'table';
  } catch (_) {
    return 'table';
  }
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
function LocLink(props) {
  const box = () => listingBox(props.loc) || props.loc;
  return (
    <a class="inv-loc" href={`/mypokoin/location/${encodeURIComponent(box())}`} title={`Everything stored in ${box()}`}>
      {props.loc}
    </a>
  );
}

/**
 * PowerTools-style listing manager for the MyPokoin desk
 * (market/src/components/InventoryBoard.jsx): summary tiles, a filter rail
 * and a dense thumbnail table, or stacks / titles groupings.
 */
export default function InventoryBoard(props) {
  const [query, setQuery] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [condition, setCondition] = createSignal('');
  const [language, setLanguage] = createSignal('');
  const [sort, setSort] = createSignal('price-down');
  const [viewMode, setViewMode] = createSignal(readView());
  // React useState(defaultSource): the first value only.
  const [pricerSource, setPricerSource] = createSignal(props.defaultSource || '');
  const pricerOn = () => Boolean(pricerSource()) || Boolean(props.autoMarketColumn);
  const [prices, setPrices] = createSignal({});
  const [pricesPending, setPricesPending] = createSignal(false);
  let pricesKey = '';

  const facets = createMemo(() => inventoryFacets(props.rows));
  const summary = createMemo(() => summarizeLiveInventory(props.rows));
  const view = createMemo(() => sortInventoryRows(
    filterInventoryRows(props.rows, { query: query(), status: status(), condition: condition(), language: language() }),
    sort(),
  ));
  const pausedCount = () => props.rows.filter(paused).length;
  const market = (row) => inventoryMarketValue(prices(), row, pricerSource());

  // Market comps for the current filtered rows while a pricer source is on.
  createEffect(
    () => (pricerOn() ? { source: pricerSource(), rows: view() } : null),
    (input) => {
      if (!input) {
        pricesKey = '';
        return undefined;
      }
      const items = input.rows.slice(0, 100).map((row) => ({
        cardId: String(row?.cardId || row?.card_id || ''),
        condition: String(row?.condition || 'NM').toUpperCase(),
        language: String(row?.language || '').toUpperCase(),
      })).filter((item) => /^\d+$/.test(item.cardId));
      if (!items.length) return undefined;
      const key = `${input.source}|${items.map((item) => item.cardId).join(',')}`;
      if (pricesKey === key) return undefined;
      let cancelled = false;
      setPricesPending(true);
      (async () => {
        try {
          const token = await getBearer();
          const data = await fetchPriceCheck(items, token);
          if (!cancelled) {
            pricesKey = key;
            setPrices(data.prices || {});
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
    <section class="inv-board" aria-label="My listings">
      <div class="inv-summary">
        <StatTile value={summary().listings.toLocaleString('en-US')} label="Live listings" />
        <StatTile value={summary().cards.toLocaleString('en-US')} label="Cards in stock" />
        <StatTile value={props.formatPrice(summary().listedPkn)} label="Total asking" tone="gold" />
        <StatTile value={pausedCount().toLocaleString('en-US')} label="Paused" />
      </div>

      <div class="inv-rail">
        <input
          class="inv-search"
          type="search"
          placeholder="Search name, set, collector…"
          value={query()}
          onInput={(event) => setQuery(event.target.value)}
          aria-label="Search listings"
        />
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
                onClick={() => setPricerSource(pricerSource() === source.id ? '' : source.id)}
              >
                {source.label}
              </button>
            )}
          </For>
        </span>
      </div>

      <div class="inv-views" role="group" aria-label="View">
        <For each={VIEWS}>
          {([id, label]) => (
            <button
              type="button"
              class={['inv-chip', { on: viewMode() === id }]}
              onClick={() => {
                setViewMode(id);
                try { localStorage.setItem('pokoin.invView', id); } catch (_) { /* private mode */ }
              }}
            >
              {label}
            </button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={viewMode() === 'stacks'}>
          <div class="loc-list">
            <For each={groupInventoryStacks(view())}>
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
        <Match when={viewMode() === 'titles'}>
          <div class="loc-list">
            <For each={groupInventoryTitles(view())}>
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
            <For each={view()}>
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
    </section>
  );
}
