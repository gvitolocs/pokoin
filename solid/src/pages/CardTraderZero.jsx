import { createEffect, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import {
  connectPowerTools,
  disconnectPowerTools,
  fetchCardTraderStatus,
  fetchCardTraderZero,
  fetchPowerToolsStatus,
} from '@market/api.js';
import { formatOrderMoney } from '@market/order-status.js';
import { Alert, DeskPanel, EmptyDesk } from '../components/Desk.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { ShipmentPanel, ZeroLine } from '../components/ZeroPack.jsx';
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

function ZeroDesk(props) {
  const navigate = useGameNavigate();
  const [data, setData] = createSignal(props.preview ? previewZero() : null);
  const [error, setError] = createSignal('');
  const [notConnected, setNotConnected] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [showPending, setShowPending] = createSignal(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const token = await getBearer();
      const result = await fetchCardTraderZero(token);
      setNotConnected(false);
      setData(() => result);
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

  const totals = () => data()?.totals;
  const refreshedAt = () => {
    const at = data()?.fetchedAt ? new Date(data().fetchedAt) : null;
    return at && !Number.isNaN(at.getTime())
      ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : '';
  };
  const pendingItems = () => data()?.pending?.items || [];

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
        <button class="btn ghost" type="button" onClick={load} disabled={loading() || notConnected() || props.preview}>
          {loading() ? 'Refreshing…' : 'Refresh'}
        </button>
      </StockNav>
      <p class="mypokoin-help">Every Thursday CardTrader merges your Zero sales into one pack to send to the hub. That current pack is listed here in picking order: Magic, Pokémon, Yu-Gi-Oh!, Riftbound, then the other games; inside a game by location box, then stack and position, then the order the copies were added to your inventory.</p>
      <Alert>{error()}</Alert>

      <Show when={notConnected()}>
        <EmptyDesk title="Connect CardTrader first" lede="The Zero list comes from your CardTrader seller orders. Paste your CardTrader API token in Settings.">
          <a class="btn" href="/mypokoin/settings">Settings</a>
        </EmptyDesk>
      </Show>

      <Show when={!data() && !error() && !notConnected()}>
        <DeskPanel title="Zero shipment"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>

      <Show when={data() && !data().weekly.length}>
        <EmptyDesk
          title="No Zero shipment to send"
          lede={pendingItems().length
            ? 'Your Zero sales are still waiting for CardTrader’s weekly merge (Thursday). They are listed below.'
            : 'When CardTrader merges your Zero sales into the weekly order, it shows up here.'}
        />
      </Show>

      <For each={data()?.weekly || []} keyed={(order) => order.orderId}>
        {(order) => <ShipmentPanel order={order()} powerTools={data()?.powerTools} preview={props.preview} />}
      </For>

      <Show when={pendingItems().length}>
        <DeskPanel
          flush
          class="zero-pending-panel"
          title={`Waiting for the next merge · ${totals().pending.units} card${totals().pending.units === 1 ? '' : 's'}`}
          extra={(
            <button class="btn ghost" type="button" onClick={() => setShowPending((open) => !open)}>
              {showPending() ? 'Hide' : 'Show'}
            </button>
          )}
        >
          <Show when={showPending()}>
            <div class="zero-grid">
              <For each={pendingItems()}>{(item) => <ZeroLine item={item} />}</For>
            </div>
          </Show>
        </DeskPanel>
      </Show>

      <Show when={!props.preview && !notConnected()}>
        <PowerToolsPanel overlay={data()?.powerTools} onSession={load} />
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
