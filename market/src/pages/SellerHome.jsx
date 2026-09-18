import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { fetchSellerListings } from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { sumOwnedQuantity } from '../collection-holdings.js';
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
    const q = query(collection(firestore, 'user_card_collections'), where('uid', '==', uid));
    const unsub = onSnapshot(q, (snap) => {
      if (cancelled) return;
      const rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      setOwnedCards(sumOwnedQuantity(rows));
    }, (err) => {
      if (!cancelled) {
        setError(err.message || 'Could not load collection.');
        setOwnedCards(0);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [signedIn, user?.uid, profile?.uid]);

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
  const empty = ownedCards === 0 && !(listed?.cards > 0);
  const collectionHref = marketUrl(APP.collection);

  return (
    <div className="page desk seller-home" data-testid="seller-home">
      <PageHead
        kicker="Seller"
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
              <a className="btn ghost" href={collectionHref} data-testid="portfolio-view-collection">
                View collection
              </a>
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
            <h2 id="seller-list-title">List Cards</h2>
            <p className="seller-tile-sub">Scan your cards and add them to your collection or list them for sale.</p>
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
