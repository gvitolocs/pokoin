import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { attachRecentsToHome, fetchCardTiles, fetchHome, setSlug, warmupSearchBar } from '../api.js';
import { useAuth } from '../auth.jsx';
import { game } from '../game.js';
import { readHomeVectorCache, writeHomeVectorCache } from '../home-cache.js';
import { readRecentCardIds, syncRemoteRecentCardIds } from '../recents.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import Carousel, { SkeletonTile } from '../components/Carousel.jsx';
import PromoCarousel from '../components/PromoCarousel.jsx';

function cardsForIds(cards, ids) {
  const byId = new Map(cards.map((card) => [String(card.id), card]));
  return (ids || []).map((id) => byId.get(String(id))).filter(Boolean);
}

function paintHome(payload, recentIds, extraCards = []) {
  return attachRecentsToHome(payload, recentIds, extraCards);
}

export default function Home() {
  const { ready } = useAuth();
  const site = game();
  const payloadRef = useRef(null);
  const [payload, setPayload] = useState(() => {
    const cached = readHomeVectorCache(site.id);
    const next = cached ? paintHome(cached, readRecentCardIds()) : null;
    payloadRef.current = next;
    return next;
  });
  const [error, setError] = useState('');
  const [recentPending, setRecentPending] = useState(() => {
    const ids = readRecentCardIds();
    const seen = payloadRef.current?.sections?.recentlySeenIds || [];
    return ids.length > 0 && seen.length < ids.length;
  });

  function commit(next) {
    payloadRef.current = next;
    setPayload(next);
  }

  useEffect(() => {
    document.title = site.title;
    let cancelled = false;
    const localIds = readRecentCardIds();
    const seen = payloadRef.current?.sections?.recentlySeenIds || [];
    setRecentPending(localIds.length > 0 && seen.length < localIds.length);

    // Public rails. Do not wait on Firebase or Firestore.
    fetchHome(localIds)
      .then(async (data) => {
        if (cancelled) {
          return;
        }
        writeHomeVectorCache(site.id, data);
        const ids = readRecentCardIds();
        const painted = paintHome(data, ids);
        commit(painted);
        warmupSearchBar();
        const missing = painted.missingRecentIds || [];
        if (!missing.length) {
          setRecentPending(false);
          return;
        }
        const tiles = await fetchCardTiles(missing).catch(() => []);
        if (cancelled) {
          return;
        }
        commit(paintHome(data, readRecentCardIds(), tiles));
        setRecentPending(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Marketplace home failed.');
          setRecentPending(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [site.id, site.title]);

  useEffect(() => {
    if (!ready) {
      return undefined;
    }
    let cancelled = false;
    syncRemoteRecentCardIds()
      .then(async (ids) => {
        if (cancelled || !ids.length) {
          return;
        }
        const current = payloadRef.current;
        if (!current) {
          return;
        }
        const next = paintHome(current, ids);
        commit(next);
        const missing = next.missingRecentIds || [];
        if (!missing.length) {
          setRecentPending(false);
          return;
        }
        setRecentPending(true);
        const tiles = await fetchCardTiles(missing).catch(() => []);
        if (cancelled) {
          return;
        }
        commit(paintHome(payloadRef.current || next, ids, tiles));
        setRecentPending(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ready]);

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
  const newSet = sections.newCards[0]?.set || sections.newCards[0]?.set_name;
  const mega = sections.newCards[0] || sections.spotlight[0];
  const recentPlaceholders = recentPending && !sections.recentlySeen.length ? 8 : 0;

  return (
    <div className="page" aria-busy={loading || recentPending ? 'true' : undefined}>
      {error ? <p className="status error">{error}</p> : null}
      {site.features.promoCarousel ? <PromoCarousel /> : null}

      <Carousel title="Recently seen" cards={sections.recentlySeen} placeholders={recentPlaceholders} />
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
