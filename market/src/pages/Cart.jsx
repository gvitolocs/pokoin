import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import {
  cartTotals,
  groupBySeller,
  isSelected,
  nextSelectAll,
  parcelNudge,
  purchasedLabel,
  reconcileRow,
  rowTotalPkn,
  sellerKeyOf,
  shippingEstimate,
} from '../cart-model.js';
import {
  useBuyAgain,
  useCardTiles,
  useCartLive,
  useDeliveryCountry,
  useInspired,
  useRecentIds,
  useRecommendations,
  useSellerShelves,
  useWatchlistIds,
} from '../cart-rails.js';
import { pknBalanceVoucher } from '../checkout-fees.js';
import { fiatFromPkn, formatLocalFromEurCents } from '../pkn.js';
import { readPknDiscount, readShippingService, writePknDiscount, writeShippingService } from '../shipping-choice.js';
import { defaultShippingService, shippingServiceOptions } from '../shipping-quote.js';
import { useBuyerCurrency } from '../use-buyer-currency.js';
import {
  BasketRow,
  BasketSummary,
  FlexCard,
  ImportantMessages,
  SellerBar,
  SubtotalAmount,
} from '../components/Basket.jsx';
import {
  ListingCard,
  RailShelf,
  RecentList,
  Shelf,
  ThumbShelf,
  TileCard,
  YourItems,
} from '../components/BasketShelf.jsx';
import '../cart.css';

const NONE = [];

/** Amazon's "… was removed from Shopping Basket" with an undo. */
function RemovedNote({ removed, onUndo }) {
  if (!removed) return null;
  return (
    <p className="bk-removed" role="status">
      {removed.all
        ? <><b>{removed.rows.length} {removed.rows.length === 1 ? 'item was' : 'items were'}</b> removed from your cart.</>
        : <><b>{removed.row.name}</b> was removed from your cart.</>}
      {' '}
      <button type="button" className="bk-link" onClick={onUndo}>Undo</button>
    </p>
  );
}

/**
 * /cart in Amazon's basket layout: ticked rows check out, unticked rows stay;
 * every row is re-checked against its live listing; one parcel per seller.
 * Signed in, the cart is the account's (synced across devices), and the
 * carousels come from GET /api/marketplace-recommendations — the client-side
 * rails below only run when that API cannot answer.
 */
export default function Cart() {
  const cart = useCart();
  const { items, saved, gift } = cart;
  const { signedIn, availablePkn, user, profile, getBearer } = useAuth();
  const buyer = useBuyerCurrency();
  const uid = user?.uid || profile?.uid || '';
  const delivery = useDeliveryCountry({ signedIn, getBearer });
  const [removed, setRemoved] = useState(null);
  const [shippingService, setShippingService] = useState(() => readShippingService());
  const [usePknDiscount, setUsePknDiscount] = useState(() => readPknDiscount());

  useEffect(() => {
    document.title = 'Cart · Pokoin';
  }, []);

  const totals = useMemo(() => cartTotals(items), [items]);
  const groups = useMemo(() => groupBySeller(items), [items]);
  const shipOptions = useMemo(() => {
    for (const group of groups) {
      if (!group.selectedCount || !group.sellerCountry) continue;
      const options = shippingServiceOptions({
        fromCountry: group.sellerCountry,
        toCountry: delivery.country,
        cardCount: group.selectedCount,
      }).filter((row) => !row.unavailable);
      if (options.length) return options;
    }
    return [];
  }, [groups, delivery.country]);
  const activeService = shipOptions.some((row) => row.id === shippingService)
    ? shippingService
    : defaultShippingService(shipOptions);
  const shipping = useMemo(
    () => shippingEstimate(groups, delivery.country, activeService),
    [groups, delivery.country, activeService],
  );
  const estimates = useMemo(
    () => Object.fromEntries(shipping.parcels.map((parcel) => [parcel.key, parcel.estimate])),
    [shipping],
  );
  const nudge = useMemo(
    () => parcelNudge(groups, delivery.country, activeService),
    [groups, delivery.country, activeService],
  );
  const discount = useMemo(() => {
    const eligiblePkn = items.reduce((sum, row) => (
      isSelected(row) && row.sellerAcceptsPkn !== false ? sum + rowTotalPkn(row) : sum
    ), 0);
    const itemCents = Math.round((Number(fiatFromPkn(totals.selectedSubtotalPkn, 'EUR')) || 0) * 100);
    return pknBalanceVoucher({
      availablePkn,
      eligiblePkn,
      chargeEurCents: itemCents + (Number(shipping.cents) || 0),
    });
  }, [items, totals.selectedSubtotalPkn, availablePkn, shipping.cents]);

  const live = useCartLive({ items, saved, applyLive: cart.applyLive, excludeSellerUid: uid });
  const liveByRow = useMemo(() => {
    const out = new Map();
    for (const row of items) {
      const entry = live.live[String(row.cardId)];
      if (entry) {
        out.set(row.id, reconcileRow(row, entry.listings, { complete: entry.complete, excludeSellerUid: uid }));
      }
    }
    return out;
  }, [items, live.live, uid]);

  // Personal rails from the API; the client rails are the fallback only.
  const recentIds = useRecentIds(signedIn);
  const watchIds = useWatchlistIds();
  const recs = useRecommendations({ items, recentIds, watchIds });
  const serverRails = recs.status === 'ready';
  const fallback = recs.status === 'failed';
  const railById = useMemo(() => new Map(recs.rails.map((rail) => [rail.id, rail])), [recs.rails]);

  const recent = useCardTiles(fallback ? recentIds : NONE);
  const watch = useCardTiles(fallback ? watchIds : NONE);
  const again = useBuyAgain(fallback ? uid : '');
  const againIds = useMemo(() => again.cards.map((row) => row.cardId), [again.cards]);
  // Paid cards the tile API does not know still show from the order's name.
  const againFallback = useMemo(() => again.cards.map((row) => ({
    id: row.cardId,
    name: row.name,
    canonicalPath: `/marketplace/en/cards/${row.cardId}`,
  })), [again.cards]);
  const againTiles = useCardTiles(againIds, againFallback);
  const inspired = useInspired(fallback ? recent.cards : NONE, {
    exclude: [...recentIds, ...items.map((row) => row.cardId)],
  });
  const shelves = useSellerShelves(fallback ? groups : NONE);
  const inCart = useMemo(() => new Set(items.map((row) => String(row.listingId || row.id))), [items]);

  const recentItems = serverRails
    ? (railById.get('recent')?.items || NONE)
    : recent.cards.map((card) => ({ card, offer: null }));
  const buyAgain = useMemo(() => {
    if (serverRails) {
      return (railById.get('buy_again')?.items || NONE).map((item) => ({
        card: item.card,
        offer: item.offer,
        note: purchasedLabel(item.purchasedAt),
      }));
    }
    const notes = new Map(again.cards.map((row) => [row.cardId, purchasedLabel(row.purchasedAt)]));
    return againTiles.cards.map((card) => ({ card, offer: null, note: notes.get(String(card.id)) || '' }));
  }, [serverRails, railById, again.cards, againTiles.cards]);

  const selectable = items.filter((row) => !row.unavailable);
  const selectAllNext = nextSelectAll(selectable);

  function remove(row) {
    setRemoved({ row, index: items.findIndex((item) => item.id === row.id) });
    live.dismissRow(row.id);
    cart.removeItem(row.id);
  }

  /** The old cart's Clear: everything goes, one Undo brings it back. */
  function removeAll() {
    if (!items.length) return;
    setRemoved({ all: true, rows: items });
    items.forEach((row) => live.dismissRow(row.id));
    cart.clear();
  }

  function undo() {
    if (!removed) return;
    if (removed.all) cart.restoreAll(removed.rows);
    else cart.restoreItem(removed.row, removed.index);
    setRemoved(null);
  }

  function swap(row, offer) {
    live.dismissRow(row.id);
    cart.replaceItem(row.id, cartItemFromOffer({
      id: row.cardId,
      name: row.name,
      canonicalPath: row.href,
      imageUrl: row.image,
      set: row.setName,
    }, offer));
  }

  const railEmpty = !items.length && !recentItems.length;
  // The "… was removed" note sits where the deleted line was, like Amazon's:
  // before the first later row of the same seller, else at that seller's end.
  const removedSlot = useMemo(() => {
    if (!removed || removed.all) return null;
    const key = sellerKeyOf(removed.row);
    const group = groups.find((row) => row.key === key);
    if (!group) return null;
    const index = new Map(items.map((row, at) => [row.id, at]));
    const before = group.rows.find((row) => index.get(row.id) >= removed.index);
    return { groupKey: key, beforeId: before?.id || '' };
  }, [removed, groups, items]);

  const bottomRails = serverRails
    ? recs.rails.filter((rail) => rail.id !== 'recent')
    : NONE;

  return (
    <div className="page desk bk-page">
      <div className={`bk-layout${items.length ? '' : ' is-empty'}${railEmpty ? ' no-rail' : ''}`}>
        <div className="bk-main">
          <section className="bk-card bk-basket" aria-labelledby="bk-title">
            {items.length ? (
              <>
                <h1 className="bk-h1" id="bk-title">Shopping Cart</h1>
                <div className="bk-head-links">
                  {selectable.length ? (
                    <button type="button" className="bk-link" onClick={() => cart.selectAll(selectAllNext)}>
                      {selectAllNext ? 'Select all items' : 'Deselect all items'}
                    </button>
                  ) : null}
                  <button type="button" className="bk-link" onClick={removeAll}>Delete all</button>
                  <Link className="bk-link" to="/marketplace">Continue shopping</Link>
                </div>
                <ImportantMessages messages={live.messages} onDismiss={live.dismiss} />
                {removed && !removedSlot ? <RemovedNote removed={removed} onUndo={undo} /> : null}
                <div className="bk-price-label" aria-hidden="true">Price</div>
                {groups.map((group) => (
                  <div className="bk-group" key={group.key}>
                    <SellerBar group={group} estimate={estimates[group.key]} currency={buyer.currency} />
                    {group.rows.map((row) => (
                      <Fragment key={row.id}>
                        {removedSlot?.groupKey === group.key && removedSlot.beforeId === row.id ? (
                          <RemovedNote removed={removed} onUndo={undo} />
                        ) : null}
                        <BasketRow
                          row={row}
                          live={liveByRow.get(row.id)}
                          checking={live.checking}
                          onSelect={(on) => cart.setSelected(row.id, on)}
                          onQty={(qty) => cart.setQty(row.id, qty)}
                          onDelete={() => remove(row)}
                          onSave={() => {
                            live.dismissRow(row.id);
                            cart.saveForLater(row.id);
                          }}
                          onSwap={(offer) => swap(row, offer)}
                        />
                      </Fragment>
                    ))}
                    {removedSlot?.groupKey === group.key && !removedSlot.beforeId ? (
                      <RemovedNote removed={removed} onUndo={undo} />
                    ) : null}
                  </div>
                ))}
                <div className="bk-subtotal-line">
                  Subtotal ({totals.selectedCount} {totals.selectedCount === 1 ? 'item' : 'items'}):{' '}
                  <SubtotalAmount pricePkn={totals.selectedSubtotalPkn} />
                </div>
              </>
            ) : (
              <div className="bk-empty">
                <h1 className="bk-h1" id="bk-title">Your Pokoin cart is empty</h1>
                <RemovedNote removed={removed} onUndo={undo} />
                <p>
                  {signedIn
                    ? 'Your cart follows your account on every device. Open a card and add a listing from its Shop, or drop cards on the cart tray.'
                    : 'Open a card and add a listing from its Shop, or drop cards on the cart tray. Sign in to keep your cart on every device.'}
                </p>
                <div className="bk-empty-links">
                  <Link className="btn" to="/marketplace">Browse the marketplace</Link>
                  {saved.length ? null : <Link className="bk-link" to="/marketplace/watchlist">Open your watchlist</Link>}
                </div>
              </div>
            )}
          </section>

          <YourItems
            saved={saved}
            buyAgain={buyAgain}
            buyAgainLoading={recs.status === 'loading' || (fallback && (again.loading || againTiles.loading))}
            signedIn={signedIn}
            onMove={(id) => cart.moveToCart(id)}
            onDeleteSaved={(id) => cart.removeSaved(id)}
          />

          <p className="bk-legal">
            Prices and stock follow each seller&apos;s live listing: the cart shows the most recent price and checks
            stock every time you open it. Each seller ships their cards as one parcel; checkout quotes shipping to
            your address. {signedIn ? 'Your cart and Saved for later are kept on your account.' : 'Sign in to keep this cart on your account.'}
          </p>
        </div>

        {items.length ? (
          <aside className="bk-summary-slot" aria-label="Order summary">
            <BasketSummary
              totals={totals}
              shipping={shipping}
              nudge={nudge}
              delivery={delivery}
              currency={buyer.currency}
              signedIn={signedIn}
              availablePkn={availablePkn}
              gift={gift}
              onGift={cart.setGift}
              shipOptions={shipOptions}
              shippingService={activeService}
              onShippingService={(id) => {
                setShippingService(id);
                writeShippingService(id);
              }}
              usePknDiscount={usePknDiscount}
              onPknDiscount={(on) => {
                setUsePknDiscount(on);
                writePknDiscount(on);
              }}
              discountPkn={discount.pkn}
              discountLocal={discount.eurCents
                ? formatLocalFromEurCents(discount.eurCents, buyer.currency)
                : ''}
            />
          </aside>
        ) : null}

        <aside className="bk-rail">
          {items.length ? <FlexCard parcels={shipping.count} /> : null}
          <RecentList items={recentItems} />
        </aside>
      </div>

      {serverRails ? (
        bottomRails.map((rail) => (
          <RailShelf
            key={rail.id}
            rail={rail}
            inCart={inCart}
            note={rail.id === 'buy_again' ? (item) => purchasedLabel(item.purchasedAt) : null}
          />
        ))
      ) : null}

      {fallback && buyAgain.length ? (
        <Shelf title="Buy it again" count={buyAgain.length}>
          {buyAgain.map(({ card, note }) => <TileCard key={card.id} card={card} note={note} />)}
        </Shelf>
      ) : null}

      {fallback ? shelves.map((seller) => {
        // Amazon never recommends what is already in the basket.
        const rows = (seller.listings || []).filter((offer) => !inCart.has(String(offer.id))).slice(0, 24);
        if (!rows.length) return null;
        return (
          <Shelf
            key={seller.handle}
            title={`More from ${seller.handle}`}
            extra={<span className="bk-shelf-sub">Ships in the same parcel as your other {seller.handle} cards</span>}
            count={rows.length}
          >
            {rows.map((offer) => <ListingCard key={offer.id} offer={offer} />)}
          </Shelf>
        );
      }) : null}

      {fallback && inspired.cards.length ? (
        <Shelf
          title="Inspired by your browsing history"
          extra={<span className="bk-shelf-sub">More printings of {inspired.names.join(' and ')}</span>}
          count={inspired.cards.length}
        >
          {inspired.cards.map((card) => <TileCard key={card.id} card={card} />)}
        </Shelf>
      ) : null}

      {fallback && watch.cards.length ? (
        <Shelf
          title="From your watchlist"
          extra={<Link className="bk-link bk-shelf-sub" to="/marketplace/watchlist">See your watchlist</Link>}
          count={watch.cards.length}
        >
          {watch.cards.map((card) => <TileCard key={card.id} card={card} />)}
        </Shelf>
      ) : null}

      <ThumbShelf title="Your browsing history" cards={recentItems.map((item) => item.card)} />
    </div>
  );
}
