import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { attachRecentsToHome, fetchCard, fetchCardTiles, fetchExpansion, fetchExpansions, fetchHome, fillMissingLastMedianPrices, setSlug, warmupSearchBar } from '../api.js';
import { ASSET_COVERAGE_LINE } from '../buyer-protection.js';
import { tileHasName } from '../lists.js';
import { isSetDeskCard } from '../search-filters.js';
import { useAuth } from '../auth.jsx';
import { game, isPokemonGame } from '../game.js';
import {
  HOME_BROWSE_BLOCK,
  createEnglishBrowseState,
  fillEnglishBrowse,
} from '../home-browse.js';
import { readHomeVectorCache, writeHomeVectorCache } from '../home-cache.js';
import { tilePricePkn } from '../pkn.js';
import { readRecentCardIds, readRecentTiles, rememberRecentTiles, pruneUnresolvedRecents, syncRemoteRecentCardIds } from '../recents.js';
import { Action, track } from '../track.js';
import { isOriginDownError, noteOriginDown, publicErrorMessage } from '../working-page.js';
import { framedByChromeExtension } from '../extension-auth-bridge.js';
import CardTile from '../components/CardTile.jsx';
import Carousel, { SkeletonTile } from '../components/Carousel.jsx';
import PromoCarousel from '../components/PromoCarousel.jsx';
import SeoHead from '../components/SeoHead.jsx';

function cardsForIds(cards, ids) {
  const byId = new Map((cards || []).map((card) => [String(card.id), card]));
  return (ids || []).map((id) => byId.get(String(id))).filter(tileHasName).filter(isSetDeskCard);
}

function spotlightBrowse(payload) {
  return cardsForIds(payload?.cards, payload?.sections?.spotlightIds);
}

function paintHome(payload, recentIds, extraCards = []) {
  return attachRecentsToHome(payload, recentIds, extraCards);
}

function localExtras(tiles = []) {
  return [...readRecentTiles(), ...tiles];
}

function seedHome(cached) {
  const ids = readRecentCardIds();
  const extras = localExtras();
  if (cached) {
    return paintHome(cached, ids, extras);
  }
  if (!extras.length) {
    return null;
  }
  return paintHome({ cards: [], sections: {} }, ids, extras);
}

function railsReady(payload) {
  return Boolean(payload?.sections?.newArrivalIds?.length);
}

function recentsNeedingTiles(payload, ids) {
  const byId = new Map((payload?.cards || []).map((card) => [String(card.id), card]));
  return (ids || []).filter((id) => {
    const card = byId.get(String(id));
    return !tileHasName(card) || tilePricePkn(card) == null;
  });
}

async function fillMissingRecents(payload, ids, already = []) {
  const first = paintHome(payload, ids, localExtras(already));
  const need = recentsNeedingTiles(first, ids);
  if (!need.length) {
    return first;
  }
  const tiles = await fetchCardTiles(need).catch(() => []);
  rememberRecentTiles(tiles);
  const filled = paintHome(payload, ids, localExtras([...already, ...tiles]));
  const still = recentsNeedingTiles(filled, ids).filter((id) => {
    const card = (filled.cards || []).find((row) => String(row.id) === String(id));
    return !tileHasName(card);
  });
  if (!still.length) {
    return filled;
  }
  const extras = await Promise.all(
    still.slice(0, 8).map((id) => fetchCard(id).then((row) => row?.card || null).catch(() => null)),
  );
  const hydrated = extras.filter(Boolean);
  rememberRecentTiles(hydrated);
  const next = paintHome(payload, ids, localExtras([...already, ...tiles, ...hydrated]));
  // Ids that still have no name are not in this game — drop them from local history.
  const resolved = (next.sections?.recentlySeenIds || []).filter((id) => {
    const card = (next.cards || []).find((row) => String(row.id) === String(id));
    return tileHasName(card);
  });
  if (resolved.length !== ids.length) {
    pruneUnresolvedRecents(resolved);
    return paintHome(payload, resolved, localExtras([...already, ...tiles, ...hydrated]));
  }
  return next;
}

export default function Home() {
  const { ready } = useAuth();
  const site = game();
  const payloadRef = useRef(null);
  const [payload, setPayload] = useState(() => {
    const next = seedHome(readHomeVectorCache(site.id));
    payloadRef.current = next;
    return next;
  });
  const [error, setError] = useState('');
  const [recentPending, setRecentPending] = useState(() => {
    const ids = readRecentCardIds();
    const seen = payloadRef.current?.sections?.recentlySeenIds || [];
    return ids.length > 0 && seen.length < ids.length;
  });
  const englishBrowse = isPokemonGame();
  const browseRef = useRef(null);
  const [browseCards, setBrowseCards] = useState([]);
  const [browseHasMore, setBrowseHasMore] = useState(englishBrowse);
  const [browseLoading, setBrowseLoading] = useState(englishBrowse);
  const [browseMoreBusy, setBrowseMoreBusy] = useState(false);

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
        const painted = paintHome(data, ids, localExtras());
        commit(painted);
        warmupSearchBar();
        let next = painted;
        if (!recentsNeedingTiles(painted, ids).length) {
          setRecentPending(false);
        } else {
          next = await fillMissingRecents(data, readRecentCardIds());
          if (cancelled) {
            return;
          }
          commit(next);
          setRecentPending(false);
        }
        const priced = await fillMissingLastMedianPrices(next.cards || []);
        if (cancelled) {
          return;
        }
        next = { ...next, cards: priced };
        writeHomeVectorCache(site.id, next);
        commit(next);
      })
      .catch((err) => {
        if (!cancelled) {
          if (isOriginDownError(err, err?.status, err?.message)) {
            if (!framedByChromeExtension()) {
              noteOriginDown();
            }
            setRecentPending(false);
            return;
          }
          setError(publicErrorMessage(err, 'Marketplace home failed.'));
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
        if (cancelled) {
          return;
        }
        const current = payloadRef.current;
        if (!current) {
          return;
        }
        const next = paintHome(current, ids, localExtras());
        commit(next);
        if (!ids.length) {
          setRecentPending(false);
          return;
        }
        if (!recentsNeedingTiles(next, ids).length) {
          setRecentPending(false);
          return;
        }
        setRecentPending(true);
        const filled = await fillMissingRecents(payloadRef.current || next, ids);
        if (cancelled) {
          return;
        }
        const priced = await fillMissingLastMedianPrices(filled.cards || []);
        commit({ ...filled, cards: priced });
        setRecentPending(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ready]);

  useEffect(() => {
    if (!englishBrowse) {
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchExpansions({ limit: 500 });
        if (cancelled) {
          return;
        }
        browseRef.current = createEnglishBrowseState(data.expansions || data.sets || []);
        const next = await fillEnglishBrowse(browseRef.current, {
          fetchExpansionPage: fetchExpansion,
        });
        if (cancelled) {
          return;
        }
        const filled = next.cards.length ? next.cards : spotlightBrowse(payloadRef.current);
        setBrowseCards(filled);
        setBrowseHasMore(next.hasMore && next.cards.length > 0);
        if (!filled.length) {
          return;
        }
        const priced = await fillMissingLastMedianPrices(filled);
        if (cancelled) {
          return;
        }
        setBrowseCards(priced);
      } catch (_) {
        if (!cancelled) {
          const fallback = spotlightBrowse(payloadRef.current);
          if (fallback.length) {
            setBrowseCards(fallback);
          }
          setBrowseHasMore(false);
        }
      } finally {
        if (!cancelled) {
          setBrowseLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [englishBrowse]);

  async function loadMoreEnglish() {
    if (!browseRef.current || browseMoreBusy) {
      return;
    }
    setBrowseMoreBusy(true);
    try {
      const next = await fillEnglishBrowse(browseRef.current, {
        fetchExpansionPage: fetchExpansion,
      });
      setBrowseCards((current) => [...current, ...next.cards]);
      setBrowseHasMore(next.hasMore);
      const priced = await fillMissingLastMedianPrices(next.cards);
      const byId = new Map(priced.map((card) => [String(card.id), card]));
      setBrowseCards((current) => current.map((card) => byId.get(String(card.id)) || card));
      if (next.cards[0]) {
        track(Action.loadMore, next.cards[0], { query: 'home-english', resultCount: browseCards.length + next.cards.length });
      }
    } finally {
      setBrowseMoreBusy(false);
    }
  }

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
      recentlySeen: cardsForIds(cards, ids.recentlySeenIds).slice(0, 20),
      newCards: cardsForIds(cards, ids.newArrivalIds),
      bestSellers: cardsForIds(cards, ids.bestSellerIds),
      featured: cardsForIds(cards, ids.featuredIds),
      spotlight: cardsForIds(cards, ids.spotlightIds).length
        ? cardsForIds(cards, ids.spotlightIds)
        : cards,
    };
  }, [payload]);

  const loading = !railsReady(payload) && !error;
  const newSet = sections.newCards[0]?.set || sections.newCards[0]?.set_name;
  const mega = sections.newCards[0] || sections.spotlight[0] || browseCards[0];
  const recentPlaceholders = recentPending && !sections.recentlySeen.length ? 8 : 0;
  const gridCards = englishBrowse ? browseCards : sections.spotlight;
  const gridLoading = englishBrowse ? browseLoading && !browseCards.length : loading;
  const gridPlaceholders = englishBrowse ? HOME_BROWSE_BLOCK : 12;
  return (
    <div className="page home" aria-busy={loading || recentPending ? 'true' : undefined}>
      <SeoHead
        title={site.title}
        description="Buy and sell Pokémon TCG cards in PKN. Browse Pokémon, sets, eras, artists, and listings."
        canonical="/marketplace"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Pokoin',
          url: 'https://pokoin.com/',
          potentialAction: {
            '@type': 'SearchAction',
            target: 'https://pokoin.com/marketplace/search?q={search_term_string}',
            'query-input': 'required name=search_term_string',
          },
        }}
      />
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
      <Carousel title="Spotlight" cards={sections.featured} placeholders={loading ? 8 : 0} />

      <Link className="callout protect-callout" to="/protection">
        {ASSET_COVERAGE_LINE}
        <span>Buyer protection →</span>
      </Link>

      <Link className="callout" to="/inventory" onClick={() => track(Action.sell, mega || { id: '703382', name: 'sell' })}>
        Sell your cards for PKN
        <span>Get started →</span>
      </Link>

      <section>
        <div className="carousel-head">
          <h2>Marketplace</h2>
        </div>
        <div className="grid">
          {gridLoading
            ? Array.from({ length: gridPlaceholders }, (_, index) => <SkeletonTile key={index} />)
            : gridCards.map((card, index) => (
                <CardTile key={card.id} card={card} rank={index} />
              ))}
        </div>
        {englishBrowse && browseHasMore ? (
          <button className="more" type="button" onClick={loadMoreEnglish} disabled={browseMoreBusy}>
            {browseMoreBusy ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </section>
    </div>
  );
}
