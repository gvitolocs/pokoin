import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  cardFromCatalogRow,
  fetchCollectionSummary,
  fetchHome,
  fetchSellerListings,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { SellerDashboardView } from '../components/SellerDashboardView.jsx';
import { SessionWait } from '../components/Desk.jsx';
import {
  inventoryListingHref,
  liveInventoryListings,
  summarizeLiveInventory,
} from '../inventory-listings.js';
import { APP, marketUrl } from '../punchouts.js';
import '../seller-home.css';

const LISTINGS_LIMIT = 200;
const MOVER_LIMIT = 10;
const LISTING_PREVIEW = 6;

/** Dev/local layout fixtures — never presented as live production data. */
const PREVIEW_FIXTURE = {
  ownedCards: 327,
  physicalOwned: 290,
  nftOwned: 37,
  uniqueItems: 241,
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

function cardsForIds(cards, ids) {
  const byId = new Map((cards || []).map((card) => [String(card.id), card]));
  return (ids || []).map((id) => byId.get(String(id))).filter(Boolean);
}

function moversFromHome(payload) {
  if (!payload) return [];
  const cards = (payload.cards || []).map(cardFromCatalogRow).filter((c) => c.id);
  const sections = payload.sections || {};
  // Best sellers is a ranked marketplace rail — no % change in the payload.
  const ranked = cardsForIds(cards, sections.bestSellerIds);
  if (ranked.length) return ranked.slice(0, MOVER_LIMIT);
  const featured = cardsForIds(cards, sections.featuredIds);
  if (featured.length) return featured.slice(0, MOVER_LIMIT);
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
  const { user, ready, signedIn, profile, getBearer } = useAuth();
  const [ownedCards, setOwnedCards] = useState(null);
  const [physicalOwned, setPhysicalOwned] = useState(0);
  const [nftOwned, setNftOwned] = useState(0);
  const [uniqueItems, setUniqueItems] = useState(0);
  const [listed, setListed] = useState(null);
  const [listingRows, setListingRows] = useState([]);
  const [movers, setMovers] = useState([]);
  const [error, setError] = useState('');

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
    setOwnedCards(null);
    setError('');
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        if (cancelled) return;
        setOwnedCards(Math.max(0, Number(data.cardsOwned) || 0));
        // Prefer qty sums; fall back to unique-item counts on older API responses.
        setPhysicalOwned(Math.max(0, Number(data.physicalOwned ?? data.physicalItems) || 0));
        setNftOwned(Math.max(0, Number(data.nftOwned ?? data.nftItems) || 0));
        setUniqueItems(Math.max(0, Number(data.items) || 0));
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
  }, [preview, signedIn, user?.uid, profile?.uid, getBearer]);

  useEffect(() => {
    if (preview) return undefined;
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    setListed(null);
    setListingRows([]);
    getBearer()
      .then((token) => fetchSellerListings(uid, token, { limit: LISTINGS_LIMIT }))
      .then((data) => {
        if (cancelled) return;
        const live = liveInventoryListings(data.listings || data.items || []);
        setListed(summarizeLiveInventory(live));
        setListingRows(live.slice(0, LISTING_PREVIEW));
      })
      .catch(() => {
        if (!cancelled) {
          setListed({ listings: 0, cards: 0, listedPkn: 0, failed: true });
          setListingRows([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [preview, signedIn, user?.uid, profile?.uid, getBearer]);

  useEffect(() => {
    if (preview) return undefined;
    let cancelled = false;
    fetchHome([])
      .then((payload) => {
        if (!cancelled) setMovers(moversFromHome(payload));
      })
      .catch(() => {
        if (!cancelled) setMovers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  function retryCollection() {
    setOwnedCards(null);
    setError('');
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        setOwnedCards(Math.max(0, Number(data.cardsOwned) || 0));
        setPhysicalOwned(Math.max(0, Number(data.physicalOwned ?? data.physicalItems) || 0));
        setNftOwned(Math.max(0, Number(data.nftOwned ?? data.nftItems) || 0));
        setUniqueItems(Math.max(0, Number(data.items) || 0));
      })
      .catch((err) => {
        console.error('dashboard collection summary failed', err);
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
