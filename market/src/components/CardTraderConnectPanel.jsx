import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getBearer } from '../auth.jsx';
import {
  connectCardTrader,
  disconnectCardTrader,
  fetchCardTraderStatus,
  syncCardTraderInventory,
} from '../api.js';

function formatSyncSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const parts = [
    `${Number(summary.pokemonInventory || summary.inventory || 0)} products checked`,
    `${Number(summary.imported || 0)} imported`,
    `${Number(summary.matchedExisting || 0)} linked`,
    `${Number(summary.updated || 0)} updated`,
    `${Number(summary.removed || 0)} removed`,
    `${Number(summary.unresolved || 0)} unresolved`,
  ];
  return parts.join(' · ');
}

/** CardTrader connect / disconnect / sync panel for Profile. */
export default function CardTraderConnectPanel() {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [syncSummary, setSyncSummary] = useState(null);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const bearer = await getBearer();
      const data = await fetchCardTraderStatus(bearer);
      setStatus(data?.status || { connected: false });
      if (data?.sync?.summary) setSyncSummary(data.sync.summary);
    } catch (err) {
      setStatus({ connected: false });
      setError(err.message || 'Could not load CardTrader status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onConnect(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bearer = await getBearer();
      const data = await connectCardTrader(bearer, token);
      setStatus(data?.status || { connected: true });
      setToken('');
      const sync = data?.inventorySync;
      if (sync?.summary) {
        setSyncSummary(sync.summary);
        setMessage(
          sync.ok === false
            ? `Connected. Inventory sync pending: ${sync.error || 'retry Sync CardTrader'}.`
            : `CardTrader connected. ${formatSyncSummary(sync.summary)}`,
        );
      } else {
        setMessage('CardTrader connected. Webhooks registered; run Sync CardTrader to import inventory.');
      }
    } catch (err) {
      setError(err.message || 'Could not connect CardTrader.');
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bearer = await getBearer();
      const data = await disconnectCardTrader(bearer);
      setStatus(data?.status || { connected: false });
      setSyncSummary(null);
      setMessage('CardTrader disconnected.');
    } catch (err) {
      setError(err.message || 'Could not disconnect CardTrader.');
    } finally {
      setBusy(false);
    }
  }

  async function onSync() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bearer = await getBearer();
      const data = await syncCardTraderInventory(bearer);
      if (data?.summary) setSyncSummary(data.summary);
      if (data?.incomplete || data?.destructiveSkipped) {
        setMessage(`Sync incomplete — no stock removed. ${data.error || 'Retry when CardTrader is reachable.'}`);
      } else if (data?.ok === false) {
        setError(data.error || 'CardTrader sync failed.');
      } else {
        setMessage(`CardTrader synced. ${formatSyncSummary(data.summary)}`);
      }
    } catch (err) {
      setError(err.message || 'Could not sync CardTrader inventory.');
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected === true;
  const username = status?.metadata?.user?.username || status?.metadata?.seller?.name || '';
  const appName = status?.metadata?.app?.name || '';

  return (
    <div className="ct-connect">
      {loading ? <p className="page-lede">Checking CardTrader…</p> : null}
      {!loading && connected ? (
        <>
          <p className="page-lede">
            Connected{username ? ` as ${username}` : ''}
            {appName ? ` · ${appName}` : ''}.
            CardTrader inventory is a synchronized subset of Pokoin; Pokoin-only listings stay independent.
          </p>
          {syncSummary ? (
            <p className="page-lede muted">{formatSyncSummary(syncSummary)}</p>
          ) : null}
          <div className="ct-connect-actions">
            <button type="button" className="btn" disabled={busy} onClick={onSync}>
              {busy ? 'Working…' : 'Sync CardTrader'}
            </button>
            <Link className="btn ghost" to="/inventory">Open inventory</Link>
            <button type="button" className="btn ghost" disabled={busy} onClick={onDisconnect}>
              {busy ? 'Working…' : 'Disconnect'}
            </button>
          </div>
        </>
      ) : null}
      {!loading && !connected ? (
        <form className="ct-connect-form" onSubmit={onConnect}>
          <p className="page-lede">
            Paste your CardTrader API token to list on CardTrader from Scan and the card desk,
            and to import your existing CardTrader inventory into Pokoin.
            The token is stored encrypted and never shown again.
          </p>
          <label className="ct-token-field">
            <span className="sr-only">CardTrader API token</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="CardTrader API token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button type="submit" className="btn" disabled={busy || token.trim().length < 16}>
            {busy ? 'Connecting…' : 'Connect CardTrader'}
          </button>
        </form>
      ) : null}
      {message ? <p className="ct-connect-ok">{message}</p> : null}
      {error ? <p className="ct-connect-err">{error}</p> : null}
    </div>
  );
}
