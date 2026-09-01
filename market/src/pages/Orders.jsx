import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { formatPkn } from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';

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

  if (!ready) {
    return <div className="page"><p className="muted">Checking session…</p></div>;
  }
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/orders')} replace />;
  }

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Account</p>
          <h1>Orders</h1>
          <p className="muted">Firestore orders for this Firebase uid. Empty until a paid checkout lands.</p>
        </div>
        <Link className="more" to="/profile" style={{ margin: 0 }}>Profile</Link>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      {rows == null && !error ? <p className="muted">Loading orders…</p> : null}
      {rows && !rows.length ? (
        <p className="muted">No orders yet. <Link to="/cart">Cart</Link></p>
      ) : (
        <div className="forum-list">
          {(rows || []).map((row) => (
            <article className="forum-row" key={row.id}>
              <strong>{row.id}</strong>
              <span className="muted">
                {row.status || row.paymentStatus || 'order'} · {formatPkn(row.totalPkn)} · {stamp(row.createdAt) || '—'}
              </span>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
