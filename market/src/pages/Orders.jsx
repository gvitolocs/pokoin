import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  cancelEurOrder,
  confirmMarketplaceDelivery,
  formatPkn,
  markMarketplaceShipped,
  reportMarketplaceProblem,
  revealMarketplaceShipping,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { loadFirestore } from '../firebase-client.js';
import { useCart } from '../cart.jsx';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '../buyer-protection.js';
import { estimatedDeliveryDate, optInFields, showReviewsOptIn } from '../google-reviews.js';
import { authFrom } from '../punchouts.js';
import {
  canResumePayment,
  filterOrdersByArchive,
  formatOrderMoney,
  fulfillmentLabel,
  holdMinutesLeft,
  isEurOrder,
  orderStatus,
  visibleOrders,
} from '../order-status.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';

function stamp(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString().slice(0, 10);
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString().slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function mergeOrders(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => stamp(b.createdAt).localeCompare(stamp(a.createdAt)));
}

function formatEurCents(cents) {
  const n = Number(cents) || 0;
  return `€${(n / 100).toFixed(2)}`;
}

function moneyLabel(row) {
  if (isEurOrder(row)) {
    return formatEurCents(row.totalEURCents);
  }
  return formatPkn(row.totalPkn);
}

function itemsTitle(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const first = items[0]?.card?.name || items[0]?.cardName || '';
  if (!first) return row.id;
  const more = items.length - 1;
  return more > 0 ? `${first} +${more}` : first;
}

export default function Orders() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { ready, signedIn, user, profile, getBearer } = useAuth();
  const { settleCheckout } = useCart();
  const [bought, setBought] = useState(null);
  const [sold, setSold] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [addresses, setAddresses] = useState({});
  const [trackingDraft, setTrackingDraft] = useState({});
  const [now, setNow] = useState(() => Date.now());
  const [archived, setArchived] = useState(false);
  const eurSession = String(searchParams.get('eur_session') || '').trim();
  const returnedOrder = String(searchParams.get('order') || '').trim();
  const [focusOrder, setFocusOrder] = useState('');
  const settledSession = useRef('');
  // Order whose cart rows still need removing once its Firestore doc arrives.
  const [settleOrder, setSettleOrder] = useState('');

  useEffect(() => {
    document.title = 'Orders · Pokoin';
    const uid = user?.uid || profile?.uid;
    if (!uid) {
      setBought(null);
      setSold(null);
      return undefined;
    }
    let cancelled = false;
    let unsubBuy = null;
    let unsubSell = null;
    loadFirestore().then(({ firestore, collection, onSnapshot, query, where }) => {
      if (cancelled) return;
      const buys = query(collection(firestore, 'orders'), where('uid', '==', uid));
      const sales = query(collection(firestore, 'orders'), where('sellerUids', 'array-contains', uid));
      unsubBuy = onSnapshot(buys, (snap) => {
        setBought(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        setError('');
      }, (err) => setError(err.message || 'Orders failed.'));
      unsubSell = onSnapshot(sales, (snap) => {
        setSold(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      }, (err) => setError(err.message || 'Orders failed.'));
    }, (err) => {
      if (!cancelled) setError(err.message || 'Orders failed.');
    });
    return () => {
      cancelled = true;
      unsubBuy?.();
      unsubSell?.();
    };
  }, [user?.uid, profile?.uid]);

  // Hold countdowns on unpaid EUR orders.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!eurSession || settledSession.current === eurSession) return;
    settledSession.current = eurSession;
    // The cards are held for this order, so their cart rows can go; unticked
    // rows stay. "Paid" only shows once Stripe's webhook confirms — the row
    // below updates live.
    if (!settleCheckout() && returnedOrder) setSettleOrder(returnedOrder);
    setFocusOrder(returnedOrder);
    setNotice('Payment submitted. The order turns Paid as soon as Stripe confirms it.');
    setSearchParams((prev) => {
      if (!prev.has('eur_session') && !prev.has('order')) return prev;
      const next = new URLSearchParams(prev);
      next.delete('eur_session');
      next.delete('order');
      return next;
    }, { replace: true });
  }, [eurSession, returnedOrder, settleCheckout, setSearchParams]);

  // No checkout record on this browser: match the paid order's listings instead.
  useEffect(() => {
    if (!settleOrder || !bought) return;
    const order = bought.find((row) => row.id === settleOrder);
    if (!order) return;
    const listingIds = (Array.isArray(order.items) ? order.items : [])
      .map((item) => String(item?.listingId || ''))
      .filter(Boolean);
    settleCheckout({ listingIds });
    setSettleOrder('');
  }, [settleOrder, bought, settleCheckout]);

  // Google Customer Reviews opt-in for the order Stripe just returned.
  // Only the returned order, and only when something is actually mailed.
  useEffect(() => {
    if (!focusOrder) return;
    const order = (bought || []).find((row) => row.id === focusOrder);
    if (!order) return;
    if (String(order.fulfillmentMode || '') === 'nft_only') return;
    showReviewsOptIn(optInFields({
      orderId: order.id,
      email: order.buyerEmail || user?.email,
      deliveryCountry: order.shippingAddressCountryCode,
      estimatedDelivery: estimatedDeliveryDate({
        orderedAt: order.createdAt,
        shipments: order.shipments,
        toCountry: order.shippingAddressCountryCode,
      }),
    }));
  }, [focusOrder, bought, user?.email]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/orders')} replace />;
  }

  const uid = user?.uid || profile?.uid || '';
  const allRows = visibleOrders(mergeOrders(bought, sold), uid);
  const rows = useMemo(
    () => filterOrdersByArchive(allRows, archived),
    [allRows, archived],
  );

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
    <div className="page desk">
      <PageHead kicker="Account" title="Orders" lede={`${ESCROW_LINE} ${NO_SHIP_GUARANTEE}`}>
        <Link className="btn ghost" to="/protection">Buyer protection</Link>
        <Link className="btn ghost" to="/bought">Buy history</Link>
        <Link className="btn ghost" to="/sales">Sold history</Link>
        <Link className="btn ghost" to="/cart">Cart</Link>
      </PageHead>
      <StockNav />
      <Alert>{error}</Alert>
      {notice ? <p className="desk-ok">{notice}</p> : null}
      {bought == null && sold == null && !error ? (
        <DeskPanel title="History"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {allRows && !allRows.length ? (
        <EmptyDesk title="No orders yet" lede="Checkout a native listing with site PKN or Stripe.">
          <Link className="btn" to="/marketplace">Shop</Link>
        </EmptyDesk>
      ) : null}
      {allRows?.length ? (
        <DeskPanel
          flush
          title={`${rows.length} ${archived ? 'archived ' : ''}order${rows.length === 1 ? '' : 's'}`}
          extra={(
            <div className="order-archive-toggle" role="group" aria-label="Order list">
              <button type="button" className={!archived ? 'on' : undefined} aria-pressed={!archived} onClick={() => setArchived(false)}>Live</button>
              <button type="button" className={archived ? 'on' : undefined} aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button>
            </div>
          )}
        >
          <div className="thread-list">
            {rows.length ? rows.map((row) => {
              const buyer = row.uid === uid || row.buyerUid === uid;
              const seller = Array.isArray(row.sellerUids) && row.sellerUids.includes(uid);
              const eur = isEurOrder(row);
              const escrow = row.paymentStatus === 'escrow';
              const paid = row.paymentStatus === 'paid' || row.paymentStatus === 'released';
              const shipped = Boolean(row.shippedAt) || row.fulfillmentStatus === 'shipped' || row.fulfillmentStatus === 'delivered';
              const open = row.disputeStatus === 'open';
              const address = addresses[row.id];
              const status = orderStatus(row);
              const step = fulfillmentLabel(row);
              const resumable = buyer && canResumePayment(row, now);
              const refunded = Number(row.refundedTotal) || 0;
              const tracking = trackingDraft[row.id] ?? row.trackingCode ?? '';
              return (
                <article className={`thread order-row${focusOrder === row.id ? ' is-focus' : ''}`} key={row.id}>
                  <span className="thread-main">
                    <strong className="thread-title">
                      {itemsTitle(row)}
                      {' '}
                      <span className={`pill order-pill is-${status.tone}`}>{status.label}</span>
                    </strong>
                    <span className="thread-meta">
                      {buyer ? 'Bought' : 'Sold'}
                      {step ? ` · ${step}` : ''}
                      {' · '}
                      {moneyLabel(row)}
                      {refunded > 0 ? ` · ${formatOrderMoney(refunded, eur ? 'EUR' : 'PKN')} refunded` : ''}
                      {' · '}
                      {stamp(row.createdAt) || '—'}
                      {' · '}
                      <span className="order-id">{row.id}</span>
                    </span>
                    {row.trackingCode ? (
                      <span className="thread-meta">Tracking {row.trackingCode}</span>
                    ) : null}
                    {resumable ? (
                      <span className="thread-meta">
                        Cards held for you for {holdMinutesLeft(row, now)} more min. Not charged until you pay.
                      </span>
                    ) : null}
                    {buyer && ['expired', 'cancelled', 'failed'].includes(row.paymentStatus) ? (
                      <span className="thread-meta">Nothing was charged. The cards went back on sale.</span>
                    ) : null}
                    {address ? (
                      <span className="thread-meta">
                        Ship to {address.fullName}, {address.addressLine1}, {address.postalCode} {address.city}, {address.countryCode}
                      </span>
                    ) : null}
                    {seller && (escrow || (eur && paid)) && !shipped ? (
                      <label className="order-tracking-field">
                        Tracking code
                        <input
                          value={tracking}
                          onChange={(event) => setTrackingDraft((current) => ({
                            ...current,
                            [row.id]: event.target.value,
                          }))}
                          placeholder="Carrier tracking number"
                          autoComplete="off"
                        />
                      </label>
                    ) : null}
                  </span>
                  <span className="order-actions">
                    {resumable ? (
                      <a className="btn" href={row.stripeCheckoutUrl}>Pay now</a>
                    ) : null}
                    {buyer && row.paymentStatus === 'pending_stripe' ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => run(row.id, (token) => cancelEurOrder(row.id, token))}
                      >
                        Cancel
                      </button>
                    ) : null}
                    {seller && (paid || escrow) ? (
                      <Link className="btn ghost" to={`/sales#${row.id}`}>Refund</Link>
                    ) : null}
                    {buyer && (escrow || (eur && paid)) ? (
                      <button
                        className="btn"
                        type="button"
                        disabled={busyId === row.id || row.fulfillmentStatus === 'delivered' || row.paymentStatus === 'released'}
                        onClick={() => run(row.id, (token) => confirmMarketplaceDelivery(row.id, token))}
                      >
                        Confirm delivery
                      </button>
                    ) : null}
                    {seller && (escrow || (eur && paid)) && !shipped ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busyId === row.id || !String(tracking).trim()}
                        onClick={() => run(row.id, (token) => markMarketplaceShipped(row.id, token, {
                          trackingCode: String(tracking).trim(),
                        }))}
                      >
                        Mark shipped
                      </button>
                    ) : null}
                    {seller && eur && (paid || escrow) && !address ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => run(row.id, (token) => revealMarketplaceShipping(row.id, token))}
                      >
                        Show address
                      </button>
                    ) : null}
                    {buyer && escrow && !open ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => run(row.id, (token) => reportMarketplaceProblem({
                          orderId: row.id,
                          reason: shipped ? 'not_as_described' : 'not_shipped',
                        }, token))}
                      >
                        Report a problem
                      </button>
                    ) : null}
                  </span>
                </article>
              );
            }) : (
              <p className="page-lede" style={{ padding: '1rem' }}>
                {archived
                  ? 'No archived orders — expired or cancelled checkouts land here.'
                  : 'No live orders right now.'}
              </p>
            )}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
