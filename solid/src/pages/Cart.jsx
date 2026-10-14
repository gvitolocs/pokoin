import { createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { buyAgainFallback, removedNoteSlot, rowCardStub } from '@market/basket-format.js';
import {
  balanceDiscount,
  cartTotals,
  groupBySeller,
  nextSelectAll,
  purchasedLabel,
  reconcileRow,
  sellerKeyOf,
} from '@market/cart-model.js';
import { cartItemFromOffer } from '@market/cart-rows.js';
import { nudgeFromParcels } from '@market/cart-shipping.js';
import { eurCentsFromPkn } from '@market/shipping-quote.js';
import {
  BasketRow,
  BasketSummary,
  FlexCard,
  ImportantMessages,
  SellerBar,
  SubtotalAmount,
} from '../components/basket/Basket.jsx';
import {
  ListingCard,
  RailShelf,
  RecentList,
  Shelf,
  ThumbShelf,
  TileCard,
  YourItems,
} from '../components/basket/BasketShelf.jsx';
import {
  createBuyAgain,
  createCardTiles,
  createCartLive,
  createInspired,
  createRecentIds,
  createRecommendations,
  createSellerShelves,
  readWatchIds,
} from '../lib/cart-rails.js';
import { createDeliveryCountry, createLiveShipping } from '../lib/cart-shipping.js';
import { availablePkn } from '../stores/account.js';
import { authUser, signedIn } from '../stores/auth.js';
import { buyerCurrency } from '../stores/buyer.js';
import {
  cartGift,
  cartItems,
  cartSaved,
  removeCartItem,
  setCartQty,
} from '../stores/cart.js';
import {
  applyCartLive,
  cartInsurance,
  cartShippingChoice,
  cartUseBalance,
  clearCart,
  moveSavedToCart,
  removeSavedItem,
  replaceCartItem,
  restoreCartItem,
  restoreCartItems,
  saveCartItemForLater,
  selectAllCartItems,
  selectCartItem,
  setCartGift,
  setCartInsurance,
  setCartShippingChoice,
  setCartUseBalance,
} from '../stores/cart-actions.js';
import { authSession } from '../stores/session.js';
import '@market/cart.css';

const NONE = [];

/** Amazon's "… was removed from Shopping Basket" with an undo. */
function RemovedNote(props) {
  return (
    <Show when={props.removed}>
      {(removed) => (
        <p class="bk-removed" role="status">
          <Show
            when={removed().all}
            fallback={<><b>{removed().row.name}</b> was removed from your cart.</>}
          >
            <b>{removed().rows.length} {removed().rows.length === 1 ? 'item was' : 'items were'}</b> removed from your cart.
          </Show>
          {' '}
          <button type="button" class="bk-link" onClick={() => props.onUndo()}>Undo</button>
        </p>
      )}
    </Show>
  );
}

/**
 * /cart (market/src/pages/Cart.jsx) in Amazon's basket layout: ticked rows
 * check out, unticked rows stay; every row is re-checked against its live
 * listing; one parcel per seller. Signed in, the cart is the account's, and
 * the carousels come from GET /api/marketplace-recommendations — the
 * client-side rails only run when that API cannot answer.
 */
export default function Cart() {
  const items = cartItems;
  const saved = cartSaved;
  const uid = () => (signedIn() ? String(authUser()?.uid || authSession()?.uid || '') : '');
  const delivery = createDeliveryCountry();
  const [removed, setRemoved] = createSignal(null);

  onSettled(() => {
    document.title = 'Cart · Pokoin';
  });

  const totals = createMemo(() => cartTotals(items()));
  const groups = createMemo(() => groupBySeller(items()));
  // The buyer's pick wins over the saved address / browser country.
  const country = () => cartShippingChoice().country || delivery().country;
  const service = () => cartShippingChoice().service;
  const liveShip = createLiveShipping({
    groups,
    to: country,
    service,
    parcelPicks: () => cartShippingChoice().parcels || {},
    subtotalPkn: () => totals().selectedSubtotalPkn,
  });
  const nudge = createMemo(() => nudgeFromParcels(groups(), liveShip.shipping().parcels));
  const discount = createMemo(() => balanceDiscount({
    balancePkn: signedIn() ? availablePkn() : 0,
    items: items(),
    shippingCents: liveShip.shipping().cents,
  }));

  const live = createCartLive({ items, saved, applyLive: applyCartLive, excludeSellerUid: uid });
  const liveByRow = createMemo(() => {
    const out = new Map();
    const entries = live.live();
    for (const row of items()) {
      const entry = entries[String(row.cardId)];
      if (entry) {
        out.set(row.id, reconcileRow(row, entry.listings, { complete: entry.complete, excludeSellerUid: uid() }));
      }
    }
    return out;
  });

  // Personal rails from the API; the client rails are the fallback only.
  const recentIds = createRecentIds();
  const watchIds = readWatchIds();
  const recs = createRecommendations({ items, recentIds, watchIds: () => watchIds });
  const serverRails = () => recs().status === 'ready';
  const fallback = () => recs().status === 'failed';
  const railById = createMemo(() => new Map(recs().rails.map((rail) => [rail.id, rail])));

  const recent = createCardTiles(() => (fallback() ? recentIds() : NONE));
  const watch = createCardTiles(() => (fallback() ? watchIds : NONE));
  const again = createBuyAgain(() => (fallback() ? uid() : ''));
  const againIds = createMemo(() => again.cards().map((row) => row.cardId));
  // Paid cards the tile API does not know still show from the order's name.
  const againTiles = createCardTiles(againIds, () => buyAgainFallback(again.cards()));
  const inspired = createInspired(
    () => (fallback() ? recent.cards() : NONE),
    () => [...recentIds(), ...items().map((row) => row.cardId)],
  );
  const shelves = createSellerShelves(() => (fallback() ? groups() : NONE));
  const inCart = createMemo(() => new Set(items().map((row) => String(row.listingId || row.id))));

  // Server items carry live availability: no offer means no copy for sale.
  const recentItems = createMemo(() => (serverRails()
    ? (railById().get('recent')?.items || NONE).map((item) => ({ ...item, known: true }))
    : recent.cards().map((card) => ({ card, offer: null, known: false }))));
  const buyAgain = createMemo(() => {
    if (serverRails()) {
      return (railById().get('buy_again')?.items || NONE).map((item) => ({
        card: item.card,
        offer: item.offer,
        note: purchasedLabel(item.purchasedAt),
        known: true,
      }));
    }
    const notes = new Map(again.cards().map((row) => [row.cardId, purchasedLabel(row.purchasedAt)]));
    return againTiles.cards().map((card) => ({ card, offer: null, note: notes.get(String(card.id)) || '' }));
  });

  const selectable = () => items().filter((row) => !row.unavailable);
  const selectAllNext = () => nextSelectAll(selectable());

  function remove(row) {
    setRemoved({ row, index: items().findIndex((item) => item.id === row.id) });
    live.dismissRow(row.id);
    removeCartItem(row.id);
  }

  /** The old cart's Clear: everything goes, one Undo brings it back. */
  function removeAll() {
    const rows = items();
    if (!rows.length) return;
    setRemoved({ all: true, rows });
    rows.forEach((row) => live.dismissRow(row.id));
    clearCart();
  }

  function undo() {
    const note = removed();
    if (!note) return;
    if (note.all) restoreCartItems(note.rows);
    else restoreCartItem(note.row, note.index);
    setRemoved(null);
  }

  function swap(row, offer) {
    live.dismissRow(row.id);
    replaceCartItem(row.id, cartItemFromOffer(rowCardStub(row), offer));
  }

  const railEmpty = () => !items().length && !recentItems().length;
  // The "… was removed" note sits where the deleted line was, like Amazon's.
  const removedSlot = createMemo(() => removedNoteSlot(removed(), groups(), items(), sellerKeyOf));
  const bottomRails = () => (serverRails() ? recs().rails.filter((rail) => rail.id !== 'recent') : NONE);

  return (
    <div class="page desk bk-page">
      <div class={['bk-layout', { 'is-empty': !items().length, 'no-rail': railEmpty() }]}>
        <div class="bk-main">
          <section class="bk-card bk-basket" aria-labelledby="bk-title">
            <Show
              when={items().length}
              fallback={(
                <div class="bk-empty">
                  <h1 class="bk-h1" id="bk-title">Your Pokoin cart is empty</h1>
                  <RemovedNote removed={removed()} onUndo={undo} />
                  <p>
                    {signedIn()
                      ? 'Your cart follows your account on every device. Open a card and add a listing from its Shop, or drop cards on the cart tray.'
                      : 'Open a card and add a listing from its Shop, or drop cards on the cart tray. Sign in to keep your cart on every device.'}
                  </p>
                  <div class="bk-empty-links">
                    <a class="btn" href="/marketplace">Browse the marketplace</a>
                    <Show when={!saved().length}><a class="bk-link" href="/marketplace/watchlist">Open your watchlist</a></Show>
                  </div>
                </div>
              )}
            >
              <h1 class="bk-h1" id="bk-title">Shopping Cart</h1>
              <div class="bk-head-links">
                <Show when={selectable().length}>
                  <button type="button" class="bk-link" onClick={() => selectAllCartItems(selectAllNext())}>
                    {selectAllNext() ? 'Select all items' : 'Deselect all items'}
                  </button>
                </Show>
                <button type="button" class="bk-link" onClick={removeAll}>Delete all</button>
                <a class="bk-link" href="/marketplace">Continue shopping</a>
              </div>
              <ImportantMessages messages={live.messages()} onDismiss={live.dismiss} />
              <Show when={removed() && !removedSlot()}><RemovedNote removed={removed()} onUndo={undo} /></Show>
              <div class="bk-price-label" aria-hidden="true">Price</div>
              <For each={groups()} keyed={(group) => group.key}>
                {(group) => (
                  <div class="bk-group">
                    <SellerBar group={group()} estimate={liveShip.estimates()[group().key]} currency={buyerCurrency()} />
                    <For each={group().rows} keyed={(row) => row.id}>
                      {(row) => (
                        <>
                          <Show when={removedSlot()?.groupKey === group().key && removedSlot().beforeId === row().id}>
                            <RemovedNote removed={removed()} onUndo={undo} />
                          </Show>
                          <BasketRow
                            row={row()}
                            live={liveByRow().get(row().id)}
                            checking={live.checking()}
                            onSelect={(on) => selectCartItem(row().id, on)}
                            onQty={(qty) => setCartQty(row().id, qty)}
                            onDelete={() => remove(row())}
                            onSave={() => {
                              live.dismissRow(row().id);
                              saveCartItemForLater(row().id);
                            }}
                            onSwap={(offer) => swap(row(), offer)}
                          />
                        </>
                      )}
                    </For>
                    <Show when={removedSlot()?.groupKey === group().key && !removedSlot().beforeId}>
                      <RemovedNote removed={removed()} onUndo={undo} />
                    </Show>
                  </div>
                )}
              </For>
              <div class="bk-subtotal-line">
                Subtotal ({totals().selectedCount} {totals().selectedCount === 1 ? 'item' : 'items'}):{' '}
                <SubtotalAmount pricePkn={totals().selectedSubtotalPkn} />
              </div>
            </Show>
          </section>

          <YourItems
            saved={saved()}
            buyAgain={buyAgain()}
            buyAgainLoading={recs().status === 'loading' || (fallback() && (again.loading() || againTiles.loading()))}
            signedIn={signedIn()}
            onMove={(id) => moveSavedToCart(id)}
            onDeleteSaved={(id) => removeSavedItem(id)}
          />

          <p class="bk-legal">
            Prices and stock follow each seller&apos;s live listing: the cart shows the most recent price and checks
            stock every time you open it. Each seller ships their cards as one parcel; checkout quotes shipping to
            your address. {signedIn() ? 'Your cart and Saved for later are kept on your account.' : 'Sign in to keep this cart on your account.'}
          </p>
        </div>

        <Show when={items().length}>
          <aside class="bk-summary-slot" aria-label="Order summary">
            <BasketSummary
              totals={totals()}
              shipping={liveShip.shipping()}
              nudge={nudge()}
              country={country()}
              countrySaved={delivery().saved && !cartShippingChoice().country}
              services={liveShip.services()}
              service={service()}
              onCountry={(code) => setCartShippingChoice({ country: code })}
              onService={(id) => setCartShippingChoice({ service: id })}
              onParcelService={(key, id) => setCartShippingChoice({ parcel: { key, service: id } })}
              currency={buyerCurrency()}
              signedIn={signedIn()}
              availablePkn={availablePkn()}
              discount={discount()}
              useBalance={cartUseBalance()}
              onUseBalance={setCartUseBalance}
              gift={cartGift()}
              onGift={setCartGift}
              insurance={cartInsurance()}
              onInsurance={setCartInsurance}
              subtotalEurCents={eurCentsFromPkn(totals().selectedSubtotalPkn)}
            />
          </aside>
        </Show>

        <aside class="bk-rail">
          <Show when={items().length}><FlexCard parcels={liveShip.shipping().count} /></Show>
          <RecentList items={recentItems()} />
        </aside>
      </div>

      <For each={bottomRails()}>
        {(rail) => (
          <RailShelf
            rail={rail}
            inCart={inCart()}
            note={rail.id === 'buy_again' ? (item) => purchasedLabel(item.purchasedAt) : null}
          />
        )}
      </For>

      <Show when={fallback() && buyAgain().length}>
        <Shelf title="Buy it again">
          <For each={buyAgain()}>{(item) => <TileCard card={item.card} note={item.note} />}</For>
        </Shelf>
      </Show>

      <Show when={fallback()}>
        <For each={shelves()}>
          {(seller) => {
            // Amazon never recommends what is already in the basket.
            const rows = () => (seller.listings || []).filter((offer) => !inCart().has(String(offer.id))).slice(0, 24);
            return (
              <Show when={rows().length}>
                <Shelf
                  title={`More from ${seller.handle}`}
                  extra={<span class="bk-shelf-sub">Ships in the same parcel as your other {seller.handle} cards</span>}
                >
                  <For each={rows()}>{(offer) => <ListingCard offer={offer} />}</For>
                </Shelf>
              </Show>
            );
          }}
        </For>
      </Show>

      <Show when={fallback() && inspired.cards().length}>
        <Shelf
          title="Inspired by your browsing history"
          extra={<span class="bk-shelf-sub">More printings of {inspired.names().join(' and ')}</span>}
        >
          <For each={inspired.cards()}>{(card) => <TileCard card={card} />}</For>
        </Shelf>
      </Show>

      <Show when={fallback() && watch.cards().length}>
        <Shelf
          title="From your watchlist"
          extra={<a class="bk-link bk-shelf-sub" href="/marketplace/watchlist">See your watchlist</a>}
        >
          <For each={watch.cards()}>{(card) => <TileCard card={card} />}</For>
        </Shelf>
      </Show>

      <ThumbShelf title="Your browsing history" cards={recentItems().map((item) => item.card)} />
    </div>
  );
}
