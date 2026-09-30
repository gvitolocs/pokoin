import { useEffect, useState } from 'react';
import {
  fetchSellerSettings,
  fetchStripeConnectStatus,
  saveSellerSettings,
  startStripeConnectOnboard,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { SHIP_FROM_COUNTRIES, shipFromCountryOptionLabel } from '../ship-countries.js';
import { Alert } from './Desk.jsx';
import { friendlyStripeError, stripeDashboardUrlForError } from '../stripe-connect.js';

/**
 * Opens a blank tab inside the click so the browser does not block it as a
 * popup once the onboarding request comes back; `go` points it at Stripe,
 * `close` drops it. Without a tab (blocked anyway) `go` navigates this one.
 */
function reserveStripeTab() {
  let win = null;
  try {
    win = window.open('', '_blank');
    if (win) win.opener = null;
  } catch (_) {
    win = null;
  }
  return {
    go(url) {
      if (!url) return;
      if (win && !win.closed) win.location.href = url;
      else window.location.assign(url);
    },
    close() {
      if (win && !win.closed) win.close();
    },
  };
}

/** Brand purple Connect button — the Stripe row of the Profile seller setup. */
export function StripeConnectButton({ className = '', disabled = false, shipFromCountry = '', onCountrySaved, onError, onStatus }) {
  const { getBearer, signedIn } = useAuth();
  const [connect, setConnect] = useState({ stripeConnectStatus: 'not_started', ready: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const status = await fetchStripeConnectStatus(token);
        if (cancelled) return;
        setConnect(status);
        onStatus?.(status);
      } catch (_) {
        /* status is best-effort */
        if (!cancelled) onStatus?.({ stripeConnectStatus: 'not_started', ready: false });
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  if (!signedIn) return null;

  async function connectStripe() {
    const tab = reserveStripeTab();
    setBusy(true);
    onError?.('');
    try {
      const token = await getBearer();
      if (!shipFromCountry) {
        throw new Error('Choose ship-from country before Stripe Connect.');
      }
      const saved = await saveSellerSettings({ shipFromCountry }, token);
      onCountrySaved?.(saved.shipFromCountry || shipFromCountry);
      const data = await startStripeConnectOnboard({}, token);
      if (!data.url) throw new Error('Stripe did not return an onboarding URL.');
      tab.go(data.url);
      setBusy(false);
    } catch (err) {
      onError?.(friendlyStripeError(err.message));
      const dashboardUrl = stripeDashboardUrlForError(err.message, err.body);
      if (dashboardUrl) tab.go(dashboardUrl);
      else tab.close();
      setBusy(false);
    }
  }

  const label = connect.ready
    ? 'Update Stripe'
    : connect.stripeConnectStatus && connect.stripeConnectStatus !== 'not_started'
      ? 'Continue Stripe'
      : 'Connect Stripe';

  return (
    <button
      type="button"
      className={`btn btn-stripe ${className}`.trim()}
      disabled={busy || disabled}
      onClick={connectStripe}
      title={connect.ready ? 'Stripe Connect ready' : `Stripe Connect: ${connect.stripeConnectStatus || 'not_started'}`}
    >
      {busy ? 'Opening…' : label}
    </button>
  );
}

/**
 * Ship-from country for the Profile seller setup. Loads the saved (or
 * IP-detected) country and saves on change — no separate Save button.
 */
export function ShipFromCountrySelect({ value, onChange, onLoaded, onError }) {
  const { getBearer, signedIn } = useAuth();
  const [source, setSource] = useState('');
  const [state, setState] = useState('idle');

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const settings = await fetchSellerSettings(token);
        if (cancelled) return;
        setSource(settings.shipFromCountrySource || '');
        onLoaded?.(settings.shipFromCountry || '');
      } catch (err) {
        if (cancelled) return;
        onLoaded?.('');
        onError?.(err.message || 'Could not load seller settings.');
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  async function save(next) {
    const prev = value || '';
    onChange?.(next);
    if (!next) return;
    setState('saving');
    onError?.('');
    try {
      const token = await getBearer();
      const data = await saveSellerSettings({ shipFromCountry: next }, token);
      onChange?.(data.shipFromCountry || next);
      setSource(data.shipFromCountrySource || 'user');
      setState('saved');
    } catch (err) {
      onChange?.(prev);
      setState('idle');
      onError?.(err.message || 'Could not save country.');
    }
  }

  const note = state === 'saving'
    ? 'Saving…'
    : state === 'saved'
      ? 'Saved.'
      : source === 'ip' && value
        ? 'Detected from your connection.'
        : '';

  return (
    <span className="ship-from-select">
      <label className="sr-only" htmlFor="ship-from-country">Ship-from country</label>
      <select
        id="ship-from-country"
        value={value || ''}
        disabled={state === 'saving'}
        onChange={(event) => save(event.target.value)}
      >
        <option value="">Select country</option>
        {SHIP_FROM_COUNTRIES.map((row) => (
          <option key={row.code} value={row.code}>
            {shipFromCountryOptionLabel(row.code)}
          </option>
        ))}
      </select>
      {note ? <span className="ship-from-note" role="status">{note}</span> : null}
    </span>
  );
}

export function ShipFromCountryGate({ open, value, onChange, onSave, onClose, busy, error }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Ship from country">
      <div className="modal-card desk-panel">
        <h2>Where do you ship from?</h2>
        <p className="page-lede">
          We could not detect your country from this connection. Choose the country you mail cards from — required before selling. You can change it later in Profile.
        </p>
        <Alert>{error}</Alert>
        <label className="sell-field">
          Country
          <select value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">Select country</option>
            {SHIP_FROM_COUNTRIES.map((row) => (
              <option key={row.code} value={row.code}>
                {shipFromCountryOptionLabel(row.code)}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button className="btn" type="button" disabled={busy || !value} onClick={onSave}>
            {busy ? 'Saving…' : 'Save and continue'}
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * "Get paid in PKN" switch for the Profile seller setup. Off = card payments
 * only (Stripe, EUR) and listing forms default to local currency.
 */
export function PknPayoutToggle({ acceptsPkn, onChange, onError }) {
  const { getBearer } = useAuth();
  const [busy, setBusy] = useState(false);
  const loading = acceptsPkn == null;

  async function flip() {
    const next = !acceptsPkn;
    setBusy(true);
    onError?.('');
    onChange?.({ acceptsPkn: next });
    try {
      const token = await getBearer();
      const saved = await saveSellerSettings({ acceptsPkn: next }, token);
      onChange?.(saved);
    } catch (err) {
      onChange?.({ acceptsPkn: !next });
      onError?.(err.message || 'Could not save your PKN payment choice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(acceptsPkn)}
      aria-label="Get paid in PKN"
      className={`setup-switch${acceptsPkn ? ' is-on' : ''}`}
      disabled={busy || loading}
      onClick={flip}
    >
      <span className="setup-switch-track" aria-hidden="true"><span className="setup-switch-thumb" /></span>
      <span className="setup-switch-label">{loading ? '…' : acceptsPkn ? 'On' : 'Off'}</span>
    </button>
  );
}
