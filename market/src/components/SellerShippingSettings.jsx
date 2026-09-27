import { useEffect, useState } from 'react';
import {
  fetchSellerSettings,
  fetchStripeConnectStatus,
  saveSellerSettings,
  startStripeConnectOnboard,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, DeskPanel } from './Desk.jsx';

const COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];

export default function SellerShippingSettings() {
  const { getBearer, signedIn } = useAuth();
  const [shipFromCountry, setShipFromCountry] = useState('');
  const [connect, setConnect] = useState({ stripeConnectStatus: 'not_started', ready: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

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
        setShipFromCountry(settings.shipFromCountry || '');
        setConnect(status);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load seller settings.');
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  if (!signedIn) return null;

  async function saveCountry(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await getBearer();
      const data = await saveSellerSettings({ shipFromCountry }, token);
      setShipFromCountry(data.shipFromCountry || '');
      setMessage('Shipping country saved.');
    } catch (err) {
      setError(err.message || 'Could not save country.');
    } finally {
      setBusy(false);
    }
  }

  async function connectStripe() {
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      if (!shipFromCountry) {
        throw new Error('Choose ship-from country before Stripe Connect.');
      }
      await saveSellerSettings({ shipFromCountry }, token);
      const data = await startStripeConnectOnboard({}, token);
      if (!data.url) throw new Error('Stripe did not return an onboarding URL.');
      window.location.assign(data.url);
    } catch (err) {
      setError(err.message || 'Connect failed.');
      setBusy(false);
    }
  }

  return (
    <DeskPanel title="Seller shipping & payouts">
      <Alert>{error}</Alert>
      {message ? <p className="desk-ok">{message}</p> : null}
      <form className="sell-form" onSubmit={saveCountry}>
        <label className="sell-field">
          Ship from country
          <select
            value={shipFromCountry}
            onChange={(event) => setShipFromCountry(event.target.value)}
            required
          >
            <option value="">Select country</option>
            {COUNTRIES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <p className="page-lede">
          Required before your first physical listing. EU is not valid — pick a real country.
        </p>
        <button className="btn" type="submit" disabled={busy || !shipFromCountry}>
          {busy ? 'Saving…' : 'Save country'}
        </button>
      </form>
      <p className="page-lede" style={{ marginTop: '1rem' }}>
        Stripe Connect: <strong>{connect.stripeConnectStatus || 'not_started'}</strong>
        {connect.ready ? ' (READY)' : ''}
      </p>
      <button className="btn ghost" type="button" disabled={busy} onClick={connectStripe}>
        {connect.ready ? 'Update Stripe Connect' : 'Connect Stripe to sell in EUR'}
      </button>
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
          Choose the country you mail cards from. You can change it later in Profile.
        </p>
        <Alert>{error}</Alert>
        <label className="sell-field">
          Country
          <select value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">Select country</option>
            {COUNTRIES.map((code) => (
              <option key={code} value={code}>{code}</option>
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
