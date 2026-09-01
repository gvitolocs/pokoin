import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchSellerListings, formatPkn } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function Inventory() {
  const location = useLocation();
  const { user, ready, signedIn, getBearer } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Inventory · Pokoin';
    if (!signedIn) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchSellerListings(user.uid, token))
      .then((data) => {
        if (!cancelled) setRows(data.listings || data.items || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Listings failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, getBearer]);

  if (!ready) {
    return <div className="page"><p className="muted">Checking session…</p></div>;
  }
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/inventory')}`} replace />;
  }

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Seller</p>
          <h1>My listings</h1>
          <p className="muted">GET marketplace-listings for this Firebase uid. Empty is honest until you list a card.</p>
        </div>
        <Link className="more" to="/marketplace" style={{ margin: 0 }}>List a card</Link>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      {rows == null && !error ? <p className="muted">Loading listings…</p> : null}
      {rows && !rows.length ? (
        <p className="muted">No live listings. Open a card desk and use List your card.</p>
      ) : (
        <div className="forum-list">
          {(rows || []).map((row) => (
            <Link
              className="forum-row"
              key={row.id || `${row.cardId}-${row.pricePkn}`}
              to={row.cardId ? `/marketplace/en/cards/${row.cardId}` : '/marketplace'}
            >
              <strong>{row.cardName || row.name || 'Listing'}</strong>
              <span className="muted">{formatPkn(row.pricePkn)} · {row.condition || 'NM'} · qty {row.quantityAvailable || 1}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
