import { useEffect, useState } from 'react';
import {
  fetchSellerSettings,
  fetchStripeConnectStatus,
  saveSellerSettings,
  startStripeConnectOnboard,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { SHIP_FROM_COUNTRIES, shipFromCountryOptionLabel } from '../ship-countries.js';
import { Alert, DeskPanel } from './Desk.jsx';

function friendlyStripeError(message) {
  const text = String(message || '');
  if (/signed up for Connect/i.test(text)) {
    return 'Stripe Connect is not enabled on the Pokoin platform account yet. Finish Connect setup in the Stripe Dashboard (Connect → Get started), then try again.';
  }
  return text || 'Connect failed.';
}

/** Brand purple Connect button — sits next to CardTrader actions on Profile. */
export function StripeConnectButton({ className = '', shipFromCountry = '', onCountrySaved, onError }) {
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
        if (!cancelled) setConnect(status);
      } catch (_) {
        /* status is best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  if (!signedIn) return null;

  async function connectStripe() {
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
      window.location.assign(data.url);
    } catch (err) {
      onError?.(friendlyStripeError(err.message));
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
      disabled={busy}
      onClick={connectStripe}
      title={connect.ready ? 'Stripe Connect ready' : `Stripe Connect: ${connect.stripeConnectStatus || 'not_started'}`}
    >
      {busy ? 'Opening…' : label}
    </button>
  );
}

export default function SellerShippingSettings({
  shipFromCountry: controlledCountry,
  onCountryChange,
  stripeError,
  onStripeError,
  hideStripeButton = false,
}) {
  const { getBearer, signedIn } = useAuth();
  const [shipFromCountry, setShipFromCountry] = useState(controlledCountry || '');
  const [countrySource, setCountrySource] = useState('');
  const [connect, setConnect] = useState({ stripeConnectStatus: 'not_started', ready: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (controlledCountry != null) setShipFromCountry(controlledCountry);
  }, [controlledCountry]);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const [settings, status] = await Promise.all([
          fetchSellerSettings(token),
          fetchStripeConnectStatus(token),
        ]);
        if (cancelled) return;
        const next = settings.shipFromCountry || '';
        setShipFromCountry(next);
        setCountrySource(settings.shipFromCountrySource || '');
        onCountryChange?.(next);
        setConnect(status);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load seller settings.');
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  if (!signedIn) return null;

  function setCountry(next) {
    setShipFromCountry(next);
    setCountrySource('user');
    onCountryChange?.(next);
  }

  async function saveCountry(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    onStripeError?.('');
    try {
      const token = await getBearer();
      const data = await saveSellerSettings({ shipFromCountry }, token);
      const next = data.shipFromCountry || '';
      setShipFromCountry(next);
      setCountrySource(data.shipFromCountrySource || 'user');
      onCountryChange?.(next);
      setMessage('Shipping country saved.');
    } catch (err) {
      setError(err.message || 'Could not save country.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DeskPanel title="Seller shipping & payouts" className="profile-shipping">
      <Alert>{error || stripeError}</Alert>
      {message ? <p className="desk-ok">{message}</p> : null}
      <form className="sell-form" onSubmit={saveCountry}>
        <label className="sell-field">
          Ship from country
          <select
            value={shipFromCountry}
            onChange={(event) => setCountry(event.target.value)}
            required
          >
            <option value="">Select country</option>
            {SHIP_FROM_COUNTRIES.map((row) => (
              <option key={row.code} value={row.code}>
                {shipFromCountryOptionLabel(row.code)}
              </option>
            ))}
          </select>
        </label>
        <p className="page-lede">
          {countrySource === 'ip' && shipFromCountry
            ? 'Detected from your connection — change it anytime before you sell.'
            : shipFromCountry
              ? 'Used on your listings and for EUR shipping rates. Change anytime.'
              : 'Required before your first physical listing. We try your IP country first; if that is missing, set it here.'}
        </p>
        <button className="btn" type="submit" disabled={busy || !shipFromCountry}>
          {busy ? 'Saving…' : 'Save country'}
        </button>
      </form>
      <p className="page-lede" style={{ marginTop: '1rem' }}>
        Stripe Connect: <strong>{connect.stripeConnectStatus || 'not_started'}</strong>
        {connect.ready ? ' (READY)' : ''}
      </p>
      {hideStripeButton ? null : (
        <StripeConnectButton
          shipFromCountry={shipFromCountry}
          onCountrySaved={(code) => {
            setShipFromCountry(code);
            onCountryChange?.(code);
          }}
          onError={(msg) => {
            setError(msg);
            onStripeError?.(msg);
          }}
        />
      )}
    </DeskPanel>
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
