import { createEffect, createSignal, For, Match, onSettled, Show, Switch } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import {
  connectPowerTools,
  disconnectPowerTools,
  fetchCardTraderStatus,
  fetchCardTraderZero,
  fetchPowerToolsStatus,
} from '@market/api.js';
import { formatOrderMoney } from '@market/order-status.js';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { ShipmentPanel, ZeroLine } from '../components/ZeroPack.jsx';
import { getBearer, signedIn } from '../stores/auth.js';

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
    <DeskPanel title="Power Tools">
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

function ZeroDesk() {
  const navigate = useNavigate();
  const [data, setData] = createSignal(null);
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
    if (!on) return undefined;
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
    () => data()?.oneDayReady === true,
    (ready) => {
      if (ready) navigate('/mypokoin/1dr', { replace: true });
    },
  );

  const totals = () => data()?.totals;
  const pendingItems = () => data()?.pending?.items || [];

  return (
    <div class="page desk">
      <PageHead
        kicker="Seller"
        title="CardTrader Zero"
        lede="Every Thursday CardTrader merges your Zero sales into one pack to send to the hub. That current pack is listed here in picking order: location box, then stock number from smaller to bigger."
      >
        <button class="btn ghost" type="button" onClick={load} disabled={loading() || notConnected()}>
          {loading() ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHead>
      <StockNav />
      <Alert>{error()}</Alert>

      <Show when={notConnected()}>
        <EmptyDesk title="Connect CardTrader first" lede="The Zero list comes from your CardTrader seller orders. Paste your CardTrader API token in Settings.">
          <a class="btn" href="/mypokoin/settings">Settings</a>
        </EmptyDesk>
      </Show>

      <Show when={data()}>
        <MetricGrid>
          <Metric value={totals().weekly.units} label="Cards to ship" hint={`${totals().weekly.lines} line${totals().weekly.lines === 1 ? '' : 's'}`} />
          <Metric value={totals().weekly.cents ? formatOrderMoney(totals().weekly.cents, 'EUR') : '—'} label="Shipment value" />
          <Metric value={totals().pending.units} label="Waiting for next merge" hint={`${data().pending.orderCount} Zero sale${data().pending.orderCount === 1 ? '' : 's'}`} />
          <Metric value={data().cardtrader?.username || '—'} label="CardTrader seller" />
        </MetricGrid>
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
        {(order) => <ShipmentPanel order={order()} powerTools={data()?.powerTools} />}
      </For>

      <Show when={pendingItems().length}>
        <DeskPanel
          flush
          title={`Waiting for the next merge · ${totals().pending.units} card${totals().pending.units === 1 ? '' : 's'}`}
          extra={(
            <button class="btn ghost" type="button" onClick={() => setShowPending((open) => !open)}>
              {showPending() ? 'Hide' : 'Show'}
            </button>
          )}
        >
          <Show when={showPending()}>
            <div class="thread-list">
              <For each={pendingItems()}>{(item) => <ZeroLine item={item} />}</For>
            </div>
          </Show>
        </DeskPanel>
      </Show>

      <Show when={!notConnected()}>
        <PowerToolsPanel overlay={data()?.powerTools} onSession={load} />
      </Show>
    </div>
  );
}

/** /mypokoin/zero (market/src/pages/CardTraderZero.jsx). 1-Day Ready accounts move to /mypokoin/1dr. */
export default function CardTraderZero() {
  document.title = 'CardTrader Zero · Pokoin';
  return (
    <SignedIn from="/mypokoin/zero">
      <ZeroDesk />
    </SignedIn>
  );
}
