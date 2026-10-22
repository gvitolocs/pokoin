import { createEffect, createMemo, createSignal, flush, For, lazy, Loading, onSettled, Show, untrack } from 'solid-js';
import { saveCardTraderZeroPick } from '@market/api.js';
import {
  confirmPickEntry,
  dirtyPickEntries,
  dropPickEntry,
  dropUnsentPicks,
  effectivePick,
  groupLinesByGame,
  inventoryNote,
  lineCopies,
  lineDone,
  lineKeyOf,
  lineMatches,
  lineQuantity,
  pickActionBody,
  pickingOrdersMatch,
  pickSaveBody,
  readPickCache,
  reconcilePickCache,
  retryableSaveError,
  setPickEntry,
  sortByPtOrder,
  takeLegacyPicked,
  writePickCache,
  zeroPickCsv,
} from '@market/zero-pick.js';
import { DEFAULT_SORT_FIELDS, sortZeroLines } from '@market/zero-sort.js';
import '@market/zero-pack.css';
import { createPointerDrag } from '../lib/pointer-drag.js';
import { getBearer } from '../stores/auth.js';
import { DeskPanel } from './Desk.jsx';
import ZeroList from './zero/ZeroList.jsx';
import ZeroTile from './zero/ZeroTile.jsx';

// Loaded on first use: most visits never open a dialog or picking mode.
const PickingMode = lazy(() => import('./zero/PickingMode.jsx'));
const IssueDialog = lazy(() => import('./zero/ZeroDialogs.jsx').then((m) => ({ default: m.IssueDialog })));
const SwapDialog = lazy(() => import('./zero/ZeroDialogs.jsx').then((m) => ({ default: m.SwapDialog })));

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

/** Power Tools-style CSV of one shipment; unsaved issues overlay from the local cache. */
export function downloadCsv(order, cache) {
  const overlay = cache || readPickCache(storage() || NO_STORAGE, String(order.orderId));
  const blob = new Blob([zeroPickCsv(order, overlay)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `zero-${String(order.code || order.orderId).replace(/[^\w.-]+/g, '_')}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A read-only tile (the "waiting for the next merge" list). */
export function ZeroLine(props) {
  return <ZeroTile item={props.item} horizontal={props.horizontal} />;
}

const PICK_ERRORS = {
  not_identical: 'That copy is not identical to the sold one.',
  insufficient_quantity: 'That box has fewer copies than this line.',
  allocated_copy_gone: 'The sold copy is no longer in your inventory, so this pick cannot be undone.',
};

function pickErrorMessage(err) {
  return PICK_ERRORS[err?.body?.code] || err?.message || 'the server refused this change.';
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
          fallback={<p class="zero-drop-empty">{props.picked ? 'Nothing picked yet. Drag a card down, or click Pick.' : 'Nothing left to pick.'}</p>}
        >
          <div class={['zero-grid', { 'is-horizontal': props.horizontal }]}>
            <For each={props.groups}>
              {(group) => (
                <>
                  <h3 class="zero-game-head">
                    {group.label}
                    <span>{group.cards} card{group.cards === 1 ? '' : 's'}</span>
                  </h3>
                  <For each={group.lines}>
                    {(entry) => (
                      <ZeroTile
                        item={entry.line}
                        horizontal={props.horizontal}
                        smartLocations={props.smartLocations}
                        place={props.places.get(lineKeyOf(entry.line))}
                        pick={props.pickOf(entry.line)}
                        done={props.isDone(entry.line)}
                        busy={props.isBusy(entry.line)}
                        match={props.matches.has(lineKeyOf(entry.line))}
                        current={props.current === lineKeyOf(entry.line)}
                        note={props.notes?.[lineKeyOf(entry.line)]}
                        error={props.errors?.[lineKeyOf(entry.line)]}
                        onPick={props.onPick}
                        onUndo={props.onUndo}
                        onSwap={props.onSwap}
                        onIssue={props.onIssue}
                        onClearIssue={props.onClearIssue}
                        onPointerDown={(event, payload) => props.onPointerDown?.(event, payload, props.zone)}
                        onPointerMove={props.onPointerMove}
                        onPointerUp={props.onPointerUp}
                        onPointerCancel={props.onPointerCancel}
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

/**
 * Lines under game headers while the sort starts with Game (one header per
 * game is then contiguous); any other sort is one "Picking order" group so
 * headers never reorder the lines. "Sort by PT order" is one PT group.
 */
export function groupsFor(lines, mode) {
  if (mode === 'game') return groupLinesByGame(lines);
  return lines.length ? [{
    game: mode,
    label: mode === 'pt' ? 'Power Tools order' : 'Picking order',
    lines: lines.map((line, index) => ({ line, place: index + 1 })),
    cards: lines.reduce((sum, line) => sum + lineQuantity(line), 0),
  }] : [];
}

/** Tiles of the read-only "waiting for the next merge" list, in the chosen sort and view. */
export function PendingList(props) {
  const lines = createMemo(() => sortZeroLines(props.items || [], props.sortFields || DEFAULT_SORT_FIELDS));
  const groups = () => groupsFor(lines(), String(props.sortFields?.[0] || '').startsWith('game.') ? 'game' : 'sorted');
  const places = createMemo(() => new Map(lines().map((line, index) => [lineKeyOf(line), index + 1])));
  const readPick = (line) => ({ picked: Number(line?.picked) || 0, issue: line?.issue || null });
  return (
    <Show
      when={props.view === 'list'}
      fallback={(
        <div class={['zero-grid', { 'is-horizontal': props.view === 'images-horizontal' }]}>
          <For each={lines()}>{(item) => <ZeroLine item={item} horizontal={props.view === 'images-horizontal'} />}</For>
        </div>
      )}
    >
      <ZeroList groups={groups()} places={places()} pickOf={readPick} isDone={() => false} readOnly />
    </Show>
  );
}

/**
 * One weekly Zero shipment in the seller's sort. A pick moves inventory
 * (POST /api/cardtrader-zero-pick with action pick / undo): it is sent once,
 * with the button disabled until the answer, and never replayed from the
 * offline cache. Issues keep the cache: unsaved ones retry on load / online.
 */
export function ShipmentPanel(props) {
  const order = () => props.order;
  const orderId = () => String(order().orderId);
  const store = () => storage() || NO_STORAGE;

  let current = untrack(() => {
    const items = order().items;
    const cache = dropUnsentPicks(reconcilePickCache(readPickCache(store(), orderId()), items), items);
    takeLegacyPicked(store(), orderId()); // old per-browser ticks never move inventory: dropped
    writePickCache(store(), orderId(), cache);
    return cache;
  });
  const [cache, setCache] = createSignal(current);
  const [errors, setErrors] = createSignal({});
  const [notes, setNotes] = createSignal({});
  const [busyKeys, setBusyKeys] = createSignal([]);
  const inFlight = new Set();
  const pickFlight = new Set();
  const setKeyed = (setter) => (lineKey, message) => setter((all) => {
    const next = { ...all };
    if (message) next[lineKey] = message;
    else delete next[lineKey];
    return next;
  });
  const setError = setKeyed(setErrors);
  const setNote = setKeyed(setNotes);

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

  /** Saves an issue change (the only cached, retried write). */
  async function send(lineKey) {
    if (props.preview || inFlight.has(lineKey)) return false;
    const entry = current[lineKey];
    if (!entry?.dirty) return true;
    const sent = { picked: entry.picked, issue: entry.issue };
    const body = pickSaveBody(untrack(orderId), lineKey, entry, ['issue']);
    inFlight.add(lineKey);
    try {
      const token = await getBearer();
      const data = await saveCardTraderZeroPick(token, body);
      commit(confirmPickEntry(current, lineKey, sent, data?.line));
      setError(lineKey, '');
      return true;
    } catch (err) {
      if (retryableSaveError(err)) return false; // stays dirty: retried on the next load or when back online
      if (current[lineKey] === entry) commit(dropPickEntry(current, lineKey));
      setError(lineKey, `Not saved: ${err.message || 'the server refused this change.'}`);
      return true;
    } finally {
      inFlight.delete(lineKey);
      if (current[lineKey]?.dirty && current[lineKey] !== entry && navigator.onLine !== false) send(lineKey);
    }
  }

  async function flushDirty() {
    for (const entry of dirtyPickEntries(current)) {
      if (!(await send(entry.lineKey))) break;
    }
  }

  onSettled(() => {
    flushDirty();
    window.addEventListener('online', flushDirty);
    return () => window.removeEventListener('online', flushDirty);
  });

  const pickOf = (line) => effectivePick(line, cache());
  const isDone = (line) => lineDone(line, cache());
  const isBusy = (line) => busyKeys().includes(lineKeyOf(line));

  function setIssue(line, issue) {
    commit(setPickEntry(current, line, { issue }));
    send(lineKeyOf(line));
  }

  /**
   * Pick (or undo) a whole line. `listingId` is the copy physically taken:
   * empty = the line's own listing; another identical copy = a swap.
   */
  async function runPick(line, action, listingId = '') {
    const key = lineKeyOf(line);
    if (pickFlight.has(key)) return; // a double click never sends twice
    const body = pickActionBody(untrack(order), line, action, listingId);
    const confirm = (inventory) => {
      const entry = effectivePick(line, current);
      commit({ ...current, [key]: { picked: action === 'undo' ? 0 : lineQuantity(line), issue: entry.issue, dirty: false } });
      setNote(key, inventoryNote({ inventory, action, listingId: body.listingId }, lineCopies(line)));
      setError(key, '');
    };
    if (props.preview) {
      const swap = body.listingId !== body.allocatedListingId;
      confirm(action === 'undo' ? 'restored' : swap ? 'swapped' : 'removed');
      return;
    }
    pickFlight.add(key);
    setBusyKeys((keys) => [...keys, key]);
    try {
      const token = await getBearer();
      const data = await saveCardTraderZeroPick(token, body);
      confirm(data?.inventory || (action === 'undo' ? 'restored' : 'removed'));
    } catch (err) {
      setError(key, `Not saved: ${pickErrorMessage(err)}`);
    } finally {
      pickFlight.delete(key);
      setBusyKeys((keys) => keys.filter((other) => other !== key));
    }
  }

  const onPick = (line, listingId = '') => runPick(line, 'pick', listingId);
  const onUndo = (line) => runPick(line, 'undo');
  const setPicked = (line, picked) => {
    if (picked > 0 && !isDone(line)) onPick(line);
    else if (picked === 0 && pickOf(line).picked) onUndo(line);
  };

  /* ---- order ---- */
  const [ptSort, setPtSort] = createSignal(false);
  const [issueKey, setIssueKey] = createSignal('');
  const [swapKey, setSwapKey] = createSignal('');
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

  const match = createMemo(() => pickingOrdersMatch(order().items));
  const ptComparable = () => order().ptPicking?.comparable === true;
  const ptSortTitle = () => {
    if (ptComparable()) return 'Reorder lines by their Power Tools position';
    if (!order().ptPicking) return 'No Power Tools picking list for this shipment';
    return 'Some cards have no Power Tools position, so the Power Tools order is incomplete';
  };
  const sortFields = () => props.sortFields || DEFAULT_SORT_FIELDS;
  const sorted = createMemo(() => sortZeroLines(order().items, sortFields()));
  const byPt = () => ptSort() && ptComparable();
  const lines = createMemo(() => (byPt() ? sortByPtOrder(sorted()) : sorted()));
  const groupMode = () => (byPt() ? 'pt' : String(sortFields()[0] || '').startsWith('game.') ? 'game' : 'sorted');
  const places = createMemo(() => new Map(lines().map((line, index) => [lineKeyOf(line), index + 1])));
  const lineByKey = (key) => order().items.find((line) => lineKeyOf(line) === key);
  const openLines = () => lines().filter((line) => !isDone(line));
  const doneLines = () => lines().filter((line) => isDone(line));
  const allGroups = () => groupsFor(lines(), groupMode());
  const openGroups = () => groupsFor(openLines(), groupMode());
  const doneGroups = () => groupsFor(doneLines(), groupMode());
  const units = () => order().items.reduce((sum, line) => sum + lineQuantity(line), 0);
  const pickedUnits = () => order().items.reduce((sum, line) => sum + pickOf(line).picked, 0);
  const issues = () => order().items.filter((line) => pickOf(line).issue).length;
  const ptBin = () => order().ptPicking?.bin || order().items.find((line) => line.powerTools?.bin)?.powerTools.bin || '';
  const view = () => props.view || 'images-vertical';

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
    get notes() { return notes(); },
    get smartLocations() { return props.smartLocations; },
    pickOf,
    isDone,
    isBusy,
    onPick,
    onUndo,
    onSwap: (line) => setSwapKey(lineKeyOf(line)),
    onIssue: (line) => setIssueKey(lineKeyOf(line)),
    onClearIssue: (line) => setIssue(line, null),
  };

  const dropRows = (horizontal) => (
    <>
      <div class="zero-cards-view">
        <DropRow
          {...rowProps}
          title="To pick"
          hint={`${openLines().length} still to pick`}
          groups={openGroups()}
          horizontal={horizontal}
          picked={false}
          zone="pick"
          over={hot('pick')}
          setZone={pointer.setZone}
          onPointerDown={pointer.onPointerDown}
          onPointerMove={pointer.onPointerMove}
          onPointerUp={pointer.onPointerUp}
          onPointerCancel={pointer.onPointerCancel}
        />
        <DropRow
          {...rowProps}
          title="Picked"
          hint={`${doneLines().length} picked`}
          groups={doneGroups()}
          horizontal={horizontal}
          picked
          zone="picked"
          over={hot('picked')}
          setZone={pointer.setZone}
          onPointerDown={pointer.onPointerDown}
          onPointerMove={pointer.onPointerMove}
          onPointerUp={pointer.onPointerUp}
          onPointerCancel={pointer.onPointerCancel}
        />
      </div>
      <Show when={printing()}><ZeroList {...rowProps} groups={allGroups()} printOnly /></Show>
    </>
  );

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
        <button
          type="button"
          class={['inv-chip', { on: byPt() }]}
          aria-pressed={byPt()}
          disabled={!ptComparable()}
          title={ptSortTitle()}
          onClick={() => setPtSort((on) => !on)}
        >
          Sort by PT order
        </button>
        <button class="btn ghost" type="button" onClick={() => { startPrint(); window.print(); }}>Print</button>
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
      </div>

      <Show when={view() === 'images-vertical'}>{dropRows(false)}</Show>
      <Show when={view() === 'images-horizontal'}>{dropRows(true)}</Show>
      <Show when={view() === 'list'}>
        <DeskPanel flush title="Picking list" extra={<span class="zero-progress">{openLines().length} still to pick</span>}>
          <ZeroList {...rowProps} groups={allGroups()} />
        </DeskPanel>
      </Show>
      <Show when={view() === 'single'}>
        <Loading fallback={null}>
        <PickingMode
          inline
          lines={lines()}
          pickOf={pickOf}
          isDone={isDone}
          isBusy={isBusy}
          noteOf={(line) => notes()[lineKeyOf(line)]}
          errorOf={(line) => errors()[lineKeyOf(line)]}
          onSetPicked={setPicked}
          onClose={() => {}}
        />
        </Loading>
        <Show when={printing()}><ZeroList {...rowProps} groups={allGroups()} printOnly /></Show>
      </Show>

      <Show when={issueKey() && lineByKey(issueKey())}>
        {(line) => (
          <Loading fallback={null}><IssueDialog
            line={line()}
            issue={pickOf(line()).issue}
            onSave={(issue) => { setIssue(line(), issue); setIssueKey(''); }}
            onClear={() => { setIssue(line(), null); setIssueKey(''); }}
            onClose={() => setIssueKey('')}
          /></Loading>
        )}
      </Show>
      <Show when={swapKey() && lineByKey(swapKey())}>
        {(line) => (
          <Loading fallback={null}><SwapDialog
            line={line()}
            copies={lineCopies(line())}
            busy={isBusy(line())}
            onChoose={(listingId) => { setSwapKey(''); onPick(line(), listingId); }}
            onClose={() => setSwapKey('')}
          /></Loading>
        )}
      </Show>
    </div>
  );
}
