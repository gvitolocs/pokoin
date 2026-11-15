import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { useLocation, useSearchParams } from '@solidjs/router';
import {
  BUY_ORDER_DAYS,
  MAX_BUY_ORDER_QUANTITY,
  cancelBuyOrder,
  errorMessage,
  expiryLabel,
  fetchBuyBoard,
  fetchBuyOrdersForMyListings,
  fetchMyBuyOrders,
  openBuyOrderIds,
  orderStateLabel,
  updateBuyOrder,
} from '@market/buy-orders.js';
import { CONDITIONS } from '@market/card-desk.js';
import { conditionChipSrc } from '@market/listing-meta.js';
import { flagSrc, getSearchLang } from '@market/locale.js';
import { authFrom } from '@market/punchouts.js';
import { formatPkn, formatPknNumber } from '@market/pkn.js';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';
import AppLink from '../components/AppLink.jsx';
import AuthLink from '../components/AuthLink.jsx';
import RequireSignIn from '../components/RequireSignIn.jsx';
import BuySellIcon from '../components/buysell/BuySellIcon.jsx';
import SellNowForm from '../components/buysell/SellNowForm.jsx';
import RowThumb from '../components/inventory/RowThumb.jsx';
import {
  BinGlyph,
  BoxGlyph,
  BuyerGlyph,
  ClockGlyph,
  CloseGlyph,
  CopiesGlyph,
  InfoGlyph,
  ListGlyph,
  OpenGlyph,
  PencilGlyph,
  SearchGlyph,
  TagGlyph,
} from '../components/buysell/BuySellIcons.jsx';
import { dismissWhileOpen } from '../lib/dismiss.js';
import { getBearer, signedIn } from '../stores/auth.js';
import { allowMypokoinPreview } from './mypokoin-preview-fixture.js';
import { BUYSELL_PREVIEW_BANNER, previewBoard, previewForMyListings, previewMine, previewOwnIds } from './buysell-preview-fixture.js';

const STATE_ORDER = ['open', 'filled', 'expired', 'cancelled'];
const BOARD_PAGE = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** The three steps, now behind the info button instead of on the page body. */
const ABOUT_STEPS = [
  'Make an offer on any card and choose how long it stays open.',
  'A seller who has the card can accept it with Sell now.',
  'You get an email and buy the listing at your price.',
];
const FINE_PRINT = 'Offers are not binding and no money is taken until you buy.';
const conditionLabel = (value) => CONDITIONS.find((row) => row.value === value)?.label || value;
const cardPath = (id) => `/marketplace/${getSearchLang()}/cards/${encodeURIComponent(String(id || ''))}`;
const toMs = (value) => (typeof value === 'number' ? value : Date.parse(String(value || '')));

/**
 * The time-left fact of a row: `27d` or `5h`, and the full date in its title.
 * The row is half as wide as the old sentence it replaces, so it cannot spell out
 * "27 days left"; `expiryLabel` stays the wording for the history list.
 */
function timeLeft(expiresAt, now = Date.now()) {
  const at = toMs(expiresAt);
  if (!Number.isFinite(at)) return { value: 'No end', title: 'Until cancelled' };
  const date = new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const left = at - now;
  if (left <= 0) return { value: 'Ended', title: `Expired ${date}` };
  if (left >= DAY_MS) return { value: `${Math.floor(left / DAY_MS)}d`, title: `Until ${date}` };
  if (left >= HOUR_MS) return { value: `${Math.floor(left / HOUR_MS)}h`, title: `Until ${date}` };
  return { value: '<1h', title: `Until ${date}` };
}

/** Condition chip, language flag and set line shared by every row. */
function OfferFacets(props) {
  const item = () => props.item;
  return (
    <span class="buysell-meta">
      <img class="shop-cond" src={conditionChipSrc(item().condition)} alt={conditionLabel(item().condition)} title={conditionLabel(item().condition)} width="40" height="28" />
      <span class="buysell-lang">
        <img class="deal-flag" src={flagSrc(String(item().language || ''))} alt="" width="22" height="22" />
        {' '}
        {item().language}
      </span>
      <Show when={item().reverse}><span>Reverse</span></Show>
      <Show when={item().first_edition}><span>1st Ed.</span></Show>
    </span>
  );
}

function OfferTitle(props) {
  const item = () => props.item;
  return (
    <span class="buysell-main">
      <AppLink to={cardPath(item().card_id)}><strong>{item().card_name || 'Card'}</strong></AppLink>
      <span class="buysell-meta">
        {[item().set_name, item().collector_number ? `#${item().collector_number}` : ''].filter(Boolean).join(' · ')}
      </span>
      {props.children}
    </span>
  );
}

/** Copies wanted, time left, the buyer, and — on the Offer side — the caller's own listing. */
function OfferFacts(props) {
  const item = () => props.item;
  const left = () => timeLeft(item().expires_at, props.now);
  return (
    <span class="buysell-facts">
      <span class="buysell-fact" title={`${item().remaining} still wanted`}>
        <CopiesGlyph />×{item().remaining}
      </span>
      <span class="buysell-fact" title={left().title}>
        <ClockGlyph />{left().value}
      </span>
      <Show when={item().buyer_name}>
        <span class="buysell-fact" title="Buyer">
          <BuyerGlyph />{item().buyer_name}
        </span>
      </Show>
      <Show when={item().my_price_pkn}>
        <span class="buysell-fact" title={`Your listing at ${formatPkn(item().my_price_pkn)}`}>
          <TagGlyph />{formatPknNumber(item().my_price_pkn)}
        </span>
      </Show>
    </span>
  );
}

/** The card page, as the row's one icon-only destination. */
function CardPageLink(props) {
  return (
    <AppLink class="buysell-act" to={cardPath(props.cardId)} title="Card page" aria-label="Card page">
      <OpenGlyph />
    </AppLink>
  );
}

/**
 * Edit and delete of one of the caller's own open offers, shared by the history list and
 * the marked rows of the Seek board: one row sits in the editor at a time, a
 * delete confirms first, and a failure of either write goes to `onError` — the
 * surface's own Alert. `onDeleted` and `onEdited` say what each list does once a
 * write lands: the history reloads, the board keeps its rows and edits them in place.
 */
function ownOfferActions({ preview, onError, onDeleted, onEdited }) {
  const [editing, setEditing] = createSignal('');
  const [busyId, setBusyId] = createSignal('');
  const isEditing = (order) => editing() === String(order.id);
  const isBusy = (order) => busyId() === String(order.id);

  async function remove(order) {
    if (!window.confirm('Delete this offer?')) return;
    setBusyId(String(order.id));
    try {
      if (!preview) await cancelBuyOrder(order.id, await getBearer());
      onDeleted(order);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  return {
    isEditing,
    isBusy,
    toggle: (order) => setEditing(isEditing(order) ? '' : String(order.id)),
    remove,
    editorDone: (order, saved, updated) => {
      setEditing('');
      if (saved) onEdited(order, updated);
    },
  };
}

/** The Edit and Delete pencil and bin of a row the caller owns; the editor opens below them. */
function OwnOfferButtons(props) {
  return (
    <>
      <button type="button" class="buysell-act" title="Edit offer" aria-label="Edit offer" onClick={() => props.actions.toggle(props.order)}>
        <PencilGlyph />
      </button>
      <button
        type="button"
        class="buysell-act"
        title="Delete offer"
        aria-label="Delete offer"
        disabled={props.actions.isBusy(props.order)}
        onClick={() => props.actions.remove(props.order)}
      >
        <BinGlyph />
      </button>
    </>
  );
}

/** Seek: the board of everyone's open offers, the caller's own first. */
function Seek(props) {
  const [sort, setSort] = createSignal('recent');
  const [items, setItems] = createSignal(null);
  const [next, setNext] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [ownIds, setOwnIds] = createSignal(props.preview ? new Set(previewOwnIds()) : new Set());
  const [now] = createSignal(Date.now());
  let seq = 0;
  let ownAsked = false;

  const isOwn = (item) => ownIds().has(String(item.id));

  /** Your own rows lead the board; inside each group the fetched order stands. */
  const ordered = createMemo(() => {
    const list = items() || [];
    if (!ownIds().size) return list;
    const mine = [];
    const others = [];
    for (const row of list) (isOwn(row) ? mine : others).push(row);
    return [...mine, ...others];
  });

  const own = ownOfferActions({
    preview: props.preview,
    onError: setError,
    onDeleted: (order) => {
      // The row simply goes: the board is not fetched again, so the loaded pages stay.
      setItems((rows) => (rows || []).filter((row) => String(row.id) !== String(order.id)));
      setOwnIds((ids) => {
        const left = new Set(ids);
        left.delete(String(order.id));
        return left;
      });
    },
    // The PATCH answer is the order itself, so the row repaints instead of the board.
    onEdited: (order, updated) => {
      if (!updated) return;
      setItems((rows) => (rows || []).map((row) => (String(row.id) === String(order.id) ? { ...row, ...updated } : row)));
    },
  });

  async function load(reset) {
    const mine = seq + 1;
    seq = mine;
    setLoading(true);
    setError('');
    try {
      const data = props.preview
        ? previewBoard(sort())
        : await fetchBuyBoard({ limit: BOARD_PAGE, sort: sort(), before: reset ? '' : next() });
      if (mine !== seq) return;
      const rows = Array.isArray(data?.items) ? data.items : [];
      setItems((current) => (reset || !current ? rows : [...current, ...rows]));
      setNext(data?.next ? String(data.next) : '');
    } catch (err) {
      if (mine !== seq) return;
      setError(err.status === 404 ? 'Buy offers are not available yet.' : errorMessage(err));
      if (reset) setItems(null);
    } finally {
      if (mine === seq) setLoading(false);
    }
  }

  createEffect(sort, () => { load(true); });

  /** The caller's own open offers, asked once; without them the board is the public one. */
  async function markOwnOffers() {
    try {
      setOwnIds(openBuyOrderIds((await fetchMyBuyOrders(await getBearer()))?.items));
    } catch (_) {
      /* a board that cannot say which rows are yours still shows the rows */
    }
  }

  createEffect(() => signedIn(), (ready) => {
    if (props.preview || ownAsked || !ready) return;
    ownAsked = true;
    markOwnOffers();
  });

  return (
    <section class="buysell-panel is-seek" aria-labelledby="buysell-seek-title">
      <div class="buysell-panel-head">
        <h2 class="buysell-panel-title" id="buysell-seek-title"><SearchGlyph size={19} />Seek</h2>
        <div class="buysell-panel-tools">
          <div class="buysell-sort" role="group" aria-label="Sort offers">
            <button
              type="button"
              class="buysell-act"
              aria-pressed={sort() === 'recent'}
              title="Newest offers first"
              aria-label="Sort by newest"
              onClick={() => setSort('recent')}
            >
              <ClockGlyph />
            </button>
            <button
              type="button"
              class="buysell-act"
              aria-pressed={sort() === 'price'}
              title="Highest price first"
              aria-label="Sort by highest price"
              onClick={() => setSort('price')}
            >
              <TagGlyph />
            </button>
          </div>
          <button
            type="button"
            class="buysell-act"
            aria-pressed={props.historyOpen() ? 'true' : 'false'}
            title="My offers"
            aria-label="My offers"
            onClick={props.onHistory}
          >
            <ListGlyph />
          </button>
        </div>
      </div>
      <Alert>{error()}</Alert>
      <Show when={items() == null && !error()}>
        <DeskPanel title="Seek"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={items() && !items().length}>
        <EmptyDesk title="No open offers yet.">
          <AppLink class="btn" to="/marketplace">Browse cards</AppLink>
        </EmptyDesk>
      </Show>
      <Show when={items()?.length}>
        <div class="buysell-list">
          <For each={ordered()}>
            {(item) => (
              <article class="buysell-row">
                <RowThumb row={item} />
                <OfferTitle item={item}>
                  <Show when={isOwn(item)}><span class="buysell-own">Your offer</span></Show>
                  <OfferFacets item={item} />
                  <OfferFacts item={item} now={now()} />
                </OfferTitle>
                <span class="buysell-side">
                  <strong>{formatPkn(item.price_pkn)}</strong>
                  <span class="buysell-acts">
                    {/* Sell now is somebody else's offer to take; yours gets Edit and Delete. */}
                    <Show when={!isOwn(item)}>
                      <SellNowForm order={item} preview={props.preview} onDone={() => load(true)} />
                    </Show>
                    <Show when={isOwn(item)}>
                      <OwnOfferButtons order={item} actions={own} />
                    </Show>
                    <CardPageLink cardId={item.card_id} />
                  </span>
                </span>
                <Show when={own.isEditing(item)}>
                  <OfferEditor
                    order={item}
                    preview={props.preview}
                    defaultDays="keep"
                    onDone={(saved, updated) => own.editorDone(item, saved, updated)}
                  />
                </Show>
              </article>
            )}
          </For>
        </div>
        <Show when={next()}>
          <p class="buysell-more">
            <button type="button" class="btn ghost" disabled={loading()} onClick={() => load(false)}>
              {loading() ? 'Loading…' : 'Load more'}
            </button>
          </p>
        </Show>
      </Show>
    </section>
  );
}

function OfferEditor(props) {
  const [price, setPrice] = createSignal(String(props.order.price_pkn ?? ''));
  const [quantity, setQuantity] = createSignal(String(props.order.quantity ?? 1));
  const [days, setDays] = createSignal(String(props.defaultDays));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  async function save() {
    const body = {};
    const nextPrice = Number(price());
    const nextQty = Number(quantity());
    if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
      setError('Enter a price above 0 PKN.');
      return;
    }
    if (!Number.isInteger(nextQty) || nextQty < 1 || nextQty > MAX_BUY_ORDER_QUANTITY) {
      setError(`Choose 1 to ${MAX_BUY_ORDER_QUANTITY} copies.`);
      return;
    }
    if (nextPrice !== Number(props.order.price_pkn)) body.price_pkn = nextPrice;
    if (nextQty !== Number(props.order.quantity)) body.quantity = nextQty;
    if (days() !== 'keep') body.days = days() === 'null' ? null : Number(days());
    if (!Object.keys(body).length) {
      props.onDone();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const updated = props.preview ? null : await updateBuyOrder(props.order.id, body, await getBearer());
      props.onDone(true, updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="buysell-edit">
      <label class="sell-field">Price (PKN)<input inputmode="decimal" value={price()} onInput={(event) => setPrice(event.currentTarget.value)} /></label>
      <label class="sell-field qty">Copies<input inputmode="numeric" value={quantity()} onInput={(event) => setQuantity(event.currentTarget.value)} /></label>
      <label class="sell-field">
        Open for
        <select value={days()} onChange={(event) => setDays(event.currentTarget.value)}>
          <option value="keep" selected={days() === 'keep'}>Keep as is</option>
          <For each={BUY_ORDER_DAYS}>
            {(row) => <option value={String(row.value)} selected={String(row.value) === days()}>{row.label}</option>}
          </For>
        </select>
      </label>
      <button type="button" class="btn" disabled={busy()} onClick={save}>{busy() ? 'Saving…' : 'Save'}</button>
      <button type="button" class="btn ghost" disabled={busy()} onClick={() => props.onDone()}>Cancel</button>
      <Show when={error()}><p class="sell-msg error">{error()}</p></Show>
    </div>
  );
}

/** The caller's offer history: filled, expired and cancelled groups, and the open ones. */
function History(props) {
  const [items, setItems] = createSignal(null);
  const [error, setError] = createSignal('');
  const [now] = createSignal(Date.now());

  async function load() {
    try {
      const data = props.preview ? previewMine() : await fetchMyBuyOrders(await getBearer());
      setItems(Array.isArray(data?.items) ? data.items : []);
      setError('');
    } catch (err) {
      setError(err.status === 404 ? 'Buy offers are not available yet.' : errorMessage(err));
    }
  }
  onSettled(() => { load(); });

  const own = ownOfferActions({
    preview: props.preview,
    onError: setError,
    onDeleted: () => load(),
    onEdited: () => load(),
  });

  const groups = createMemo(() => STATE_ORDER
    .map((state) => ({ state, rows: (items() || []).filter((row) => row.state === state) }))
    .filter((group) => group.rows.length));

  return (
    <section class="buysell-panel buysell-history" aria-labelledby="buysell-history-title">
      <div class="buysell-panel-head">
        <h2 class="buysell-panel-title" id="buysell-history-title"><ListGlyph size={19} />My offers</h2>
        <button type="button" class="buysell-act" title="Close My offers" aria-label="Close My offers" onClick={props.onClose}>
          <CloseGlyph />
        </button>
      </div>
      <Alert>{error()}</Alert>
      <Show when={items() == null && !error()}>
        <DeskPanel title="My offers"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={items() && !items().length}>
        <EmptyDesk title="No offers yet.">
          <AppLink class="btn" to="/marketplace">Browse cards</AppLink>
        </EmptyDesk>
      </Show>
      <For each={groups()}>
        {(group) => (
          <>
            <h3 class="buysell-group">{orderStateLabel(group.state)} ({group.rows.length})</h3>
            <div class="buysell-list">
              <For each={group.rows}>
                {(order) => (
                  <article class="buysell-row">
                    <RowThumb row={order} />
                    <OfferTitle item={order}>
                      <OfferFacets item={order} />
                      <span class="buysell-facts">
                        <span class="buysell-fact" title="still wanted">
                          <CopiesGlyph />{order.remaining} of {order.quantity}
                        </span>
                        <Show when={group.state === 'open'}>
                          <span class="buysell-fact" title={expiryLabel(order.expires_at, now())}>
                            <ClockGlyph />{timeLeft(order.expires_at, now()).value}
                          </span>
                        </Show>
                      </span>
                      <For each={(order.fills || []).filter((fill) => fill.listing_status === 'active' || fill.listing_status === 'sold_out')}>
                        {(fill) => (
                          <span class="buysell-meta">
                            {fill.quantity} {fill.listing_status === 'sold_out' ? 'sold' : 'listed'} at {formatPkn(fill.price_pkn)}
                            <Show when={fill.listing_status === 'active'}>
                              <AppLink to={cardPath(order.card_id)}>Buy now</AppLink>
                            </Show>
                            {/* What the seller chose to say when they took the offer. An older API
                                simply has no field, which reads as no note. */}
                            <Show when={fill.seller_message}>
                              <span class="buysell-note">Seller's note: {fill.seller_message}</span>
                            </Show>
                          </span>
                        )}
                      </For>
                    </OfferTitle>
                    <span class="buysell-side">
                      <strong>{formatPkn(order.price_pkn)}</strong>
                      <Show when={group.state === 'open'}>
                        <span class="buysell-acts">
                          <OwnOfferButtons order={order} actions={own} />
                          <CardPageLink cardId={order.card_id} />
                        </span>
                      </Show>
                    </span>
                    <Show when={own.isEditing(order)}>
                      <OfferEditor
                        order={order}
                        preview={props.preview}
                        defaultDays="keep"
                        onDone={(saved, updated) => own.editorDone(order, saved, updated)}
                      />
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </>
        )}
      </For>
    </section>
  );
}

/** Offer: the open offers that match the caller's own active listings. */
function Offer(props) {
  const [items, setItems] = createSignal(null);
  const [error, setError] = createSignal('');
  const [now] = createSignal(Date.now());
  let panel;

  async function load() {
    try {
      const data = props.preview ? previewForMyListings() : await fetchBuyOrdersForMyListings(await getBearer());
      setItems(Array.isArray(data?.items) ? data.items : []);
      setError('');
    } catch (err) {
      setError(err.status === 404 ? 'Buy offers are not available yet.' : errorMessage(err));
    }
  }

  // The panel only has an answer once there is a session to ask with, and the
  // cached session can settle after the first paint, so this tracks the sign-in.
  createEffect(() => (props.preview || signedIn()), (ready) => { if (ready) load(); });

  /** `?tab=sell` lands here: scrolled to where it can be read, and nowhere when it already is. */
  let scrolled = false;
  createEffect(props.focus, (onSell) => {
    if (!onSell || scrolled) return;
    scrolled = true;
    requestAnimationFrame(() => panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });

  return (
    <section class="buysell-panel is-offer" ref={(el) => { panel = el; }} aria-labelledby="buysell-offer-title">
      <div class="buysell-panel-head">
        <h2 class="buysell-panel-title" id="buysell-offer-title"><BoxGlyph size={19} />Offer</h2>
      </div>
      <Show when={props.preview || signedIn()}>
        <Alert>{error()}</Alert>
        <Show when={items() == null && !error()}>
          <DeskPanel title="Offer"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
        </Show>
        <Show when={items() && !items().length}>
          <EmptyDesk title="No one wants a card you have listed yet.">
            <AppLink class="btn" to="/mypokoin">My listings</AppLink>
          </EmptyDesk>
        </Show>
        <Show when={items()?.length}>
          <div class="buysell-list">
            <For each={items()}>
              {(item) => (
                <article class="buysell-row">
                  <RowThumb row={item} />
                  <OfferTitle item={item}>
                    <OfferFacets item={item} />
                    <OfferFacts item={item} now={now()} />
                  </OfferTitle>
                  <span class="buysell-side">
                    <strong>{formatPkn(item.price_pkn)}</strong>
                    <span class="buysell-acts">
                      <SellNowForm order={item} fromPath="/cardgts?tab=sell" preview={props.preview} onDone={load} />
                      <CardPageLink cardId={item.card_id} />
                    </span>
                  </span>
                </article>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={!props.preview && !signedIn()}>
        <p class="buysell-ask">Sign in to see the offers that match your listings.</p>
        <AuthLink class="btn" to={authFrom(props.fromPath)}>Sign in</AuthLink>
      </Show>
    </section>
  );
}

/** /cardgts: the Seek board of standing buy offers and the Offer side of the caller's listings. */
export default function BuySell() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const preview = untrack(() => allowMypokoinPreview(params));
  const here = () => `${location.pathname}${location.search}`;
  const historyOpen = () => params.tab === 'mine';
  const [about, setAbout] = createSignal(false);
  let aboutBox;

  dismissWhileOpen(about, () => aboutBox, () => setAbout(false));

  onSettled(() => {
    document.title = 'CardGTS · Pokoin';
  });

  return (
    <div class="page desk buysell">
      <PageHead
        title={<><BuySellIcon class="buysell-title-ico" size="0.85em" />CardGTS</>}
        lede="Say what you will pay for a card. Anyone who has it can sell it to you."
      >
        <span class="buysell-about" ref={(el) => { aboutBox = el; }}>
          <button
            type="button"
            class="buysell-act"
            aria-expanded={about() ? 'true' : 'false'}
            aria-controls="buysell-about-pop"
            title="How CardGTS works"
            aria-label="How CardGTS works"
            onClick={() => setAbout((open) => !open)}
          >
            <InfoGlyph size={19} />
          </button>
          <Show when={about()}>
            <div class="buysell-about-pop" id="buysell-about-pop">
              <ol class="buysell-how">
                <For each={ABOUT_STEPS}>{(step) => <li>{step}</li>}</For>
              </ol>
              <p class="buysell-fine">{FINE_PRINT}</p>
            </div>
          </Show>
        </span>
      </PageHead>
      <Show when={preview}><p class="seller-preview-banner" role="status">{BUYSELL_PREVIEW_BANNER}</p></Show>
      <div class="buysell-panels">
        <Seek
          preview={preview}
          historyOpen={historyOpen}
          onHistory={() => setParams({ tab: historyOpen() ? undefined : 'mine' })}
        />
        <Offer preview={preview} fromPath={here()} focus={() => params.tab === 'sell'} />
      </div>
      <Show when={historyOpen()}>
        <Show
          when={preview}
          fallback={<RequireSignIn from={here()}><History onClose={() => setParams({ tab: undefined })} /></RequireSignIn>}
        >
          <History preview onClose={() => setParams({ tab: undefined })} />
        </Show>
      </Show>
    </div>
  );
}
