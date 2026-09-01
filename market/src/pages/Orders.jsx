import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { formatPkn } from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';

function stamp(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString().slice(0, 10);
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString().slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

export default function Orders() {
  const location = useLocation();
  const { ready, signedIn, user } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Orders · Pokoin';
    if (!user?.uid) {
      setRows(null);
      return undefined;
    }
    const q = query(collection(firestore, 'orders'), where('uid', '==', user.uid));
    return onSnapshot(q, (snap) => {
      const next = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      next.sort((a, b) => stamp(b.createdAt).localeCompare(stamp(a.createdAt)));
      setRows(next);
      setError('');
    }, (err) => setError(err.message || 'Orders failed.'));
  }, [user?.uid]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/orders')} replace />;
  }

  return (
    <div className="page desk">
      <PageHead kicker="Account" title="Orders" lede="Paid checkouts for this Firebase uid. Empty until a checkout lands.">
        <Link className="btn ghost" to="/cart">Cart</Link>
      </PageHead>
      <Alert>{error}</Alert>
      {rows == null && !error ? (
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
            {rows.map((row) => (
              <article className="thread" key={row.id}>
                <span className="thread-main">
                  <strong className="thread-title">{row.id}</strong>
                  <span className="thread-meta">
                    {row.status || row.paymentStatus || 'order'} · {formatPkn(row.totalPkn)} · {stamp(row.createdAt) || '—'}
                  </span>
                </span>
              </article>
            ))}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
