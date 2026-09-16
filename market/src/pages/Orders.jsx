import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  confirmMarketplaceDelivery,
  formatPkn,
  markMarketplaceShipped,
  reportMarketplaceProblem,
} from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
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

export default function Orders() {
  const location = useLocation();
  const { ready, signedIn, user, profile, getBearer } = useAuth();
  const [bought, setBought] = useState(null);
  const [sold, setSold] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

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
      await fn(token);
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
      {bought == null && sold == null && !error ? (
        <DeskPanel title="History"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {rows && !rows.length ? (
        <EmptyDesk title="No orders yet" lede="Checkout a native listing with site PKN.">
          <Link className="btn" to="/marketplace">Shop</Link>
        </EmptyDesk>
      ) : null}
      {rows?.length ? (
        <DeskPanel flush title={`${rows.length} order${rows.length === 1 ? '' : 's'}`}>
          <div className="thread-list">
            {rows.map((row) => {
              const buyer = row.uid === uid || row.buyerUid === uid;
              const seller = Array.isArray(row.sellerUids) && row.sellerUids.includes(uid);
              const escrow = row.paymentStatus === 'escrow';
              const shipped = Boolean(row.shippedAt) || row.fulfillmentStatus === 'shipped';
              const open = row.disputeStatus === 'open';
              return (
                <article className="thread" key={row.id}>
                  <span className="thread-main">
                    <strong className="thread-title">{row.id}</strong>
                    <span className="thread-meta">
                      {row.paymentStatus || row.status || 'order'}
                      {row.fulfillmentStatus ? ` · ${row.fulfillmentStatus}` : ''}
                      {open ? ' · dispute open' : ''}
                      {' · '}
                      {formatPkn(row.totalPkn)}
                      {' · '}
                      {stamp(row.createdAt) || '—'}
                    </span>
                  </span>
                  <span className="order-actions">
                    {buyer && escrow ? (
                      <button
                        className="btn"
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => run(row.id, (token) => confirmMarketplaceDelivery(row.id, token))}
                      >
                        Confirm delivery
                      </button>
                    ) : null}
                    {seller && escrow && !shipped ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => run(row.id, (token) => markMarketplaceShipped(row.id, token))}
                      >
                        Mark shipped
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
