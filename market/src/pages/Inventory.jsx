import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchSellerListings, formatPkn } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait, Thread } from '../components/Desk.jsx';
import {
  inventoryListingHref,
  inventoryListingMeta,
  liveInventoryListings,
} from '../inventory-listings.js';

export default function Inventory() {
  const location = useLocation();
  const { user, ready, signedIn, profile, getBearer } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Inventory · Pokoin';
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchSellerListings(uid, token))
      .then((data) => {
        if (!cancelled) setRows(liveInventoryListings(data.listings || data.items || []));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Listings failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, getBearer]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/inventory')}`} replace />;
  }

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="My listings"
      >
        <Link className="btn" to="/inventory/scan">Scan cards</Link>
        <Link className="btn ghost" to="/marketplace">List a card</Link>
      </PageHead>
      <Alert>{error}</Alert>
      {rows == null && !error ? (
        <DeskPanel title="Inventory"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {rows && !rows.length ? (
        <EmptyDesk title="No live listings" lede="Scan a pile with your phone, or open a card and use List your card.">
          <Link className="btn" to="/inventory/scan">Scan cards</Link>
          <Link className="btn ghost" to="/marketplace">Find a card</Link>
        </EmptyDesk>
      ) : null}
      {rows?.length ? (
        <DeskPanel flush title={`${rows.length} listing${rows.length === 1 ? '' : 's'}`}>
          <div className="thread-list">
            {rows.map((row) => (
              <Thread
                key={row.id || `${row.cardId}-${row.pricePkn}`}
                to={inventoryListingHref(row)}
                title={row.cardName || row.name || 'Listing'}
                meta={inventoryListingMeta(row, formatPkn)}
              />
            ))}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
