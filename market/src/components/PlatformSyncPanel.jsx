import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getBearer } from '../auth.jsx';
import {
  connectPlatform,
  disconnectPlatform,
  fetchPlatformIntegrations,
  resyncPlatform,
} from '../api.js';
import CardTraderConnectPanel from './CardTraderConnectPanel.jsx';

const RUNNING_PHASES = new Set(['starting', 'running', 'importing', 'import', 'inventory', 'linking']);

const FIELD_HELP = {
  shopify: 'Shopify admin → Settings → Apps and sales channels → Develop apps → create an app with read_orders, read_products, write_inventory and read_locations, then paste its Admin API access token and API secret key.',
  binderpos: 'BinderPOS runs on your Shopify store: in Shopify admin → Settings → Apps and sales channels → Develop apps, create an app with read_orders, read_products, write_inventory and read_locations, then paste its Admin API access token and API secret key.',
  tcgplayer: 'TCGplayer Seller Portal → Store settings → Applications → authorize Pokoin and paste the authorization code.',
};

function accountName(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  return metadata.username || metadata.shopName || metadata.storeName || metadata.shopDomain || metadata.storeId || '';
}

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function isRunning(status) {
  return RUNNING_PHASES.has(String(status?.inventorySync?.phase || ''));
}

function headerLabel(provider) {
  const { status } = provider;
  if (status?.connected) {
    const name = accountName(status.metadata);
    return `${provider.label} · Connected${name ? ` as ${name}` : ''}`;
  }
  if (status?.state === 'pending_activation') return `${provider.label} · Waiting for activation`;
  if (!provider.available && provider.authType !== 'partner') return `${provider.label} · Not available yet`;
  return `Connect to ${provider.label}`;
}

function inventoryLine(sync) {
  if (!sync || typeof sync !== 'object') return '';
  if (sync.phase === 'failed') return `Inventory check failed${sync.error ? `: ${sync.error}` : ''}.`;
  const parts = [];
  if (Number(sync.total) > 0) parts.push(`${Number(sync.processed || 0)}/${Number(sync.total)} checked`);
  parts.push(`${Number(sync.linked || 0)} linked`);
  parts.push(`${Number(sync.imported || 0)} imported`);
  parts.push(`${Number(sync.unmatched || 0)} not matched`);
  const prefix = RUNNING_PHASES.has(String(sync.phase || '')) ? 'Checking inventory… ' : '';
  return `${prefix}${parts.join(' · ')}`;
}

function Explainer({ provider, email }) {
  return (
    <>
      <p>
        Pokoin will automatically keep your {provider.label} and Pokoin inventories up to date after each sale.
      </p>
      <p>
        Pokoin <strong>does not access any information</strong> except your recent orders and the stock
        quantities it adjusts. Passwords are never asked for or saved. We store an encrypted access token,
        used only for the sync. You can stop the sync any time from this page.
      </p>
      {provider.authType === 'partner' ? (
        <p>
          The sync <strong>will not start immediately</strong>; our staff will contact you
          {email ? <> at <strong>{email}</strong></> : null} to activate it.
        </p>
      ) : null}
    </>
  );
}

function Consents({ provider, checked, onChange, disabled }) {
  const rows = [];
  if (provider.authType === 'partner') {
    rows.push(['email', 'I will monitor my email for a message from support']);
  }
  rows.push(['stock', `I authorize Pokoin to decrease stock quantities on ${provider.label} after an order on Pokoin or another connected platform`]);
  rows.push(['privacy', null]);
  return (
    <div className="platform-consents">
      {rows.map(([key, text]) => (
        <label key={key} className="platform-consent">
          <input
            type="checkbox"
            checked={disabled ? true : Boolean(checked[key])}
            disabled={disabled}
            onChange={(event) => onChange({ ...checked, [key]: event.target.checked })}
          />
          <span>
            {text || (
              <>I have read and accept the <Link to="/privacy">Privacy Policy</Link> and the <Link to="/terms">Terms of Service</Link></>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

function requiredConsents(provider) {
  return provider.authType === 'partner' ? ['email', 'stock', 'privacy'] : ['stock', 'privacy'];
}

function ConnectForm({ provider, email, onDone }) {
  const [values, setValues] = useState({});
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const consentsOk = requiredConsents(provider).every((key) => checked[key]);
  const fieldsOk = (provider.fields || []).every((field) => !field.required || String(values[field.name] || '').trim());
  const canSubmit = consentsOk && fieldsOk && !busy;
  const submitLabel = provider.authType === 'oauth_redirect'
    ? `Log in to ${provider.label}`
    : provider.authType === 'partner' ? 'Request sync' : 'Connect';

  async function onSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const bearer = await getBearer();
      const result = await connectPlatform(bearer, provider.id, values);
      if (result?.redirectUrl) {
        window.location.assign(result.redirectUrl);
        return;
      }
      onDone(result?.status || null);
    } catch (err) {
      setError(err?.message || `${provider.label} connection failed.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="platform-form" onSubmit={onSubmit}>
      <fieldset>
        <legend>Log in to {provider.label}</legend>
        {provider.authType === 'oauth_redirect' ? (
          <p className="platform-help">
            You will log in on {provider.label} itself; Pokoin never sees your password.
          </p>
        ) : null}
        {FIELD_HELP[provider.id] ? <p className="platform-help">{FIELD_HELP[provider.id]}</p> : null}
        {(provider.fields || []).map((field) => (
          <label key={field.name} className="platform-field">
            <span>{field.label}</span>
            <input
              type={field.type === 'password' ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={field.placeholder || ''}
              required={field.required}
              value={values[field.name] || ''}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          </label>
        ))}
        <Consents provider={provider} checked={checked} onChange={setChecked} />
        <div className="platform-actions">
          <button type="submit" className="btn" disabled={!canSubmit}>
            {busy ? 'Connecting…' : submitLabel}
          </button>
        </div>
        {error ? <p className="ct-connect-err" role="alert">{error}</p> : null}
      </fieldset>
    </form>
  );
}

function ConnectedBody({ provider, onStatus }) {
  const { status } = provider;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function onRevoke() {
    if (!window.confirm(`Stop syncing ${provider.label}? Your Pokoin listings stay as they are.`)) return;
    setBusy('revoke');
    setError('');
    try {
      const bearer = await getBearer();
      const result = await disconnectPlatform(bearer, provider.id);
      onStatus(result?.status || null);
    } catch (err) {
      setError(err?.message || 'Could not stop the sync.');
    } finally {
      setBusy('');
    }
  }

  async function onResync() {
    setBusy('resync');
    setError('');
    setNotice('');
    try {
      const bearer = await getBearer();
      const result = await resyncPlatform(bearer, provider.id);
      setNotice(result?.alreadyRunning ? 'An inventory check is already running.' : 'Inventory check started.');
      onStatus(null, { refresh: true });
    } catch (err) {
      setError(err?.message || 'Could not start the inventory check.');
    } finally {
      setBusy('');
    }
  }

  const webhook = status?.webhook;
  return (
    <div className="platform-connected">
      <dl className="platform-facts">
        <div><dt>Account</dt><dd>{accountName(status?.metadata) || '—'}</dd></div>
        <div><dt>Connected since</dt><dd>{formatWhen(status?.connectedAt)}</dd></div>
        <div><dt>Last order check</dt><dd>{formatWhen(status?.lastPolledAt)}</dd></div>
        {webhook ? (
          <div>
            <dt>Live updates</dt>
            <dd>{webhook.ok ? 'On' : `Off — ${webhook.error || 'registration failed'} (orders are still checked every 5 minutes)`}</dd>
          </div>
        ) : null}
        {status?.inventorySync ? (
          <div><dt>Inventory</dt><dd>{inventoryLine(status.inventorySync)}</dd></div>
        ) : null}
      </dl>
      <Consents provider={provider} checked={{}} onChange={() => {}} disabled />
      <div className="platform-actions">
        {status?.connected && provider.capabilities?.import !== false ? (
          <button type="button" className="btn ghost" onClick={onResync} disabled={Boolean(busy) || isRunning(status)}>
            {busy === 'resync' ? 'Starting…' : 'Re-sync inventory'}
          </button>
        ) : null}
        <button type="button" className="btn btn-revoke" onClick={onRevoke} disabled={Boolean(busy)}>
          {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
        </button>
      </div>
      {notice ? <p className="ct-connect-ok" role="status">{notice}</p> : null}
      {error ? <p className="ct-connect-err" role="alert">{error}</p> : null}
    </div>
  );
}

function readReturnParams() {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return {
    platform: params.get('platform') || '',
    connected: params.get('connected') === '1',
    error: params.get('error') || '',
  };
}

function clearReturnParams() {
  try {
    const url = new URL(window.location.href);
    ['platform', 'connected', 'error'].forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (_) {
    /* keep the query string rather than break the page */
  }
}

/**
 * Profile → "Sync with other platforms": one accordion row per platform, like
 * CardTrader's own page. CardTrader keeps its existing panel; every other
 * platform talks to /api/platform-integrations (docs/PLATFORM_SYNC.md).
 */
export default function PlatformSyncPanel() {
  const returned = useMemo(readReturnParams, []);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(returned.platform || '');
  const [flash, setFlash] = useState(() => {
    if (!returned.platform) return null;
    if (returned.connected) return { id: returned.platform, tone: 'ok', text: 'Connected. Pokoin is checking your inventory now.' };
    if (returned.error) return { id: returned.platform, tone: 'err', text: `Login did not complete (${returned.error}). Try again.` };
    return null;
  });

  const load = useCallback(async () => {
    try {
      const bearer = await getBearer();
      const result = await fetchPlatformIntegrations(bearer);
      setData(result);
      setLoadError('');
    } catch (err) {
      setLoadError(err?.message || 'Could not load your connected platforms.');
    }
  }, []);

  useEffect(() => {
    load();
    if (returned.platform) clearReturnParams();
  }, [load, returned.platform]);

  const anyRunning = (data?.providers || []).some((provider) => isRunning(provider.status));
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  function setStatus(id, status, { refresh = false } = {}) {
    if (status) {
      setData((prev) => prev && ({
        ...prev,
        providers: prev.providers.map((row) => (row.id === id ? { ...row, status } : row)),
      }));
    }
    if (refresh || !status) load();
  }

  function toggle(id) {
    setOpen((current) => (current === id ? '' : id));
  }

  const rows = data?.providers || [];
  return (
    <div className="platform-sync">
      <p className="platform-lede">
        Selling somewhere else too? Connect it to Pokoin and we keep your stock in sync in real time —
        no split inventory, and the same card is never sold twice.
      </p>
      {loadError ? <p className="ct-connect-err" role="alert">{loadError}</p> : null}
      <ul className="platform-list">
        <li className="platform-row">
          <button
            type="button"
            className="platform-head"
            aria-expanded={open === 'cardtrader'}
            onClick={() => toggle('cardtrader')}
          >
            CardTrader
          </button>
          {open === 'cardtrader' ? (
            <div className="platform-body">
              <CardTraderConnectPanel showWipe={false} />
            </div>
          ) : null}
        </li>
        {!data && !loadError ? <li className="platform-row platform-wait">Loading platforms…</li> : null}
        {rows.map((provider) => {
          const status = provider.status || {};
          const linked = status.connected || status.state === 'pending_activation';
          const unavailable = !provider.available && provider.authType !== 'partner';
          return (
            <li key={provider.id} className={`platform-row${status.connected ? ' is-connected' : ''}`}>
              <button
                type="button"
                className="platform-head"
                aria-expanded={open === provider.id}
                onClick={() => toggle(provider.id)}
              >
                {headerLabel(provider)}
              </button>
              {open === provider.id ? (
                <div className="platform-body">
                  {flash?.id === provider.id ? (
                    <p className={flash.tone === 'ok' ? 'ct-connect-ok' : 'ct-connect-err'} role="status">{flash.text}</p>
                  ) : null}
                  <Explainer provider={provider} email={data?.email} />
                  {linked ? (
                    <ConnectedBody
                      provider={provider}
                      onStatus={(next, options) => {
                        setFlash(null);
                        setStatus(provider.id, next, options);
                      }}
                    />
                  ) : unavailable ? (
                    <p className="platform-help">This integration is not available yet.</p>
                  ) : (
                    <ConnectForm
                      provider={provider}
                      email={data?.email}
                      onDone={(next) => {
                        setFlash(null);
                        setStatus(provider.id, next, { refresh: true });
                      }}
                    />
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
