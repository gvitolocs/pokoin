import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useLocation } from '@solidjs/router';
import { imageSrc } from '@market/api.js';
import {
  BUY_ORDER_DAYS,
  MAX_BUY_ORDER_QUANTITY,
  beatPricePkn,
  buyerNameOf,
  cancelBuyOrder,
  createBuyOrder,
  crossesAsk,
  defaultOfferSettings,
  errorMessage,
  offerBarModel,
  offerBody,
  offerLanguages,
  offerPriceInput,
  offerPriceLabel,
  offerPricePkn,
  offerSummary,
  selectionBid,
  validateBuyOrder,
  withHouseOffer,
} from '@market/buy-orders.js';
import { CONDITIONS } from '@market/card-desk.js';
import { game } from '@market/game.js';
import { displayName, printingIdentity } from '@market/identity.js';
import { listingExtraChips, listingFoilOptions } from '@market/listing-faces.js';
import { authFrom } from '@market/punchouts.js';
import { sellerNameOf } from '@market/auth-session.js';
import { useGameNavigate } from '../../lib/game-navigate.js';
import { authUser, getBearer, signedIn } from '../../stores/auth.js';
import { profile } from '../../stores/session.js';
import { BUYSELL_PREVIEW_BANNER } from '../../pages/buysell-preview-fixture.js';
import { buyerCurrency, buyerParts } from '../../stores/buyer.js';
import BuySellIcon from '../buysell/BuySellIcon.jsx';
import SellNowForm from '../buysell/SellNowForm.jsx';

const CONDITION_ROWS = CONDITIONS.filter((row) => row.value);
// Material "settings": one path, same 24x24 filled style as the header icons.
const GEAR_ICON = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const POPUP_WIDTH = 352;
const SHEET_QUERY = '(max-width: 720px)';

/**
 * The offer bar inside the card desk's Best Deal panel, above Add to cart:
 * `[⇄ Offer <best price>] [Beat offer | Make offer] [gear]`. Beat offer posts one
 * step above the best offer with the visitor's settings in one press; Make offer
 * and the gear open the Define offer popup (price, copies, condition, language,
 * duration, Reverse / 1st Ed., Sell now). Nothing expands inside the panel. The
 * desk loads the one buy-order book (lib/buy-book.js) and hands it over as
 * props.buy, shared with the book rows beside the bar; while the book is missing
 * or the request failed, the bar is not drawn. Prices are typed and shown in the
 * visitor's display currency.
 * props: buy, card, condition, language, languages, pinned, above,
 * askFor(condition, language), onBuyNow().
 */
export default function OfferBar(props) {
  const navigate = useGameNavigate();
  const location = useLocation();
  const buy = props.buy;
  const preview = buy.preview;
  const book = buy.book;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal('');
  // Settings the visitor changed in the popup; everything else follows the desk's chips.
  const [overrides, setOverrides] = createSignal({});
  const [price, setPrice] = createSignal('');
  const [priceTouched, setPriceTouched] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal(null);

  let bar;
  let gear;
  let popup;
  let priceInput;

  // The chips are the source of truth for condition and language: a new chip pick clears those two settings.
  createEffect(
    () => `${props.condition}|${props.language}`,
    () => {
      const { condition, language, ...rest } = untrack(overrides);
      if (condition !== undefined || language !== undefined) setOverrides(rest);
    },
  );

  const settings = createMemo(() => ({
    ...defaultOfferSettings({ condition: props.condition, language: props.language }),
    ...overrides(),
  }));
  const setSetting = (key, value) => setOverrides({ ...untrack(overrides), [key]: value });
  // A Sell button in the book rows asks for a condition; the Sell now form lives in here.
  createEffect(buy.sellPick, (condition) => {
    if (!condition) return;
    buy.pickSell('');
    setSetting('condition', condition);
    openPopup();
  });
  // The Buy offers cell with nothing to sell into names no condition: its Make
  // offer opens the popup on the chips as they stand.
  createEffect(buy.offerAsk, (ask) => {
    if (!ask) return;
    openPopup();
  });
  const currency = () => buyerCurrency(props.pinned);
  const cur = () => currency() || 'PKN';

  // The bar shows the offer for the desk's chips; the buttons act on the offer settings' tuple.
  // With no buyer's offer the selection still has one: Pokoin's 1 PKN starting
  // offer. So the bar always shows a price and the button is always Beat offer;
  // the gear is the only way into the Define offer popup.
  const bid = createMemo(() => withHouseOffer(selectionBid(book(), { condition: props.condition, language: props.language })));
  const target = createMemo(() => withHouseOffer(selectionBid(book(), { condition: settings().condition, language: settings().language })));
  const barModel = createMemo(() => offerBarModel(bid()));
  const model = createMemo(() => offerBarModel(target()));
  const beatPkn = () => beatPricePkn(target());
  const beatText = () => (beatPkn() ? offerSummary(beatPkn(), settings(), cur()) : '');
  const priceText = () => {
    const parts = buyerParts(bid()?.best_price_pkn, true, props.pinned);
    return parts.local || parts.pkn || '';
  };
  const formLangs = createMemo(() => offerLanguages([...(props.languages || []), props.language, settings().language]));
  const offersReverse = () => listingFoilOptions(game().id).some((row) => row.value === 'reverse');
  const offersFirstEd = () => listingExtraChips(game().id).some((row) => row.key === 'firstEd');
  const typedPkn = () => offerPricePkn(price(), cur());
  const ask = () => props.askFor?.(settings().condition, settings().language);
  const crosses = () => crossesAsk(typedPkn(), ask());
  const canSellNow = () => Boolean(target()?.best_order_id) && !buy.mine().includes(target().best_order_id);
  const fromPath = () => `${location.pathname}${location.search}`;

  function prefill() {
    const pkn = beatPkn();
    setPrice(pkn ? offerPriceInput(pkn, cur()) : '');
  }

  function place() {
    if (!bar) return;
    if (window.matchMedia?.(SHEET_QUERY).matches) {
      setPos('');
      return;
    }
    const rect = bar.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(POPUP_WIDTH, vw - 16);
    const left = Math.min(Math.max(8, rect.right - width), vw - width - 8);
    const below = vh - rect.bottom - 14;
    const above = rect.top - 14;
    const down = below >= 380 || below >= above;
    const maxHeight = Math.max(220, down ? below : above);
    const edge = down ? `top:${rect.bottom + 6}px` : `bottom:${vh - rect.top + 6}px`;
    setPos(`left:${left}px;width:${width}px;max-height:${maxHeight}px;${edge}`);
  }

  function openPopup() {
    setError('');
    setNotice(null);
    setPriceTouched(false);
    prefill();
    place();
    setOpen(true);
  }

  function closePopup() {
    setOpen(false);
    setError('');
    queueMicrotask(() => gear?.focus());
  }

  createEffect(open, (isOpen) => {
    if (!isOpen) return undefined;
    const frame = requestAnimationFrame(() => (priceInput || popup?.querySelector(FOCUSABLE))?.focus());
    const onPointer = (event) => {
      if (popup?.contains(event.target) || gear?.contains(event.target)) return;
      closePopup();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopup();
        return;
      }
      if (event.key !== 'Tab' || !popup) return;
      const items = [...popup.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, { capture: true });
    };
  });

  function card() {
    const row = untrack(() => props.card) || {};
    const ident = printingIdentity(row);
    return {
      name: displayName(row) || row.name || '',
      imageUrl: imageSrc(row, 'grid') || '',
      set: ident.set || '',
      number: ident.number || '',
    };
  }

  /** Posts one offer at `pricePkn` with the current settings. `fromPopup` keeps the popup open on errors. */
  async function post(pricePkn, fromPopup) {
    if (busy()) return;
    const body = offerBody({
      cardId: props.cardId,
      pricePkn,
      settings: settings(),
      buyerName: buyerNameOf(sellerNameOf(authUser(), profile())),
      card: card(),
    });
    const check = validateBuyOrder(body);
    if (!check.ok) {
      const first = Object.entries(check.errors)[0];
      setError(first[0] === 'price_pkn' ? `Enter a price above 0 ${cur()}.` : first[1]);
      return;
    }
    const posted = `Offer posted at ${offerPriceLabel(pricePkn, cur())}.`;
    if (preview) {
      setOpen(false);
      setError('');
      setNotice({ text: posted, undoId: 'preview-order' });
      return;
    }
    if (!signedIn()) {
      navigate(authFrom(fromPath()));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      if (!token) {
        navigate(authFrom(fromPath()));
        return;
      }
      const created = await createBuyOrder(body, token);
      setOpen(false);
      if (created?.id) buy.noteMine(created.id);
      setNotice({ text: posted, undoId: created?.id || '' });
      await buy.reload();
    } catch (err) {
      if (err.status === 401) {
        navigate(authFrom(fromPath()));
        return;
      }
      if (String(err.message) === 'duplicate_buy_order') {
        setError('You already have an offer on this card. Change it in Define offer.');
        if (!fromPopup) openPopupKeepError();
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function openPopupKeepError() {
    const message = error();
    openPopup();
    setError(message);
  }

  function submit() {
    if (!currency()) {
      setError('Your currency is still loading. Try again in a moment.');
      return;
    }
    const pkn = typedPkn();
    if (pkn == null) {
      setError(`Enter a price above 0 ${cur()}.`);
      return;
    }
    return post(pkn, true);
  }

  function main() {
    if (!model().hasOffer) {
      openPopup();
      return;
    }
    if (!currency()) {
      setError('Your currency is still loading. Try again in a moment.');
      return;
    }
    return post(beatPkn(), false);
  }

  async function undo() {
    const id = notice()?.undoId;
    if (!id || busy()) return;
    if (preview) {
      setNotice({ text: 'Offer cancelled.' });
      return;
    }
    setBusy(true);
    try {
      const token = await getBearer();
      if (!token) {
        navigate(authFrom(fromPath()));
        return;
      }
      await cancelBuyOrder(id, token);
      buy.forgetMine(id);
      setNotice({ text: 'Offer cancelled.' });
      await buy.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const popupStyle = () => pos();

  return (
    <Show when={book()}>
      <div class={['offer-wrap', { 'is-above': props.above }]}>
        <Show when={preview}><p class="seller-preview-banner" role="status">{BUYSELL_PREVIEW_BANNER}</p></Show>
        <div class="offer-bar" ref={(el) => { bar = el; }}>
          <span class="offer-bar-price" title={barModel().title} aria-label={barModel().title}>
            <BuySellIcon size="1.3em" />
            <Show when={barModel().hasOffer} fallback={(
              <span class="offer-bar-none">
                <span class="offer-bar-none-long">No offers yet</span>
                <span class="offer-bar-none-short">No offers</span>
              </span>
            )}>
              <span class="offer-bar-label">Offer</span>
              <span class="offer-bar-amount">{priceText()}</span>
            </Show>
          </span>
          <button
            type="button"
            class="offer-bar-btn"
            disabled={busy()}
            title={model().hasOffer ? beatText() : undefined}
            aria-label={model().hasOffer ? `Beat offer. ${beatText()}` : undefined}
            onClick={main}
          >
            {model().button}
          </button>
          <button
            type="button"
            class="offer-bar-gear"
            ref={(el) => { gear = el; }}
            aria-label="Define offer"
            title="Define offer"
            aria-haspopup="dialog"
            aria-expanded={open() ? 'true' : 'false'}
            onClick={() => (open() ? closePopup() : openPopup())}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d={GEAR_ICON} /></svg>
          </button>
        </div>
        <Show when={notice()}>
          {(note) => (
            <p class="sell-msg ok">
              {note().text}
              <Show when={note().undoId}>
                {' '}
                <button type="button" class="linkish" disabled={busy()} onClick={undo}>Undo</button>
              </Show>
            </p>
          )}
        </Show>
        <Show when={error() && !open()}><p class="sell-msg error">{error()}</p></Show>
        <Show when={open()}>
          <Portal mount={document.body}>
            <div class="offer-scrim" aria-hidden="true" />
            <div
              ref={(el) => { popup = el; }}
              class="offer-pop"
              role="dialog"
              aria-label="Define offer"
              style={popupStyle()}
            >
              <div class="offer-pop-head">
                <h3 class="offer-open-head">Define offer</h3>
                <button type="button" class="offer-pop-close" aria-label="Close" onClick={closePopup}>×</button>
              </div>
              <Show when={canSellNow()}>
                <SellNowForm
                  order={{ id: target().best_order_id, price_pkn: target().best_price_pkn, remaining: target().best_remaining }}
                  fromPath={fromPath()}
                  preview={preview}
                  onDone={() => {
                    const sold = offerPriceLabel(target()?.best_price_pkn, cur());
                    setOpen(false);
                    setNotice({ text: `Listed at ${sold}. The buyer has been told.` });
                    return buy.reload();
                  }}
                />
              </Show>
              <div class="buy-form">
                <div class="sell-row">
                  <label class="sell-field grow price">
                    {`Price (${currency() || '…'})`}
                    <input
                      ref={(el) => { priceInput = el; }}
                      inputmode="decimal"
                      value={price()}
                      onInput={(event) => {
                        setPriceTouched(true);
                        setPrice(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <label class="sell-field qty">
                    Copies
                    <input
                      inputmode="numeric"
                      value={settings().quantity}
                      aria-label={`Copies, 1 to ${MAX_BUY_ORDER_QUANTITY}`}
                      onInput={(event) => setSetting('quantity', event.currentTarget.value)}
                    />
                  </label>
                </div>
                <div class="sell-row">
                  <label class="sell-field grow">
                    Condition
                    <select
                      value={settings().condition}
                      onChange={(event) => {
                        setSetting('condition', event.currentTarget.value);
                        if (!priceTouched()) prefill();
                      }}
                    >
                      <For each={CONDITION_ROWS}>
                        {(row) => <option value={row.value} selected={row.value === settings().condition}>{row.label}</option>}
                      </For>
                    </select>
                  </label>
                  <label class="sell-field grow">
                    Language
                    <select
                      value={settings().language}
                      onChange={(event) => {
                        setSetting('language', event.currentTarget.value);
                        if (!priceTouched()) prefill();
                      }}
                    >
                      <For each={formLangs()}>
                        {(code) => <option value={code} selected={code === settings().language}>{code}</option>}
                      </For>
                    </select>
                  </label>
                </div>
                <div class="sell-row">
                  <label class="sell-field grow">
                    Open for
                    <select value={settings().days} onChange={(event) => setSetting('days', event.currentTarget.value)}>
                      <For each={BUY_ORDER_DAYS}>
                        {(row) => <option value={String(row.value)} selected={String(row.value) === settings().days}>{row.label}</option>}
                      </For>
                    </select>
                  </label>
                </div>
                <Show when={offersReverse() || offersFirstEd()}>
                  <div class="buy-toggles">
                    <Show when={offersReverse()}>
                      <button type="button" class={['deal-chip buy-toggle', { 'is-on': settings().reverse }]} aria-pressed={settings().reverse ? 'true' : 'false'} onClick={() => setSetting('reverse', !settings().reverse)}>Reverse</button>
                    </Show>
                    <Show when={offersFirstEd()}>
                      <button type="button" class={['deal-chip buy-toggle', { 'is-on': settings().firstEdition }]} aria-pressed={settings().firstEdition ? 'true' : 'false'} onClick={() => setSetting('firstEdition', !settings().firstEdition)}>1st Ed.</button>
                    </Show>
                  </div>
                </Show>
                <Show when={crosses()}>
                  <p class="buy-cross">
                    A listing at {offerPriceLabel(ask(), cur())} is already available.
                    {' '}
                    <button type="button" class="linkish" onClick={() => { closePopup(); props.onBuyNow?.(); }}>You can buy it now.</button>
                  </p>
                </Show>
                <Show when={error()}><p class="sell-msg error">{error()}</p></Show>
                <div class="sell-now-actions">
                  <button type="button" class="btn" disabled={busy()} onClick={submit}>{busy() ? 'Posting…' : 'Post offer'}</button>
                  <button type="button" class="btn ghost" disabled={busy()} onClick={closePopup}>Cancel</button>
                </div>
                <p class="buy-note">Offers are not binding. No money is taken until you buy a listing.</p>
              </div>
            </div>
          </Portal>
        </Show>
      </div>
    </Show>
  );
}
