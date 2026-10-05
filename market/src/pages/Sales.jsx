import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchSoldHistory, imageSrc, markMarketplaceShipped, refundMarketplaceOrder } from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { inventoryListingHref } from '../inventory-listings.js';
import {
  formatOrderMoney,
  newRefundToken,
  orderStatus,
  refundAmountFromInput,
  refundInputFromAmount,
} from '../order-status.js';
import CardArt from '../components/CardArt.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';
import '../sales-row.css';

const SOURCES = [
  { id: 'all', label: 'All sales' },
  { id: 'pokoin', label: 'Pokoin checkout' },
  { id: 'cardtrader', label: 'CardTrader' },
];

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '—';
}

function saleTitle(row) {
  const items = row.items || [];
  const first = items[0]?.cardName || 'Card';
  return items.length > 1 ? `${first} +${items.length - 1}` : first;
}

function unitCount(row) {
  return (row.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

function SaleThumb({ item }) {
  if (!item) return null;
  const name = item.cardName || 'Card';
  const src = imageSrc({ id: item.cardId, name, imageUrl: item.imageUrl || '' }, 'grid');
  const href = item.cardId ? inventoryListingHref(item) : '';
  const art = src ? <CardArt src={src} alt="" /> : <span className="tile-ph" />;
  if (!href) return <span className="sale-thumb">{art}</span>;
  return <Link className="sale-thumb" to={href} aria-label={name}>{art}</Link>;
}

function lineMoney(item, currency) {
  return currency === 'EUR'
    ? formatOrderMoney((Number(item.unitPriceEURCents) || 0) * (Number(item.quantity) || 1), 'EUR')
    : formatOrderMoney((Number(item.unitPricePkn) || 0) * (Number(item.quantity) || 1), 'PKN');
}

function RefundForm({ row, onDone, onCancel }) {
  const { getBearer } = useAuth();
  const [amountText, setAmountText] = useState(() => refundInputFromAmount(row.refundable, row.currency));
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token] = useState(newRefundToken);
  const amount = refundAmountFromInput(amountText, row.currency);
  const valid = Number.isSafeInteger(amount) && amount > 0 && amount <= row.refundable;
  const unit = row.currency === 'EUR' ? '€' : 'PKN';

  async function submit(event) {
    event.preventDefault();
    if (!valid) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const bearer = await getBearer();
      const result = await refundMarketplaceOrder({
        orderId: row.orderId,
        amount,
        reason: reason.trim(),
        clientToken: token,
      }, bearer);
      onDone(result);
    } catch (err) {
      setError(err.message || 'Refund failed.');
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="refund-form" onSubmit={submit}>
      <label>
        Refund ({unit})
        <input
          inputMode="decimal"
          value={amountText}
          onChange={(event) => { setAmountText(event.target.value); setConfirm(false); }}
          disabled={busy}
          aria-invalid={!valid}
        />
      </label>
      <label className="refund-reason">
        Note to buyer
        <input
          value={reason}
          maxLength={240}
          placeholder="e.g. corner ding not in the photos"
          onChange={(event) => setReason(event.target.value)}
          disabled={busy}
        />
      </label>
      <span className="refund-hint">
        Up to {formatOrderMoney(row.refundable, row.currency)} left of your share.
        {row.currency === 'EUR'
          ? ' Goes back to the buyer’s card; your payout drops by the same amount.'
          : ' Goes back to the buyer’s PKN balance.'}
      </span>
      <span className="refund-buttons">
        <button className="btn" type="submit" disabled={!valid || busy}>
          {busy ? 'Refunding…' : confirm ? `Confirm refund ${valid ? formatOrderMoney(amount, row.currency) : ''}` : 'Refund'}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>Close</button>
      </span>
      {error ? <span className="refund-error" role="status">{error}</span> : null}
    </form>
  );
}

export default function Sales() {
  const location = useLocation();
  const { ready, signedIn, getBearer } = useAuth();
  const [sales, setSales] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [source, setSource] = useState('all');
  const [openId, setOpenId] = useState(() => decodeURIComponent(String(location.hash || '').replace(/^#/, '')));
  const [shipId, setShipId] = useState('');
  const [trackingDraft, setTrackingDraft] = useState({});
  const [shipBusy, setShipBusy] = useState('');

  useEffect(() => {
    document.title = 'Sold history · Pokoin';
    if (!signedIn) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchSoldHistory(token))
      .then((data) => { if (!cancelled) setSales(data.sales || []); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Sold history failed.'); });
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  useEffect(() => {
    if (!openId || !sales) return;
    document.getElementById(`sale-${openId}`)?.scrollIntoView({ block: 'center' });
  }, [openId, sales]);

  const shown = useMemo(
    () => (sales || []).filter((row) => source === 'all' || row.source === source),
    [sales, source],
  );

  const totals = useMemo(() => {
    const live = (sales || []).filter((row) => row.paymentStatus !== 'cancelled' && row.paymentStatus !== 'refunded');
    const eur = live.filter((row) => row.currency === 'EUR');
    const pkn = live.filter((row) => row.currency !== 'EUR');
    return {
      count: live.length,
      units: live.reduce((sum, row) => sum + unitCount(row), 0),
      eurNet: eur.reduce((sum, row) => sum + (row.gross - row.refunded), 0),
      pknNet: pkn.reduce((sum, row) => sum + (row.gross - row.refunded), 0),
      eurRefunded: eur.reduce((sum, row) => sum + row.refunded, 0),
      pknRefunded: pkn.reduce((sum, row) => sum + row.refunded, 0),
    };
  }, [sales]);

  if (!ready) return <SessionWait />;
  if (!signedIn) return <Navigate to={authFrom(location.pathname || '/sales')} replace />;

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
    const trackingCode = String(trackingDraft[orderId] || '').trim();
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
        row.orderId === orderId && row.source !== 'cardtrader'
          ? {
            ...row,
            fulfillmentStatus: result.order?.fulfillmentStatus || 'shipped',
            shippedAt: result.order?.shippedAt || new Date().toISOString(),
            trackingCode: result.order?.trackingCode || trackingCode,
          }
          : row
      )));
      setShipId('');
      setNotice(`Marked ${orderId} shipped · ${trackingCode}`);
    } catch (err) {
      setError(err.message || 'Could not mark shipped.');
    } finally {
      setShipBusy('');
    }
  }

  const refundedLine = [
    totals.eurRefunded ? formatOrderMoney(totals.eurRefunded, 'EUR') : '',
    totals.pknRefunded ? formatOrderMoney(totals.pknRefunded, 'PKN') : '',
  ].filter(Boolean).join(' · ') || '—';

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="Sold history"
        lede="Every card that actually sold: Pokoin checkout and your linked CardTrader store. Refund part of a Pokoin order from here."
      >
        <Link className="btn ghost" to="/inventory/scan">Scan cards</Link>
      </PageHead>
      <StockNav />
      <Alert>{error}</Alert>
      {notice ? <p className="desk-ok">{notice}</p> : null}

      {sales ? (
        <MetricGrid>
          <Metric value={totals.count} label="Sales" />
          <Metric value={totals.units} label="Cards sold" />
          <Metric
            value={totals.eurNet ? formatOrderMoney(totals.eurNet, 'EUR') : '—'}
            label="EUR after refunds"
            hint={totals.pknNet ? `+ ${formatOrderMoney(totals.pknNet, 'PKN')}` : ''}
          />
          <Metric value={refundedLine} label="Refunded" />
        </MetricGrid>
      ) : null}

      {sales == null && !error ? (
        <DeskPanel title="Sales"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}

      {sales && !sales.length ? (
        <EmptyDesk title="Nothing sold yet" lede="Paid Pokoin orders and CardTrader sales of your linked cards land here.">
          <Link className="btn" to="/mypokoin">MyPokoin</Link>
        </EmptyDesk>
      ) : null}

      {sales?.length ? (
        <DeskPanel
          flush
          title={`${shown.length} sale${shown.length === 1 ? '' : 's'}`}
          extra={(
            <select
              className="sales-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-label="Sales channel"
            >
              {SOURCES.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
            </select>
          )}
        >
          <div className="thread-list">
            {shown.map((row) => {
              const ct = row.source === 'cardtrader';
              const status = ct
                ? {
                  label: row.paymentStatus === 'cancelled'
                    ? 'Cancelled'
                    : (row.channel === '1dr' ? 'CardTrader 1-DR' : 'CardTrader'),
                  tone: row.paymentStatus === 'cancelled' ? 'muted' : 'ct',
                }
                : orderStatus(row);
              const open = openId === row.orderId && !ct;
              const shipping = shipId === row.orderId && !ct;
              const needsShip = !ct
                && ['paid', 'escrow'].includes(row.paymentStatus)
                && row.fulfillmentStatus !== 'shipped'
                && row.fulfillmentStatus !== 'delivered'
                && !row.shippedAt;
              return (
                <article
                  className={`thread sale-row${open || shipping ? ' is-focus' : ''}`}
                  key={`${row.source}-${row.orderId}-${row.items?.[0]?.listingId || ''}`}
                  id={`sale-${row.orderId}`}
                >
                  <SaleThumb item={row.items?.[0]} />
                  <span className="thread-main">
                    <strong className="thread-title">
                      {saleTitle(row)}
                      {' '}
                      <span className={`pill order-pill is-${status.tone}`}>{status.label}</span>
                    </strong>
                    <span className="thread-meta">
                      {day(row.soldAt)}
                      {' · '}
                      {unitCount(row)} card{unitCount(row) === 1 ? '' : 's'}
                      {' · '}
                      {formatOrderMoney(row.gross, row.currency)}
                      {row.refunded ? ` · ${formatOrderMoney(row.refunded, row.currency)} refunded` : ''}
                      {ct && row.ctOrderCode ? ` · CT ${row.ctOrderCode}` : ''}
                      {row.trackingCode ? ` · Tracking ${row.trackingCode}` : ''}
                    </span>
                    <span className="sale-lines">
                      {(row.items || []).map((item) => (
                        <span className="sale-line" key={`${item.listingId}-${item.cardId}`}>
                          {item.cardId ? <Link to={inventoryListingHref(item)}>{item.cardName || 'Card'}</Link> : (item.cardName || 'Card')}
                          {' '}
                          <span className="muted">
                            {[item.condition, item.language].filter(Boolean).join(' ')}
                            {' · ×'}
                            {item.quantity}
                            {' · '}
                            {lineMoney(item, row.currency)}
                          </span>
                        </span>
                      ))}
                      {row.shippingCents ? (
                        <span className="sale-line muted">Shipping {formatOrderMoney(row.shippingCents, 'EUR')}</span>
                      ) : null}
                    </span>
                    {(row.refunds || []).filter((refund) => refund.status !== 'failed').map((refund) => (
                      <span className="thread-meta" key={`${refund.createdAt}-${refund.amount}`}>
                        Refunded {formatOrderMoney(refund.amount, row.currency)} {day(refund.createdAt)}
                        {refund.reason ? ` — ${refund.reason}` : ''}
                        {refund.status === 'pending' ? ' (processing)' : ''}
                      </span>
                    ))}
                    {shipping ? (
                      <label className="order-tracking-field">
                        Tracking code
                        <input
                          value={trackingDraft[row.orderId] || ''}
                          onChange={(event) => setTrackingDraft((current) => ({
                            ...current,
                            [row.orderId]: event.target.value,
                          }))}
                          placeholder="Carrier tracking number"
                          autoComplete="off"
                        />
                        <span className="order-actions">
                          <button
                            className="btn"
                            type="button"
                            disabled={shipBusy === row.orderId || !String(trackingDraft[row.orderId] || '').trim()}
                            onClick={() => shipOrder(row.orderId)}
                          >
                            {shipBusy === row.orderId ? 'Saving…' : 'Mark shipped'}
                          </button>
                          <button className="btn ghost" type="button" onClick={() => setShipId('')}>Cancel</button>
                        </span>
                      </label>
                    ) : null}
                    {open ? (
                      <RefundForm
                        row={row}
                        onDone={(result) => applyRefund(row.orderId, result)}
                        onCancel={() => setOpenId('')}
                      />
                    ) : null}
                  </span>
                  {!ct && !open && !shipping ? (
                    <span className="order-actions">
                      {needsShip ? (
                        <button className="btn ghost" type="button" onClick={() => { setOpenId(''); setShipId(row.orderId); }}>
                          Add tracking
                        </button>
                      ) : null}
                      {row.refundable > 0 ? (
                        <button className="btn ghost" type="button" onClick={() => { setShipId(''); setOpenId(row.orderId); }}>
                          Refund
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </article>
              );
            })}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
