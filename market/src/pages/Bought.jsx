import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  cancelEurOrder,
  confirmMarketplaceDelivery,
  formatPkn,
  reportMarketplaceProblem,
} from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '../buyer-protection.js';
import { authFrom } from '../punchouts.js';
import {
  canResumePayment,
  filterOrdersByArchive,
  formatOrderMoney,
  fulfillmentLabel,
  holdMinutesLeft,
  isEurOrder,
  orderStatus,
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

function formatEurCents(cents) {
  const n = Number(cents) || 0;
  return `€${(n / 100).toFixed(2)}`;
}

function moneyLabel(row) {
  if (isEurOrder(row)) return formatEurCents(row.totalEURCents);
  return formatPkn(row.totalPkn);
}

function itemsTitle(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const first = items[0]?.card?.name || items[0]?.cardName || '';
  if (!first) return row.id;
  const more = items.length - 1;
  return more > 0 ? `${first} +${more}` : first;
}

export default function Bought() {
  const location = useLocation();
  const { ready, signedIn, user, profile, getBearer } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    document.title = 'Buy history · Pokoin';
    const uid = user?.uid || profile?.uid;
    if (!uid) {
      setRows(null);
      return undefined;
    }
    const buys = query(collection(firestore, 'orders'), where('uid', '==', uid));
    const unsub = onSnapshot(buys, (snap) => {
      const list = snap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => stamp(b.createdAt).localeCompare(stamp(a.createdAt)));
      setRows(list);
      setError('');
    }, (err) => setError(err.message || 'Buy history failed.'));
    return () => unsub();
  }, [user?.uid, profile?.uid]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/bought')} replace />;
  }

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

  const shown = useMemo(
    () => filterOrdersByArchive(rows || [], archived),
    [rows, archived],
  );

  return (
    <div className="page desk">
      <PageHead
        kicker="Account"
        title="Buy history"
        lede={`${ESCROW_LINE} ${NO_SHIP_GUARANTEE}`}
      >
        <Link className="btn ghost" to="/protection">Buyer protection</Link>
        <Link className="btn ghost" to="/cart">Cart</Link>
      </PageHead>
      <StockNav />
      <Alert>{error}</Alert>
      {rows == null && !error ? (
        <DeskPanel title="Purchases"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {rows && !rows.length ? (
        <EmptyDesk title="No purchases yet" lede="Checkout a native listing with site PKN or Stripe.">
          <Link className="btn" to="/marketplace">Shop</Link>
        </EmptyDesk>
      ) : null}
      {rows?.length ? (
        <DeskPanel
          flush
          title={`${shown.length} ${archived ? 'archived' : 'purchase'}${shown.length === 1 ? '' : 's'}`}
          extra={(
            <div className="order-archive-toggle" role="group" aria-label="Purchase list">
              <button
                type="button"
                className={!archived ? 'on' : undefined}
                aria-pressed={!archived}
                onClick={() => setArchived(false)}
              >
                Live
              </button>
              <button
                type="button"
                className={archived ? 'on' : undefined}
                aria-pressed={archived}
                onClick={() => setArchived(true)}
              >
                Archived
              </button>
            </div>
          )}
        >
          <div className="thread-list">
            {shown.length ? shown.map((row) => {
              const eur = isEurOrder(row);
              const escrow = row.paymentStatus === 'escrow';
              const paid = row.paymentStatus === 'paid' || row.paymentStatus === 'released';
              const shipped = Boolean(row.shippedAt)
                || row.fulfillmentStatus === 'shipped'
                || row.fulfillmentStatus === 'delivered';
              const open = row.disputeStatus === 'open';
              const status = orderStatus(row);
              const step = fulfillmentLabel(row);
              const resumable = canResumePayment(row, now);
              const refunded = Number(row.refundedTotal) || 0;
              return (
                <article className="thread order-row" key={row.id}>
                  <span className="thread-main">
                    <strong className="thread-title">
                      {itemsTitle(row)}
                      {' '}
                      <span className={`pill order-pill is-${status.tone}`}>{status.label}</span>
                    </strong>
                    <span className="thread-meta">
                      Bought
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
                    {['expired', 'cancelled', 'failed'].includes(row.paymentStatus) ? (
                      <span className="thread-meta">Nothing was charged. The cards went back on sale.</span>
                    ) : null}
                  </span>
                  <span className="order-actions">
                    {resumable ? (
                      <a className="btn" href={row.stripeCheckoutUrl}>Pay now</a>
                    ) : null}
                    {row.paymentStatus === 'pending_stripe' ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => run(row.id, (token) => cancelEurOrder(row.id, token))}
                      >
                        Cancel
                      </button>
                    ) : null}
                    {(escrow || (eur && paid)) ? (
                      <button
                        className="btn"
                        type="button"
                        disabled={busyId === row.id || row.fulfillmentStatus === 'delivered' || row.paymentStatus === 'released'}
                        onClick={() => run(row.id, (token) => confirmMarketplaceDelivery(row.id, token))}
                      >
                        Confirm delivery
                      </button>
                    ) : null}
                    {escrow && !open ? (
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
                  ? 'No archived purchases — expired or cancelled checkouts land here.'
                  : 'No live purchases right now.'}
              </p>
            )}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
