import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getBearer } from '../auth.jsx';
import {
  connectCardTrader,
  disconnectCardTrader,
  fetchCardTraderStatus,
} from '../api.js';

/** CardTrader connect / disconnect panel for Profile. */
export default function CardTraderConnectPanel() {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const bearer = await getBearer();
      const data = await fetchCardTraderStatus(bearer);
      setStatus(data?.status || { connected: false });
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
      setMessage('CardTrader connected. Webhooks registered for sold sync.');
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
      setMessage('CardTrader disconnected.');
    } catch (err) {
      setError(err.message || 'Could not disconnect CardTrader.');
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
            Sold listings sync both ways when you list on both.
          </p>
          <div className="ct-connect-actions">
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
            Paste your CardTrader API token to list on CardTrader from Scan and the card desk.
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
