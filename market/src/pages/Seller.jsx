import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { fetchSellerByUsername } from '../api.js';
import ShopListingRow from '../components/ShopListing.jsx';
import { Alert, EmptyDesk, Metric, MetricGrid } from '../components/Desk.jsx';
import { peekHasListingRows, peekSellerListings } from '../listings-cache.js';
import {
  listingSellerName,
  sellerCountryFlag,
  sellerCountryLabel,
  sellerHandle,
} from '../listing-meta.js';

function seedSellerListings(handle, locationState) {
  const cached = peekSellerListings(handle);
  if (peekHasListingRows(cached)) {
    return cached.listings;
  }
  const row = locationState?.listing;
  const name = sellerHandle(row) || listingSellerName(row);
  if (row && name && name.toLowerCase() === handle.toLowerCase()) {
    return [row];
  }
  return null;
}

export default function Seller() {
  const { username = '' } = useParams();
  const location = useLocation();
  const handle = decodeURIComponent(String(username || '').trim());
  const [listings, setListings] = useState(() => seedSellerListings(handle, location.state));
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = `${handle} · Pokoin`;
    if (!handle) return undefined;
    let cancelled = false;
    fetchSellerByUsername(handle, { limit: 200 })
      .then((data) => {
        if (!cancelled) {
          setListings(data.listings || data.items || []);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setListings([]);
          setError(err.message || 'Seller not found.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  const sample = listings?.[0];
  const display = listingSellerName(sample) || handle;
  const country = sellerCountryFlag(sample?.sellerCountry);
  const countryLine = sellerCountryLabel(sample?.sellerCountry);
  const uniqueCards = useMemo(() => {
    const ids = new Set((listings || []).map((row) => String(row.cardId || row.card_id || '')));
    ids.delete('');
    return ids.size;
  }, [listings]);

  if (listings && !listings.length && error) {
    return (
      <EmptyDesk title="Seller not found" lede={error}>
        <p className="status">Usernames match live native listings.</p>
      </EmptyDesk>
    );
  }

  return (
    <div className="page desk seller-page">
      <header className="seller-hero">
        <span className="seller-avatar" aria-hidden="true">
          {(display || '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="seller-id">
          <p className="page-kicker">Seller</p>
          <h1 className="page-title">{display}</h1>
          {country ? (
            <p className="seller-country">
              <img src={country.src} alt="" width="22" height="22" />
              <span>({(countryLine || country.label).toUpperCase()})</span>
            </p>
          ) : null}
        </div>
      </header>
      {listings ? (
        <MetricGrid>
          <Metric value={listings.length} label="Total items" />
          <Metric value={uniqueCards} label="Unique items" />
        </MetricGrid>
      ) : (
        <p className="status">Loading listings…</p>
      )}
      <Alert>{error && listings?.length ? error : ''}</Alert>
      {listings?.length ? (
        <section className="panel shop-panel shop-terminal">
          <header className="panel-head shop-head">
            <h2>Shop</h2>
          </header>
          <div className="shop-list">
            {listings.map((offer, index) => (
              <ShopListingRow
                key={offer.id || `${offer.cardId}-${index}`}
                offer={offer}
                showCard
              />
            ))}
          </div>
        </section>
      ) : listings ? (
        <EmptyDesk title="No listings" lede={`${display} has no live asks.`} />
      ) : null}
    </div>
  );
}
