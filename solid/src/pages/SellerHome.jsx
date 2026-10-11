import { createEffect, createSignal, onSettled, Show, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import {
  cardFromCatalogRow,
  fetchCardTraderAssets,
  fetchCollectionSummary,
  fetchPortfolioHistory,
  fetchSellerListings,
} from '@market/api.js';
import { inventoryListingHref, liveInventoryListings, summarizeLiveInventory } from '@market/inventory-listings.js';
import { fetchRail, RAIL } from '@market/lists.js';
import { addUtcDays, utcDayKey } from '@market/portfolio-history.js';
import { loadPortfolioHistory, peekPortfolioHistory } from '@market/portfolio-history-cache.js';
import {
  portfolioTilesFingerprint,
  portfolioTilesFromSummary,
  readPortfolioTilesCache,
  writePortfolioTilesCache,
} from '@market/portfolio-tiles-cache.js';
import { APP, marketUrl } from '@market/punchouts.js';
import '@market/seller-home.css';
import { DashboardBoundary, SellerDashboardView } from '../components/dashboard/SellerDashboardView.jsx';
import SignedIn from '../components/SignedIn.jsx';
import { accountProfile, availablePkn } from '../stores/account.js';
import { authUid, getBearer, signedIn } from '../stores/auth.js';

const MOVER_LIMIT = 10;
// Owner reads come back cheapest-first and include cancelled rows. One page
// of 200 was 146 inactive + 54 live, so the sheet hid the rest of the stock.
const LISTINGS_PAGE = 1000;

/** Dev/local layout fixtures — never presented as live production data. */
const PREVIEW_FIXTURE = {
  ownedCards: 327,
  physicalOwned: 290,
  nftOwned: 37,
  uniqueItems: 241,
  pknBalance: 15,
  cardTraderAssets: {
    oneDayReady: true,
    totals: { products: 186, cards: 227, pricedCards: 106, valuePkn: 16740.15 },
    items: [
      { ctProductId: 'p1', cardId: '968186', cardName: 'Snorlax', setName: 'Pokémon Card 151', condition: 'NM', language: 'EN', quantity: 2, pricePkn: 620, imageUrl: '/card-images/502874_snorlax-181-165-pokemon-card-151.jpg' },
      { ctProductId: 'p2', cardId: '968172', cardName: 'Psyduck', setName: 'Pokémon Card 151', condition: 'NM', language: 'IT', reverse: true, quantity: 1, pricePkn: 260, imageUrl: '/card-images/502862_psyduck-175-165-pokemon-card-151.jpg' },
      { ctProductId: 'p3', cardId: '968124', cardName: 'Slowpoke', setName: 'Scarlet & Violet', condition: 'SP', language: 'EN', quantity: 2, pricePkn: 170, imageUrl: '/card-images/484062_slowpoke-204-198-scarlet-violet.jpg' },
    ],
  },
  listed: { listings: 18, cards: 24, listedPkn: 12400 },
  listingRows: [
    { id: 'p1', cardName: 'Charizard ex', setName: 'Obsidian Flames', condition: 'NM', quantityAvailable: 1, pricePkn: 4200, cardImageUrl: '', cardId: '1' },
    { id: 'p2', cardName: 'Pikachu', setName: 'Base Set', condition: 'LP', quantityAvailable: 2, pricePkn: 180, cardImageUrl: '', cardId: '2' },
    { id: 'p3', cardName: 'Mewtwo LV.X', setName: 'Legends Awakened', condition: 'NM', quantityAvailable: 1, pricePkn: 950, cardImageUrl: '', cardId: '3' },
    { id: 'p4', cardName: 'Umbreon VMAX', setName: 'Evolving Skies', condition: 'NM', quantityAvailable: 1, pricePkn: 3100, cardImageUrl: '', cardId: '4' },
  ],
  movers: [
    { id: '101', name: 'Mimikyu', set: 'Stellar Crown', number: '037/142', price: 42 },
    { id: '102', name: 'Gardevoir ex', set: 'Scarlet & Violet', number: '086/198', price: 18 },
    { id: '103', name: 'Roaring Moon ex', set: 'Paradox Rift', number: '124/182', price: 55 },
    { id: '104', name: 'Iron Valiant ex', set: 'Paradox Rift', number: '089/182', price: 12 },
    { id: '105', name: 'Charizard', set: '151', number: '006/165', price: 28 },
  ].map(cardFromCatalogRow),
};

/**
 * One point per day like the API: wallet 15 PKN for months, then 227 1-DR
 * cards from the sync day, carried between sales with small basket moves.
 */
function previewHistorySeries(now = new Date()) {
  const today = utcDayKey(now);
  const moves = { 20: 0.012, 15: -0.008, 10: 0.021, 6: 0.005, 3: -0.011, 1: 0.009 };
  const days = [{ date: addUtcDays(today, -121), currencyPkn: 0 }];
  let cards = 13135;
  let priced = 86;
  for (let back = 120; back >= 0; back -= 1) {
    const date = addUtcDays(today, -back);
    if (back > 26) {
      days.push({ date, currencyPkn: 15 });
      continue;
    }
    let move = back === 26 ? null : 0;
    if (back === 25) {
      priced = 87;
      cards = 13163;
    } else if (back === 24) {
      priced = 106;
      cards = 16285;
      move = -0.002127;
    } else if (moves[back] != null) {
      move = moves[back];
      cards = Math.round(cards * (1 + move) * 100) / 100;
    }
    days.push({ date, currencyPkn: 15, cardsKnown: true, cardsValuePkn: cards, cardsPriced: priced, cardsHeld: 227, cardsMove: move });
  }
  return days;
}

function moversFromRail(rail) {
  const cards = ((rail && rail.cards) || []).map(cardFromCatalogRow).filter((c) => c.id);
  return cards.slice(0, MOVER_LIMIT);
}

function allowLayoutPreview(params) {
  // Explicit fixture layout only — never when reviewing live auth data.
  if (params.dashPreview === undefined) return false;
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

const HREFS = {
  collection: () => marketUrl(APP.collection),
  inventory: () => marketUrl(APP.inventory),
  sales: () => marketUrl('/sales'),
  marketplace: () => marketUrl('/marketplace'),
};

function PreviewDashboard() {
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
      historySeries={previewHistorySeries()}
      loading={false}
      error=""
      collectionHref={HREFS.collection()}
      inventoryHref={HREFS.inventory()}
      salesHref={HREFS.sales()}
      marketplaceHref={HREFS.marketplace()}
      onRetry={() => {}}
      listingHrefFor={() => HREFS.inventory()}
    />
  );
}

function LiveDashboard() {
  const [ownedCards, setOwnedCards] = createSignal(null);
  const [physicalOwned, setPhysicalOwned] = createSignal(0);
  const [nftOwned, setNftOwned] = createSignal(0);
  const [uniqueItems, setUniqueItems] = createSignal(0);
  const [listed, setListed] = createSignal(null);
  const [listingRows, setListingRows] = createSignal([]);
  const [movers, setMovers] = createSignal([]);
  const [cardTraderAssets, setCardTraderAssets] = createSignal(null);
  const [historySeries, setHistorySeries] = createSignal([]);
  const [historyPending, setHistoryPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const uid = () => authUid() || accountProfile()?.uid || '';
  const sellerUid = () => (signedIn() ? uid() : '');

  function applyTiles(entry) {
    setOwnedCards(entry.ownedCards);
    setPhysicalOwned(entry.physicalOwned);
    setNftOwned(entry.nftOwned);
    setUniqueItems(entry.uniqueItems);
  }

  // Collection summary: instant paint from the last tile metrics for this uid.
  createEffect(sellerUid, (id) => {
    if (!id) return undefined;
    let cancelled = false;
    const cached = readPortfolioTilesCache(id);
    if (cached) {
      applyTiles(cached);
      if (cached.listed) setListed(() => cached.listed);
    } else {
      setOwnedCards(null);
    }
    setError('');
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        if (cancelled) return;
        const next = portfolioTilesFromSummary(data);
        const entry = writePortfolioTilesCache(id, next) || { ...next, fingerprint: portfolioTilesFingerprint(next) };
        if (entry.fingerprint !== (cached?.fingerprint || '') || cached == null) applyTiles(entry);
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
    return () => { cancelled = true; };
  });

  // Every live listing (active or paused with stock, D00005R), paged.
  createEffect(sellerUid, (id) => {
    if (!id) return undefined;
    let cancelled = false;
    const cached = readPortfolioTilesCache(id);
    // Do not blank listed tiles when we already painted from cache.
    if (!cached?.listed) {
      setListed(null);
      setListingRows([]);
    }
    getBearer()
      .then(async (token) => {
        const live = [];
        const seen = new Set();
        let offset = 0;
        for (;;) {
          const data = await fetchSellerListings(id, token, { limit: LISTINGS_PAGE, offset });
          const raw = data.listings || data.items || [];
          for (const row of liveInventoryListings(raw)) {
            const key = String(row.id || row.listingId || '');
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            live.push(row);
          }
          if (raw.length < LISTINGS_PAGE) break;
          offset += raw.length;
        }
        return live;
      })
      .then((live) => {
        if (cancelled || !live) return;
        const summary = summarizeLiveInventory(live);
        writePortfolioTilesCache(id, { listed: summary });
        setListed(() => summary);
        setListingRows(live);
      })
      .catch(() => {
        if (cancelled) return;
        // Keep the cached listed tile; only fail when we had nothing to show.
        if (cached?.listed && !cached.listed.failed) return;
        const failed = { listings: 0, cards: 0, listedPkn: 0, failed: true };
        writePortfolioTilesCache(id, { listed: failed });
        setListed(failed);
        setListingRows([]);
      });
    return () => { cancelled = true; };
  });

  // CardTrader 1-Day Ready stock: dashboard assets, never Pokoin listings.
  createEffect(sellerUid, (id) => {
    if (!id) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchCardTraderAssets(token))
      .then((data) => { if (!cancelled) setCardTraderAssets(() => (data?.oneDayReady ? data : null)); })
      .catch(() => { if (!cancelled) setCardTraderAssets(null); });
    return () => { cancelled = true; };
  });

  createEffect(uid, (id) => {
    if (!id) return undefined;
    let cancelled = false;
    const cached = peekPortfolioHistory(id);
    if (cached) setHistorySeries(cached);
    setHistoryPending(!cached);
    loadPortfolioHistory(id, () => getBearer().then((token) => fetchPortfolioHistory(token)))
      .then((series) => { if (!cancelled) setHistorySeries(series); })
      .catch(() => { if (!cancelled) setHistorySeries([]); })
      .finally(() => { if (!cancelled) setHistoryPending(false); });
    return () => { cancelled = true; };
  });

  // Trending reads the table-backed best_sellers rail (~90 ms), then featured.
  onSettled(() => {
    let cancelled = false;
    (async () => {
      const bestSellers = await fetchRail(RAIL.bestSellers).catch(() => null);
      if (cancelled) return;
      if (bestSellers?.cards?.length) {
        setMovers(moversFromRail(bestSellers));
        return;
      }
      const featured = await fetchRail(RAIL.featured).catch(() => null);
      if (!cancelled) setMovers(moversFromRail(featured));
    })();
    return () => { cancelled = true; };
  });

  function retryCollection() {
    const id = uid();
    const cached = id ? readPortfolioTilesCache(id) : null;
    // Retry keeps cached numbers visible — no skeleton flash.
    if (!cached) setOwnedCards(null);
    setError('');
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        if (!id) return;
        const next = portfolioTilesFromSummary(data);
        applyTiles(writePortfolioTilesCache(id, next) || next);
        setError('');
      })
      .catch((err) => {
        console.error('dashboard collection summary failed', err);
        if (cached) return;
        setError("Couldn't load your collection");
        setOwnedCards(0);
      });
  }

  return (
    <DashboardBoundary>
      <SellerDashboardView
        ownedCards={ownedCards() ?? 0}
        physicalOwned={physicalOwned()}
        nftOwned={nftOwned()}
        uniqueItems={uniqueItems()}
        pknBalance={availablePkn()}
        cardTraderAssets={cardTraderAssets()}
        historySeries={historySeries()}
        historyPending={historyPending()}
        listed={listed()}
        listingRows={listingRows()}
        movers={movers()}
        loading={ownedCards() == null}
        error={error()}
        collectionHref={HREFS.collection()}
        inventoryHref={HREFS.inventory()}
        salesHref={HREFS.sales()}
        marketplaceHref={HREFS.marketplace()}
        onRetry={retryCollection}
        listingHrefFor={(row) => {
          const path = inventoryListingHref(row);
          return path.startsWith('/marketplace') ? marketUrl(path) : path;
        }}
      />
    </DashboardBoundary>
  );
}

/**
 * /dashboard (market/src/pages/SellerHome.jsx): Portfolio / Your collection,
 * asking value, collection chart, Sell and Buy. Ownership first (D00006G).
 * `?dashPreview` on dev/localhost shows fixtures.
 */
export default function SellerHome() {
  const [params] = useSearchParams();
  document.title = 'Dashboard · Pokoin';
  return (
    <Show when={!untrack(() => allowLayoutPreview(params))} fallback={<PreviewDashboard />}>
      <SignedIn from="/dashboard">
        <LiveDashboard />
      </SignedIn>
    </Show>
  );
}
