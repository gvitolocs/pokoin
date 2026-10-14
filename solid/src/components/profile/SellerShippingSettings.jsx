import { createSignal, For, onSettled, Show } from 'solid-js';
import {
  fetchSellerSettings,
  fetchStripeConnectStatus,
  saveSellerSettings,
  startStripeConnectOnboard,
} from '@market/api.js';
import { SHIP_FROM_COUNTRIES, shipFromCountryOptionLabel } from '@market/ship-countries.js';
import { friendlyStripeError, stripeDashboardUrlForError } from '@market/stripe-connect.js';
import { getBearer, signedIn } from '../../stores/auth.js';

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

/**
 * Brand purple Connect button — the Stripe row of the Profile seller setup
 * (market/src/components/SellerShippingSettings.jsx). Mounted only for a
 * signed-in seller (the Profile gate).
 */
export function StripeConnectButton(props) {
  const [connect, setConnect] = createSignal({ stripeConnectStatus: 'not_started', ready: false });
  const [busy, setBusy] = createSignal(false);

  onSettled(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const status = await fetchStripeConnectStatus(token);
        if (cancelled) return;
        setConnect(() => status);
        props.onStatus?.(status);
      } catch (_) {
        /* status is best-effort */
        if (!cancelled) props.onStatus?.({ stripeConnectStatus: 'not_started', ready: false });
      }
    })();
    return () => { cancelled = true; };
  });

  async function connectStripe() {
    const tab = reserveStripeTab();
    setBusy(true);
    props.onError?.('');
    try {
      const token = await getBearer();
      if (!props.shipFromCountry) throw new Error('Choose ship-from country before Stripe Connect.');
      const saved = await saveSellerSettings({ shipFromCountry: props.shipFromCountry }, token);
      props.onCountrySaved?.(saved.shipFromCountry || props.shipFromCountry);
      const data = await startStripeConnectOnboard({}, token);
      if (!data.url) throw new Error('Stripe did not return an onboarding URL.');
      tab.go(data.url);
      setBusy(false);
    } catch (err) {
      props.onError?.(friendlyStripeError(err.message));
      const dashboardUrl = stripeDashboardUrlForError(err.message, err.body);
      if (dashboardUrl) tab.go(dashboardUrl);
      else tab.close();
      setBusy(false);
    }
  }

  const label = () => (connect().ready
    ? 'Update Stripe'
    : connect().stripeConnectStatus && connect().stripeConnectStatus !== 'not_started'
      ? 'Continue Stripe'
      : 'Connect Stripe');

  return (
    <Show when={signedIn()}>
      <button
        type="button"
        class={['btn', 'btn-stripe', props.class]}
        disabled={busy() || props.disabled}
        onClick={connectStripe}
        title={connect().ready ? 'Stripe Connect ready' : `Stripe Connect: ${connect().stripeConnectStatus || 'not_started'}`}
      >
        {busy() ? 'Opening…' : label()}
      </button>
    </Show>
  );
}

/**
 * Ship-from country for the Profile seller setup. Loads the saved (or
 * IP-detected) country and saves on change — no separate Save button.
 */
export function ShipFromCountrySelect(props) {
  const [source, setSource] = createSignal('');
  const [state, setState] = createSignal('idle');

  onSettled(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const settings = await fetchSellerSettings(token);
        if (cancelled) return;
        setSource(settings.shipFromCountrySource || '');
        props.onLoaded?.(settings.shipFromCountry || '');
      } catch (err) {
        if (cancelled) return;
        props.onLoaded?.('');
        props.onError?.(err.message || 'Could not load seller settings.');
      }
    })();
    return () => { cancelled = true; };
  });

  async function save(next) {
    const prev = props.value || '';
    props.onChange?.(next);
    if (!next) return;
    setState('saving');
    props.onError?.('');
    try {
      const token = await getBearer();
      const data = await saveSellerSettings({ shipFromCountry: next }, token);
      props.onChange?.(data.shipFromCountry || next);
      setSource(data.shipFromCountrySource || 'user');
      setState('saved');
    } catch (err) {
      props.onChange?.(prev);
      setState('idle');
      props.onError?.(err.message || 'Could not save country.');
    }
  }

  const note = () => (state() === 'saving'
    ? 'Saving…'
    : state() === 'saved'
      ? 'Saved.'
      : source() === 'ip' && props.value
        ? 'Detected from your connection.'
        : '');

  return (
    <span class="ship-from-select">
      <label class="sr-only" for="ship-from-country">Ship-from country</label>
      <select id="ship-from-country" value={props.value || ''} disabled={state() === 'saving'} onChange={(event) => save(event.target.value)}>
        <option value="">Select country</option>
        <For each={SHIP_FROM_COUNTRIES}>{(row) => <option value={row.code}>{shipFromCountryOptionLabel(row.code)}</option>}</For>
      </select>
      <Show when={note()}><span class="ship-from-note" role="status">{note()}</span></Show>
    </span>
  );
}

/**
 * "Get paid in PKN" switch for the Profile seller setup. Off = card payments
 * only (Stripe, EUR) and listing forms default to local currency.
 */
export function PknPayoutToggle(props) {
  const [busy, setBusy] = createSignal(false);
  const loading = () => props.acceptsPkn == null;

  async function flip() {
    const next = !props.acceptsPkn;
    setBusy(true);
    props.onError?.('');
    props.onChange?.({ acceptsPkn: next });
    try {
      const token = await getBearer();
      const saved = await saveSellerSettings({ acceptsPkn: next }, token);
      props.onChange?.(saved);
    } catch (err) {
      props.onChange?.({ acceptsPkn: !next });
      props.onError?.(err.message || 'Could not save your PKN payment choice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={String(Boolean(props.acceptsPkn))}
      aria-label="Get paid in PKN"
      class={['setup-switch', { 'is-on': Boolean(props.acceptsPkn) }]}
      disabled={busy() || loading()}
      onClick={flip}
    >
      <span class="setup-switch-track" aria-hidden="true"><span class="setup-switch-thumb" /></span>
      <span class="setup-switch-label">{loading() ? '…' : props.acceptsPkn ? 'On' : 'Off'}</span>
    </button>
  );
}
