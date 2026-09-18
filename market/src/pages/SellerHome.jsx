import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchCollectionSummary, fetchSellerListings } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';
import { liveInventoryListings, summarizeLiveInventory } from '../inventory-listings.js';
import { APP, marketUrl } from '../punchouts.js';
import '../seller-home.css';

const LISTINGS_LIMIT = 200;

export default function SellerHome() {
  const location = useLocation();
  const { user, ready, signedIn, profile, getBearer } = useAuth();
  const [ownedCards, setOwnedCards] = useState(null);
  const [listed, setListed] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Dashboard · Pokoin';
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    setOwnedCards(null);
    setError('');
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        if (cancelled) return;
        setOwnedCards(Math.max(0, Number(data.cardsOwned) || 0));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('dashboard collection summary failed', err);
        setError("Couldn't load your collection");
        setOwnedCards(0);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, getBearer]);

  useEffect(() => {
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    setListed(null);
    getBearer()
      .then((token) => fetchSellerListings(uid, token, { limit: LISTINGS_LIMIT }))
      .then((data) => {
        if (cancelled) return;
        const live = liveInventoryListings(data.listings || data.items || []);
        setListed(summarizeLiveInventory(live));
      })
      .catch(() => {
        if (!cancelled) setListed({ listings: 0, cards: 0, listedPkn: 0, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, getBearer]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/')}`} replace />;
  }

  const loading = ownedCards == null;
  const empty = ownedCards === 0 && !(listed?.cards > 0) && !error;
  const collectionHref = marketUrl(APP.collection);

  function retryCollection() {
    setOwnedCards(null);
    setError('');
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => setOwnedCards(Math.max(0, Number(data.cardsOwned) || 0)))
      .catch((err) => {
        console.error('dashboard collection summary failed', err);
        setError("Couldn't load your collection");
        setOwnedCards(0);
      });
  }

  return (
    <div className="page desk seller-home" data-testid="seller-home">
      <PageHead
        title="Dashboard"
        lede="Your collection overview and the quickest way to add more cards."
      />
      <div className="seller-home-grid">
        <section className="seller-tile seller-tile-portfolio" aria-labelledby="seller-portfolio-title">
          <header className="seller-tile-head">
            <h2 id="seller-portfolio-title">Portfolio</h2>
            <p className="seller-tile-sub">Your collection</p>
          </header>
          {loading ? (
            <div className="seller-tile-body" aria-busy="true" aria-label="Loading collection">
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          ) : null}
          {error ? (
            <div className="seller-tile-body">
              <Alert>{error}</Alert>
              <div className="seller-tile-actions">
                <button type="button" className="btn ghost" onClick={retryCollection} data-testid="portfolio-retry">
                  Retry
                </button>
                <a className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                  View collection
                </a>
              </div>
            </div>
          ) : null}
          {!loading && !error && empty ? (
            <EmptyDesk
              nested
              title="No cards in your collection yet."
              lede="Scan a pile to add cards you own, or list them for sale."
            >
              <Link className="btn" to="/scan" data-testid="portfolio-empty-scan">Scan cards</Link>
              <a className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                View collection
              </a>
            </EmptyDesk>
          ) : null}
          {!loading && !error && !empty ? (
            <div className="seller-tile-body">
              <MetricGrid>
                <Metric
                  value={String(ownedCards)}
                  label={ownedCards === 1 ? 'Card owned' : 'Cards owned'}
                  hint="Sum of quantities in your collection"
                />
                <Metric
                  value={String(listed?.cards ?? '—')}
                  label="Listed for sale"
                  hint={listed?.failed
                    ? 'Listings unavailable'
                    : `Sum of quantity on live asks · ${listed?.listings === 1 ? '1 listing' : `${listed?.listings ?? 0} listings`}`}
                />
              </MetricGrid>
              <div className="seller-tile-actions">
                <a className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                  View collection
                </a>
              </div>
            </div>
          ) : null}
        </section>

        <section className="seller-tile seller-tile-list" aria-labelledby="seller-list-title">
          <header className="seller-tile-head">
            <h2 id="seller-list-title">Add Cards</h2>
            <p className="seller-tile-sub">Scan cards to add them to your collection or list them for sale.</p>
          </header>
          <div className="seller-tile-body seller-tile-cta">
            <Link className="btn" to="/scan" data-testid="list-cards-scan">
              Scan cards
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
