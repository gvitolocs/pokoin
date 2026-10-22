import { createEffect, createMemo, createSignal, flush, For, lazy, Loading, onSettled, Show, untrack } from 'solid-js';
import { saveCardTraderZeroPick } from '@market/api.js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import {
  confirmPickEntry,
  dirtyPickEntries,
  dropPickEntry,
  effectivePick,
  groupLinesByGame,
  lineDone,
  lineKeyOf,
  lineLocation,
  lineLocationFromPt,
  lineMatches,
  lineQuantity,
  migrateLegacyPicks,
  pickingOrdersMatch,
  pickSaveBody,
  readPickCache,
  reconcilePickCache,
  retryableSaveError,
  setPickEntry,
  sortByPtOrder,
  takeLegacyPicked,
  VIEW_KEY,
  writePickCache,
  zeroPickCsv,
} from '@market/zero-pick.js';
import '@market/zero-pack.css';
import { createPointerDrag } from '../lib/pointer-drag.js';
import { getBearer } from '../stores/auth.js';
import ScanImage from './ScanImage.jsx';
import { DeskPanel } from './Desk.jsx';
import ZeroList from './zero/ZeroList.jsx';

// Loaded on first use: most visits never open a dialog or picking mode.
const PickingMode = lazy(() => import('./zero/PickingMode.jsx'));
const PickQuantityDialog = lazy(() => import('./zero/ZeroDialogs.jsx').then((m) => ({ default: m.PickQuantityDialog })));
const IssueDialog = lazy(() => import('./zero/ZeroDialogs.jsx').then((m) => ({ default: m.IssueDialog })));
import { FacetBadges, IssueBadge, lineImage, linePrice, LocationText, lineWhere, PtPlace, TakeBits } from './zero/zero-bits.jsx';

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    : '—';
}

function storage() {
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

const NO_STORAGE = { getItem: () => null, setItem() {}, removeItem() {} };

function readView() {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards';
  } catch (_) {
    return 'cards';
  }
}

function writeView(view) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch (_) {
    /* private mode: the view resets on reload */
  }
}

function downloadCsv(order, cache) {
  const blob = new Blob([zeroPickCsv(order, cache)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `zero-${String(order.code || order.orderId).replace(/[^\w.-]+/g, '_')}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function powerToolsLine(pt) {
  if (!pt) return '';
  const parts = [];
  if (pt.pickedQuantity != null) parts.push(`picked ${pt.pickedQuantity}`);
  else if (pt.orderState) parts.push(pt.orderState);
  if (pt.bin) parts.push(`bin ${pt.bin}`);
  return parts.length ? `Power Tools: ${parts.join(' · ')}` : '';
}

/**
 * One pack line (one box of a CardTrader item). Without `onPick` it is a
 * read-only line (the "waiting for the next merge" list): no drag, no button.
 */
export function ZeroLine(props) {
  const item = () => props.item;
  const location = () => lineLocation(item());
  const quantity = () => lineQuantity(item());
  const pick = () => props.pick || { picked: Number(item().picked) || 0, issue: item().issue || null };
  const done = () => Boolean(props.done);
  const pt = () => powerToolsLine(item().powerTools);
  const price = () => linePrice(item());
  const src = () => lineImage(item());
  const interactive = () => Boolean(props.onPick);
  return (
    <article
      class={['zero-card', {
        'is-picked': done(),
        'is-draggable': interactive(),
        'has-issue': Boolean(pick().issue),
        'is-match': Boolean(props.match),
        'is-current': Boolean(props.current),
      }]}
      draggable="false"
      data-zero-line={interactive() ? lineKeyOf(item()) : undefined}
      onPointerDown={(event) => {
        if (!interactive()) return;
        props.onPointerDown?.(event, {
          lineKey: lineKeyOf(item()),
          image: src(),
          label: item().name || '',
        });
      }}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <div
        class="zero-card-art"
        onClick={() => {
          if (!interactive() || props.consumeClick?.()) return;
          props.onPick(item());
        }}
      >
        <ScanImage
          src={src()}
          label={item().name}
          letterClass="zero-card-fallback"
          width="126"
          height="176"
        />
        <span class={['zero-loc', { 'is-empty': !location() }]} title={lineLocationFromPt(item()) ? 'Location from Power Tools' : 'MyPokoin location'}>
          <LocationText item={item()} />
        </span>
        <Show when={props.place != null}>
          <span class="zero-place" title="Place in this pack, in picking order">{props.place}</span>
        </Show>
        <Show when={quantity() > 1}><span class="zero-qty">take {quantity()}</span></Show>
        <Show when={done()}>
          <span class="zero-card-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="36" height="36">
              <path d="M5 12.5 10 17l9-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </Show>
      </div>
      <div class="zero-card-body">
        <strong class="thread-title">
          <Show when={item().cardId} fallback={item().name}>
            <a href={inventoryListingHref(item())} draggable="false">{item().name}</a>
          </Show>
        </strong>
        <Show when={item().nameEn}><span class="thread-meta">{item().nameEn}</span></Show>
        <Show when={lineWhere(item())}><span class="thread-meta">{lineWhere(item())}</span></Show>
        <div class="zero-line-tags">
          <FacetBadges item={item()} />
          <TakeBits item={item()} />
          <PtPlace item={item()} />
          <IssueBadge issue={pick().issue} />
        </div>
        <Show when={price()}><span class="zero-card-price">{price()}</span></Show>
        <Show when={props.error}><span class="zero-save-error" role="alert">{props.error}</span></Show>
        <Show when={interactive()}>
          <span class="zero-picked-count">picked {pick().picked}/{quantity()}</span>
        </Show>
        <Show when={!interactive() && pt()}><span class="zero-pt">{pt()}</span></Show>
      </div>
      <Show when={interactive()}>
        <div class="zero-card-actions">
          <button
            class="btn ghost zero-move"
            type="button"
            draggable="false"
            aria-pressed={pick().picked >= quantity() ? 'true' : 'false'}
            onClick={() => props.onPick(item())}
          >
            <Show
              when={quantity() > 1}
              fallback={(
                <Show when={pick().picked} fallback={<><span class="zero-move-full">Mark picked</span><span class="zero-move-short">Picked</span></>}>
                  Undo
                </Show>
              )}
            >
              Picked {pick().picked}/{quantity()}
            </Show>
          </button>
          <Show
            when={pick().issue}
            fallback={<button class="zero-issue-link" type="button" onClick={() => props.onIssue(item())}>Report issue</button>}
          >
            <button class="zero-issue-link" type="button" onClick={() => props.onClearIssue(item())}>Clear issue</button>
          </Show>
        </div>
      </Show>
    </article>
  );
}

function DropRow(props) {
  return (
    <div
      class={['zero-column', { 'is-over': props.over }]}
      data-drop-zone={props.zone}
      ref={(element) => props.setZone?.(props.zone, element)}
    >
      <DeskPanel flush title={props.title} extra={<span class="zero-progress">{props.hint}</span>}>
        <Show
          when={props.groups.length}
          fallback={<p class="zero-drop-empty">{props.picked ? 'Nothing picked yet. Drag a card down, or click Mark picked.' : 'Nothing left to pick.'}</p>}
        >
          <div class="zero-grid">
            <For each={props.groups}>
              {(group) => (
                <>
                  <h3 class="zero-game-head">
                    {group.label}
                    <span>{group.cards} card{group.cards === 1 ? '' : 's'}</span>
                  </h3>
                  <For each={group.lines}>
                    {(entry) => (
                      <ZeroLine
                        item={entry.line}
                        place={props.places.get(lineKeyOf(entry.line))}
                        pick={props.pickOf(entry.line)}
                        done={props.isDone(entry.line)}
                        match={props.matches.has(lineKeyOf(entry.line))}
                        current={props.current === lineKeyOf(entry.line)}
                        error={props.errors?.[lineKeyOf(entry.line)]}
                        onPick={props.onPick}
                        onIssue={props.onIssue}
                        onClearIssue={props.onClearIssue}
                        onPointerDown={(event, payload) => props.onPointerDown?.(event, payload, props.zone)}
                        onPointerMove={props.onPointerMove}
                        onPointerUp={props.onPointerUp}
                        onPointerCancel={props.onPointerCancel}
                        consumeClick={props.consumeClick}
                      />
                    )}
                  </For>
                </>
              )}
            </For>
          </div>
        </Show>
      </DeskPanel>
    </div>
  );
}

/** Lines grouped under game headers; with "Sort by PT order" one Power Tools group. */
function groupsFor(lines, byPt) {
  if (!byPt) return groupLinesByGame(lines);
  return lines.length ? [{
    game: 'pt',
    label: 'Power Tools order',
    lines: lines.map((line, index) => ({ line, place: index + 1 })),
    cards: lines.reduce((sum, line) => sum + lineQuantity(line), 0),
  }] : [];
}

/**
 * One weekly Zero shipment in the server's picking order. Picked copies and
 * issues are server state (POST /api/cardtrader-zero-pick); localStorage only
 * keeps unsaved changes until the next load or the `online` event.
 */
export function ShipmentPanel(props) {
  const order = () => props.order;
  const orderId = () => String(order().orderId);
  const store = () => storage() || NO_STORAGE;

  let current = untrack(() => {
    const items = order().items;
    let cache = reconcilePickCache(readPickCache(store(), orderId()), items);
    const legacy = takeLegacyPicked(store(), orderId());
    if (legacy) cache = migrateLegacyPicks(items, legacy, cache);
    writePickCache(store(), orderId(), cache);
    return cache;
  });
  const [cache, setCache] = createSignal(current);
  const [errors, setErrors] = createSignal({});
  const inFlight = new Set();
  const setError = (lineKey, message) => setErrors((all) => {
    const next = { ...all };
    if (message) next[lineKey] = message;
    else delete next[lineKey];
    return next;
  });

  function commit(next) {
    current = next;
    setCache(next);
    writePickCache(store(), untrack(orderId), next);
  }

  // Fresh server data: server wins for every saved line.
  createEffect(
    () => order().items,
    (items) => commit(reconcilePickCache(current, items)),
    { defer: true },
  );

  async function send(lineKey, fields) {
    if (props.preview || inFlight.has(lineKey)) return false;
    const entry = current[lineKey];
    if (!entry?.dirty) return true;
    const sent = { picked: entry.picked, issue: entry.issue };
    const body = pickSaveBody(untrack(orderId), lineKey, entry, fields);
    inFlight.add(lineKey);
    try {
      const token = await getBearer();
      const data = await saveCardTraderZeroPick(token, body);
      commit(confirmPickEntry(current, lineKey, sent, data?.line));
      setError(lineKey, '');
      return true;
    } catch (err) {
      if (retryableSaveError(err)) return false; // stays dirty: retried on the next load or when back online
      // Rejected (4xx): drop the change, show the server value and why.
      if (current[lineKey] === entry) commit(dropPickEntry(current, lineKey));
      setError(lineKey, `Not saved: ${err.message || 'the server refused this change.'}`);
      return true;
    } finally {
      inFlight.delete(lineKey);
      if (current[lineKey]?.dirty && current[lineKey] !== entry && navigator.onLine !== false) send(lineKey, ['picked', 'issue']);
    }
  }

  async function flushDirty() {
    for (const entry of dirtyPickEntries(current)) {
      if (!(await send(entry.lineKey, ['picked', 'issue']))) break;
    }
  }

  onSettled(() => {
    flushDirty();
    window.addEventListener('online', flushDirty);
    return () => window.removeEventListener('online', flushDirty);
  });

  const pickOf = (line) => effectivePick(line, cache());
  const isDone = (line) => lineDone(line, cache());

  function change(line, fields) {
    commit(setPickEntry(current, line, fields));
    send(lineKeyOf(line), Object.keys(fields));
  }
  const setPicked = (line, picked) => change(line, { picked });

  /* ---- views and order ---- */
  const [view, setViewSignal] = createSignal(readView());
  const setView = (next) => { setViewSignal(next); writeView(next); };
  const [ptSort, setPtSort] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  // The print list exists only while printing: on screen it doubled the DOM.
  const [printing, setPrinting] = createSignal(false);
  const startPrint = () => { setPrinting(true); flush(); };
  const endPrint = () => setPrinting(false);
  onSettled(() => {
    window.addEventListener('beforeprint', startPrint);
    window.addEventListener('afterprint', endPrint);
    return () => {
      window.removeEventListener('beforeprint', startPrint);
      window.removeEventListener('afterprint', endPrint);
    };
  });
  const [qtyKey, setQtyKey] = createSignal('');
  const [issueKey, setIssueKey] = createSignal('');

  const match = createMemo(() => pickingOrdersMatch(order().items));
  const ptComparable = () => order().ptPicking?.comparable === true;
  const ptSortTitle = () => {
    if (ptComparable()) return 'Reorder lines by their Power Tools position';
    if (!order().ptPicking) return 'No Power Tools picking list for this shipment';
    return 'Some cards have no Power Tools position, so the Power Tools order is incomplete';
  };
  const lines = createMemo(() => (ptSort() && ptComparable() ? sortByPtOrder(order().items) : order().items));
  const places = createMemo(() => {
    const map = new Map();
    order().items.forEach((line, index) => map.set(lineKeyOf(line), index + 1));
    return map;
  });
  const lineByKey = (key) => order().items.find((line) => lineKeyOf(line) === key);
  const openLines = () => lines().filter((line) => !isDone(line));
  const doneLines = () => lines().filter((line) => isDone(line));
  const allGroups = () => groupsFor(lines(), ptSort() && ptComparable());
  const openGroups = () => groupsFor(openLines(), ptSort() && ptComparable());
  const doneGroups = () => groupsFor(doneLines(), ptSort() && ptComparable());
  const units = () => order().items.reduce((sum, line) => sum + lineQuantity(line), 0);
  const pickedUnits = () => order().items.reduce((sum, line) => sum + pickOf(line).picked, 0);
  const issues = () => order().items.filter((line) => pickOf(line).issue).length;
  const ptBin = () => order().ptPicking?.bin || order().items.find((line) => line.powerTools?.bin)?.powerTools.bin || '';

  function onPick(line) {
    if (lineQuantity(line) > 1) setQtyKey(lineKeyOf(line));
    else setPicked(line, pickOf(line).picked ? 0 : 1);
  }

  /* ---- search: highlight, not filter ---- */
  let root;
  const [query, setQuery] = createSignal('');
  const [hit, setHit] = createSignal(0);
  const matchKeys = createMemo(() => lines().filter((line) => lineMatches(line, query())).map(lineKeyOf));
  const matchSet = createMemo(() => new Set(matchKeys()));
  const currentKey = () => (matchKeys().length ? matchKeys()[Math.min(hit(), matchKeys().length - 1)] : '');

  function reveal(key) {
    if (!key || !root) return;
    const nodes = [...root.querySelectorAll('[data-zero-line]')].filter((node) => node.dataset.zeroLine === key);
    nodes.find((node) => node.offsetParent !== null)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function step(delta) {
    const count = matchKeys().length;
    if (!count) return;
    const next = (Math.min(hit(), count - 1) + delta + count) % count;
    setHit(next);
    reveal(matchKeys()[next]);
  }

  const pointer = createPointerDrag({
    onMove(action) {
      if (!action?.payload?.lineKey || action.from === action.to) return;
      const line = lineByKey(action.payload.lineKey);
      if (line) setPicked(line, action.to === 'picked' ? lineQuantity(line) : 0);
    },
  });
  const hot = (zone) => pointer.view().phase === 'dragging' && pointer.view().over === zone;

  const title = () => [
    `Shipment ${order().code || order().orderId}`,
    order().packingNumber != null ? `packing #${order().packingNumber}` : '',
    order().paidAt ? `merged ${day(order().paidAt)}` : '',
  ].filter(Boolean).join(' · ');

  const rowProps = {
    get places() { return places(); },
    get matches() { return matchSet(); },
    get current() { return currentKey(); },
    get errors() { return errors(); },
    pickOf,
    isDone,
    onPick,
    onIssue: (line) => setIssueKey(lineKeyOf(line)),
    onClearIssue: (line) => change(line, { issue: null }),
  };

  return (
    <div class="zero-pack" ref={root}>
      <div class="zero-pack-title">
        <span>{title()}</span>
        <span>
          {doneLines().length}/{order().items.length} lines picked · {pickedUnits()}/{units()} card{units() === 1 ? '' : 's'}
          <Show when={issues()}><strong class="zero-issue-count"> · {issues()} issue{issues() === 1 ? '' : 's'}</strong></Show>
        </span>
      </div>

      <Show when={order().ptPicking || ptBin()}>
        <p class="zero-pt-list">
          <Show when={order().ptPicking?.listName}><span>Power Tools list: <strong>{order().ptPicking.listName}</strong></span></Show>
          <Show when={order().ptPicking?.ctZeroClosed}><span class="zero-tag">Ct Zero closed</span></Show>
          <Show when={ptBin()}><span>PT bin <strong>{ptBin()}</strong></span></Show>
        </p>
      </Show>

      <Show when={props.powerTools?.ok && order().items.length}>
        <p class={match().equal ? 'desk-ok' : 'ct-token-hint is-warn'} role="status">
          {match().equal
            ? 'Your picking order matches the Power Tools order.'
            : match().comparable
              ? `${match().mismatches} card${match().mismatches === 1 ? ' is' : 's are'} in a different place than in Power Tools.`
              : 'Power Tools is connected, but some cards in this pack have no Power Tools position, so the orders cannot be compared.'}
        </p>
      </Show>

      <div class="zero-toolbar">
        <div class="zero-view-toggle" role="group" aria-label="View">
          <button type="button" class={['inv-chip', { on: view() === 'cards' }]} aria-pressed={view() === 'cards'} onClick={() => setView('cards')}>Cards</button>
          <button type="button" class={['inv-chip', { on: view() === 'list' }]} aria-pressed={view() === 'list'} onClick={() => setView('list')}>List</button>
        </div>
        <button class="btn" type="button" onClick={() => setPicking(true)} disabled={!order().items.length}>Start picking</button>
        <button
          type="button"
          class={['inv-chip', { on: ptSort() && ptComparable() }]}
          aria-pressed={ptSort() && ptComparable()}
          disabled={!ptComparable()}
          title={ptSortTitle()}
          onClick={() => setPtSort((on) => !on)}
        >
          Sort by PT order
        </button>
        <button class="btn ghost" type="button" onClick={() => downloadCsv(order(), current)}>Export CSV</button>
        <button class="btn ghost" type="button" onClick={() => { startPrint(); window.print(); }}>Print</button>
      </div>

      <div class="zero-search">
        <label class="ct-token-field">
          <span class="sr-only">Find a card in this shipment</span>
          <input
            type="search"
            placeholder="Find: name, set, number, location"
            value={query()}
            onInput={(event) => {
              setQuery(event.target.value);
              setHit(0);
              window.requestAnimationFrame(() => reveal(currentKey()));
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }}
          />
        </label>
        <Show when={query().trim()}>
          <span class="zero-search-count" aria-live="polite">
            {matchKeys().length ? `${Math.min(hit(), matchKeys().length - 1) + 1} of ${matchKeys().length}` : 'No match'}
          </span>
          <button class="btn ghost" type="button" onClick={() => step(-1)} disabled={!matchKeys().length}>Prev</button>
          <button class="btn ghost" type="button" onClick={() => step(1)} disabled={!matchKeys().length}>Next</button>
        </Show>
      </div>

      <Show
        when={view() === 'list'}
        fallback={(
          <>
            <div class="zero-cards-view">
              <DropRow
                {...rowProps}
                title="Pick"
                hint={`${openLines().length} still to pick · picking order`}
                groups={openGroups()}
                picked={false}
                zone="pick"
                over={hot('pick')}
                setZone={pointer.setZone}
                onPointerDown={pointer.onPointerDown}
                onPointerMove={pointer.onPointerMove}
                onPointerUp={pointer.onPointerUp}
                onPointerCancel={pointer.onPointerCancel}
                consumeClick={pointer.consumeClick}
              />
              <DropRow
                {...rowProps}
                title="Picked"
                hint={`${doneLines().length} picked`}
                groups={doneGroups()}
                picked
                zone="picked"
                over={hot('picked')}
                setZone={pointer.setZone}
                onPointerDown={pointer.onPointerDown}
                onPointerMove={pointer.onPointerMove}
                onPointerUp={pointer.onPointerUp}
                onPointerCancel={pointer.onPointerCancel}
                consumeClick={pointer.consumeClick}
              />
            </div>
            <Show when={printing()}><ZeroList {...rowProps} groups={allGroups()} printOnly /></Show>
          </>
        )}
      >
        <DeskPanel flush title="Picking list" extra={<span class="zero-progress">{openLines().length} still to pick</span>}>
          <ZeroList {...rowProps} groups={allGroups()} />
        </DeskPanel>
      </Show>

      <Show when={qtyKey() && lineByKey(qtyKey())}>
        {(line) => (
          <Loading fallback={null}><PickQuantityDialog
            line={line()}
            picked={pickOf(line()).picked}
            onChange={(picked) => setPicked(line(), picked)}
            onClose={() => setQtyKey('')}
          /></Loading>
        )}
      </Show>
      <Show when={issueKey() && lineByKey(issueKey())}>
        {(line) => (
          <Loading fallback={null}><IssueDialog
            line={line()}
            issue={pickOf(line()).issue}
            onSave={(issue) => { change(line(), { issue }); setIssueKey(''); }}
            onClear={() => { change(line(), { issue: null }); setIssueKey(''); }}
            onClose={() => setIssueKey('')}
          /></Loading>
        )}
      </Show>
      <Show when={picking()}>
        <Loading fallback={null}>
          <PickingMode lines={lines()} pickOf={pickOf} isDone={isDone} onSetPicked={setPicked} onClose={() => setPicking(false)} />
        </Loading>
      </Show>
    </div>
  );
}
