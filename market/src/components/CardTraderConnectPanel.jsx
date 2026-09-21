import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getBearer } from '../auth.jsx';
import { DASHBOARD_HOME } from '../punchouts.js';
import {
  connectCardTrader,
  disconnectCardTrader,
  fetchCardTraderStatus,
  syncCardTraderInventory,
} from '../api.js';
import {
  MIN_CARDTRADER_TOKEN_LENGTH,
  describeCardTraderToken,
} from '../cardtrader-token.js';

const CT_TOKEN_DOCS = 'https://www.cardtrader.com/en/docs/api/full/reference';

/** One line under the token field: which CardTrader app it belongs to, or what is wrong. */
function tokenHint(pasted) {
  if (!pasted.token) return null;
  if (pasted.problem === 'not_token') {
    return {
      tone: 'warn',
      text: 'This does not look like a CardTrader API token. Clear the field and paste only the token from your CardTrader settings.',
    };
  }
  if (pasted.problem === 'incomplete') {
    return {
      tone: 'warn',
      text: 'This token looks cut off or has extra characters. Clear the field and paste it again with CardTrader’s Copy button.',
    };
  }
  const parts = [pasted.appName ? `CardTrader token for “${pasted.appName}”` : 'CardTrader token'];
  if (pasted.issuedAt) {
    parts.push(`issued ${pasted.issuedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`);
  }
  if (pasted.cleaned) parts.push('extra spaces or text removed');
  return { tone: 'ok', text: parts.join(' · ') };
}

function formatSyncSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  if (summary.mode === 'one_day_ready') {
    const hidden = Number(summary.hiddenListings || 0);
    return [
      `${Number(summary.assetCards || 0)} cards on your Dashboard as CardTrader 1-DR`,
      `${Number(summary.assets || 0)} products`,
      hidden ? `${hidden} Pokoin listings hidden` : '',
    ].filter(Boolean).join(' · ');
  }
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

function phaseLabel(phase) {
  switch (String(phase || '')) {
    case 'starting': return 'Starting…';
    case 'export': return 'Downloading CardTrader inventory…';
    case 'export_done': return 'Preparing import…';
    case 'import': return 'Importing into Pokoin…';
    case 'finishing': return 'Finishing…';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    default: return phase ? String(phase) : 'Syncing…';
  }
}

function progressPercent(processed, total) {
  const p = Math.max(0, Number(processed) || 0);
  const t = Math.max(0, Number(total) || 0);
  if (t <= 0) return 8;
  return Math.max(2, Math.min(100, Math.round((100 * p) / t)));
}

/** CardTrader connect / disconnect / sync panel for Profile. */
export default function CardTraderConnectPanel() {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [syncSummary, setSyncSummary] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null);
  const pollRef = useRef(null);
  const pasted = useMemo(() => describeCardTraderToken(token), [token]);
  const hint = tokenHint(pasted);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function applySyncPayload(data) {
    const sync = data?.sync || null;
    const summary = sync?.summary || data?.summary || null;
    if (summary) setSyncSummary(summary);
    const running = Boolean(
      data?.running
      || sync?.running
      || summary?.running
      || data?.inventorySync?.running,
    );
    const processed = Number(
      data?.processed ?? sync?.processed ?? summary?.processed ?? 0,
    );
    const total = Number(
      data?.total ?? sync?.total ?? summary?.total ?? 0,
    );
    const phase = data?.phase || sync?.phase || summary?.phase || '';
    if (running || (phase && phase !== 'done' && phase !== 'failed')) {
      setSyncProgress({ running, phase, processed, total });
    } else if (summary && summary.running === false) {
      setSyncProgress(null);
    }
    return running;
  }

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const bearer = await getBearer();
      const data = await fetchCardTraderStatus(bearer);
      setStatus(data?.status || { connected: false });
      const running = applySyncPayload(data);
      if (running) startPolling();
    } catch (err) {
      setStatus({ connected: false });
      setError(err.message || 'Could not load CardTrader status.');
    } finally {
      setLoading(false);
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const bearer = await getBearer();
        const data = await fetchCardTraderStatus(bearer);
        setStatus(data?.status || { connected: false });
        const running = applySyncPayload(data);
        if (!running) {
          stopPolling();
          setBusy(false);
          const summary = data?.sync?.summary || data?.summary;
          if (data?.sync?.lastSyncOk === false || summary?.phase === 'failed') {
            setError(data?.sync?.lastSyncError || 'CardTrader sync failed.');
            setMessage('');
          } else if (summary) {
            setMessage(`CardTrader synced. ${formatSyncSummary(summary)}`);
          }
        }
      } catch (_) {
        // Keep polling; transient errors happen mid-import.
      }
    }, 1200);
  }

  useEffect(() => {
    refresh();
    return () => stopPolling();
  }, []);

  async function onConnect(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bearer = await getBearer();
      const data = await connectCardTrader(bearer, pasted.token);
      setStatus(data?.status || { connected: true });
      setToken('');
      setTokenVisible(false);
      const sync = data?.inventorySync;
      if (sync?.async || sync?.running) {
        setSyncProgress({
          running: true,
          phase: sync?.summary?.phase || 'starting',
          processed: 0,
          total: 0,
        });
        setMessage('CardTrader connected. Importing inventory in the background…');
        startPolling();
      } else if (sync?.summary) {
        setSyncSummary(sync.summary);
        setMessage(
          sync.ok === false
            ? `Connected. Inventory sync pending: ${sync.error || 'retry Sync CardTrader'}.`
            : `CardTrader connected. ${formatSyncSummary(sync.summary)}`,
        );
        setBusy(false);
      } else {
        setMessage('CardTrader connected. Webhooks registered; run Sync CardTrader to import inventory.');
        setBusy(false);
      }
    } catch (err) {
      setError(err.message || 'Could not connect CardTrader.');
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    stopPolling();
    setSyncProgress(null);
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
      if (data?.async || data?.running) {
        setSyncProgress({
          running: true,
          phase: data?.summary?.phase || 'starting',
          processed: 0,
          total: 0,
        });
        setMessage('Import started — this stays on the page while it runs.');
        startPolling();
        return;
      }
      if (data?.summary) setSyncSummary(data.summary);
      if (data?.incomplete || data?.destructiveSkipped) {
        setMessage(`Sync incomplete — no stock removed. ${data.error || 'Retry when CardTrader is reachable.'}`);
      } else if (data?.ok === false) {
        setError(data.error || 'CardTrader sync failed.');
      } else {
        setMessage(`CardTrader synced. ${formatSyncSummary(data.summary)}`);
      }
      setBusy(false);
    } catch (err) {
      setError(err.message || 'Could not sync CardTrader inventory.');
      setBusy(false);
    }
  }

  const connected = status?.connected === true;
  // 1-Day Ready: CardTrader stocks and sells the cards, so they are dashboard
  // assets, never Pokoin listings.
  const oneDayReady = connected && (
    status?.metadata?.oneDayReady === true || syncSummary?.mode === 'one_day_ready'
  );
  const username = status?.metadata?.user?.username || status?.metadata?.seller?.name || '';
  const appName = status?.metadata?.app?.name || '';
  const syncing = Boolean(syncProgress?.running);

  return (
    <div className="ct-connect">
      {loading ? <p className="page-lede">Checking CardTrader…</p> : null}
      {!loading && connected ? (
        <>
          <p className="page-lede">
            Connected{username ? ` as ${username}` : ''}
            {appName ? ` · ${appName}` : ''}.
            {' '}
            {oneDayReady
              ? 'This is a CardTrader 1-Day Ready account: CardTrader stocks and sells these cards, so they show on your Dashboard as CardTrader 1-DR assets, not as Pokoin listings.'
              : 'CardTrader inventory is a synchronized subset of Pokoin; Pokoin-only listings stay independent.'}
          </p>
          {syncSummary && !syncing ? (
            <p className="page-lede muted">{formatSyncSummary(syncSummary)}</p>
          ) : null}
          {syncing ? (
            <div className="ct-sync-progress" role="status" aria-live="polite">
              <div className="ct-sync-progress-label">
                {phaseLabel(syncProgress.phase)}
                {syncProgress.total > 0
                  ? ` · ${syncProgress.processed} / ${syncProgress.total}`
                  : ''}
              </div>
              <div className="ct-sync-progress-track">
                <div
                  className="ct-sync-progress-bar"
                  style={{ width: `${progressPercent(syncProgress.processed, syncProgress.total)}%` }}
                />
              </div>
            </div>
          ) : null}
          <div className="ct-connect-actions">
            <button type="button" className="btn" disabled={busy || syncing} onClick={onSync}>
              {syncing ? 'Syncing…' : busy ? 'Working…' : 'Sync CardTrader'}
            </button>
            {oneDayReady
              ? <a className="btn ghost" href={DASHBOARD_HOME}>Open dashboard</a>
              : <Link className="btn ghost" to="/inventory">Open inventory</Link>}
            <button type="button" className="btn ghost" disabled={busy || syncing} onClick={onDisconnect}>
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
            {' '}
            Find yours in the{' '}
            <a href={CT_TOKEN_DOCS} target="_blank" rel="noreferrer">CardTrader API docs</a>.
          </p>
          <div className="ct-token-row">
            <label className="ct-token-field">
              <span className="sr-only">CardTrader API token</span>
              {/* Not type="password": browsers and password managers fill saved
                  site passwords into password fields and the paste lands next
                  to them. The text is masked with CSS instead. */}
              <input
                type="text"
                name="cardtrader-api-token"
                className={tokenVisible ? '' : 'is-masked'}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                placeholder="CardTrader API token"
                value={token}
                aria-describedby={hint ? 'ct-token-hint' : undefined}
                onChange={(event) => {
                  setToken(event.target.value);
                  // A rejection belongs to the previous paste.
                  setError('');
                }}
              />
            </label>
            <button
              type="button"
              className="btn ghost ct-token-toggle"
              aria-pressed={tokenVisible}
              disabled={!token}
              onClick={() => setTokenVisible((visible) => !visible)}
            >
              {tokenVisible ? 'Hide' : 'Show'}
            </button>
          </div>
          {hint ? (
            <p id="ct-token-hint" className={`ct-token-hint is-${hint.tone}`}>{hint.text}</p>
          ) : null}
          {syncing ? (
            <div className="ct-sync-progress" role="status" aria-live="polite">
              <div className="ct-sync-progress-label">
                {phaseLabel(syncProgress.phase)}
                {syncProgress.total > 0
                  ? ` · ${syncProgress.processed} / ${syncProgress.total}`
                  : ''}
              </div>
              <div className="ct-sync-progress-track">
                <div
                  className="ct-sync-progress-bar"
                  style={{ width: `${progressPercent(syncProgress.processed, syncProgress.total)}%` }}
                />
              </div>
            </div>
          ) : null}
          <button
            type="submit"
            className="btn"
            disabled={busy || syncing || pasted.token.length < MIN_CARDTRADER_TOKEN_LENGTH}
          >
            {busy || syncing ? 'Connecting…' : 'Connect CardTrader'}
          </button>
        </form>
      ) : null}
      {message ? <p className="ct-connect-ok">{message}</p> : null}
      {error ? <p className="ct-connect-err">{error}</p> : null}
    </div>
  );
}
