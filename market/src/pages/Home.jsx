import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchHome, readRecentCardIds, setSlug } from '../api.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import Carousel, { SkeletonTile } from '../components/Carousel.jsx';
import PromoCarousel from '../components/PromoCarousel.jsx';

function cardsForIds(cards, ids) {
  const byId = new Map(cards.map((card) => [String(card.id), card]));
  return (ids || []).map((id) => byId.get(String(id))).filter(Boolean);
}

export default function Home() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Pokoin marketplace';
    let cancelled = false;
    fetchHome(readRecentCardIds())
      .then((data) => {
        if (!cancelled) {
          setPayload(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Marketplace home failed.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo(() => {
    const empty = {
      recentlySeen: [],
      newCards: [],
      bestSellers: [],
      featured: [],
      topSold: [],
      spotlight: [],
    };
    if (!payload) {
      return empty;
    }
    const cards = payload.cards || [];
    const ids = payload.sections || {};
    return {
      recentlySeen: cardsForIds(cards, ids.recentlySeenIds),
      newCards: cardsForIds(cards, ids.newArrivalIds),
      bestSellers: cardsForIds(cards, ids.bestSellerIds),
      featured: cardsForIds(cards, ids.featuredIds),
      topSold: cardsForIds(cards, ids.topSoldIds),
      spotlight: cardsForIds(cards, ids.spotlightIds).length
        ? cardsForIds(cards, ids.spotlightIds)
        : cards,
    };
  }, [payload]);

  const loading = !payload && !error;
  const newSet = sections.newCards[0]?.set;
  const mega = sections.newCards[0] || sections.spotlight[0];

  return (
    <div className="page" aria-busy={loading ? 'true' : undefined}>
      {error ? <p className="status error">{error}</p> : null}
      <PromoCarousel />

      <Carousel title="Recently seen" cards={sections.recentlySeen} placeholders={loading ? 8 : 0} />
      <Carousel
        title="New cards"
        cards={sections.newCards}
        href={newSet ? `/marketplace/sets/${setSlug(newSet)}` : undefined}
        placeholders={loading ? 8 : 0}
      />
      <Carousel title="Best sellers" cards={sections.bestSellers} placeholders={loading ? 8 : 0} />
      <Carousel title="Featured" cards={sections.featured} placeholders={loading ? 8 : 0} />
      <Carousel title="Popular" cards={sections.topSold} placeholders={loading ? 8 : 0} />

      <Link className="callout" to="/inventory" onClick={() => track(Action.sell, mega || { id: '703382', name: 'sell' })}>
        Sell your cards for PKN
        <span>Get started →</span>
      </Link>

      <section>
        <div className="carousel-head">
          <h2>Marketplace</h2>
        </div>
        <div className="grid">
          {loading
            ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} />)
            : sections.spotlight.map((card, index) => (
                <CardTile key={card.id} card={card} rank={index} />
              ))}
        </div>
      </section>
    </div>
  );
}
