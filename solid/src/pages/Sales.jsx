import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { useLocation, useSearchParams } from '@solidjs/router';
import { fetchSoldHistory, imageSrc, markMarketplaceShipped, refundMarketplaceOrder } from '@market/api.js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import {
  SALES_SOURCES,
  saleDay,
  saleLineMoney,
  saleNeedsShip,
  saleStatus,
  saleTitle,
  saleUnitCount,
  salesRefundedLine,
  salesTotals,
  shippedSale,
} from '@market/order-rows.js';
import {
  formatOrderMoney,
  newRefundToken,
  orderStatus,
  refundAmountFromInput,
  refundInputFromAmount,
} from '@market/order-status.js';
import CardArt from '../components/CardArt.jsx';
import { Alert, DeskPanel, EmptyDesk } from '../components/Desk.jsx';
import RequireSignIn from '../components/RequireSignIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { getBearer } from '../stores/auth.js';
import { allowMypokoinPreview, MYPOKOIN_PREVIEW_BANNER, previewSales } from './mypokoin-preview-fixture.js';
import '@market/sales-row.css';

function SaleThumb(props) {
  const name = () => props.item.cardName || 'Card';
  const src = () => imageSrc({ id: props.item.cardId, name: name(), imageUrl: props.item.imageUrl || '' }, 'grid');
  const href = () => (props.item.cardId ? inventoryListingHref(props.item) : '');
  const art = () => (src() ? <CardArt src={src()} alt="" /> : <span class="tile-ph" />);
  return (
    <Show when={href()} fallback={<span class="sale-thumb">{art()}</span>}>
      <a class="sale-thumb" href={href()} aria-label={name()}>{art()}</a>
    </Show>
  );
}

function RefundForm(props) {
  const currency = () => props.row.currency;
  const [amountText, setAmountText] = createSignal(untrack(() => refundInputFromAmount(props.row.refundable, props.row.currency)));
  const [reason, setReason] = createSignal('');
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const token = newRefundToken();
  const amount = () => refundAmountFromInput(amountText(), currency());
  const valid = () => Number.isSafeInteger(amount()) && amount() > 0 && amount() <= props.row.refundable;
  const unit = () => (currency() === 'EUR' ? '€' : 'PKN');

  async function submit(event) {
    event.preventDefault();
    if (!valid()) return;
    if (!confirm()) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const bearer = await getBearer();
      const result = await refundMarketplaceOrder({
        orderId: props.row.orderId,
        amount: amount(),
        reason: reason().trim(),
        clientToken: token,
      }, bearer);
      props.onDone(result);
    } catch (err) {
      setError(err.message || 'Refund failed.');
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="refund-form" onSubmit={submit}>
      <label>
        Refund ({unit()})
        <input
          inputMode="decimal"
          value={amountText()}
          onInput={(event) => { setAmountText(event.target.value); setConfirm(false); }}
          disabled={busy()}
          aria-invalid={!valid()}
        />
      </label>
      <label class="refund-reason">
        Note to buyer
        <input
          value={reason()}
          maxLength={240}
          placeholder="e.g. corner ding not in the photos"
          onInput={(event) => setReason(event.target.value)}
          disabled={busy()}
        />
      </label>
      <span class="refund-hint">
        Up to {formatOrderMoney(props.row.refundable, currency())} left of your share.
        {currency() === 'EUR'
          ? ' Goes back to the buyer’s card; your payout drops by the same amount.'
          : ' Goes back to the buyer’s PKN balance.'}
      </span>
      <span class="refund-buttons">
        <button class="btn" type="submit" disabled={!valid() || busy()}>
          {busy() ? 'Refunding…' : confirm() ? `Confirm refund ${valid() ? formatOrderMoney(amount(), currency()) : ''}` : 'Refund'}
        </button>
        <button class="btn ghost" type="button" onClick={() => props.onCancel()} disabled={busy()}>Close</button>
      </span>
      <Show when={error()}><span class="refund-error" role="status">{error()}</span></Show>
    </form>
  );
}

function SalesDesk(props) {
  const location = useLocation();
  const [sales, setSales] = createSignal(null);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [source, setSource] = createSignal('all');
  const [openId, setOpenId] = createSignal(untrack(() => decodeURIComponent(String(location.hash || '').replace(/^#/, ''))));
  const [shipId, setShipId] = createSignal('');
  const [trackingDraft, setTrackingDraft] = createSignal({});
  const [shipBusy, setShipBusy] = createSignal('');

  onSettled(() => {
    if (props.preview) {
      setSales(previewSales());
      return undefined;
    }
    let cancelled = false;
    getBearer()
      .then((token) => fetchSoldHistory(token))
      .then((data) => { if (!cancelled) setSales(() => data.sales || []); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Sold history failed.'); });
    return () => {
      cancelled = true;
    };
  });

  // /sales#<orderId> (Refund from Orders): bring that sale into view once listed.
  createEffect(
    () => (openId() && sales() ? openId() : ''),
    (id) => {
      if (id) document.getElementById(`sale-${id}`)?.scrollIntoView({ block: 'center' });
    },
  );

  const shown = createMemo(() => (sales() || []).filter((row) => source() === 'all' || row.source === source()));
  const totals = createMemo(() => salesTotals(sales()));

  function applyRefund(orderId, result) {
    setOpenId('');
    setNotice(`Refunded ${formatOrderMoney(result.refund?.amount, result.currency)} on ${orderId}.`);
    if (result.sale) {
      setSales((current) => (current || []).map((row) => (
        row.orderId === orderId && row.source !== 'cardtrader' ? { ...result.sale, source: 'pokoin' } : row
      )));
    }
  }

  async function shipOrder(orderId) {
    const trackingCode = String(trackingDraft()[orderId] || '').trim();
    if (!trackingCode) {
      setError('Add the shipping tracking code before marking shipped.');
      return;
    }
    setShipBusy(orderId);
    setError('');
    try {
      const token = await getBearer();
      const result = await markMarketplaceShipped(orderId, token, { trackingCode });
      setSales((current) => (current || []).map((row) => (
        row.orderId === orderId && row.source !== 'cardtrader' ? shippedSale(row, result, trackingCode) : row
      )));
      setShipId('');
      setNotice(`Marked ${orderId} shipped · ${trackingCode}`);
    } catch (err) {
      setError(err.message || 'Could not mark shipped.');
    } finally {
      setShipBusy('');
    }
  }

  return (
    <div class="page desk mypokoin">
      <Show when={props.preview}>
        <p class="seller-preview-banner" role="status">{MYPOKOIN_PREVIEW_BANNER}</p>
      </Show>
      <StockNav
        title="Sold history"
        lede="Every card that actually sold, on Pokoin and CardTrader."
        metrics={sales() ? [
          { value: totals().count, label: 'Sales' },
          { value: totals().units, label: 'Cards sold' },
          {
            value: totals().eurNet ? formatOrderMoney(totals().eurNet, 'EUR') : '—',
            label: 'EUR after refunds',
            hint: totals().pknNet ? `+ ${formatOrderMoney(totals().pknNet, 'PKN')}` : '',
          },
          { value: salesRefundedLine(totals()), label: 'Refunded' },
        ] : []}
      >
        <a class="btn ghost" href="/inventory/scan">Scan cards</a>
      </StockNav>
      <Alert>{error()}</Alert>
      <Show when={notice()}><p class="desk-ok">{notice()}</p></Show>

      <Show when={sales() == null && !error()}>
        <DeskPanel title="Sales"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>

      <Show when={sales() && !sales().length}>
        <EmptyDesk title="Nothing sold yet" lede="Paid Pokoin orders and CardTrader sales of your linked cards land here.">
          <a class="btn" href="/mypokoin">MyPokoin</a>
        </EmptyDesk>
      </Show>

      <Show when={sales()?.length}>
        <DeskPanel
          flush
          title={`${shown().length} sale${shown().length === 1 ? '' : 's'}`}
          extra={(
            <select
              class="sales-source"
              value={source()}
              onChange={(event) => setSource(event.target.value)}
              aria-label="Sales channel"
            >
              <For each={SALES_SOURCES}>{(row) => <option value={row.id}>{row.label}</option>}</For>
            </select>
          )}
        >
          <div class="thread-list">
            <For each={shown()}>
              {(row) => {
                const ct = row.source === 'cardtrader';
                const status = () => saleStatus(row, orderStatus);
                const open = () => openId() === row.orderId && !ct;
                const shipping = () => shipId() === row.orderId && !ct;
                return (
                  <article class={['thread sale-row', { 'is-focus': open() || shipping() }]} id={`sale-${row.orderId}`}>
                    <Show when={row.items?.[0]}>{(item) => <SaleThumb item={item()} />}</Show>
                    <span class="thread-main">
                      <strong class="thread-title">
                        {saleTitle(row)}
                        {' '}
                        <span class={`pill order-pill is-${status().tone}`}>{status().label}</span>
                      </strong>
                      <span class="thread-meta">
                        {saleDay(row.soldAt)}
                        {' · '}
                        {saleUnitCount(row)} card{saleUnitCount(row) === 1 ? '' : 's'}
                        {' · '}
                        {formatOrderMoney(row.gross, row.currency)}
                        {row.refunded ? ` · ${formatOrderMoney(row.refunded, row.currency)} refunded` : ''}
                        {ct && row.ctOrderCode ? ` · CT ${row.ctOrderCode}` : ''}
                        {row.trackingCode ? ` · Tracking ${row.trackingCode}` : ''}
                      </span>
                      <span class="sale-lines">
                        <For each={row.items || []}>
                          {(item) => (
                            <span class="sale-line">
                              <Show when={item.cardId} fallback={item.cardName || 'Card'}>
                                <a href={inventoryListingHref(item)}>{item.cardName || 'Card'}</a>
                              </Show>
                              {' '}
                              <span class="muted">
                                {[item.condition, item.language].filter(Boolean).join(' ')}
                                {' · ×'}
                                {item.quantity}
                                {' · '}
                                {saleLineMoney(item, row.currency)}
                              </span>
                            </span>
                          )}
                        </For>
                        <Show when={row.shippingCents}>
                          <span class="sale-line muted">Shipping {formatOrderMoney(row.shippingCents, 'EUR')}</span>
                        </Show>
                      </span>
                      <For each={(row.refunds || []).filter((refund) => refund.status !== 'failed')}>
                        {(refund) => (
                          <span class="thread-meta">
                            Refunded {formatOrderMoney(refund.amount, row.currency)} {saleDay(refund.createdAt)}
                            {refund.reason ? ` — ${refund.reason}` : ''}
                            {refund.status === 'pending' ? ' (processing)' : ''}
                          </span>
                        )}
                      </For>
                      <Show when={shipping()}>
                        <label class="order-tracking-field">
                          Tracking code
                          <input
                            value={trackingDraft()[row.orderId] || ''}
                            onInput={(event) => setTrackingDraft((current) => ({
                              ...current,
                              [row.orderId]: event.target.value,
                            }))}
                            placeholder="Carrier tracking number"
                            autocomplete="off"
                          />
                          <span class="order-actions">
                            <button
                              class="btn"
                              type="button"
                              disabled={shipBusy() === row.orderId || !String(trackingDraft()[row.orderId] || '').trim()}
                              onClick={() => shipOrder(row.orderId)}
                            >
                              {shipBusy() === row.orderId ? 'Saving…' : 'Mark shipped'}
                            </button>
                            <button class="btn ghost" type="button" onClick={() => setShipId('')}>Cancel</button>
                          </span>
                        </label>
                      </Show>
                      <Show when={open()}>
                        <RefundForm
                          row={row}
                          onDone={(result) => applyRefund(row.orderId, result)}
                          onCancel={() => setOpenId('')}
                        />
                      </Show>
                    </span>
                    <Show when={!ct && !open() && !shipping()}>
                      <span class="order-actions">
                        <Show when={saleNeedsShip(row)}>
                          <button class="btn ghost" type="button" onClick={() => { setOpenId(''); setShipId(row.orderId); }}>
                            Add tracking
                          </button>
                        </Show>
                        <Show when={row.refundable > 0}>
                          <button class="btn ghost" type="button" onClick={() => { setShipId(''); setOpenId(row.orderId); }}>
                            Refund
                          </button>
                        </Show>
                      </span>
                    </Show>
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

/** /sales: sold history, partial refunds, tracking. */
export default function Sales() {
  const [params] = useSearchParams();
  onSettled(() => {
    document.title = 'Sold history · Pokoin';
  });
  return (
    <Show
      when={untrack(() => allowMypokoinPreview(params))}
      fallback={(
        <RequireSignIn>
          <SalesDesk />
        </RequireSignIn>
      )}
    >
      <SalesDesk preview />
    </Show>
  );
}
