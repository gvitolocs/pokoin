import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js';
import {
  connectCardTrader,
  disconnectCardTrader,
  fetchCardTraderStatus,
  syncCardTraderInventory,
} from '@market/api.js';
import { MIN_CARDTRADER_TOKEN_LENGTH, describeCardTraderToken } from '@market/cardtrader-token.js';
import { DASHBOARD_HOME } from '@market/punchouts.js';
import { getBearer } from '../../stores/auth.js';
import CardTraderPowerToolsModal from './CardTraderPowerToolsModal.jsx';
import WipeAllInventory from './WipeAllInventory.jsx';

/** Where a seller copies their CardTrader API token. */
export const CT_TOKEN_DOCS = 'https://www.cardtrader.com/en/docs/api/full/reference';

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
  return [
    `${Number(summary.pokemonInventory || summary.inventory || 0)} products checked`,
    `${Number(summary.imported || 0)} imported`,
    `${Number(summary.matchedExisting || 0)} linked`,
    `${Number(summary.updated || 0)} updated`,
    `${Number(summary.removed || 0)} removed`,
    `${Number(summary.unresolved || 0)} unresolved`,
  ].join(' · ');
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

function SyncProgress(props) {
  return (
    <div class="ct-sync-progress" role="status" aria-live="polite">
      <div class="ct-sync-progress-label">
        {phaseLabel(props.progress.phase)}
        {props.progress.total > 0 ? ` · ${props.progress.processed} / ${props.progress.total}` : ''}
      </div>
      <div class="ct-sync-progress-track">
        <div class="ct-sync-progress-bar" style={{ width: `${progressPercent(props.progress.processed, props.progress.total)}%` }} />
      </div>
    </div>
  );
}

/**
 * CardTrader connect / disconnect / sync panel for Profile.
 * `onStatus` hears every
 * status load; `showWipe` false leaves Delete all inventory to the danger zone.
 */
export default function CardTraderConnectPanel(props) {
  const [status, setStatus] = createSignal(null);
  const [token, setToken] = createSignal('');
  const [tokenVisible, setTokenVisible] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [syncSummary, setSyncSummary] = createSignal(null);
  const [syncProgress, setSyncProgress] = createSignal(null);
  const [ptModalOpen, setPtModalOpen] = createSignal(false);
  const [ptGames, setPtGames] = createSignal(null);
  const [ptGamesLoading, setPtGamesLoading] = createSignal(false);
  const [ptPreviewBusy, setPtPreviewBusy] = createSignal(false);
  const [ptPreview, setPtPreview] = createSignal(null);
  let poll = null;
  const pasted = createMemo(() => describeCardTraderToken(token()));
  const hint = () => tokenHint(pasted());
  const showWipe = () => props.showWipe !== false;

  function stopPolling() {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  function applySyncPayload(data) {
    const sync = data?.sync || null;
    const summary = sync?.summary || data?.summary || null;
    if (summary) setSyncSummary(() => summary);
    const running = Boolean(data?.running || sync?.running || summary?.running || data?.inventorySync?.running);
    const processed = Number(data?.processed ?? sync?.processed ?? summary?.processed ?? 0);
    const total = Number(data?.total ?? sync?.total ?? summary?.total ?? 0);
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
      setStatus(() => data?.status || { connected: false });
      if (applySyncPayload(data)) startPolling();
    } catch (err) {
      setStatus({ connected: false });
      setError(err.message || 'Could not load CardTrader status.');
    } finally {
      setLoading(false);
    }
  }

  function startPolling() {
    stopPolling();
    poll = setInterval(async () => {
      try {
        const bearer = await getBearer();
        const data = await fetchCardTraderStatus(bearer);
        setStatus(() => data?.status || { connected: false });
        const running = applySyncPayload(data);
        if (!running) {
          stopPolling();
          setBusy(false);
          const summary = data?.sync?.summary || data?.summary;
          if (data?.sync?.lastSyncOk === false || summary?.phase === 'failed') {
            setError(data?.sync?.lastSyncError || 'CardTrader sync failed.');
            setMessage('');
          } else if (summary?.needsPowerToolsReview) {
            setSyncSummary(() => summary);
            setMessage('Sync done — review CardTrader ↔ Power Tools mismatches.');
            window.location.assign('/inventory/sync-review');
          } else if (summary) {
            setMessage(`CardTrader synced. ${formatSyncSummary(summary)}`);
          }
        }
      } catch (_) {
        // Keep polling; transient errors happen mid-import.
      }
    }, 1200);
  }

  onSettled(() => {
    refresh();
    return () => stopPolling();
  });

  createEffect(
    () => (status() ? { ...status(), syncSummary: syncSummary() } : null),
    (value) => {
      if (value) props.onStatus?.(value);
    },
  );

  async function onConnect(event) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bearer = await getBearer();
      const data = await connectCardTrader(bearer, pasted().token);
      setStatus(() => data?.status || data?.integration || { connected: true });
      setToken('');
      setTokenVisible(false);
      const sync = data?.inventorySync;
      if (sync?.async || sync?.running) {
        setSyncProgress({ running: true, phase: sync?.summary?.phase || 'starting', processed: 0, total: 0 });
        setMessage('CardTrader connected. Importing inventory in the background…');
        startPolling();
      } else if (sync?.summary) {
        setSyncSummary(() => sync.summary);
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
    if (busy()) return;
    // Without the token Pokoin can't see CardTrader sales, so imported stock is
    // deleted (sold cards stay as sales history; nothing changes on CardTrader).
    if (!window.confirm('Disconnect CardTrader? Cards imported from CardTrader are deleted from Pokoin — your listings on CardTrader stay. Reconnect any time to import them again.')) {
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    stopPolling();
    setSyncProgress(null);
    try {
      const bearer = await getBearer();
      const data = await disconnectCardTrader(bearer);
      setStatus(() => data?.status || { connected: false });
      setSyncSummary(null);
      const removed = Number(data?.removedListings ?? data?.hiddenListings) || 0;
      const assets = Number(data?.removedAssets) || 0;
      setMessage(removed > 0 || assets > 0
        ? `CardTrader disconnected. ${removed} imported listing${removed === 1 ? '' : 's'} and ${assets} 1-Day Ready asset${assets === 1 ? '' : 's'} deleted from Pokoin — reconnect to import them again.`
        : 'CardTrader disconnected.');
    } catch (err) {
      setError(err.message || 'Could not disconnect CardTrader.');
    } finally {
      setBusy(false);
    }
  }

  async function runSync(options = {}) {
    setBusy(true);
    setError('');
    setMessage('');
    setPtModalOpen(false);
    try {
      const bearer = await getBearer();
      const data = await syncCardTraderInventory(bearer, options);
      if (data?.async || data?.running) {
        setSyncProgress({ running: true, phase: data?.summary?.phase || 'starting', processed: 0, total: 0 });
        setMessage(options.powerToolsCsv
          ? 'Importing CardTrader with Power Tools locations…'
          : 'Import started — this stays on the page while it runs.');
        startPolling();
        return;
      }
      if (data?.summary) setSyncSummary(() => data.summary);
      if (data?.incomplete || data?.destructiveSkipped) {
        setMessage(`Sync incomplete — no stock removed. ${data.error || 'Retry when CardTrader is reachable.'}`);
      } else if (data?.ok === false) {
        setError(data.error || 'CardTrader sync failed.');
      } else if (data?.summary?.needsPowerToolsReview) {
        setMessage('Sync done — review CardTrader ↔ Power Tools mismatches.');
        window.location.assign('/inventory/sync-review');
      } else {
        setMessage(`CardTrader synced. ${formatSyncSummary(data.summary)}`);
      }
      setBusy(false);
    } catch (err) {
      setError(err.message || 'Could not sync CardTrader inventory.');
      setBusy(false);
    }
  }

  const syncing = () => Boolean(syncProgress()?.running);

  function onSync() {
    if (busy() || syncing()) return;
    setPtGames(null);
    setPtPreview(null);
    setPtModalOpen(true);
  }

  async function onPreviewGames() {
    if (ptGamesLoading()) return;
    setPtGamesLoading(true);
    setError('');
    try {
      const bearer = await getBearer();
      const data = await syncCardTraderInventory(bearer, { previewGames: true });
      setPtGames(Array.isArray(data?.games) ? data.games : []);
    } catch (err) {
      setError(err.message || 'Could not read CardTrader games.');
      setPtGames([]);
    } finally {
      setPtGamesLoading(false);
    }
  }

  async function onPreviewPowerToolsSample(options = {}) {
    setPtPreviewBusy(true);
    setError('');
    try {
      const bearer = await getBearer();
      const data = await syncCardTraderInventory(bearer, { ...options, previewPowerTools: true });
      setPtPreview(() => data);
      if (data?.ok === false) {
        setError(data.error || 'Power Tools preview failed.');
        return false;
      }
      return true;
    } catch (err) {
      setError(err.message || 'Power Tools preview failed.');
      setPtPreview(null);
      return false;
    } finally {
      setPtPreviewBusy(false);
    }
  }

  const connected = () => status()?.connected === true;
  // 1-Day Ready: CardTrader stocks and sells the cards, so they are dashboard
  // assets, never Pokoin listings.
  const oneDayReady = () => connected() && (status()?.metadata?.oneDayReady === true || syncSummary()?.mode === 'one_day_ready');
  const username = () => status()?.metadata?.user?.username || status()?.metadata?.seller?.name || '';
  const appName = () => status()?.metadata?.app?.name || '';

  return (
    <div class="ct-connect">
      <Show when={loading()}><p class="page-lede">Checking CardTrader…</p></Show>
      <Show when={!loading() && connected()}>
        <p class="page-lede">
          Connected{username() ? ` as ${username()}` : ''}
          {appName() ? ` · ${appName()}` : ''}.
        </p>
        <Show when={syncSummary() && !syncing()}>
          <p class="page-lede muted">{formatSyncSummary(syncSummary())}</p>
        </Show>
        <Show when={syncing()}><SyncProgress progress={syncProgress()} /></Show>
        <div class="ct-connect-actions">
          <button type="button" class="btn btn-cardtrader" disabled={busy() || syncing()} onClick={onSync}>
            {syncing() ? 'Syncing…' : busy() ? 'Working…' : 'Sync CardTrader'}
          </button>
          {props.stripeAction}
          <Show when={oneDayReady()} fallback={<a class="btn ghost" href="/mypokoin">Open MyPokoin</a>}>
            <a class="btn ghost" href={DASHBOARD_HOME}>Open dashboard</a>
          </Show>
          <button type="button" class="btn ghost" disabled={busy() || syncing()} onClick={onDisconnect}>
            {busy() ? 'Working…' : 'Disconnect'}
          </button>
        </div>
        <Show when={showWipe()}>
          <WipeAllInventory
            disabled={busy() || syncing()}
            onError={(text) => {
              setError(text || '');
              if (text) setMessage('');
            }}
            onMessage={(text) => {
              setMessage(text || '');
              setError('');
              setSyncSummary(null);
            }}
          />
        </Show>
      </Show>
      <Show when={!loading() && !connected()}>
        <form class="ct-connect-form" onSubmit={onConnect}>
          <p class="page-lede">
            Paste your CardTrader API token to list on CardTrader from Scan and the card desk,
            and to import your existing CardTrader inventory into Pokoin.
            The token is stored encrypted and never shown again.
            {' '}
            Find yours in the{' '}
            <a href={CT_TOKEN_DOCS} target="_blank" rel="noreferrer">CardTrader API docs</a>.
          </p>
          <div class="ct-token-row">
            <label class="ct-token-field">
              <span class="sr-only">CardTrader API token</span>
              {/* Not type="password": browsers and password managers fill saved
                  site passwords into password fields and the paste lands next
                  to them. The text is masked with CSS instead. */}
              <input
                type="text"
                name="cardtrader-api-token"
                class={tokenVisible() ? '' : 'is-masked'}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                placeholder="CardTrader API token"
                value={token()}
                aria-describedby={hint() ? 'ct-token-hint' : undefined}
                onInput={(event) => {
                  setToken(event.target.value);
                  // A rejection belongs to the previous paste.
                  setError('');
                }}
              />
            </label>
            <button
              type="button"
              class="btn ghost ct-token-toggle"
              aria-pressed={String(tokenVisible())}
              disabled={!token()}
              onClick={() => setTokenVisible((visible) => !visible)}
            >
              {tokenVisible() ? 'Hide' : 'Show'}
            </button>
          </div>
          <Show when={hint()}>
            {(line) => <p id="ct-token-hint" class={`ct-token-hint is-${line().tone}`}>{line().text}</p>}
          </Show>
          <Show when={syncing()}><SyncProgress progress={syncProgress()} /></Show>
          <div class="ct-connect-actions">
            <button
              type="submit"
              class="btn btn-cardtrader"
              disabled={busy() || syncing() || pasted().token.length < MIN_CARDTRADER_TOKEN_LENGTH}
            >
              {busy() || syncing() ? 'Connecting…' : 'Connect CardTrader'}
            </button>
            {props.stripeAction}
          </div>
        </form>
      </Show>
      <Show when={message()}><p class="ct-connect-ok">{message()}</p></Show>
      <Show when={error()}><p class="ct-connect-err">{error()}</p></Show>
      <CardTraderPowerToolsModal
        open={ptModalOpen()}
        busy={busy() || syncing()}
        games={ptGames()}
        loadingGames={ptGamesLoading()}
        previewBusy={ptPreviewBusy()}
        preview={ptPreview()}
        onClose={() => {
          if (busy() || syncing() || ptPreviewBusy()) return;
          setPtModalOpen(false);
          setPtPreview(null);
        }}
        onSkipPowerTools={() => runSync({})}
        onPreviewGames={onPreviewGames}
        onPreviewSample={onPreviewPowerToolsSample}
        onConfirmWithCsv={(opts) => runSync(opts)}
      />
    </div>
  );
}
