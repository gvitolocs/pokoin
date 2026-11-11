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
  orderStateLabel,
  updateBuyOrder,
} from '@market/buy-orders.js';
import { CONDITIONS } from '@market/card-desk.js';
import { conditionChipSrc } from '@market/listing-meta.js';
import { flagSrc, getSearchLang } from '@market/locale.js';
import { formatPkn } from '@market/pkn.js';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';
import AppLink from '../components/AppLink.jsx';
import RequireSignIn from '../components/RequireSignIn.jsx';
import BuySellIcon from '../components/buysell/BuySellIcon.jsx';
import SellNowForm from '../components/buysell/SellNowForm.jsx';
import RowThumb from '../components/inventory/RowThumb.jsx';
import { getBearer } from '../stores/auth.js';
import { allowMypokoinPreview } from './mypokoin-preview-fixture.js';
import { BUYSELL_PREVIEW_BANNER, previewBoard, previewForMyListings, previewMine } from './buysell-preview-fixture.js';

const TABS = [
  { id: 'wanted', label: 'Wanted' },
  { id: 'mine', label: 'My offers' },
  { id: 'sell', label: 'Sell to buyers' },
];
const STATE_ORDER = ['open', 'filled', 'expired', 'cancelled'];
const BOARD_PAGE = 24;
const conditionLabel = (value) => CONDITIONS.find((row) => row.value === value)?.label || value;
const cardPath = (id) => `/marketplace/${getSearchLang()}/cards/${encodeURIComponent(String(id || ''))}`;

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

function Wanted(props) {
  const [sort, setSort] = createSignal('recent');
  const [items, setItems] = createSignal(null);
  const [next, setNext] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [now] = createSignal(Date.now());
  let seq = 0;

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

  return (
    <>
      <div class="buysell-bar">
        <div class="buysell-sort" role="group" aria-label="Sort offers">
          <button type="button" class={{ on: sort() === 'recent' }} aria-pressed={sort() === 'recent'} onClick={() => setSort('recent')}>Recent</button>
          <button type="button" class={{ on: sort() === 'price' }} aria-pressed={sort() === 'price'} onClick={() => setSort('price')}>Highest price</button>
        </div>
      </div>
      <Alert>{error()}</Alert>
      <Show when={items() == null && !error()}>
        <DeskPanel title="Wanted"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={items() && !items().length}>
        <EmptyDesk title="No offers yet" lede="Open any card and choose Make offer to be the first.">
          <AppLink class="btn" to="/marketplace">Browse cards</AppLink>
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
                  <span class="buysell-meta">
                    {item.remaining} wanted · {expiryLabel(item.expires_at, now())}
                    <Show when={item.buyer_name}>{` · ${item.buyer_name}`}</Show>
                  </span>
                </OfferTitle>
                <span class="buysell-side">
                  <strong>{formatPkn(item.price_pkn)}</strong>
                  <SellNowForm order={item} preview={props.preview} onDone={() => load(true)} />
                  <AppLink to={cardPath(item.card_id)}>Card page</AppLink>
                </span>
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
    </>
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
      if (!props.preview) await updateBuyOrder(props.order.id, body, await getBearer());
      props.onDone(true);
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

function MyOffers(props) {
  const [items, setItems] = createSignal(null);
  const [error, setError] = createSignal('');
  const [editing, setEditing] = createSignal('');
  const [busyId, setBusyId] = createSignal('');
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

  const groups = createMemo(() => STATE_ORDER
    .map((state) => ({ state, rows: (items() || []).filter((row) => row.state === state) }))
    .filter((group) => group.rows.length));

  async function cancel(order) {
    if (!window.confirm('Cancel this offer?')) return;
    setBusyId(order.id);
    try {
      if (!props.preview) await cancelBuyOrder(order.id, await getBearer());
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  return (
    <>
      <Alert>{error()}</Alert>
      <Show when={items() == null && !error()}>
        <DeskPanel title="My offers"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={items() && !items().length}>
        <EmptyDesk title="No offers yet" lede="Open any card and choose Make offer.">
          <AppLink class="btn" to="/marketplace">Browse cards</AppLink>
        </EmptyDesk>
      </Show>
      <For each={groups()}>
        {(group) => (
          <>
            <h2 class="buysell-group">{orderStateLabel(group.state)} ({group.rows.length})</h2>
            <div class="buysell-list">
              <For each={group.rows}>
                {(order) => (
                  <article class="buysell-row">
                    <RowThumb row={order} />
                    <OfferTitle item={order}>
                      <OfferFacets item={order} />
                      <span class="buysell-meta">
                        {order.remaining} of {order.quantity} still wanted
                        {group.state === 'open' ? ` · ${expiryLabel(order.expires_at, now())}` : ''}
                      </span>
                      <For each={(order.fills || []).filter((fill) => fill.listing_status === 'active' || fill.listing_status === 'sold_out')}>
                        {(fill) => (
                          <span class="buysell-meta">
                            {fill.quantity} {fill.listing_status === 'sold_out' ? 'sold' : 'listed'} at {formatPkn(fill.price_pkn)}
                            <Show when={fill.listing_status === 'active'}>
                              <AppLink to={cardPath(order.card_id)}>Buy now</AppLink>
                            </Show>
                          </span>
                        )}
                      </For>
                    </OfferTitle>
                    <span class="buysell-side">
                      <strong>{formatPkn(order.price_pkn)}</strong>
                      <Show when={group.state === 'open'}>
                        <button type="button" class="btn ghost" onClick={() => setEditing(editing() === order.id ? '' : order.id)}>Edit</button>
                        <button type="button" class="btn ghost" disabled={busyId() === order.id} onClick={() => cancel(order)}>Cancel offer</button>
                      </Show>
                    </span>
                    <Show when={editing() === order.id}>
                      <OfferEditor
                        order={order}
                        preview={props.preview}
                        defaultDays="keep"
                        onDone={(saved) => {
                          setEditing('');
                          if (saved) load();
                        }}
                      />
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </>
        )}
      </For>
    </>
  );
}

function SellToBuyers(props) {
  const [items, setItems] = createSignal(null);
  const [error, setError] = createSignal('');
  const [now] = createSignal(Date.now());

  async function load() {
    try {
      const data = props.preview ? previewForMyListings() : await fetchBuyOrdersForMyListings(await getBearer());
      setItems(Array.isArray(data?.items) ? data.items : []);
      setError('');
    } catch (err) {
      setError(err.status === 404 ? 'Buy offers are not available yet.' : errorMessage(err));
    }
  }
  onSettled(() => { load(); });

  return (
    <>
      <Alert>{error()}</Alert>
      <Show when={items() == null && !error()}>
        <DeskPanel title="Sell to buyers"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={items() && !items().length}>
        <EmptyDesk title="No matching offers" lede="When a buyer wants a card you have listed, it shows up here.">
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
                  <span class="buysell-meta">
                    Your listing {formatPkn(item.my_price_pkn)} · {item.remaining} wanted · {expiryLabel(item.expires_at, now())}
                  </span>
                </OfferTitle>
                <span class="buysell-side">
                  <strong>{formatPkn(item.price_pkn)}</strong>
                  <SellNowForm order={item} fromPath="/buysell?tab=sell" preview={props.preview} onDone={load} />
                </span>
              </article>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

/** /buysell: the board of standing buy offers, the caller's own, and offers that match their listings. */
export default function BuySell() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const preview = untrack(() => allowMypokoinPreview(params));
  const tab = () => (TABS.some((row) => row.id === params.tab) ? params.tab : 'wanted');
  const here = () => `${location.pathname}${location.search}`;

  onSettled(() => {
    document.title = 'BuySell · Pokoin';
  });

  return (
    <div class="page desk buysell">
      <PageHead
        title={<><BuySellIcon class="buysell-title-ico" size="0.85em" />BuySell</>}
        lede="Say what you will pay for a card. Anyone who has it can sell it to you."
      />
      <Show when={preview}><p class="seller-preview-banner" role="status">{BUYSELL_PREVIEW_BANNER}</p></Show>
      <ol class="buysell-how">
        <li>Make an offer on any card and choose how long it stays open.</li>
        <li>A seller who has the card can accept it with Sell now.</li>
        <li>You get an email and buy the listing at your price.</li>
      </ol>
      <p class="buysell-fine">Offers are not binding and no money is taken until you buy.</p>
      <div class="buysell-bar">
        <div class="buysell-tabs" role="tablist" aria-label="BuySell">
          <For each={TABS}>
            {(row) => (
              <button
                type="button"
                role="tab"
                class={{ on: tab() === row.id }}
                aria-selected={tab() === row.id}
                onClick={() => setParams({ tab: row.id === 'wanted' ? undefined : row.id })}
              >
                {row.label}
              </button>
            )}
          </For>
        </div>
      </div>
      <Show when={tab() === 'wanted'}><Wanted preview={preview} /></Show>
      <Show when={tab() === 'mine'}>
        <Show when={preview} fallback={<RequireSignIn from={here()}><MyOffers /></RequireSignIn>}><MyOffers preview /></Show>
      </Show>
      <Show when={tab() === 'sell'}>
        <Show when={preview} fallback={<RequireSignIn from={here()}><SellToBuyers /></RequireSignIn>}><SellToBuyers preview /></Show>
      </Show>
    </div>
  );
}
