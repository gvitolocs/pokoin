import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  cardFromCatalogRow,
  fetchCardTraderAssets,
  fetchCheapestPricePknMap,
  fetchCollectionSummary,
  fetchSellerListings,
} from '../api.js';
import { fetchOwnedCollectionDocuments } from '../firestore-rest.js';
import { fetchRail, RAIL } from '../lists.js';
import { useAuth } from '../auth.jsx';
import { SellerDashboardView } from '../components/SellerDashboardView.jsx';
import { SessionWait } from '../components/Desk.jsx';
import {
  inventoryListingHref,
  liveInventoryListings,
  summarizeLiveInventory,
} from '../inventory-listings.js';
import {
  buildCollectionHistory,
  marketValueFromHoldings,
  movementFromLedger,
} from '../portfolio-history.js';
import {
  portfolioTilesFingerprint,
  portfolioTilesFromSummary,
  readPortfolioTilesCache,
  writePortfolioTilesCache,
} from '../portfolio-tiles-cache.js';
import { APP, marketUrl } from '../punchouts.js';
import '../seller-home.css';

const LISTINGS_LIMIT = 200;
const MOVER_LIMIT = 10;
// The dashboard's visual inventory is a 12-by-6 sheet of card miniatures.
const LISTING_PREVIEW = 72;

/** Dev/local layout fixtures — never presented as live production data. */
const PREVIEW_FIXTURE = {
  ownedCards: 327,
  physicalOwned: 290,
  nftOwned: 37,
  uniqueItems: 241,
  pknBalance: 15,
  cardTraderAssets: {
    oneDayReady: true,
    totals: { products: 3, cards: 5, valuePkn: 1840 },
    items: [
      { ctProductId: 'p1', cardId: '968186', cardName: 'Snorlax', setName: 'Pokémon Card 151', condition: 'NM', language: 'EN', quantity: 2, pricePkn: 620, imageUrl: '/card-images/502874_snorlax-181-165-pokemon-card-151.jpg' },
      { ctProductId: 'p2', cardId: '968172', cardName: 'Psyduck', setName: 'Pokémon Card 151', condition: 'NM', language: 'IT', reverse: true, quantity: 1, pricePkn: 260, imageUrl: '/card-images/502862_psyduck-175-165-pokemon-card-151.jpg' },
      { ctProductId: 'p3', cardId: '968124', cardName: 'Slowpoke', setName: 'Scarlet & Violet', condition: 'SP', language: 'EN', quantity: 2, pricePkn: 170, imageUrl: '/card-images/484062_slowpoke-204-198-scarlet-violet.jpg' },
    ],
  },
  listed: { listings: 18, cards: 24, listedPkn: 12400 },
  listingRows: [
    {
      id: 'p1',
      cardName: 'Charizard ex',
      setName: 'Obsidian Flames',
      condition: 'NM',
      quantityAvailable: 1,
      pricePkn: 4200,
      cardImageUrl: '',
      cardId: '1',
    },
    {
      id: 'p2',
      cardName: 'Pikachu',
      setName: 'Base Set',
      condition: 'LP',
      quantityAvailable: 2,
      pricePkn: 180,
      cardImageUrl: '',
      cardId: '2',
    },
    {
      id: 'p3',
      cardName: 'Mewtwo LV.X',
      setName: 'Legends Awakened',
      condition: 'NM',
      quantityAvailable: 1,
      pricePkn: 950,
      cardImageUrl: '',
      cardId: '3',
    },
    {
      id: 'p4',
      cardName: 'Umbreon VMAX',
      setName: 'Evolving Skies',
      condition: 'NM',
      quantityAvailable: 1,
      pricePkn: 3100,
      cardImageUrl: '',
      cardId: '4',
    },
  ],
  movers: [
    { id: '101', name: 'Mimikyu', set: 'Stellar Crown', number: '037/142', price: 42 },
    { id: '102', name: 'Gardevoir ex', set: 'Scarlet & Violet', number: '086/198', price: 18 },
    { id: '103', name: 'Roaring Moon ex', set: 'Paradox Rift', number: '124/182', price: 55 },
    { id: '104', name: 'Iron Valiant ex', set: 'Paradox Rift', number: '089/182', price: 12 },
    { id: '105', name: 'Charizard', set: '151', number: '006/165', price: 28 },
  ].map(cardFromCatalogRow),
};

function moversFromRail(rail) {
  const cards = ((rail && rail.cards) || []).map(cardFromCatalogRow).filter((c) => c.id);
  return cards.slice(0, MOVER_LIMIT);
}

function allowLayoutPreview(searchParams, pathname = '') {
  // Explicit fixture layout only — never when reviewing live auth data.
  if (!searchParams.has('dashPreview')) return false;
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

export default function SellerHome() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const preview = allowLayoutPreview(searchParams, location.pathname);
  const { user, ready, signedIn, profile, getBearer, availablePkn } = useAuth();
  const [ownedCards, setOwnedCards] = useState(null);
  const [physicalOwned, setPhysicalOwned] = useState(0);
  const [nftOwned, setNftOwned] = useState(0);
  const [uniqueItems, setUniqueItems] = useState(0);
  const [listed, setListed] = useState(null);
  const [listingRows, setListingRows] = useState([]);
  const [movers, setMovers] = useState([]);
  const [cardTraderAssets, setCardTraderAssets] = useState(null);
  const [assetsSettled, setAssetsSettled] = useState(false);
  const [historySeries, setHistorySeries] = useState([]);
  const [historyPending, setHistoryPending] = useState(false);
  const [error, setError] = useState('');
  const uid = user?.uid || profile?.uid || '';

  const collectionHref = marketUrl(APP.collection);
  const inventoryHref = marketUrl(APP.inventory);
  const marketplaceHref = marketUrl('/marketplace');

  useEffect(() => {
    document.title = 'Dashboard · Pokoin';
  }, []);

  useEffect(() => {
    if (preview) return undefined;
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    // Instant paint from the last successful tile metrics for this uid.
    const cached = readPortfolioTilesCache(uid);
    if (cached) {
      setOwnedCards(cached.ownedCards);
      setPhysicalOwned(cached.physicalOwned);
      setNftOwned(cached.nftOwned);
      setUniqueItems(cached.uniqueItems);
      if (cached.listed) setListed(cached.listed);
      setError('');
    } else {
      setOwnedCards(null);
      setError('');
    }
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        if (cancelled) return;
        const next = portfolioTilesFromSummary(data);
        const entry = writePortfolioTilesCache(uid, next) || { ...next, fingerprint: portfolioTilesFingerprint(next) };
        const prevFp = cached?.fingerprint || '';
        if (entry.fingerprint !== prevFp || cached == null) {
          setOwnedCards(entry.ownedCards);
          setPhysicalOwned(entry.physicalOwned);
          setNftOwned(entry.nftOwned);
          setUniqueItems(entry.uniqueItems);
        }
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('dashboard collection summary failed', err);
        // Keep cached tiles on screen when the refresh fails.
        if (cached) return;
        setError("Couldn't load your collection");
        setOwnedCards(0);
      });
    return () => {
      cancelled = true;
    };
  }, [preview, signedIn, user?.uid, profile?.uid, getBearer]);

  useEffect(() => {
    if (preview) return undefined;
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    const cached = readPortfolioTilesCache(uid);
    // Do not blank listed tiles when we already painted from cache.
    if (!cached?.listed) {
      setListed(null);
      setListingRows([]);
    }
    getBearer()
      .then((token) => fetchSellerListings(uid, token, { limit: LISTINGS_LIMIT }))
      .then((data) => {
        if (cancelled) return;
        const live = liveInventoryListings(data.listings || data.items || []);
        const summary = summarizeLiveInventory(live);
        writePortfolioTilesCache(uid, { listed: summary });
        setListed(summary);
        setListingRows(live.slice(0, LISTING_PREVIEW));
      })
      .catch(() => {
        if (cancelled) return;
        if (cached?.listed && !cached.listed.failed) {
          // Keep the cached listed tile; only fail when we had nothing to show.
          return;
        }
        const failed = { listings: 0, cards: 0, listedPkn: 0, failed: true };
        writePortfolioTilesCache(uid, { listed: failed });
        setListed(failed);
        setListingRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [preview, signedIn, user?.uid, profile?.uid, getBearer]);

  // CardTrader 1-Day Ready stock: dashboard assets, never Pokoin listings.
  useEffect(() => {
    if (preview) return undefined;
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    setAssetsSettled(false);
    getBearer()
      .then((token) => fetchCardTraderAssets(token))
      .then((data) => {
        if (!cancelled) setCardTraderAssets(data?.oneDayReady ? data : null);
      })
      .catch(() => {
        if (!cancelled) setCardTraderAssets(null);
      })
      .finally(() => {
        if (!cancelled) setAssetsSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [preview, signedIn, user?.uid, profile?.uid, getBearer]);

  useEffect(() => {
    if (preview || !uid) return undefined;
    let cancelled = false;
    setHistoryPending(true);
    (async () => {
      let movements = [];
      try {
        const token = await getBearer();
        const rows = await fetchOwnedCollectionDocuments('ledger_entries', uid, token, { limit: 200 });
        movements = rows.map(movementFromLedger).filter(Boolean);
      } catch {
        movements = [];
      }
      let marketCardsPkn = null;
      const items = assetsSettled && cardTraderAssets?.oneDayReady ? cardTraderAssets.items || [] : [];
      if (assetsSettled && items.length) {
        const ids = [...new Set(items.map((item) => String(item.cardId || '').trim()).filter((id) => /^\d+$/.test(id)))];
        const prices = {};
        const chunks = [];
        for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
        const parts = await Promise.all(chunks.map((chunk) => fetchCheapestPricePknMap(chunk)));
        for (const part of parts) Object.assign(prices, part);
        marketCardsPkn = marketValueFromHoldings(items, prices)?.cardsValuePkn ?? null;
      }
      if (cancelled) return;
      setHistorySeries(buildCollectionHistory({
        movements,
        balance: availablePkn,
        marketCardsPkn: assetsSettled ? marketCardsPkn : null,
      }));
      setHistoryPending(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [preview, uid, availablePkn, cardTraderAssets, assetsSettled, getBearer]);

  useEffect(() => {
    if (preview) return undefined;
    let cancelled = false;
    // Trending reads the table-backed best_sellers rail (~90 ms). The shared
    // home hydrate in api.js is seconds cold on api.pokoin.com, and the
    // dashboard host is not on the origin-worker cached route. Its hydrate
    // payload carries bestSellerIds but no newArrivalIds, so
    // isPublicRailsVector rejected it — seconds of wait, then discarded.
    async function loadMovers() {
      const bestSellers = await fetchRail(RAIL.bestSellers).catch(() => null);
      if (cancelled) return;
      if (bestSellers?.cards?.length) {
        setMovers(moversFromRail(bestSellers));
        return;
      }
      const featured = await fetchRail(RAIL.featured).catch(() => null);
      if (!cancelled) setMovers(moversFromRail(featured));
    }
    loadMovers();
    return () => {
      cancelled = true;
    };
  }, [preview]);

  function retryCollection() {
    const uid = user?.uid || profile?.uid;
    const cached = uid ? readPortfolioTilesCache(uid) : null;
    // Retry keeps cached numbers visible — no skeleton flash.
    if (!cached) setOwnedCards(null);
    setError('');
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        if (!uid) return;
        const next = portfolioTilesFromSummary(data);
        const entry = writePortfolioTilesCache(uid, next) || next;
        setOwnedCards(entry.ownedCards);
        setPhysicalOwned(entry.physicalOwned);
        setNftOwned(entry.nftOwned);
        setUniqueItems(entry.uniqueItems);
        setError('');
      })
      .catch((err) => {
        console.error('dashboard collection summary failed', err);
        if (cached) return;
        setError("Couldn't load your collection");
        setOwnedCards(0);
      });
  }

  const previewView = useMemo(() => {
    if (!preview) return null;
    return (
      <SellerDashboardView
        previewBanner
        ownedCards={PREVIEW_FIXTURE.ownedCards}
        physicalOwned={PREVIEW_FIXTURE.physicalOwned}
        nftOwned={PREVIEW_FIXTURE.nftOwned}
        uniqueItems={PREVIEW_FIXTURE.uniqueItems}
        pknBalance={PREVIEW_FIXTURE.pknBalance}
        cardTraderAssets={PREVIEW_FIXTURE.cardTraderAssets}
        listed={PREVIEW_FIXTURE.listed}
        listingRows={PREVIEW_FIXTURE.listingRows}
        movers={PREVIEW_FIXTURE.movers}
        loading={false}
        error=""
        collectionHref={collectionHref}
        inventoryHref={inventoryHref}
        marketplaceHref={marketplaceHref}
        onRetry={() => {}}
        listingHrefFor={() => inventoryHref}
      />
    );
  }, [preview, collectionHref, inventoryHref, marketplaceHref]);

  if (preview) {
    return previewView;
  }

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/')}`} replace />;
  }

  const loading = ownedCards == null;

  return (
    <SellerDashboardView
      ownedCards={ownedCards ?? 0}
      physicalOwned={physicalOwned}
      nftOwned={nftOwned}
      uniqueItems={uniqueItems}
      pknBalance={availablePkn}
      cardTraderAssets={cardTraderAssets}
      historySeries={historySeries}
      historyPending={historyPending}
      listed={listed}
      listingRows={listingRows}
      movers={movers}
      loading={loading}
      error={error}
      collectionHref={collectionHref}
      inventoryHref={inventoryHref}
      marketplaceHref={marketplaceHref}
      onRetry={retryCollection}
      listingHrefFor={(row) => {
        const path = inventoryListingHref(row);
        return path.startsWith('/marketplace') ? marketUrl(path) : path;
      }}
    />
  );
}
