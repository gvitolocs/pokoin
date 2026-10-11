import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { cancelEurOrder, confirmMarketplaceDelivery, reportMarketplaceProblem } from '@market/api.js';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '@market/buyer-protection.js';
import {
  ORDER_CLOCK_MS,
  orderFlags,
  orderItemsTitle,
  orderMoneyLabel,
  orderStamp,
  refundedLabel,
  sortOrdersByDate,
  watchOrders,
} from '@market/order-rows.js';
import {
  canResumePayment,
  filterOrdersByArchive,
  fulfillmentLabel,
  holdMinutesLeft,
  orderStatus,
} from '@market/order-status.js';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';
import RequireSignIn from '../components/RequireSignIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { authUser, getBearer } from '../stores/auth.js';

function BoughtDesk() {
  const uid = () => String(authUser()?.uid || '');
  const [rows, setRows] = createSignal(null);
  const [error, setError] = createSignal('');
  const [busyId, setBusyId] = createSignal('');
  const [now, setNow] = createSignal(Date.now());
  const [archived, setArchived] = createSignal(false);

  createEffect(uid, (id) => {
    if (!id) {
      setRows(null);
      return undefined;
    }
    return watchOrders(id, 'uid', {
      onRows: (list) => {
        setRows(() => sortOrdersByDate(list));
        setError('');
      },
      onError: (err) => setError(err.message || 'Buy history failed.'),
    });
  });

  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), ORDER_CLOCK_MS);
    return () => clearInterval(timer);
  });

  async function run(orderId, fn) {
    setBusyId(orderId);
    setError('');
    try {
      const token = await getBearer();
      await fn(token);
    } catch (err) {
      setError(err.message || 'Order update failed.');
    } finally {
      setBusyId('');
    }
  }

  const shown = createMemo(() => filterOrdersByArchive(rows() || [], archived()));

  return (
    <div class="page desk">
      <PageHead kicker="Account" title="Buy history" lede={`${ESCROW_LINE} ${NO_SHIP_GUARANTEE}`}>
        <a class="btn ghost" href="/protection">Buyer protection</a>
        <a class="btn ghost" href="/cart">Cart</a>
      </PageHead>
      <StockNav />
      <Alert>{error()}</Alert>
      <Show when={rows() == null && !error()}>
        <DeskPanel title="Purchases"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={rows() && !rows().length}>
        <EmptyDesk title="No purchases yet" lede="Checkout a native listing with site PKN or Stripe.">
          <a class="btn" href="/marketplace">Shop</a>
        </EmptyDesk>
      </Show>
      <Show when={rows()?.length}>
        <DeskPanel
          flush
          title={`${shown().length} ${archived() ? 'archived' : 'purchase'}${shown().length === 1 ? '' : 's'}`}
          extra={(
            <div class="order-archive-toggle" role="group" aria-label="Purchase list">
              <button type="button" class={{ on: !archived() }} aria-pressed={!archived()} onClick={() => setArchived(false)}>
                Live
              </button>
              <button type="button" class={{ on: archived() }} aria-pressed={archived()} onClick={() => setArchived(true)}>
                Archived
              </button>
            </div>
          )}
        >
          <div class="thread-list">
            <For
              each={shown()}
              fallback={(
                <p class="page-lede" style={{ padding: '1rem' }}>
                  {archived()
                    ? 'No archived purchases — expired or cancelled checkouts land here.'
                    : 'No live purchases right now.'}
                </p>
              )}
            >
              {(row) => {
                const flags = () => orderFlags(row, uid());
                const status = () => orderStatus(row);
                const step = () => fulfillmentLabel(row);
                const resumable = () => canResumePayment(row, now());
                return (
                  <article class="thread order-row">
                    <span class="thread-main">
                      <strong class="thread-title">
                        {orderItemsTitle(row)}
                        {' '}
                        <span class={`pill order-pill is-${status().tone}`}>{status().label}</span>
                      </strong>
                      <span class="thread-meta">
                        Bought
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
                      <Show when={flags().nothingCharged}>
                        <span class="thread-meta">Nothing was charged. The cards went back on sale.</span>
                      </Show>
                    </span>
                    <span class="order-actions">
                      <Show when={resumable()}>
                        <a class="btn" href={row.stripeCheckoutUrl}>Pay now</a>
                      </Show>
                      <Show when={row.paymentStatus === 'pending_stripe'}>
                        <button
                          class="btn ghost"
                          type="button"
                          disabled={busyId() === row.id}
                          onClick={() => run(row.id, (token) => cancelEurOrder(row.id, token))}
                        >
                          Cancel
                        </button>
                      </Show>
                      <Show when={flags().escrow || (flags().eur && flags().paid)}>
                        <button
                          class="btn"
                          type="button"
                          disabled={busyId() === row.id || row.fulfillmentStatus === 'delivered' || row.paymentStatus === 'released'}
                          onClick={() => run(row.id, (token) => confirmMarketplaceDelivery(row.id, token))}
                        >
                          Confirm delivery
                        </button>
                      </Show>
                      <Show when={flags().escrow && !flags().open}>
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

/** /bought: the signed-in buyer's purchases. */
export default function Bought() {
  onSettled(() => {
    document.title = 'Buy history · Pokoin';
  });
  return (
    <RequireSignIn>
      <BoughtDesk />
    </RequireSignIn>
  );
}
