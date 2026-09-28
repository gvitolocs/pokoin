import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  confirmMarketplaceDelivery,
  formatPkn,
  markMarketplaceShipped,
  reportMarketplaceProblem,
  revealMarketplaceShipping,
} from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '../buyer-protection.js';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';

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
  if (row.currency === 'EUR' || row.paymentMethod === 'stripe') {
    return formatEurCents(row.totalEURCents);
  }
  return formatPkn(row.totalPkn);
}

export default function Orders() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { ready, signedIn, user, profile, getBearer } = useAuth();
  const { clear } = useCart();
  const [bought, setBought] = useState(null);
  const [sold, setSold] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [addresses, setAddresses] = useState({});
  const eurSession = String(searchParams.get('eur_session') || '').trim();

  useEffect(() => {
    document.title = 'Orders · Pokoin';
    const uid = user?.uid || profile?.uid;
    if (!uid) {
      setBought(null);
      setSold(null);
      return undefined;
    }
    const buys = query(collection(firestore, 'orders'), where('uid', '==', uid));
    const sales = query(collection(firestore, 'orders'), where('sellerUids', 'array-contains', uid));
    const unsubBuy = onSnapshot(buys, (snap) => {
      setBought(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      setError('');
    }, (err) => setError(err.message || 'Orders failed.'));
    const unsubSell = onSnapshot(sales, (snap) => {
      setSold(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
    }, (err) => setError(err.message || 'Orders failed.'));
    return () => {
      unsubBuy();
      unsubSell();
    };
  }, [user?.uid, profile?.uid]);

  useEffect(() => {
    if (!eurSession) return;
    clear();
    setNotice('Card payment received. Your order is listed below once Stripe confirms.');
    setSearchParams((prev) => {
      if (!prev.has('eur_session')) return prev;
      const next = new URLSearchParams(prev);
      next.delete('eur_session');
      return next;
    }, { replace: true });
  }, [eurSession, clear, setSearchParams]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/orders')} replace />;
  }

  const rows = mergeOrders(bought, sold);
  const uid = user?.uid || profile?.uid || '';

  async function run(orderId, fn) {
    setBusyId(orderId);
    setError('');
    try {
      const token = await getBearer();
      const result = await fn(token);
      if (result?.shippingAddress) {
        setAddresses((current) => ({ ...current, [orderId]: result.shippingAddress }));
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
        <Link className="btn ghost" to="/cart">Cart</Link>
      </PageHead>
      <Alert>{error}</Alert>
      {notice ? <p className="desk-ok">{notice}</p> : null}
      {bought == null && sold == null && !error ? (
        <DeskPanel title="History"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {rows && !rows.length ? (
        <EmptyDesk title="No orders yet" lede="Checkout a native listing with site PKN or Stripe.">
          <Link className="btn" to="/marketplace">Shop</Link>
        </EmptyDesk>
      ) : null}
      {rows?.length ? (
        <DeskPanel flush title={`${rows.length} order${rows.length === 1 ? '' : 's'}`}>
          <div className="thread-list">
            {rows.map((row) => {
              const buyer = row.uid === uid || row.buyerUid === uid;
              const seller = Array.isArray(row.sellerUids) && row.sellerUids.includes(uid);
              const eur = row.currency === 'EUR' || row.paymentMethod === 'stripe';
              const escrow = row.paymentStatus === 'escrow';
              const paid = row.paymentStatus === 'paid' || row.paymentStatus === 'released';
              const shipped = Boolean(row.shippedAt) || row.fulfillmentStatus === 'shipped' || row.fulfillmentStatus === 'delivered';
              const open = row.disputeStatus === 'open';
              const address = addresses[row.id];
              return (
                <article className="thread" key={row.id}>
                  <span className="thread-main">
                    <strong className="thread-title">{row.id}</strong>
                    <span className="thread-meta">
                      {row.paymentStatus || row.status || 'order'}
                      {row.fulfillmentStatus ? ` · ${row.fulfillmentStatus}` : ''}
                      {eur ? ' · EUR' : ''}
                      {open ? ' · dispute open' : ''}
                      {' · '}
                      {moneyLabel(row)}
                      {' · '}
                      {stamp(row.createdAt) || '—'}
                    </span>
                    {address ? (
                      <span className="thread-meta">
                        Ship to {address.fullName}, {address.addressLine1}, {address.postalCode} {address.city}, {address.countryCode}
                      </span>
                    ) : null}
                  </span>
                  <span className="order-actions">
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
                        disabled={busyId === row.id}
                        onClick={() => run(row.id, (token) => markMarketplaceShipped(row.id, token))}
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
            })}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
