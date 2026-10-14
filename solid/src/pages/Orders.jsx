import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { useLocation, useSearchParams } from '@solidjs/router';
import {
  cancelEurOrder,
  confirmMarketplaceDelivery,
  markMarketplaceShipped,
  reportMarketplaceProblem,
  revealMarketplaceShipping,
} from '@market/api.js';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '@market/buyer-protection.js';
import { estimatedDeliveryDate, optInFields, showReviewsOptIn } from '@market/google-reviews.js';
import {
  ORDER_CLOCK_MS,
  mergeOrders,
  orderFlags,
  orderItemsTitle,
  orderMoneyLabel,
  orderStamp,
  refundedLabel,
  watchOrders,
} from '@market/order-rows.js';
import {
  canResumePayment,
  filterOrdersByArchive,
  fulfillmentLabel,
  holdMinutesLeft,
  orderStatus,
  visibleOrders,
} from '@market/order-status.js';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';
import RequireSignIn from '../components/RequireSignIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { authUser, getBearer } from '../stores/auth.js';
import { settleCheckout } from '../stores/cart-actions.js';

function OrdersDesk(props) {
  const uid = () => String(authUser()?.uid || '');
  const [bought, setBought] = createSignal(null);
  const [sold, setSold] = createSignal(null);
  const [error, setError] = createSignal('');
  const [busyId, setBusyId] = createSignal('');
  const [addresses, setAddresses] = createSignal({});
  const [trackingDraft, setTrackingDraft] = createSignal({});
  const [now, setNow] = createSignal(Date.now());
  const [archived, setArchived] = createSignal(false);

  createEffect(uid, (id) => {
    if (!id) {
      setBought(null);
      setSold(null);
      return undefined;
    }
    const stopBuys = watchOrders(id, 'uid', {
      onRows: (rows) => {
        setBought(() => rows);
        setError('');
      },
      onError: (err) => setError(err.message || 'Orders failed.'),
    });
    const stopSales = watchOrders(id, 'sellerUids', {
      onRows: (rows) => setSold(() => rows),
      onError: (err) => setError(err.message || 'Orders failed.'),
    });
    return () => {
      stopBuys();
      stopSales();
    };
  });

  // Hold countdowns on unpaid EUR orders.
  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), ORDER_CLOCK_MS);
    return () => clearInterval(timer);
  });

  // No checkout record on this browser: match the paid order's listings instead.
  createEffect(
    () => {
      const id = props.settleOrder;
      const order = id ? (bought() || []).find((row) => row.id === id) : null;
      return order || null;
    },
    (order) => {
      if (!order) return;
      const listingIds = (Array.isArray(order.items) ? order.items : [])
        .map((item) => String(item?.listingId || ''))
        .filter(Boolean);
      settleCheckout({ listingIds });
      props.onCartSettled();
    },
  );

  // Google Customer Reviews opt-in for the order Stripe just returned —
  // only that order, and only when something is actually mailed.
  createEffect(
    () => {
      const id = props.focusOrder;
      return id ? (bought() || []).find((row) => row.id === id) || null : null;
    },
    (order) => {
      if (!order || String(order.fulfillmentMode || '') === 'nft_only') return;
      showReviewsOptIn(optInFields({
        orderId: order.id,
        email: order.buyerEmail || untrack(authUser)?.email,
        deliveryCountry: order.shippingAddressCountryCode,
        estimatedDelivery: estimatedDeliveryDate({
          orderedAt: order.createdAt,
          shipments: order.shipments,
          toCountry: order.shippingAddressCountryCode,
        }),
      }));
    },
  );

  const allRows = createMemo(() => visibleOrders(mergeOrders(bought(), sold()), uid()));
  const rows = createMemo(() => filterOrdersByArchive(allRows(), archived()));

  async function run(orderId, fn) {
    setBusyId(orderId);
    setError('');
    try {
      const token = await getBearer();
      const result = await fn(token);
      if (result?.shippingAddress) {
        setAddresses((current) => ({ ...current, [orderId]: result.shippingAddress }));
      }
      if (result?.order?.trackingCode) {
        setTrackingDraft((current) => {
          const next = { ...current };
          delete next[orderId];
          return next;
        });
      }
    } catch (err) {
      setError(err.message || 'Order update failed.');
    } finally {
      setBusyId('');
    }
  }

  return (
    <div class="page desk">
      <PageHead kicker="Account" title="Orders" lede={`${ESCROW_LINE} ${NO_SHIP_GUARANTEE}`}>
        <a class="btn ghost" href="/protection">Buyer protection</a>
        <a class="btn ghost" href="/bought">Buy history</a>
        <a class="btn ghost" href="/sales">Sold history</a>
        <a class="btn ghost" href="/cart">Cart</a>
      </PageHead>
      <StockNav />
      <Alert>{error()}</Alert>
      <Show when={props.notice}><p class="desk-ok">{props.notice}</p></Show>
      <Show when={bought() == null && sold() == null && !error()}>
        <DeskPanel title="History"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={(bought() != null || sold() != null) && !allRows().length}>
        <EmptyDesk title="No orders yet" lede="Checkout a native listing with site PKN or Stripe.">
          <a class="btn" href="/marketplace">Shop</a>
        </EmptyDesk>
      </Show>
      <Show when={allRows().length}>
        <DeskPanel
          flush
          title={`${rows().length} ${archived() ? 'archived ' : ''}order${rows().length === 1 ? '' : 's'}`}
          extra={(
            <div class="order-archive-toggle" role="group" aria-label="Order list">
              <button type="button" class={{ on: !archived() }} aria-pressed={!archived()} onClick={() => setArchived(false)}>Live</button>
              <button type="button" class={{ on: archived() }} aria-pressed={archived()} onClick={() => setArchived(true)}>Archived</button>
            </div>
          )}
        >
          <div class="thread-list">
            <For
              each={rows()}
              fallback={(
                <p class="page-lede" style={{ padding: '1rem' }}>
                  {archived()
                    ? 'No archived orders — expired or cancelled checkouts land here.'
                    : 'No live orders right now.'}
                </p>
              )}
            >
              {(row) => {
                const flags = () => orderFlags(row, uid());
                const status = () => orderStatus(row);
                const step = () => fulfillmentLabel(row);
                const resumable = () => flags().buyer && canResumePayment(row, now());
                const address = () => addresses()[row.id];
                const tracking = () => trackingDraft()[row.id] ?? row.trackingCode ?? '';
                const sellerNeedsShip = () => flags().seller && (flags().escrow || (flags().eur && flags().paid)) && !flags().shipped;
                return (
                  <article class={['thread order-row', { 'is-focus': props.focusOrder === row.id }]}>
                    <span class="thread-main">
                      <strong class="thread-title">
                        {orderItemsTitle(row)}
                        {' '}
                        <span class={`pill order-pill is-${status().tone}`}>{status().label}</span>
                      </strong>
                      <span class="thread-meta">
                        {flags().buyer ? 'Bought' : 'Sold'}
                        {step() ? ` · ${step()}` : ''}
                        {' · '}
                        {orderMoneyLabel(row)}
                        {refundedLabel(row, flags().refunded)}
                        {' · '}
                        {orderStamp(row.createdAt) || '—'}
                        {' · '}
                        <span class="order-id">{row.id}</span>
                      </span>
                      <Show when={row.trackingCode}>
                        <span class="thread-meta">Tracking {row.trackingCode}</span>
                      </Show>
                      <Show when={resumable()}>
                        <span class="thread-meta">
                          Cards held for you for {holdMinutesLeft(row, now())} more min. Not charged until you pay.
                        </span>
                      </Show>
                      <Show when={flags().buyer && flags().nothingCharged}>
                        <span class="thread-meta">Nothing was charged. The cards went back on sale.</span>
                      </Show>
                      <Show when={address()}>
                        {(a) => (
                          <span class="thread-meta">
                            Ship to {a().fullName}, {a().addressLine1}, {a().postalCode} {a().city}, {a().countryCode}
                          </span>
                        )}
                      </Show>
                      <Show when={sellerNeedsShip()}>
                        <label class="order-tracking-field">
                          Tracking code
                          <input
                            value={tracking()}
                            onInput={(event) => setTrackingDraft((current) => ({
                              ...current,
                              [row.id]: event.target.value,
                            }))}
                            placeholder="Carrier tracking number"
                            autocomplete="off"
                          />
                        </label>
                      </Show>
                    </span>
                    <span class="order-actions">
                      <Show when={resumable()}>
                        <a class="btn" href={row.stripeCheckoutUrl}>Pay now</a>
                      </Show>
                      <Show when={flags().buyer && row.paymentStatus === 'pending_stripe'}>
                        <button
                          class="btn ghost"
                          type="button"
                          disabled={busyId() === row.id}
                          onClick={() => run(row.id, (token) => cancelEurOrder(row.id, token))}
                        >
                          Cancel
                        </button>
                      </Show>
                      <Show when={flags().seller && (flags().paid || flags().escrow)}>
                        <a class="btn ghost" href={`/sales#${row.id}`}>Refund</a>
                      </Show>
                      <Show when={flags().buyer && (flags().escrow || (flags().eur && flags().paid))}>
                        <button
                          class="btn"
                          type="button"
                          disabled={busyId() === row.id || row.fulfillmentStatus === 'delivered' || row.paymentStatus === 'released'}
                          onClick={() => run(row.id, (token) => confirmMarketplaceDelivery(row.id, token))}
                        >
                          Confirm delivery
                        </button>
                      </Show>
                      <Show when={sellerNeedsShip()}>
                        <button
                          class="btn ghost"
                          type="button"
                          disabled={busyId() === row.id || !String(tracking()).trim()}
                          onClick={() => run(row.id, (token) => markMarketplaceShipped(row.id, token, {
                            trackingCode: String(tracking()).trim(),
                          }))}
                        >
                          Mark shipped
                        </button>
                      </Show>
                      <Show when={flags().seller && flags().eur && (flags().paid || flags().escrow) && !address()}>
                        <button
                          class="btn ghost"
                          type="button"
                          disabled={busyId() === row.id}
                          onClick={() => run(row.id, (token) => revealMarketplaceShipping(row.id, token))}
                        >
                          Show address
                        </button>
                      </Show>
                      <Show when={flags().buyer && flags().escrow && !flags().open}>
                        <button
                          class="btn ghost"
                          type="button"
                          disabled={busyId() === row.id}
                          onClick={() => run(row.id, (token) => reportMarketplaceProblem({
                            orderId: row.id,
                            reason: flags().shipped ? 'not_as_described' : 'not_shipped',
                          }, token))}
                        >
                          Report a problem
                        </button>
                      </Show>
                    </span>
                  </article>
                );
              }}
            </For>
          </div>
        </DeskPanel>
      </Show>
    </div>
  );
}

/** /orders (market/src/pages/Orders.jsx): bought and sold orders, live from Firestore. */
export default function Orders() {
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const [notice, setNotice] = createSignal('');
  const [focusOrder, setFocusOrder] = createSignal('');
  // Order whose cart rows still need removing once its Firestore doc arrives.
  const [settleOrder, setSettleOrder] = createSignal('');
  let settledSession = '';

  onSettled(() => {
    document.title = 'Orders · Pokoin';
  });

  // Back from Stripe (?eur_session=…&order=…): the cards are held for this
  // order, so its cart rows go (unticked rows stay). "Paid" shows once
  // Stripe's webhook confirms — the row updates live.
  createEffect(
    () => {
      const params = new URLSearchParams(location.search);
      return [String(params.get('eur_session') || '').trim(), String(params.get('order') || '').trim()];
    },
    ([eurSession, returnedOrder]) => {
      if (!eurSession || settledSession === eurSession) return;
      settledSession = eurSession;
      if (!settleCheckout() && returnedOrder) setSettleOrder(returnedOrder);
      setFocusOrder(returnedOrder);
      setNotice('Payment submitted. The order turns Paid as soon as Stripe confirms it.');
      setSearchParams({ eur_session: undefined, order: undefined }, { replace: true });
    },
  );

  return (
    <RequireSignIn>
      <OrdersDesk
        notice={notice()}
        focusOrder={focusOrder()}
        settleOrder={settleOrder()}
        onCartSettled={() => setSettleOrder('')}
      />
    </RequireSignIn>
  );
}
