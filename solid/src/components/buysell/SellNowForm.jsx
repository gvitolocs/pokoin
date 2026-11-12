import { createSignal, Show } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { errorMessage, sellIntoBuyOrder } from '@market/buy-orders.js';
import { formatPkn } from '@market/pkn.js';
import { authFrom } from '@market/punchouts.js';
import { useGameNavigate } from '../../lib/game-navigate.js';
import { getBearer, signedIn } from '../../stores/auth.js';
import AppLink from '../AppLink.jsx';

/**
 * "Sell now" on a buy offer: asks how many copies, says what happens, then lists
 * the seller's card at the offer price. props.order = { id, price_pkn, remaining };
 * props.onDone(result) runs after a successful sale so the caller can refetch.
 * props.preview skips sign-in and the API call (layout preview).
 * Optional: props.priceLabel (the price in the visitor's unit, else PKN),
 * props.buyerLabel ("Pokoin" for the starting offer, else "the buyer"), and
 * props.sell(quantity, token) for an offer that is not an order row.
 */
export default function SellNowForm(props) {
  const navigate = useGameNavigate();
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  const [qty, setQty] = createSignal('1');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [done, setDone] = createSignal(false);
  const remaining = () => Math.max(1, Number(props.order?.remaining) || 1);
  const price = () => props.priceLabel || formatPkn(props.order?.price_pkn);
  const buyer = () => props.buyerLabel || 'the buyer';
  const buyerSentence = () => `${buyer().charAt(0).toUpperCase()}${buyer().slice(1)}`;

  function toSignIn() {
    navigate(authFrom(props.fromPath || `${location.pathname}${location.search}` || '/marketplace'));
  }

  function begin() {
    if (!props.preview && !signedIn()) {
      toSignIn();
      return;
    }
    setError('');
    setDone(false);
    setOpen(true);
  }

  async function submit() {
    const quantity = Number(qty());
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > remaining()) {
      setError(`Choose 1 to ${remaining()} copies.`);
      return;
    }
    if (props.preview) {
      setDone(true);
      setOpen(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      if (!token) {
        toSignIn();
        return;
      }
      const result = props.sell
        ? await props.sell(quantity, token)
        : await sellIntoBuyOrder(props.order.id, quantity, token);
      setDone(true);
      setOpen(false);
      props.onDone?.(result);
    } catch (err) {
      if (err.status === 401) {
        toSignIn();
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="sell-now">
      <Show when={!open() && !done()}>
        <button type="button" class="btn ghost sell-now-btn" onClick={begin}>Sell now</button>
      </Show>
      <Show when={open()}>
        <div class="sell-now-form">
          <label class="sell-field qty">
            Copies (1 to {remaining()})
            <input inputmode="numeric" value={qty()} onInput={(event) => setQty(event.currentTarget.value)} />
          </label>
          <p class="sell-now-note">
            This lists your card at {price()} and tells {buyer()}. You are paid when they buy it.
          </p>
          <div class="sell-now-actions">
            <button type="button" class="btn" disabled={busy()} onClick={submit}>
              {busy() ? 'Listing…' : `List at ${price()}`}
            </button>
            <button type="button" class="btn ghost" disabled={busy()} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      </Show>
      <Show when={done()}>
        <p class="sell-msg ok">
          Listed at {price()}. {buyerSentence()} has been told.
          {' '}
          <AppLink to="/mypokoin">See your listings</AppLink>
        </p>
      </Show>
      <Show when={error()}><p class="sell-msg error">{error()}</p></Show>
    </div>
  );
}
