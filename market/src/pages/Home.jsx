import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchExpansion, fetchHome, readRecentCardIds, setSlug } from '../api.js';
import { FLUTTER } from '../punchouts.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import Carousel, { SkeletonTile } from '../components/Carousel.jsx';

function cardsForIds(cards, ids) {
  const byId = new Map(cards.map((card) => [String(card.id), card]));
  return (ids || []).map((id) => byId.get(String(id))).filter(Boolean);
}

export default function Home() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Pokoin marketplace';
    fetchExpansion({ slug: 'mega-evolution', limit: 48 }).catch(() => {});
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
      <section className="promo" aria-label="Featured">
        <div>
          <p className="eyebrow">Pokémon TCG</p>
          <h1>Shop the Mega Era</h1>
          <p className="muted">Singles from Mega Evolution, priced in PKN. Identity is set + number + public card id.</p>
          <Link
            className="btn"
            to="/marketplace/sets/mega-evolution"
            onPointerEnter={() => {
              fetchExpansion({ slug: 'mega-evolution', limit: 48 }).catch(() => {});
            }}
            onClick={() => track(Action.clickBanner, mega || { id: '703382', name: 'Mega Evolution' })}
          >
            Browse Mega Evolution
          </Link>
        </div>
      </section>

      <Carousel title="Recently seen" cards={sections.recentlySeen} placeholders={loading ? 8 : 0} />
      <Carousel
        title="New cards"
        cards={sections.newCards}
        href={newSet ? `/marketplace/sets/${setSlug(newSet)}` : undefined}
        placeholders={loading ? 8 : 0}
      />
      <Carousel title="Best sellers" cards={sections.bestSellers} placeholders={loading ? 8 : 0} />
      <Carousel title="Featured" cards={sections.featured} placeholders={loading ? 8 : 0} />

      <a className="callout" href={FLUTTER.inventory} onClick={() => track(Action.sell, mega || { id: '703382', name: 'sell' })}>
        Sell your cards for PKN
        <span>Get started →</span>
      </a>

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
