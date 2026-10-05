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
import { inventoryListingHref } from '../inventory-listings.js';
import { formatOrderMoney } from '../order-status.js';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';

const PICKED_KEY = 'pokoin.ctZero.picked.';

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    : '—';
}

/** Ticked lines per shipment, this browser only (a picking aid, not shared state). */
function readPicked(orderId) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PICKED_KEY + orderId) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch (_) {
    return new Set();
  }
}

function writePicked(orderId, picked) {
  try {
    if (picked.size) window.localStorage.setItem(PICKED_KEY + orderId, JSON.stringify([...picked]));
    else window.localStorage.removeItem(PICKED_KEY + orderId);
  } catch (_) {
    /* private mode: ticks just don't survive a reload */
  }
}

function facets(item) {
  return [
    item.condition,
    item.language,
    item.reverse ? 'Reverse' : '',
    item.firstEdition ? '1st ed.' : '',
    item.signed ? 'Signed' : '',
    item.altered ? 'Altered' : '',
    item.graded ? 'Graded' : '',
  ].filter(Boolean).join(' ');
}

function powerToolsLine(pt) {
  if (!pt) return '';
  const parts = [];
  if (pt.pickedQuantity != null) parts.push(`picked ${pt.pickedQuantity}`);
  else if (pt.orderState) parts.push(pt.orderState);
  if (pt.bin) parts.push(`bin ${pt.bin}`);
  return parts.length ? `Power Tools: ${parts.join(' · ')}` : '';
}

function ZeroLine({ item, picked, onToggle }) {
  const location = item.location || item.powerTools?.location || '';
  const fromPowerTools = !item.location && Boolean(item.powerTools?.location);
  const where = [item.expansion, item.collectorNumber ? `#${item.collectorNumber}` : ''].filter(Boolean).join(' · ');
  const pt = powerToolsLine(item.powerTools);
  return (
    <div className={`thread zero-line${picked ? ' is-picked' : ''}`}>
      {onToggle ? (
        <input
          type="checkbox"
          className="zero-tick"
          checked={picked}
          onChange={onToggle}
          aria-label={`Picked ${item.name}`}
        />
      ) : null}
      <span className={`zero-loc${location ? '' : ' is-empty'}`} title={fromPowerTools ? 'Location from Power Tools' : 'MyPokoin location'}>
        {location || 'No location'}
        {fromPowerTools ? <small> PT</small> : null}
      </span>
      <span className="thread-main">
        <strong className="thread-title">
          {item.cardId ? <Link to={inventoryListingHref(item)}>{item.name}</Link> : item.name}
          {item.quantity > 1 ? <span className="zero-qty"> ×{item.quantity}</span> : null}
        </strong>
        <span className="thread-meta">
          {[where, facets(item), item.lineCents != null ? formatOrderMoney(item.lineCents, item.currency) : '']
            .filter(Boolean)
            .join(' · ')}
          {pt ? <span className="zero-pt"> · {pt}</span> : null}
        </span>
      </span>
    </div>
  );
}

function ShipmentPanel({ order }) {
  const [picked, setPicked] = useState(() => readPicked(order.orderId));
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const done = order.items.filter((item) => picked.has(item.itemId)).length;

  function toggle(itemId) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      writePicked(order.orderId, next);
      return next;
    });
  }

  const title = [
    `Shipment ${order.code || order.orderId}`,
    order.packingNumber != null ? `packing #${order.packingNumber}` : '',
    order.paidAt ? `merged ${day(order.paidAt)}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <DeskPanel
      flush
      title={title}
      extra={(
        <span className="zero-progress">
          {done}/{order.items.length} picked · {units} card{units === 1 ? '' : 's'}
          {done ? (
            <button className="btn ghost" type="button" onClick={() => { writePicked(order.orderId, new Set()); setPicked(new Set()); }}>
              Clear ticks
            </button>
          ) : null}
        </span>
      )}
    >
      <div className="thread-list">
        {order.items.map((item) => (
          <ZeroLine
            key={item.itemId}
            item={item}
            picked={picked.has(item.itemId)}
            onToggle={() => toggle(item.itemId)}
          />
        ))}
      </div>
    </DeskPanel>
  );
}

function PowerToolsPanel({ overlay }) {
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
            Optional. Sign in with your Power Tools account to see its picking state and locations next to each card.
            The list above always comes straight from CardTrader. Pokoin keeps only your encrypted Power Tools
            session, never your password.
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
        lede="Every Thursday CardTrader merges your Zero sales into one order to send to the hub. This is that list, in picking order by MyPokoin location, read live from your CardTrader seller orders."
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

      {(data?.weekly || []).map((order) => <ShipmentPanel key={order.orderId} order={order} />)}

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

      {!notConnected ? <PowerToolsPanel overlay={data?.powerTools} /> : null}
    </div>
  );
}
