import { createEffect, createMemo, createSignal, For, Match, Show, Switch, untrack } from 'solid-js';
import { cancelListing, fetchPriceChecksByGame, imageSrc } from '@market/api.js';
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
import { leftGroupLine } from '@market/pricing-group-note.js';
import { cardtraderLinked } from '@market/listing-row-edit.js';
import { localizeStrategyName } from '@market/pricer.js';
import { describeOrigins, findCrossSourceDuplicates, listingOrigin, originFacets, originLabel } from '@market/inventory-origin.js';
import { gamePrices, inventoryMarketLabel, inventoryMarketValue, priceCheckGroups } from '@market/inventory-price.js';
import { conditionChipSrc, conditionShort, conditionTone, listingLanguageFlag } from '@market/listing-meta.js';
import ScanImage from '../ScanImage.jsx';
import { authUser, getBearer } from '../../stores/auth.js';
import { authSession } from '../../stores/session.js';
import ListingEditDrawer from './ListingEditDrawer.jsx';
import { Alert } from '../Desk.jsx';
import NewGroupForm from '../pricer/NewGroupForm.jsx';
import PricerPopup from '../pricer/PricerPopup.jsx';
import { TagIcon } from '../pricer/icons.jsx';
import {
  allSelected,
  groupFilter,
  moveResultLine,
  movePlan,
  NO_GROUP,
  removeResultLine,
  selectionState,
  selectRows,
  toggleSelected,
} from '../pricer/pricer-ui.js';
import { memoPrices, rememberPrices } from './price-memo.js';
import { memoizeByRows } from '../../lib/derived-cache.js';
import RowThumb from './RowThumb.jsx';

// A tab switch rebuilds the board over the same book; these four walks of all
// 1,500 rows are pure functions of it, so the second visit reuses the first.
const facetsOf = memoizeByRows(inventoryFacets);
const originsOf = memoizeByRows(originFacets);
const duplicatesOf = memoizeByRows(findCrossSourceDuplicates);
const summaryOf = memoizeByRows(summarizeLiveInventory);

const STATUS_CHIPS = [
  { id: '', label: 'All' },
  { id: 'active', label: 'Live' },
  { id: 'paused', label: 'Paused' },
];

// TCGplayer retains its source USD quotes separately from PKN asks. The two
// Cardmarket chips are the sellers we scanned ourselves, not its price guide.
const PRICER_SOURCES = [
  { id: 'pokoin', label: 'Pokoin', enabled: true },
  { id: 'cardtrader', label: 'CardTrader', enabled: true },
  { id: 'cardmarketpro', label: 'Cardmarket · pro', enabled: true },
  { id: 'cardmarketprivate', label: 'Cardmarket · private', enabled: true },
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

/**
 * The price checks of the rows on screen, one per game: card ids are per game,
 * and a Riftbound or Magic card read from the Pokémon catalog has no comp.
 */
function priceRequest(source, rows) {
  const games = priceCheckGroups(rows, game().id);
  return { games, count: games.reduce((sum, group) => sum + group.items.length, 0), key: `${source}|${JSON.stringify(games)}` };
}

const qty = (row) => Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0);
const paused = (row) => String(row?.status || '').toLowerCase() === 'paused';

function MarketCell(props) {
  return (
    <Switch
      fallback={(
        <span class="inv-mkt" title={props.value.title}>
          {inventoryMarketLabel(props.value)}
          {/* The CardTrader ask beside the net: the net is what a seller keeps. */}
          <Show when={props.value.askLabel}><small class="inv-mkt-ask">ask {props.value.askLabel}</small></Show>
        </span>
      )}
    >
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

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
      />
    </svg>
  );
}

/**
 * Edit and Delete for one listing. They sit beside the row's link, never
 * inside it: a button in an anchor is unclickable and unreachable by keyboard.
 */
function RowActions(props) {
  const name = () => props.row?.cardName || props.row?.name || 'listing';
  return (
    <span class={['inv-actions', props.class || ''].filter(Boolean).join(' ')}>
      <button
        type="button"
        class="icon-btn inv-edit"
        disabled={props.busy}
        aria-label={`Edit ${name()}`}
        title={`Edit ${name()}`}
        onClick={() => props.onEdit(props.row)}
      >
        <EditIcon />
      </button>
      <button
        type="button"
        class="icon-btn inv-del"
        disabled={props.busy}
        aria-label={`Delete ${name()}`}
        title={`Delete ${name()}`}
        onClick={() => props.onDelete(props.row)}
      >
        <TrashIcon />
      </button>
    </span>
  );
}

/**
 * Where the listing came from, plus the cross-channel duplicate warning.
 * Read-only: the seller decides what to do with a flagged pair.
 */function OriginTags(props) {
  const origin = () => listingOrigin(props.row);
  const dup = () => props.duplicates?.get(String(props.row?.id ?? ''));
  return (
    <span class="inv-tags">
      <span class={`inv-origin is-${origin()}`} title={`Listed from ${originLabel(origin())}`}>{originLabel(origin())}</span>
      <Show when={dup()}>
        {(entry) => (
          <span class="inv-dup" title={`Also listed from ${describeOrigins(entry().others)}`}>Possible duplicate</span>
        )}
      </Show>
    </span>
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
        <OriginTags row={row()} duplicates={props.duplicates} />
      </span>
    </a>
  );
}

/**
 * The board's selection: "N selected", select every filtered listing, take
 * them out of their group, move them into one ("Add to group ▾" menu with a
 * New group mini-form; moving takes a card out of its old group), or price
 * them ("Price selected": the pricer pop-up).
 */
function SelectionBar(props) {
  const pricing = props.pricing;
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let wrap;
  const ids = () => [...props.selected];
  const count = () => props.selected.size;
  const inGroup = () => ids().some((id) => pricing.memberships().has(id));
  const strategyName = (id) => localizeStrategyName(pricing.strategies().find((entry) => entry.id === id)?.name, pricing.currencyCtx()) || 'No strategy';

  // Outside clicks and Escape close the menu.
  createEffect(menuOpen, (open) => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (wrap && !wrap.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });

  async function run(action) {
    setBusy(true);
    props.onError('');
    try {
      const line = await action();
      setMenuOpen(false);
      props.onDone(line);
    } catch (err) {
      props.onError(err.message || 'Could not change the groups.');
    } finally {
      setBusy(false);
    }
  }

  const moveTo = (group) => run(async () => {
    const plan = movePlan(ids(), pricing.memberships(), group.id);
    const groups = pricing.groups();
    await pricing.saveGroup({ groupId: group.id, add: ids() });
    return moveResultLine(plan, groups, group.name);
  });

  const createWith = async (input) => {
    const plan = movePlan(ids(), pricing.memberships(), '');
    const groups = pricing.groups();
    await pricing.saveGroup({ group: input, add: ids() });
    setMenuOpen(false);
    props.onDone(moveResultLine(plan, groups, input.name));
  };

  const removeAll = () => run(async () => {
    const answer = await pricing.saveGroup({ remove: ids() });
    return removeResultLine(answer.removed ?? count());
  });

  return (
    <div class="pricer-selbar" role="region" aria-label="Selected listings">
      <strong class="pricer-selbar-count">{count()} selected</strong>
      <Show when={!allSelected(props.selected, props.filtered)}>
        <button type="button" class="btn ghost" onClick={() => props.onSelectAll()}>
          Select all {props.filtered.length} filtered
        </button>
      </Show>
      <button type="button" class="btn ghost" onClick={() => props.onClear()}>Clear</button>
      <button type="button" class="btn ghost" disabled={busy() || !inGroup()} onClick={removeAll}>Remove from group</button>
      <div
        class="pricer-menu-wrap"
        ref={(node) => { wrap = node; }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setMenuOpen(false);
        }}
      >
        <button
          type="button"
          class="btn ghost"
          aria-haspopup="true"
          aria-expanded={String(menuOpen())}
          disabled={busy()}
          onClick={() => setMenuOpen(!menuOpen())}
        >
          Add to group ▾
        </button>
        <Show when={menuOpen()}>
          <div class="pricer-menu">
            <p class="pricer-menu-head">Move {count()} {count() === 1 ? 'card' : 'cards'} to…</p>
            <Show when={pricing.groups().length}>
              <div role="menu" aria-label="Pricing groups">
                <For each={pricing.groups()} keyed={(group) => group.id}>
                  {(group) => (
                    <button type="button" role="menuitem" class="pricer-menu-item" disabled={busy()} onClick={() => moveTo(group())}>
                      <strong>{group().name}</strong> · {strategyName(group().strategyId)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show
              when={pricing.strategies().length}
              fallback={(
                <p class="mypokoin-help">
                  A group needs a strategy: make one in <a href={props.pricerHref}>Pricer → Strategies</a> first.
                </p>
              )}
            >
              <NewGroupForm
                class="pricer-menu-form"
                idPrefix="board-new-group"
                ctx={pricing.currencyCtx()}
                groups={pricing.groups()}
                strategies={pricing.strategies()}
                onCreate={createWith}
              />
            </Show>
            <p class="pricer-hint">A card is in at most one group; moving it takes it out of the old one.</p>
          </div>
        </Show>
      </div>
      <button type="button" class="btn pricer-price-btn" disabled={busy()} onClick={() => props.onPrice()}>
        <TagIcon size={18} /> Price selected
      </button>
    </div>
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
  const [origin, setOrigin] = createSignal('');
  const [duplicatesOnly, setDuplicatesOnly] = createSignal(false);
  const [sort, setSort] = createSignal('price-down');
  const [mode, setMode] = createSignal(readBoardMode());
  function chooseMode(next) {
    setMode(next);
    writeBoardMode(next);
  }
  const [pricerSource, setPricerSource] = createSignal(untrack(() => props.defaultSource) || '');
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
  // Pricing groups: the Group filter, the row chips and the selection bar.
  const [groupPick, setGroupPick] = createSignal('');
  const [selected, setSelected] = createSignal(new Set());
  const [actionLine, setActionLine] = createSignal('');
  const [actionError, setActionError] = createSignal('');
  // The listings the "Price selected" pop-up prices (null: closed).
  const [priceIds, setPriceIds] = createSignal(null);
  const memberships = () => props.pricing?.memberships() || new Map();
  const groupName = (row) => {
    const id = memberships().get(String(row?.id ?? ''));
    return id ? props.pricing.groups().find((group) => group.id === id)?.name || '' : '';
  };

  const facets = createMemo(() => facetsOf(props.rows));
  const origins = createMemo(() => originsOf(props.rows));
  // One pass over the whole book; rows look their flag up by id.
  const duplicates = createMemo(() => duplicatesOf(props.rows));
  const summary = createMemo(() => summaryOf(props.rows));
  const view = createMemo(() => sortInventoryRows(
    filterInventoryRows(props.rows, {
      query: query(),
      status: status(),
      condition: condition(),
      language: language(),
      origin: origin(),
      duplicatesOnly: duplicatesOnly() && duplicates().size > 0,
      duplicates: duplicates(),
    }).filter(groupFilter(groupPick(), memberships())),
    sort(),
  ));
  // Filter the full book, but mount only one page, as the seller shop does.
  const [page, setPage] = createSignal(() => {
    query(); status(); condition(); language(); origin(); groupPick(); duplicatesOnly(); sort(); mode();
    return 1;
  });
  let board;
  function choosePage(next) {
    setPage(next);
    board?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  const pageSize = 40;
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
    () => (pricerOn() ? { source: pricerSource(), rows: visibleRows(), previewComps: props.preview ? props.previewComps : null } : null),
    (input) => {
      if (!input) {
        pricesKey = '';
        return undefined;
      }
      // Layout preview: the fixture's answers, no request.
      if (input.previewComps) {
        setPrices({ [game().id]: input.previewComps });
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

  // Row actions: the listing the editor is open on, and the row with a write in flight.
  const [editRow, setEditRow] = createSignal(null);
  const [editDirty, setEditDirty] = createSignal(false);
  const [busyId, setBusyId] = createSignal('');
  let search;
  const rowId = (row) => String(row?.id ?? '');
  const rowName = (row) => row?.cardName || row?.name || 'listing';

  /**
   * Open the drawer on a row. Only one drawer is ever open: opening another row
   * switches it, so unsaved edits in the one already open would be lost — the
   * seller is asked first.
   */
  function openEditRow(row) {
    const current = editRow();
    if (current && rowId(current) !== rowId(row) && editDirty()
      && !window.confirm(`Discard your changes to ${rowName(current)}?`)) return;
    setEditDirty(false);
    setEditRow(row);
  }

  /** Keyboard focus back onto a row's Edit button, else the search box. */
  function focusRowEdit(id) {
    const rowNode = id && [...board.querySelectorAll('[data-listing-id]')]
      .find((node) => node.dataset.listingId === id);
    (rowNode?.querySelector('.inv-edit') || search)?.focus();
  }

  function saveRow(saved) {
    props.onRowSaved?.(saved);
    setActionError('');
    // The new price can take the listing out of its pricing group, as on the desk.
    const left = leftGroupLine(saved);
    setActionLine(left ? `Listing updated. ${left}` : 'Listing updated.');
    // The dialog closes after this and its focus restore finds a detached
    // button, because the changed row re-rendered: hand the keyboard back to it.
    queueMicrotask(() => focusRowEdit(rowId(saved)));
  }

  /** One confirm, then the soft unlist. True only when the listing went away. */
  async function removeRow(row) {
    const id = rowId(row);
    if (!id) return false;
    const name = rowName(row);
    const extra = cardtraderLinked(row) ? ' It is also taken off CardTrader.' : '';
    if (!window.confirm(`Remove ${name} from your shop?${extra}`)) return false;
    const list = visibleRows();
    const at = list.findIndex((entry) => rowId(entry) === id);
    const neighbour = list[at + 1] || list[at - 1];
    if (props.preview) {
      props.onRowRemoved?.(id);
      setActionLine(`${name} is no longer listed.`);
      queueMicrotask(() => focusRowEdit(rowId(neighbour)));
      return true;
    }
    setBusyId(id);
    setActionError('');
    try {
      const token = await getBearer();
      if (!token) {
        setActionError('Sign in again to remove a listing.');
        return false;
      }
      await cancelListing(id, token, authUser()?.uid || authSession()?.uid || '');
      props.onRowRemoved?.(id);
      setActionLine(`${name} is no longer listed.`);
      queueMicrotask(() => focusRowEdit(rowId(neighbour)));
      return true;
    } catch (err) {
      setActionError(err?.status === 401 ? 'Sign in again to remove a listing.' : (err?.message || 'Could not remove the listing.'));
      return false;
    } finally {
      setBusyId('');
    }
  }

  return (
    <section class={['inv-board', { 'has-edit-drawer': editRow() }]} aria-label="My listings" ref={(node) => { board = node; }}>
      <div class="mypokoin-panel-head">
        <div>
          <h2>Live listings</h2>
          <p class="mypokoin-help">Search the book; edit or remove a listing from its row, or open the card.</p>
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
          ref={(node) => { search = node; }}
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
        <Show when={origins().length > 1}>
          <select class="inv-select" value={origin()} onChange={(event) => setOrigin(event.target.value)} aria-label="Source">
            <option value="">Any source</option>
            <For each={origins()} keyed={(entry) => entry.id}>{(entry) => <option value={entry().id}>{`${entry().label} (${entry().count})`}</option>}</For>
          </select>
        </Show>
        <Show when={props.pricing?.groups().length}>
          <select class="inv-select" value={groupPick()} onChange={(event) => setGroupPick(event.target.value)} aria-label="Group">
            <option value="">Any group</option>
            <option value={NO_GROUP}>No group</option>
            <For each={props.pricing.groups()} keyed={(group) => group.id}>{(group) => <option value={group().id}>{group().name}</option>}</For>
          </select>
        </Show>
        <Show when={duplicates().size > 0}>
          <button
            type="button"
            class={['inv-chip', 'inv-dup-chip', { on: duplicatesOnly() }]}
            aria-pressed={duplicatesOnly()}
            title="Same card, condition, language and finish from more than one channel, not stored in separate slots"
            onClick={() => setDuplicatesOnly(!duplicatesOnly())}
          >
            Possible duplicates · {duplicates().size}
          </button>
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
      <Show when={props.pricing && selected().size}>
        <SelectionBar
          pricing={props.pricing}
          selected={selected()}
          filtered={view()}
          pricerHref={props.preview ? '/mypokoin/pricer?mypokoinPreview&view=strategies' : '/mypokoin/pricer?view=strategies'}
          onSelectAll={() => setSelected(selectRows(selected(), view(), true))}
          onClear={() => setSelected(new Set())}
          onError={setActionError}
          onDone={(line) => {
            setSelected(new Set());
            setActionLine(line);
          }}
          onPrice={() => {
            setActionLine('');
            setPriceIds([...selected()]);
          }}
        />
      </Show>
      <Show when={props.pricing && priceIds()}>
        {(ids) => (
          <PricerPopup
            mode="board"
            count={ids().length}
            listingIds={ids()}
            pricing={props.pricing}
            strategies={props.pricing.strategies()}
            groups={props.pricing.groups()}
            onApplied={() => {
              setSelected(new Set());
              props.onApplied?.();
            }}
            onClose={() => setPriceIds(null)}
          />
        )}
      </Show>
      <Alert>{actionError()}</Alert>
      <Show when={actionLine()}><p class="ct-connect-ok pricer-result-line" role="status">{actionLine()}</p></Show>
      <Show when={editRow()}>
        {(row) => (
          <ListingEditDrawer
            row={row()}
            game={game().id}
            preview={props.preview}
            previewComps={props.previewComps}
            pricing={props.pricing}
            onDirty={setEditDirty}
            onClose={() => setEditRow(null)}
            onSaved={saveRow}
            onDelete={() => removeRow(row())}
          />
        )}
      </Show>

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
                        <div class="loc-posting-line" data-listing-id={rowId(row)}>
                          <a class="loc-posting" href={inventoryListingHref(row)}>
                            <span class="loc-posting-date">{inventoryRowDate(row) || '—'}</span>
                            <span class="inv-qty num">{qty(row)}×</span>
                            <span class="inv-price num">{props.formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
                            <Show when={pricerOn()}><MarketCell value={market(row)} pending={pricesPending()} /></Show>
                            <span class={['inv-status', paused(row) ? 'is-paused' : 'is-live']}>{paused(row) ? 'Paused' : 'Live'}</span>
                            <OriginTags row={row} duplicates={duplicates()} />
                          </a>
                          <RowActions row={row} busy={busyId() === rowId(row)} onEdit={openEditRow} onDelete={removeRow} />
                        </div>
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
                          <div class="loc-posting-line" data-listing-id={rowId(row)}>
                            <a class="loc-posting" href={inventoryListingHref(row)}>
                              <RowThumb row={row} />
                              <span class="inv-card-txt">
                                <strong>{setName || group.title}</strong>
                                <span class="inv-card-sub">
                                  {collector ? `#${collector}` : ''}
                                  {flag ? `${collector ? ' · ' : ''}${flag.code.toUpperCase()}` : ''}
                                </span>
                                <OriginTags row={row} duplicates={duplicates()} />
                              </span>
                              <CondChip condition={row?.condition} />
                              <span class="inv-qty num">{qty(row)}×</span>
                              <span class="inv-price num">{props.formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
                              <Show when={pricerOn()}><MarketCell value={market(row)} pending={pricesPending()} /></Show>
                              <span class={['inv-status', paused(row) ? 'is-paused' : 'is-live']}>{paused(row) ? 'Paused' : 'Live'}</span>
                            </a>
                            <RowActions row={row} busy={busyId() === rowId(row)} onEdit={openEditRow} onDelete={removeRow} />
                          </div>
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
              <For each={pageEntries()}>
                {(row) => (
                  <div class="inv-tile" data-listing-id={rowId(row)}>
                    <ListingTile row={row} formatPrice={props.formatPrice} duplicates={duplicates()} />
                    <RowActions row={row} class="inv-tile-actions" busy={busyId() === rowId(row)} onEdit={openEditRow} onDelete={removeRow} />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Match>
        <Match when={true}>
          <div class={['inv-table', { 'has-mkt': pricerOn(), 'has-pick': Boolean(props.pricing) }]}>
            <div class="inv-head">
              <Show when={props.pricing}>
                <label class="inv-pick">
                  <input
                    type="checkbox"
                    aria-label="Select every listing on this page"
                    checked={selectionState(selected(), pageEntries()) === 'all'}
                    prop:indeterminate={selectionState(selected(), pageEntries()) === 'some'}
                    onChange={(event) => setSelected(selectRows(selected(), pageEntries(), event.target.checked))}
                  />
                </label>
              </Show>
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
              <span class="inv-act-head">Actions</span>
            </div>
            <For each={pageEntries()}>
              {(row) => {
                const setName = String(row?.setName || row?.set_name || '').trim();
                const collector = String(row?.collectorNumber || row?.collector_number || '').trim();
                const loc = String(row?.location || '').trim();
                const flag = listingLanguageFlag(row?.language);
                const id = String(row?.id ?? '');
                const cells = (
                  <>
                    <span class="inv-card">
                      <RowThumb row={row} />
                      <span class="inv-card-txt">
                        <strong>{row?.cardName || row?.name || 'Listing'}</strong>
                        <span class="inv-card-sub">
                          {setName}{collector ? `${setName ? ' · ' : ''}#${collector}` : ''}
                          <Show when={loc}><LocLink loc={loc} /></Show>
                        </span>
                        <span class="inv-row-tags">
                          <OriginTags row={row} duplicates={duplicates()} />
                          <Show when={groupName(row)}>
                            {(name) => <span class="inv-group-chip" title={`Pricing group ${name()}`}>{name()}</span>}
                          </Show>
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
                  </>
                );
                return (
                  <div
                    class={['inv-row', { 'has-pick': Boolean(props.pricing), 'is-picked': selected().has(id) }]}
                    data-listing-id={id}
                  >
                    <Show when={props.pricing}>
                      <label class="inv-pick">
                        <input
                          type="checkbox"
                          aria-label={`Select ${row?.cardName || row?.name || 'listing'}`}
                          checked={selected().has(id)}
                          onChange={() => setSelected(toggleSelected(selected(), id))}
                        />
                      </label>
                    </Show>
                    <a class="inv-row-link" href={inventoryListingHref(row)}>{cells}</a>
                    <RowActions row={row} busy={busyId() === id} onEdit={openEditRow} onDelete={removeRow} />
                  </div>
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
