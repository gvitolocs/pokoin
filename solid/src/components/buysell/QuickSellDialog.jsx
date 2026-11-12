import { createSignal, onSettled, Show } from 'solid-js';
import { Portal } from '@solidjs/web';
import {
  BUYER_MESSAGE_MAX,
  buyerMessageError,
  buyerMessageLength,
  errorMessage,
  offerPriceLabel,
  sellIntoBuyOrder,
  sellToHouse,
  storedOfferUnit,
} from '@market/buy-orders.js';
import { formatPkn } from '@market/pkn.js';
import { authFrom } from '@market/punchouts.js';
import { useGameNavigate } from '../../lib/game-navigate.js';
import { getBearer, signedIn } from '../../stores/auth.js';
import { buyerCurrency } from '../../stores/buyer.js';
import AppLink from '../AppLink.jsx';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const SHEET_QUERY = '(max-width: 720px)';
let titleSeq = 0;

/**
 * Quick Sell: the whole sell path, in its own dialog, opened from every Sell
 * action — a Buy offers row, Pokoin's starting offer, the "Have this card?"
 * strip and the BuySell board. It sells into one exact target (`sellTarget(row)`
 * in lib/buy-book.js), so nothing here waits for a chip to move, and the Define
 * offer popup stays on the buyer's side of the trade.
 * A listing is not a sale: the buyer is told, and pays only if they buy it.
 * props.target is { house, orderId, remaining, pricePkn, condition, language,
 * reverse, firstEdition }; props.card is { name, imageUrl, set, number };
 * props.buyerName only when the caller knows one (the book names nobody).
 * props.onDone runs after a sale, and after a 409 that says the offer moved, so
 * the caller's book or board is fresh again.
 */
export default function QuickSellDialog(props) {
  const navigate = useGameNavigate();
  const [qty, setQty] = createSignal(1);
  const [note, setNote] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [done, setDone] = createSignal(false);
  const [titleId] = createSignal(`quick-sell-title-${(titleSeq += 1)}`);

  let box;

  const target = () => props.target || {};
  const house = () => Boolean(target().house);
  const remaining = () => Math.max(1, Number(target().remaining) || 1);
  const pricePkn = () => Number(target().pricePkn) || 0;
  // The price is shown in the unit the visitor already picked for offers, so the
  // dialog and the Define offer popup never say two different amounts.
  const unit = () => storedOfferUnit(buyerCurrency(props.pinned));
  const price = () => offerPriceLabel(pricePkn(), unit());
  const pknLine = () => (unit() === 'PKN' ? '' : formatPkn(pricePkn()));
  const facets = () => [
    target().condition,
    target().language,
    target().reverse ? 'Reverse' : '',
    target().firstEdition ? '1st Ed.' : '',
  ].filter(Boolean).join(' · ');
  const who = () => (house() ? '' : String(props.buyerName || '').trim() || 'A buyer');
  const count = () => buyerMessageLength(note());
  const noteBad = () => buyerMessageError(note());
  const blocked = () => busy() || Boolean(noteBad());

  function close() {
    if (busy()) return;
    props.onClose?.();
  }

  function toSignIn() {
    navigate(authFrom(props.fromPath || '/marketplace'));
  }

  function step(delta) {
    setQty((value) => Math.min(remaining(), Math.max(1, value + delta)));
  }

  async function submit() {
    if (blocked()) return;
    if (props.preview) {
      setDone(true);
      props.onDone?.();
      return;
    }
    if (!signedIn()) {
      toSignIn();
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
      const text = note();
      const result = house()
        ? await sellToHouse({
          cardId: props.cardId,
          condition: target().condition,
          language: target().language,
          reverse: target().reverse,
          firstEdition: target().firstEdition,
          quantity: qty(),
          card: props.card,
          buyerMessage: text,
        }, token)
        : await sellIntoBuyOrder(target().orderId, qty(), token, text);
      setDone(true);
      props.onDone?.(result);
    } catch (err) {
      if (err.status === 401) {
        toSignIn();
        return;
      }
      setError(errorMessage(err));
      // A 409 means the copies or the price moved under this dialog: the form
      // stays open with the sentence, and the caller reloads so the limit is fresh.
      if (err.status === 409) props.onDone?.();
    } finally {
      setBusy(false);
    }
  }

  onSettled(() => {
    const trigger = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => box?.focus());
    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (busy()) return;
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !box) return;
      const items = [...box.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const here = items.indexOf(document.activeElement);
      // -1 is the container itself, which is where focus lands on open.
      if (event.shiftKey && here <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && here === items.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointer = (event) => {
      if (busy() || box?.contains(event.target)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
      document.body.style.overflow = overflow;
      // Back to the Sell button that opened this, except on a phone, where the
      // sheet covered it and the visitor has already moved on.
      if (!window.matchMedia?.(SHEET_QUERY).matches) trigger?.focus?.();
    };
  });

  return (
    <Portal mount={document.body}>
      <div class="qs-scrim" aria-hidden="true" />
      <div
        ref={box}
        class="qs-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId()}
        tabindex="-1"
      >
        <div class="qs-head">
          <h3 id={titleId()} class="qs-title">Sell this card</h3>
          <button type="button" class="qs-close" aria-label="Close" disabled={busy()} onClick={close}>×</button>
        </div>
        <div class="qs-card">
          <Show when={props.card?.imageUrl}>
            <img class="qs-art" src={props.card.imageUrl} alt="" width="48" height="67" draggable="false" />
          </Show>
          <span class="qs-card-lines">
            <strong class="qs-card-name">{props.card?.name || 'Card'}</strong>
            <Show when={props.card?.set || props.card?.number}>
              <span class="qs-card-set">{[props.card.set, props.card.number ? `#${props.card.number}` : ''].filter(Boolean).join(' · ')}</span>
            </Show>
            <span class="qs-card-facets">{facets()}</span>
          </span>
        </div>
        <Show when={!done()}>
          <div class="qs-offer">
            <span class="qs-offer-what">
              <span class="qs-label">{house() ? "Pokoin's offer" : 'Buyer offer'}</span>
              <Show when={who()}>
                <span class="qs-offer-who">{who()}</span>
              </Show>
            </span>
            <span class="qs-offer-price">
              <strong>{price()}</strong>
              <Show when={pknLine()}>
                <span class="qs-offer-pkn">{pknLine()}</span>
              </Show>
            </span>
          </div>
          <div class="qs-copies">
            <span class="qs-label" id={`${titleId()}-copies`}>Copies</span>
            <span class="qs-stepper" role="group" aria-labelledby={`${titleId()}-copies`}>
              <button type="button" class="qs-step" disabled={busy() || qty() <= 1} onClick={() => step(-1)} aria-label="One copy fewer">−</button>
              <span class="qs-qty">{qty()}</span>
              <button type="button" class="qs-step" disabled={busy() || qty() >= remaining()} onClick={() => step(1)} aria-label="One copy more">+</button>
            </span>
            <span class="qs-hint">{remaining() === 1 ? 'only 1 wanted' : `up to ${remaining()} wanted`}</span>
          </div>
          <label class="sell-field qs-field">
            <span class="qs-label-line">
              <span class="qs-label">{house() ? 'Note to Pokoin (optional)' : 'Message to buyer (optional)'}</span>
              <span class={['qs-count', { 'is-over': count() > BUYER_MESSAGE_MAX }]} aria-live="polite">{count()}/{BUYER_MESSAGE_MAX}</span>
            </span>
            <textarea
              rows="3"
              placeholder="Sleeved since opening, ready to ship…"
              value={note()}
              onInput={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <p class="qs-help">Sent to the buyer with the notification. This is not a chat.</p>
          <p class="qs-fine">
            {house()
              ? "This creates a listing at Pokoin's starting price. Pokoin is not charged automatically; you are paid only if it buys it."
              : "This creates a listing at the buyer's offered price. They are not charged automatically; you are paid only if they buy it."}
          </p>
          <Show when={error()}><p class="sell-msg error">{error()}</p></Show>
          <div class="sell-now-actions">
            <button type="button" class="btn" disabled={blocked()} onClick={submit}>{busy() ? 'Listing…' : `List at ${price()}`}</button>
            <button type="button" class="btn ghost" disabled={busy()} onClick={close}>Cancel</button>
          </div>
        </Show>
        <Show when={done()}>
          <p class="sell-msg ok">
            {house() ? `Listed at ${price()}. Pokoin will be notified.` : `Listed at ${price()}. The buyer will be notified.`}
          </p>
          <div class="sell-now-actions">
            <AppLink class="btn" to="/mypokoin">See your listings</AppLink>
            <button type="button" class="btn ghost" onClick={close}>Done</button>
          </div>
        </Show>
      </div>
    </Portal>
  );
}
