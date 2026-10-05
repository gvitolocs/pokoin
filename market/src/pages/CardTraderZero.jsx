import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import {
  connectPowerTools,
  disconnectPowerTools,
  fetchCardTraderStatus,
  fetchCardTraderZero,
  fetchPowerToolsStatus,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { formatOrderMoney } from '../order-status.js';
import { ShipmentPanel } from '../zero-pack.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';

function PowerToolsPanel({ overlay, onSession }) {
  const { getBearer } = useAuth();
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getBearer()
      .then((token) => fetchPowerToolsStatus(token))
      .then((data) => { if (!cancelled) setStatus(data.status || null); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Power Tools status failed.'); });
    return () => { cancelled = true; };
  }, [getBearer]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const body = mode === 'session' ? { session } : { email, password };
      const data = await connectPowerTools(token, body);
      setStatus(data.status || null);
      setPassword('');
      setSession('');
      if (onSession) await onSession();
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
      setStatus(data.status || null);
      if (onSession) await onSession();
    } catch (err) {
      setError(err.message || 'Could not forget the Power Tools session.');
    } finally {
      setBusy(false);
    }
  }

  const expired = overlay?.connected && overlay.ok === false && overlay.code === 'powertools_session_expired';

  return (
    <DeskPanel title="Power Tools">
      <Alert>{error}</Alert>
      {status?.connected ? (
        <div className="zero-pt-status">
          <p className="page-lede">
            Signed in as <strong>{status.account?.username || 'your Power Tools account'}</strong>.
            {overlay?.ok ? ` Matched ${overlay.matchedItems || 0} line${overlay.matchedItems === 1 ? '' : 's'} with Power Tools picking.` : ''}
          </p>
          {status.cardtraderMatch === false ? (
            <p className="ct-token-hint is-warn">
              This Power Tools account is linked to a different CardTrader seller than the one connected to Pokoin.
            </p>
          ) : null}
          {expired ? (
            <p className="ct-token-hint is-warn">The Power Tools session expired. Sign out and sign in again.</p>
          ) : overlay?.connected && overlay.ok === false ? (
            <p className="ct-token-hint is-warn">{overlay.error}</p>
          ) : null}
          <button className="btn ghost" type="button" onClick={signOut} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out of Power Tools'}
          </button>
        </div>
      ) : status ? (
        <form className="ct-connect-form" onSubmit={submit}>
          <p className="page-lede">
            Optional. Sign in with your Power Tools account. Pokoin then checks this pack's location order
            against the Power Tools position order, and shows its picking state next to each card.
            Pokoin keeps only your encrypted Power Tools session, never your password.
          </p>
          <p className="ct-token-hint is-ok">
            Already signed in to Power Tools in Chrome? Open the{' '}
            <a href="/download/extension.zip">Pokoin extension</a> side panel and click Power Tools → Connect.
            No password needed.
          </p>
          {mode === 'password' ? (
            <>
              <label className="ct-token-field">
                <span className="sr-only">Power Tools email</span>
                <input
                  type="email"
                  name="powertools-email"
                  autoComplete="username"
                  placeholder="Power Tools email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label className="ct-token-field">
                <span className="sr-only">Power Tools password</span>
                <input
                  type="password"
                  name="powertools-password"
                  autoComplete="current-password"
                  placeholder="Power Tools password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <label className="ct-token-field">
              <span className="sr-only">Power Tools session</span>
              <input
                type="text"
                name="powertools-session"
                className="is-masked"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                placeholder="Power Tools session (jwt cookie value)"
                value={session}
                onChange={(event) => setSession(event.target.value)}
                required
              />
            </label>
          )}
          <div className="ct-connect-actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in to Power Tools'}
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => { setMode(mode === 'password' ? 'session' : 'password'); setError(''); }}
            >
              {mode === 'password' ? 'Google or two-factor account? Paste a session' : 'Use email and password'}
            </button>
          </div>
          {mode === 'session' ? (
            <p className="ct-token-hint is-ok">
              On new.tcgpowertools.com open DevTools → Application → Cookies and copy the value of <code>jwt</code>.
            </p>
          ) : null}
        </form>
      ) : (
        <div className="skeleton-line" />
      )}
    </DeskPanel>
  );
}

export default function CardTraderZero() {
  const location = useLocation();
  const { ready, signedIn, getBearer } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notConnected, setNotConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPending, setShowPending] = useState(false);
  const [oneDayReady, setOneDayReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = await getBearer();
      const result = await fetchCardTraderZero(token);
      setNotConnected(false);
      setData(result);
    } catch (err) {
      if (err.body?.code === 'cardtrader_not_connected') setNotConnected(true);
      else setError(err.message || 'CardTrader Zero list failed.');
    } finally {
      setLoading(false);
    }
  }, [getBearer]);

  useEffect(() => {
    document.title = 'CardTrader Zero · Pokoin';
    if (!signedIn) return undefined;
    load();
    let cancelled = false;
    getBearer()
      .then((token) => fetchCardTraderStatus(token))
      .then((status) => {
        const ready = status?.status?.metadata?.oneDayReady === true
          || status?.sync?.summary?.mode === 'one_day_ready';
        if (!cancelled && ready) setOneDayReady(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [signedIn, load, getBearer]);

  const totals = data?.totals;
  const pendingItems = useMemo(() => data?.pending?.items || [], [data]);

  if (!ready) return <SessionWait />;
  if (!signedIn) return <Navigate to={authFrom(location.pathname || '/mypokoin/zero')} replace />;
  if (oneDayReady || data?.oneDayReady) return <Navigate to="/mypokoin/1dr" replace />;

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="CardTrader Zero"
        lede="Every Thursday CardTrader merges your Zero sales into one pack to send to the hub. That current pack is listed here in picking order: location box, then stock number from smaller to bigger."
      >
        <button className="btn ghost" type="button" onClick={load} disabled={loading || notConnected}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHead>
      <StockNav />
      <Alert>{error}</Alert>

      {notConnected ? (
        <EmptyDesk title="Connect CardTrader first" lede="The Zero list comes from your CardTrader seller orders. Paste your CardTrader API token in Settings.">
          <Link className="btn" to="/mypokoin/settings">Settings</Link>
        </EmptyDesk>
      ) : null}

      {data ? (
        <MetricGrid>
          <Metric value={totals.weekly.units} label="Cards to ship" hint={`${totals.weekly.lines} line${totals.weekly.lines === 1 ? '' : 's'}`} />
          <Metric value={totals.weekly.cents ? formatOrderMoney(totals.weekly.cents, 'EUR') : '—'} label="Shipment value" />
          <Metric value={totals.pending.units} label="Waiting for next merge" hint={`${data.pending.orderCount} Zero sale${data.pending.orderCount === 1 ? '' : 's'}`} />
          <Metric value={data.cardtrader?.username || '—'} label="CardTrader seller" />
        </MetricGrid>
      ) : null}

      {!data && !error && !notConnected ? (
        <DeskPanel title="Zero shipment"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}

      {data && !data.weekly.length ? (
        <EmptyDesk
          title="No Zero shipment to send"
          lede={pendingItems.length
            ? 'Your Zero sales are still waiting for CardTrader’s weekly merge (Thursday). They are listed below.'
            : 'When CardTrader merges your Zero sales into the weekly order, it shows up here.'}
        />
      ) : null}

      {(data?.weekly || []).map((order) => (
        <ShipmentPanel key={order.orderId} order={order} powerTools={data.powerTools} />
      ))}

      {pendingItems.length ? (
        <DeskPanel
          flush
          title={`Waiting for the next merge · ${totals.pending.units} card${totals.pending.units === 1 ? '' : 's'}`}
          extra={(
            <button className="btn ghost" type="button" onClick={() => setShowPending((open) => !open)}>
              {showPending ? 'Hide' : 'Show'}
            </button>
          )}
        >
          {showPending ? (
            <div className="thread-list">
              {pendingItems.map((item) => <ZeroLine key={`${item.orderId}-${item.itemId}`} item={item} />)}
            </div>
          ) : null}
        </DeskPanel>
      ) : null}

      {!notConnected ? <PowerToolsPanel overlay={data?.powerTools} onSession={load} /> : null}
    </div>
  );
}
