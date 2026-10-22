import { createEffect, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import {
  connectPowerTools,
  disconnectPowerTools,
  fetchCardTraderStatus,
  fetchCardTraderZero,
  fetchPowerToolsStatus,
  pushCardTraderZeroPtSort,
  saveCardTraderZeroSort,
} from '@market/api.js';
import { formatOrderMoney } from '@market/order-status.js';
import { normalizeView, VIEW_KEY, ZERO_VIEWS } from '@market/zero-pick.js';
import { DEFAULT_SORT_FIELDS, sortSequence, sortZeroLines, validateSortFields } from '@market/zero-sort.js';
import { Alert, DeskPanel, EmptyDesk } from '../components/Desk.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { downloadCsv, PendingList, ShipmentPanel } from '../components/ZeroPack.jsx';
import { PtSortDialog } from '../components/zero/ZeroDialogs.jsx';
import ZeroSortBar from '../components/zero/ZeroSortBar.jsx';
import { getBearer, signedIn } from '../stores/auth.js';
import {
  allowMypokoinPreview,
  MYPOKOIN_PREVIEW_BANNER,
  previewZero,
} from './mypokoin-preview-fixture.js';

function PowerToolsPanel(props) {
  const [status, setStatus] = createSignal(null);
  const [mode, setMode] = createSignal('password');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [session, setSession] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  onSettled(() => {
    let cancelled = false;
    getBearer()
      .then((token) => fetchPowerToolsStatus(token))
      .then((data) => { if (!cancelled) setStatus(() => data.status || null); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Power Tools status failed.'); });
    return () => { cancelled = true; };
  });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const body = mode() === 'session' ? { session: session() } : { email: email(), password: password() };
      const data = await connectPowerTools(token, body);
      setStatus(() => data.status || null);
      setPassword('');
      setSession('');
      if (props.onSession) await props.onSession();
    } catch (err) {
      setError(err.message || 'Power Tools sign-in failed.');
      if (err.body?.code === 'powertools_two_factor') setMode('session');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const data = await disconnectPowerTools(token);
      setStatus(() => data.status || null);
      if (props.onSession) await props.onSession();
    } catch (err) {
      setError(err.message || 'Could not forget the Power Tools session.');
    } finally {
      setBusy(false);
    }
  }

  const overlay = () => props.overlay;
  const expired = () => overlay()?.connected && overlay().ok === false && overlay().code === 'powertools_session_expired';

  return (
    <DeskPanel title="Power Tools" class="zero-pt-panel">
      <Alert>{error()}</Alert>
      <Switch fallback={<div class="skeleton-line" />}>
        <Match when={status()?.connected}>
          <div class="zero-pt-status">
            <p class="page-lede">
              Signed in as <strong>{status().account?.username || 'your Power Tools account'}</strong>.
              {overlay()?.ok ? ` Matched ${overlay().matchedItems || 0} line${overlay().matchedItems === 1 ? '' : 's'} with Power Tools picking.` : ''}
            </p>
            <Show when={status().cardtraderMatch === false}>
              <p class="ct-token-hint is-warn">
                This Power Tools account is linked to a different CardTrader seller than the one connected to Pokoin.
              </p>
            </Show>
            <Switch>
              <Match when={expired()}>
                <p class="ct-token-hint is-warn">The Power Tools session expired. Sign out and sign in again.</p>
              </Match>
              <Match when={overlay()?.connected && overlay().ok === false}>
                <p class="ct-token-hint is-warn">{overlay().error}</p>
              </Match>
            </Switch>
            <button class="btn ghost" type="button" onClick={signOut} disabled={busy()}>
              {busy() ? 'Signing out…' : 'Sign out of Power Tools'}
            </button>
          </div>
        </Match>
        <Match when={status()}>
          <form class="ct-connect-form" onSubmit={submit}>
            <p class="page-lede">
              Optional. Sign in with your Power Tools account. Pokoin then checks this pack's location order
              against the Power Tools position order, and shows its picking state next to each card.
              Pokoin keeps only your encrypted Power Tools session, never your password.
            </p>
            <p class="ct-token-hint is-ok">
              Already signed in to Power Tools in Chrome? Open the{' '}
              <a href="/download/extension.zip">Pokoin extension</a> side panel and click Power Tools → Connect.
              No password needed.
            </p>
            <Show
              when={mode() === 'password'}
              fallback={(
                <label class="ct-token-field">
                  <span class="sr-only">Power Tools session</span>
                  <input
                    type="text"
                    name="powertools-session"
                    class="is-masked"
                    autocomplete="off"
                    spellcheck="false"
                    data-1p-ignore=""
                    data-lpignore="true"
                    placeholder="Power Tools session (jwt cookie value)"
                    value={session()}
                    onInput={(event) => setSession(event.target.value)}
                    required
                  />
                </label>
              )}
            >
              <label class="ct-token-field">
                <span class="sr-only">Power Tools email</span>
                <input
                  type="email"
                  name="powertools-email"
                  autocomplete="username"
                  placeholder="Power Tools email"
                  value={email()}
                  onInput={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label class="ct-token-field">
                <span class="sr-only">Power Tools password</span>
                <input
                  type="password"
                  name="powertools-password"
                  autocomplete="current-password"
                  placeholder="Power Tools password"
                  value={password()}
                  onInput={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
            </Show>
            <div class="ct-connect-actions">
              <button class="btn" type="submit" disabled={busy()}>
                {busy() ? 'Signing in…' : 'Sign in to Power Tools'}
              </button>
              <button
                class="btn ghost"
                type="button"
                onClick={() => { setMode(mode() === 'password' ? 'session' : 'password'); setError(''); }}
              >
                {mode() === 'password' ? 'Google or two-factor account? Paste a session' : 'Use email and password'}
              </button>
            </div>
            <Show when={mode() === 'session'}>
              <p class="ct-token-hint is-ok">
                On new.tcgpowertools.com open DevTools → Application → Cookies and copy the value of <code>jwt</code>.
              </p>
            </Show>
          </form>
        </Match>
      </Switch>
    </DeskPanel>
  );
}

const PT_SORT_ERRORS = {
  powertools_session_expired: 'Your Power Tools session expired. Reconnect Power Tools.',
  powertools_cardtrader_not_connected: 'Power Tools has no CardTrader account connected.',
  pt_picking_list_missing: 'The Power Tools picking list of this shipment no longer exists.',
  pt_sort_throttled: 'Power Tools was just updated. Wait 15 seconds and try again.',
  pt_sort_mismatch: 'The Power Tools list changed. Reload the picking list and try again.',
  pt_sort_count_changed: 'The Power Tools list changed since the confirmation. Reload the picking list and try again.',
  powertools_not_connected: 'Connect Power Tools first.',
};

function ptSortError(err) {
  const code = err?.body?.code || '';
  return {
    tone: 'warn',
    text: PT_SORT_ERRORS[code] || err?.message || 'Power Tools did not answer.',
    reconnect: code === 'powertools_session_expired' || code === 'powertools_not_connected',
  };
}

function readView() {
  try {
    return normalizeView(window.localStorage.getItem(VIEW_KEY));
  } catch (_) {
    return 'images-vertical';
  }
}

function writeView(view) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch (_) {
    /* private mode: the view resets on reload */
  }
}

function ZeroDesk(props) {
  const navigate = useGameNavigate();
  const [data, setData] = createSignal(props.preview ? previewZero() : null);
  const [error, setError] = createSignal('');
  const [notConnected, setNotConnected] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [listMode, setListMode] = createSignal('weekly');
  const [view, setViewSignal] = createSignal(readView());
  const setView = (next) => { setViewSignal(next); writeView(next); };
  const initialSorting = untrack(() => data()?.sorting);
  const [sortFields, setSortFields] = createSignal(initialSorting?.fields || [...DEFAULT_SORT_FIELDS]);
  const [smartLocations, setSmartLocations] = createSignal(initialSorting?.smartLocations !== false);
  const [sortBusy, setSortBusy] = createSignal(false);
  const [sortNote, setSortNote] = createSignal(null);
  const [confirm, setConfirm] = createSignal(null);
  const [confirmBusy, setConfirmBusy] = createSignal(false);
  let queue = [];

  function takeSorting(sorting) {
    if (!sorting) return;
    const checked = validateSortFields(sorting.fields || []);
    if (checked.ok) setSortFields(checked.fields);
    if ('smartLocations' in sorting) setSmartLocations(sorting.smartLocations !== false);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const token = await getBearer();
      const result = await fetchCardTraderZero(token);
      setNotConnected(false);
      setData(() => result);
      takeSorting(result?.sorting);
    } catch (err) {
      if (err.body?.code === 'cardtrader_not_connected') setNotConnected(true);
      else setError(err.message || 'CardTrader Zero list failed.');
    } finally {
      setLoading(false);
    }
  }

  createEffect(signedIn, (on) => {
    if (props.preview || !on) return undefined;
    load();
    let cancelled = false;
    getBearer()
      .then((token) => fetchCardTraderStatus(token))
      .then((status) => {
        const ready = status?.status?.metadata?.oneDayReady === true
          || status?.sync?.summary?.mode === 'one_day_ready';
        if (!cancelled && ready) navigate('/mypokoin/1dr', { replace: true });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  });
  createEffect(
    () => !props.preview && data()?.oneDayReady === true,
    (ready) => {
      if (ready) navigate('/mypokoin/1dr', { replace: true });
    },
  );

  /* ---- Apply sort: local, then Pokoin, then (confirmed) Power Tools ---- */

  /** Weekly shipments Power Tools can re-sort: connected, with a picking list. */
  function ptTargets(fields) {
    if (!data()?.powerTools?.connected) return [];
    return (data()?.weekly || [])
      .filter((order) => order.ptPicking?.listId)
      .map((order) => ({
        orderId: String(order.orderId),
        listId: order.ptPicking.listId,
        label: `Shipment ${order.code || order.orderId}`,
        sequence: sortSequence(sortZeroLines(order.items, fields)),
      }));
  }

  /** Dry run of the next shipment: its card count goes in the confirmation. */
  async function nextTarget() {
    const [target, ...rest] = queue;
    queue = rest;
    if (!target) return;
    const token = await getBearer();
    const dry = await pushCardTraderZeroPtSort(token, {
      orderId: target.orderId,
      listId: target.listId,
      sequence: target.sequence,
      dryRun: true,
    });
    setConfirm({ ...target, count: (dry?.items || []).length });
  }

  async function applySort(fields) {
    const checked = validateSortFields(fields);
    if (!checked.ok) {
      setSortNote({ tone: 'warn', text: checked.error });
      return;
    }
    setSortFields(checked.fields); // instant: every list re-sorts here
    setSortNote(null);
    if (props.preview) {
      setSortNote({ tone: 'ok', text: 'Preview: sorted here only. Nothing was saved or sent.' });
      return;
    }
    setSortBusy(true);
    try {
      const token = await getBearer();
      const saved = await saveCardTraderZeroSort(token, { fields: checked.fields, smartLocations: smartLocations() });
      takeSorting(saved?.sorting);
      queue = ptTargets(checked.fields);
      if (!queue.length) {
        setSortNote({ tone: 'ok', text: 'Saved on Pokoin. No Power Tools picking list for this shipment.' });
        return;
      }
      await nextTarget();
    } catch (err) {
      setSortNote(ptSortError(err));
    } finally {
      setSortBusy(false);
    }
  }

  async function sendConfirmed() {
    const target = confirm();
    if (!target || confirmBusy()) return;
    setConfirmBusy(true);
    try {
      const token = await getBearer();
      const result = await pushCardTraderZeroPtSort(token, {
        orderId: target.orderId,
        listId: target.listId,
        sequence: target.sequence,
        expectCount: target.count,
      });
      const before = Array.isArray(result?.before) ? result.before.map(String) : [];
      setSortNote({
        tone: result?.applied ? 'ok' : 'warn',
        text: result?.applied ? 'CardTrader order updated' : 'Power Tools kept a different order',
        restore: before.length ? { orderId: target.orderId, listId: target.listId, before } : null,
      });
    } catch (err) {
      setSortNote(ptSortError(err));
    } finally {
      setConfirm(null);
      setConfirmBusy(false);
    }
    if (queue.length) nextTarget().catch((err) => setSortNote(ptSortError(err)));
  }

  function cancelConfirmed() {
    setConfirm(null);
    setSortNote({ tone: 'ok', text: 'Saved on Pokoin. Not sent to CardTrader.' });
    if (queue.length) nextTarget().catch((err) => setSortNote(ptSortError(err)));
  }

  async function restoreOrder() {
    const restore = sortNote()?.restore;
    if (!restore || sortBusy()) return;
    setSortBusy(true);
    try {
      const token = await getBearer();
      const result = await pushCardTraderZeroPtSort(token, {
        orderId: restore.orderId,
        listId: restore.listId,
        sequence: restore.before,
        expectCount: restore.before.length,
      });
      setSortNote({
        tone: result?.applied ? 'ok' : 'warn',
        text: result?.applied ? 'Previous order restored on CardTrader' : 'Power Tools kept a different order',
      });
    } catch (err) {
      setSortNote(ptSortError(err));
    } finally {
      setSortBusy(false);
    }
  }

  async function resetSort() {
    setSortFields([...DEFAULT_SORT_FIELDS]);
    setSortNote(null);
    if (props.preview) return;
    setSortBusy(true);
    try {
      const token = await getBearer();
      const saved = await saveCardTraderZeroSort(token, { reset: true });
      takeSorting(saved?.sorting);
      setSortNote({ tone: 'ok', text: 'Sort reset to Game, then Location. Saved on Pokoin.' });
    } catch (err) {
      setSortNote({ tone: 'warn', text: err.message || 'Could not reset the sort.' });
    } finally {
      setSortBusy(false);
    }
  }

  async function changeSmartLocations(on) {
    setSmartLocations(on);
    if (props.preview) return;
    setSortBusy(true);
    try {
      const token = await getBearer();
      const saved = await saveCardTraderZeroSort(token, { fields: sortFields(), smartLocations: on });
      takeSorting(saved?.sorting);
      await load(); // the server adds or drops each line's candidate boxes
    } catch (err) {
      setSortNote({ tone: 'warn', text: err.message || 'Could not save Smart locations.' });
    } finally {
      setSortBusy(false);
    }
  }

  function exportList() {
    if (listMode() === 'pending') {
      downloadCsv({ orderId: 'pending', code: 'waiting-for-merge', items: sortZeroLines(pendingItems(), sortFields()) }, {});
      return;
    }
    for (const order of data()?.weekly || []) downloadCsv({ ...order, items: sortZeroLines(order.items, sortFields()) });
  }

  const totals = () => data()?.totals;
  const refreshedAt = () => {
    const at = data()?.fetchedAt ? new Date(data().fetchedAt) : null;
    return at && !Number.isNaN(at.getTime())
      ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : '';
  };
  const pendingItems = () => data()?.pending?.items || [];
  const showingPending = () => listMode() === 'pending';

  return (
    <div class="page desk mypokoin">
      <Show when={props.preview}>
        <p class="seller-preview-banner" role="status">{MYPOKOIN_PREVIEW_BANNER}</p>
      </Show>
      <StockNav
        title="CardTrader Zero"
        lede="Thursday's Zero pack, in picking order."
        metrics={data() ? [
          { value: totals().weekly.units, label: 'Cards to ship', hint: `${totals().weekly.lines} line${totals().weekly.lines === 1 ? '' : 's'}` },
          { value: totals().weekly.cents ? formatOrderMoney(totals().weekly.cents, 'EUR') : '—', label: 'Shipment value' },
          { value: totals().pending.units, label: 'Waiting for next merge', hint: `${data().pending.orderCount} Zero sale${data().pending.orderCount === 1 ? '' : 's'}` },
          { value: data().cardtrader?.username || '—', label: 'CardTrader seller' },
        ] : []}
      >
        <Show when={refreshedAt()}>
          <span class="zero-refreshed thread-meta">Refreshed at {refreshedAt()}</span>
        </Show>
        <button
          class="btn ghost"
          type="button"
          onClick={() => setListMode(showingPending() ? 'weekly' : 'pending')}
          disabled={!data()}
          title={showingPending() ? 'Show the weekly Zero shipment' : 'Show the Zero sales waiting for the next merge'}
        >
          Switch list
        </button>
        <button class="btn ghost" type="button" onClick={load} disabled={loading() || notConnected() || props.preview}>
          {loading() ? 'Reloading…' : 'Reload picking list'}
        </button>
        <button class="btn ghost" type="button" onClick={exportList} disabled={!data()}>Export</button>
      </StockNav>
      <p class="mypokoin-help">Every Thursday CardTrader merges your Zero sales into one pack to send to the hub. That current pack is listed here in picking order: Magic, Pokémon, Yu-Gi-Oh!, Riftbound, then the other games; inside a game by location box, then stack and position, then the order the copies were added to your inventory. Picking a card takes that copy out of your inventory; undo puts it back.</p>
      <Alert>{error()}</Alert>

      <Show when={notConnected()}>
        <EmptyDesk title="Connect CardTrader first" lede="The Zero list comes from your CardTrader seller orders. Paste your CardTrader API token in Settings.">
          <a class="btn" href="/mypokoin/settings">Settings</a>
        </EmptyDesk>
      </Show>

      <Show when={!data() && !error() && !notConnected()}>
        <DeskPanel title="Zero shipment"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>

      <Show when={data()}>
        <div class="zero-controls">
          <p class="zero-list-name">
            <strong>{showingPending() ? 'Waiting for the next merge' : 'Zero shipment'}</strong>
            <span class="thread-meta">
              {showingPending()
                ? ` · ${totals().pending.units} card${totals().pending.units === 1 ? '' : 's'}`
                : ` · ${totals().weekly.units} card${totals().weekly.units === 1 ? '' : 's'}`}
            </span>
          </p>
          <div class="zero-view-toggle" role="group" aria-label="View">
            <For each={ZERO_VIEWS}>
              {(entry) => (
                <button
                  type="button"
                  class={['inv-chip', { on: view() === entry.id }]}
                  aria-pressed={view() === entry.id}
                  onClick={() => setView(entry.id)}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>
          <ZeroSortBar
            fields={sortFields()}
            smartLocations={smartLocations()}
            busy={sortBusy()}
            onApply={applySort}
            onReset={resetSort}
            onSmartLocations={changeSmartLocations}
          />
          <Show when={sortNote()}>
            {(note) => (
              <p class={note().tone === 'ok' ? 'desk-ok zero-sort-note' : 'ct-token-hint is-warn zero-sort-note'} role="status">
                {note().text}
                <Show when={note().reconnect}>
                  {' '}<a href="#zero-powertools">Open the Power Tools panel</a>
                </Show>
                <Show when={note().restore}>
                  {' '}
                  <button class="btn ghost" type="button" onClick={restoreOrder} disabled={sortBusy()}>Restore previous order</button>
                </Show>
              </p>
            )}
          </Show>
        </div>
      </Show>

      <Show when={!showingPending()}>
        <Show when={data() && !data().weekly.length}>
          <EmptyDesk
            title="No Zero shipment to send"
            lede={pendingItems().length
              ? 'Your Zero sales are still waiting for CardTrader’s weekly merge (Thursday). Use Switch list to see them.'
              : 'When CardTrader merges your Zero sales into the weekly order, it shows up here.'}
          />
        </Show>
        <For each={data()?.weekly || []} keyed={(order) => order.orderId}>
          {(order) => (
            <ShipmentPanel
              order={order()}
              powerTools={data()?.powerTools}
              preview={props.preview}
              view={view()}
              sortFields={sortFields()}
              smartLocations={smartLocations()}
            />
          )}
        </For>
      </Show>

      <Show when={showingPending()}>
        <DeskPanel flush class="zero-pending-panel" title="Waiting for the next merge">
          <Show when={pendingItems().length} fallback={<p class="zero-drop-empty">No Zero sale is waiting for the next merge.</p>}>
            <PendingList items={pendingItems()} view={view()} sortFields={sortFields()} />
          </Show>
        </DeskPanel>
      </Show>

      <Show when={confirm()}>
        {(target) => (
          <PtSortDialog
            count={target().count}
            label={target().label}
            busy={confirmBusy()}
            onSend={sendConfirmed}
            onCancel={cancelConfirmed}
          />
        )}
      </Show>

      <Show when={!props.preview && !notConnected()}>
        <div id="zero-powertools">
          <PowerToolsPanel overlay={data()?.powerTools} onSession={load} />
        </div>
      </Show>
    </div>
  );
}

/** /mypokoin/zero. 1-Day Ready accounts move to /mypokoin/1dr. */
export default function CardTraderZero() {
  document.title = 'CardTrader Zero · Pokoin';
  const [params] = useSearchParams();
  return (
    <Show
      when={untrack(() => allowMypokoinPreview(params))}
      fallback={(
        <SignedIn early from="/mypokoin/zero">
          <ZeroDesk />
        </SignedIn>
      )}
    >
      <ZeroDesk preview />
    </Show>
  );
}
