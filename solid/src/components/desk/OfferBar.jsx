import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { useLocation, useSearchParams } from '@solidjs/router';
import { imageSrc } from '@market/api.js';
import {
  BUY_ORDER_DAYS,
  DEFAULT_BUY_ORDER_DAYS,
  MAX_BUY_ORDER_QUANTITY,
  buyerNameOf,
  createBuyOrder,
  crossesAsk,
  errorMessage,
  fetchBuyBook,
  offerBarModel,
  offerPrefill,
  offerLanguages,
  selectionBid,
  validateBuyOrder,
} from '@market/buy-orders.js';
import { CONDITIONS } from '@market/card-desk.js';
import { game } from '@market/game.js';
import { displayName, printingIdentity } from '@market/identity.js';
import { listingExtraChips, listingFoilOptions } from '@market/listing-faces.js';
import { formatPkn, parseListAmount } from '@market/pkn.js';
import { authFrom } from '@market/punchouts.js';
import { sellerNameOf } from '@market/auth-session.js';
import { useGameNavigate } from '../../lib/game-navigate.js';
import { whenIdle } from '../../lib/idle.js';
import { authUser, getBearer, signedIn } from '../../stores/auth.js';
import { profile } from '../../stores/session.js';
import { allowMypokoinPreview } from '../../pages/mypokoin-preview-fixture.js';
import { BUYSELL_PREVIEW_BANNER, previewBook } from '../../pages/buysell-preview-fixture.js';
import { buyerParts } from '../../stores/buyer.js';
import BuySellIcon from '../buysell/BuySellIcon.jsx';
import SellNowForm from '../buysell/SellNowForm.jsx';

const CONDITION_ROWS = CONDITIONS.filter((row) => row.value);
const OFFER_LIVE = 'Your offer is live. Manage it in My offers.';

/**
 * The offer bar inside the card desk's Best Deal panel, above Add to cart: the best
 * offer for the chosen condition and language and a button that opens the offer form
 * (and Sell now) in place. The book loads after the listings (props.ready), never in
 * the first paint, and a failed request renders nothing so the panel stays as before.
 * props: card, cardId, ready, condition, language, languages, pinned, above,
 * askFor(condition, language), onBuyNow().
 */
export default function OfferBar(props) {
  const navigate = useGameNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const preview = untrack(() => allowMypokoinPreview(params));
  const [book, setBook] = createSignal(null);
  const [forming, setForming] = createSignal(false);
  const [price, setPrice] = createSignal('');
  const [quantity, setQuantity] = createSignal('1');
  const [days, setDays] = createSignal(String(DEFAULT_BUY_ORDER_DAYS));
  const [formCond, setFormCond] = createSignal('NM');
  const [formLang, setFormLang] = createSignal('EN');
  const [reverse, setReverse] = createSignal(false);
  const [firstEd, setFirstEd] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');

  let fetchSeq = 0;
  function loadBook(id) {
    const seq = fetchSeq + 1;
    fetchSeq = seq;
    if (preview) {
      setBook(() => previewBook(untrack(() => props.language)).book);
      return Promise.resolve();
    }
    return fetchBuyBook(id).then(
      (data) => {
        if (seq === fetchSeq) setBook(() => (Array.isArray(data?.book) ? data.book : []));
      },
      () => {
        if (seq === fetchSeq) setBook(null);
      },
    );
  }

  createEffect(
    () => ((preview || props.ready) && props.cardId ? String(props.cardId) : ''),
    (id) => {
      if (!id) return undefined;
      setBook(null);
      return whenIdle(() => { loadBook(id); });
    },
  );
  onCleanup(() => { fetchSeq += 1; });

  const bid = createMemo(() => selectionBid(book(), { condition: props.condition, language: props.language }));
  const formLangs = createMemo(() => offerLanguages([...(props.languages || []), props.language]));
  const model = createMemo(() => offerBarModel(bid()));
  const priceText = () => {
    const parts = buyerParts(bid()?.best_price_pkn, true, props.pinned);
    return parts.local || parts.pkn || '';
  };
  const offersReverse = () => listingFoilOptions(game().id).some((row) => row.value === 'reverse');
  const offersFirstEd = () => listingExtraChips(game().id).some((row) => row.key === 'firstEd');
  const priceNumber = () => {
    const parsed = parseListAmount(price());
    return Number.isFinite(Number(parsed)) ? Number(parsed) : NaN;
  };
  const ask = () => props.askFor?.(formCond(), formLang());
  const crosses = () => crossesAsk(priceNumber(), ask());
  const fromPath = () => `${location.pathname}${location.search}`;

  function toggleForm() {
    if (forming()) {
      setForming(false);
      return;
    }
    if (!preview && !signedIn()) {
      navigate(authFrom(fromPath()));
      return;
    }
    setFormCond(props.condition || 'NM');
    setFormLang(formLangs().includes(String(props.language || '').toUpperCase()) ? String(props.language).toUpperCase() : 'EN');
    setPrice(offerPrefill(bid()));
    setError('');
    setNotice('');
    setForming(true);
  }

  async function submit() {
    const card = untrack(() => props.card) || {};
    const ident = printingIdentity(card);
    const body = {
      card_id: String(props.cardId || ''),
      condition: formCond(),
      language: formLang(),
      reverse: reverse(),
      first_edition: firstEd(),
      price_pkn: priceNumber(),
      quantity: Number(quantity()),
      days: days() === 'null' ? null : Number(days()),
      buyer_name: buyerNameOf(sellerNameOf(authUser(), profile())),
      card_name: displayName(card) || card.name || '',
      card_image_url: imageSrc(card, 'grid') || '',
      set_name: ident.set || '',
      collector_number: ident.number || '',
    };
    const check = validateBuyOrder(body);
    if (!check.ok) {
      setError(Object.values(check.errors)[0]);
      return;
    }
    if (preview) {
      setForming(false);
      setNotice(OFFER_LIVE);
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
      await createBuyOrder(body, token);
      setForming(false);
      setNotice(OFFER_LIVE);
      setPrice('');
      await loadBook(String(props.cardId));
    } catch (err) {
      if (err.status === 401) {
        navigate(authFrom(fromPath()));
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={book()}>
      <div class={['offer-wrap', { 'is-above': props.above }]}>
        <Show when={preview}><p class="seller-preview-banner" role="status">{BUYSELL_PREVIEW_BANNER}</p></Show>
        <div class="offer-bar">
          <span class="offer-bar-price" title={model().title} aria-label={model().title}>
            <BuySellIcon />
            <Show when={model().hasOffer} fallback={<span class="offer-bar-none">No offers yet</span>}>
              <span class="offer-bar-label">Offer</span>
              <span class="offer-bar-amount">{priceText()}</span>
            </Show>
          </span>
          <button
            type="button"
            class="offer-bar-btn"
            aria-expanded={forming() ? 'true' : 'false'}
            onClick={toggleForm}
          >
            {model().button}
          </button>
        </div>
        <Show when={notice()}><p class="sell-msg ok">{notice()}</p></Show>
        <Show when={forming()}>
          <div class="offer-open">
            <h3 class="offer-open-head">{model().hasOffer ? 'Beat the best offer' : 'Make an offer'}</h3>
            <Show when={bid()?.best_order_id}>
              <SellNowForm
                order={{ id: bid().best_order_id, price_pkn: bid().best_price_pkn, remaining: bid().best_remaining }}
                fromPath={fromPath()}
                preview={preview}
                onDone={() => {
                  setForming(false);
                  setNotice(`Listed at ${formatPkn(bid()?.best_price_pkn)}. The buyer has been told.`);
                  return loadBook(String(props.cardId));
                }}
              />
            </Show>
            <div class="buy-form">
              <div class="sell-row">
                <label class="sell-field grow price">
                  Price (PKN)
                  <input inputmode="decimal" value={price()} onInput={(event) => setPrice(event.currentTarget.value)} />
                </label>
                <label class="sell-field qty">
                  Copies
                  <input
                    inputmode="numeric"
                    value={quantity()}
                    aria-label={`Copies, 1 to ${MAX_BUY_ORDER_QUANTITY}`}
                    onInput={(event) => setQuantity(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div class="sell-row">
                <label class="sell-field grow">
                  Condition
                  <select value={formCond()} onChange={(event) => setFormCond(event.currentTarget.value)}>
                    <For each={CONDITION_ROWS}>
                      {(row) => <option value={row.value} selected={row.value === formCond()}>{row.label}</option>}
                    </For>
                  </select>
                </label>
                <label class="sell-field grow">
                  Language
                  <select value={formLang()} onChange={(event) => setFormLang(event.currentTarget.value)}>
                    <For each={formLangs()}>
                      {(code) => <option value={code} selected={code === formLang()}>{code}</option>}
                    </For>
                  </select>
                </label>
                <label class="sell-field grow">
                  Open for
                  <select value={days()} onChange={(event) => setDays(event.currentTarget.value)}>
                    <For each={BUY_ORDER_DAYS}>
                      {(row) => <option value={String(row.value)} selected={String(row.value) === days()}>{row.label}</option>}
                    </For>
                  </select>
                </label>
              </div>
              <Show when={offersReverse() || offersFirstEd()}>
                <div class="buy-toggles">
                  <Show when={offersReverse()}>
                    <button type="button" class={['deal-chip buy-toggle', { 'is-on': reverse() }]} aria-pressed={reverse() ? 'true' : 'false'} onClick={() => setReverse(!reverse())}>Reverse</button>
                  </Show>
                  <Show when={offersFirstEd()}>
                    <button type="button" class={['deal-chip buy-toggle', { 'is-on': firstEd() }]} aria-pressed={firstEd() ? 'true' : 'false'} onClick={() => setFirstEd(!firstEd())}>1st Ed.</button>
                  </Show>
                </div>
              </Show>
              <Show when={crosses()}>
                <p class="buy-cross">
                  A listing at {formatPkn(ask())} is already available.
                  {' '}
                  <button type="button" class="linkish" onClick={() => props.onBuyNow?.()}>You can buy it now.</button>
                </p>
              </Show>
              <div class="sell-now-actions">
                <button type="button" class="btn" disabled={busy()} onClick={submit}>{busy() ? 'Posting…' : 'Post offer'}</button>
                <button type="button" class="btn ghost" disabled={busy()} onClick={() => setForming(false)}>Cancel</button>
              </div>
              <p class="buy-note">Offers are not binding. No money is taken until you buy a listing.</p>
            </div>
          </div>
        </Show>
        <Show when={error()}><p class="sell-msg error">{error()}</p></Show>
      </div>
    </Show>
  );
}
