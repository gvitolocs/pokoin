import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchSellerListings, formatPkn } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait, Thread } from '../components/Desk.jsx';

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

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/inventory')}`} replace />;
  }

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="My listings"
        lede="Live native listings for this Firebase uid. Empty is honest until you list from a card desk."
      >
        <Link className="btn" to="/marketplace">List a card</Link>
      </PageHead>
      <Alert>{error}</Alert>
      {rows == null && !error ? (
        <DeskPanel title="Inventory"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {rows && !rows.length ? (
        <EmptyDesk title="No live listings" lede="Open a card and use List your card. GET marketplace-listings for this uid stays empty until then.">
          <Link className="btn" to="/marketplace">Find a card</Link>
        </EmptyDesk>
      ) : null}
      {rows?.length ? (
        <DeskPanel flush title={`${rows.length} listing${rows.length === 1 ? '' : 's'}`}>
          <div className="thread-list">
            {rows.map((row) => (
              <Thread
                key={row.id || `${row.cardId}-${row.pricePkn}`}
                to={row.cardId ? `/marketplace/en/cards/${row.cardId}` : '/marketplace'}
                title={row.cardName || row.name || 'Listing'}
                meta={`${formatPkn(row.pricePkn)} · ${row.condition || 'NM'} · qty ${row.quantityAvailable || 1}`}
              />
            ))}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
