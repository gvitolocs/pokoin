import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchCard,
  fetchCardSales,
  fetchExactNameCards,
  fetchListings,
  fetchNativeSales,
  fetchVersionSet,
  peekCard,
  prefetchCardDesk,
} from './api.js';
import { fetchBuyBook, readBookCache } from './buy-orders.js';
import { listingsKnown, peekListings, resetListingsCacheForTests } from './listings-cache.js';
import { peekNativeSales, resetNativeSalesCacheForTests } from './native-sales-cache.js';
import { resetCardPriceHistoryCacheForTests } from './price-history-cache.js';
import { peekCardSales, resetCardSalesCacheForTests } from './sold-sales-cache.js';

/**
 * PH-R034, report §0 (navigation-fetches.md): the request order the lead measured on
 * production — card 813622, then its next arrow 813624 — replayed over the real reads.
 *
 * Every function here is the real one (`market/src/api.js`, `market/src/buy-orders.js`,
 * the four device caches) over a recording `fetch`; only the network and the listings
 * clock are simulated. The trace records each request together with the desk step that
 * was running when it went out, so "asked by the warm" and "asked again by the mount"
 * are observations rather than readings of the code.
 *
 * What the replay must show after P1…P9: the neighbour is answered *before* the click,
 * the click asks no listings, and no panel of the desk it opens has to wait.
 */

const ROUTES = [
  '/api/marketplace-card-page',
  '/api/marketplace-listings',
  '/api/marketplace-card-sales',
  '/api/marketplace-version-set',
  '/api/marketplace-buy-orders',
  '/api/marketplace-list',
  '/api/marketplace-native-sales',
];

/** The routes that name the card they are about; the name snapshot is keyed by name. */
const CARD_KEYED_ROUTES = ROUTES.filter((path) => path !== '/api/marketplace-list');

/** `solid/src/pages/Card.jsx` PREFETCH_FRESH_MS: the window a mount read adopts a warm in. */
const PREFETCH_FRESH_MS = 120_000;

const NAME = 'Charizard ex';
const SLICE = {
  day: '2026-11-10',
  condition: 'NM',
  language: 'EN',
  medianPkn: 240,
  minPkn: 200,
  maxPkn: 300,
  soldQty: 2,
  listings: 3,
  sampleCount: 3,
};
const NATIVE_SALE = {
  soldAt: '2026-11-01T09:30:00Z',
  condition: 'NM',
  language: 'EN',
  quantity: 2,
  unitPricePkn: 240,
};

/** The window the page answer carries: the arrows are only known once it lands. */
let neighbors = {};

let segment = '';
let trace = [];
let clockOffset = 0;
let holdListingsOf = '';
let releaseHeldListings = null;

function cardRow(id) {
  return { id, name: NAME };
}

function pageFor(id) {
  return {
    cardId: id,
    card: { id, name: NAME, set: 'Scarlet & Violet', set_name: 'Scarlet & Violet', illustrator: 'Nagi' },
    neighbors: neighbors[id] || { prev: [], next: [] },
    listings: [],
    total: 0,
    rarities: [],
    versions: [],
    printings: [],
  };
}

function payloadFor(route, params) {
  const id = params.get('cardId') || params.get('card_id') || '';
  if (route === '/api/marketplace-card-page') {
    return pageFor(id);
  }
  // The measured card has nobody selling it: the empty answer is the whole point.
  if (route === '/api/marketplace-listings') {
    return { listings: [], total: 0 };
  }
  if (route === '/api/marketplace-card-sales') {
    return { slices: [SLICE], rows: [] };
  }
  if (route === '/api/marketplace-version-set') {
    return { printings: [] };
  }
  if (route === '/api/marketplace-buy-orders') {
    return { book: [] };
  }
  if (route === '/api/marketplace-native-sales') {
    return { sales: [NATIVE_SALE] };
  }
  if (route === '/api/marketplace-list') {
    return { cards: [], hasMore: false, count: 0 };
  }
  return {};
}

function useLocalStorage() {
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => items.set(String(key), String(value)),
    removeItem: (key) => items.delete(String(key)),
  };
  return items;
}

/**
 * The recording network. `segment` tags each request with the desk step that issued
 * it; `holdListingsOf` keeps one card's listings answer outstanding, so "the book did
 * not wait for the listings" is a state observed while they had still not landed.
 */
function stubNetwork() {
  const realNow = Date.now;
  // The listings cache reads its own age off `Date.now()` (market/src/listings-cache.js),
  // so this is the clock the 2-minute window is measured against. `local-read.js` keeps
  // the clock it captured at module load: the store-backed panels decide freshness
  // against copies that landed moments ago, exactly as they do 280 ms into a page.
  Date.now = () => realNow() + clockOffset;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const route = ROUTES.find((path) => href.includes(`${path}?`));
    const params = new URL(href).searchParams;
    trace.push({ segment, route, href, id: params.get('cardId') || params.get('card_id') || '' });
    if (route === '/api/marketplace-listings' && params.get('cardId') === holdListingsOf) {
      await new Promise((resolve) => {
        releaseHeldListings = resolve;
      });
    }
    return new Response(JSON.stringify(payloadFor(route, params)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => {
    Date.now = realNow;
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function until(read, limitMs = 2000) {
  const stop = Date.now() + limitMs;
  for (;;) {
    const value = read();
    if (value) {
      return value;
    }
    if (Date.now() >= stop) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function begin() {
  trace = [];
  segment = '';
  clockOffset = 0;
  holdListingsOf = '';
  releaseHeldListings = null;
  neighbors = {};
  resetListingsCacheForTests();
  resetCardSalesCacheForTests();
  resetNativeSalesCacheForTests();
  resetCardPriceHistoryCacheForTests();
  useLocalStorage();
  return stubNetwork();
}

const asked = (route, id) => trace.filter((row) => row.route === route && row.id === id);
const inSegment = (name) => trace.filter((row) => row.segment === name);
const firstAt = (route, id) => trace.findIndex((row) => row.route === route && row.id === id);

/** The reads one desk issues the moment it mounts (`solid/src/pages/Card.jsx`). */
function mountDesk(id) {
  const reads = [];
  // refreshListings(listingsSeq, PREFETCH_FRESH_MS)
  const listings = fetchListings(id, { fresh: true, maxAgeMs: PREFETCH_FRESH_MS });
  reads.push(listings);
  // fetchCard(cardId, { lang, slug, fresh: Boolean(cached), onUpdate: showCard })
  const page = fetchCard(id, {
    lang: 'en',
    slug: `${NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}`,
    fresh: Boolean(peekCard(id, { lang: 'en' })),
    onUpdate: () => {},
  });
  reads.push(page);
  // fetchCardSales(cardId, { slices: true })
  reads.push(fetchCardSales(id, { slices: true }));
  // fetchVersionSet(cardId, { onUpdate: showVersionSet })
  reads.push(fetchVersionSet(id, { onUpdate: () => {} }));
  // createBuyBook → whenIdle(() => load(id), 300) → fetchBuyBook(id)
  reads.push(fetchBuyBook(id));
  // NativeSales panel → fetchNativeSales(id)
  reads.push(fetchNativeSales(id));
  // createEffect(exactName) → fetchExactNameCards(name, { lang })
  reads.push(fetchExactNameCards(NAME, { lang: 'en' }));
  return { page, listings, reads };
}

/** `showCard → warmNeighbors`: one warmer per arrow target, as the queue's desk case runs it. */
function warmArrows(neighborWindow) {
  return [neighborWindow?.next?.[0], neighborWindow?.prev?.[0]]
    .filter(Boolean)
    .map((row) => prefetchCardDesk(row, {
      lang: 'en',
      listings: true,
      sales: true,
      versions: true,
      book: true,
      names: true,
      native: true,
    }));
}

test('the measured order: hover warms the neighbour, the click finds every panel answered', async () => {
  const restore = begin();
  const CURRENT = '813622';
  const NEXT = '813624';
  const PREV = '813620';
  neighbors = {
    [CURRENT]: { prev: [cardRow(PREV)], next: [cardRow(NEXT)] },
    [NEXT]: { prev: [cardRow(CURRENT)], next: [cardRow('813626')] },
    [PREV]: { prev: [], next: [cardRow(CURRENT)] },
  };
  try {
    // — the desk the lead was on. Its own reads go out with the component. —
    segment = 'mount 813622';
    const here = mountDesk(CURRENT);
    const herePage = await here.page;

    // — hover / intent on the next arrow, which is only nameable from that page answer. —
    segment = 'warm 813624 + 813620';
    holdListingsOf = NEXT;
    const warmed = await Promise.all(warmArrows(herePage.neighbors));
    const bookWarmed = await until(() => asked('/api/marketplace-buy-orders', NEXT).length > 0);

    // (b) The book is not behind the listings: it was already asked while the
    // neighbour's listings answer had still not landed.
    assert.ok(bookWarmed, 'the warm asks the buy book');
    assert.equal(asked('/api/marketplace-listings', NEXT).length, 1, 'the held listings is still the only one');
    holdListingsOf = '';
    releaseHeldListings?.();
    await Promise.all(warmed);
    await settle();

    // (c) Both arrow targets are fully warmed, and (d) none of it started before the
    // page that names them had been asked.
    for (const id of [NEXT, PREV]) {
      for (const route of CARD_KEYED_ROUTES) {
        assert.equal(asked(route, id).length, 1, `${id} was warmed on ${route} exactly once`);
      }
      assert.ok(firstAt('/api/marketplace-card-page', id) > firstAt('/api/marketplace-card-page', CURRENT));
    }
    // The name rail is not per-card at all: it is the snapshot of this name, which the
    // desk the visitor is on already read. Neither the warm nor the next desk asks it
    // again, so P8's rail paints from the copy this device already has.
    assert.equal(trace.filter((row) => row.route === '/api/marketplace-list').length, 1, 'one name snapshot, at the first mount');
    assert.ok(
      inSegment('warm 813624 + 813620').every((row) => trace.indexOf(row) > firstAt('/api/marketplace-card-page', CURRENT)),
      'the warm never pre-empts the desk the visitor is on',
    );

    // (a) The visitor takes 110 s to press the arrow: inside the adoption window.
    clockOffset = 110_000;
    segment = 'mount 813624';
    assert.equal(listingsKnown(NEXT), true, 'the warm is an answer, not a maybe');
    const before = trace.length;
    const there = mountDesk(NEXT);
    const [listed] = await Promise.all([there.listings, ...there.reads]);
    await settle();

    // (a) again, as the click sees it: the arrow step asks no listings read at all, and
    // nothing about the two neighbours carries a cache bust. The desk the lead started on
    // does bust its own first read — nothing had answered for it yet, and that is the
    // behaviour the report keeps: only a warm answer may not be thrown away.
    assert.deepEqual(trace.slice(before).filter((row) => row.route === '/api/marketplace-listings'), []);
    assert.equal(asked('/api/marketplace-listings', NEXT).length, 1, 'one listings read for the neighbour, the warm');
    for (const id of [NEXT, PREV]) {
      assert.ok(asked('/api/marketplace-listings', id).every((row) => !row.href.includes('_=')), `${id} is never cache-busted`);
    }
    assert.ok(!trace.some((row) => row.href.includes('fresh=')), 'no forced edge bypass');
    assert.deepEqual(listed.listings, [], 'the empty warm is the first frame: "No listings yet."');

    // (c) and the panels answer off this device, not off the click.
    assert.equal(peekCard(NEXT, { lang: 'en' })?.card?.name, NAME);
    assert.equal(peekCardSales(NEXT)?.slices?.[0]?.medianPkn, 240);
    assert.equal(peekNativeSales(NEXT)?.sales?.[0]?.unitPricePkn, 240);
    assert.ok(Array.isArray(readBookCache(NEXT)), 'the book this desk paints from was stored by the warm');
    // The Silver gate, as the wire sees it: this desk declared no Silver account, so
    // no price-history request — plain or `fields=graph` — is anywhere in the replay.
    assert.ok(!trace.some((row) => row.href.includes('marketplace-card-price-history')));
  } finally {
    restore();
  }
});

test('stepping back paints from the desk the visitor left and asks no listings', async () => {
  const restore = begin();
  const A = '813640';
  const B = '813642';
  neighbors = {
    [A]: { prev: [], next: [cardRow(B)] },
    [B]: { prev: [cardRow(A)], next: [] },
  };
  try {
    segment = 'mount 813640';
    const first = mountDesk(A);
    const firstPage = await first.page;
    const ownRows = await first.listings;

    segment = 'warm 813642';
    await Promise.all(warmArrows(firstPage.neighbors));
    await settle();

    // The press: 813642 mounts, and its own arrows name the card just left.
    clockOffset = 110_000;
    segment = 'mount 813642';
    const second = mountDesk(B);
    const secondPage = await second.page;
    await Promise.all(second.reads);

    segment = 'warm back 813640';
    await Promise.all(warmArrows(secondPage.neighbors));
    await settle();

    // The return press, 5 s later.
    clockOffset = 115_000;
    segment = 'back to 813640';
    const listingsBefore = trace.length;
    const back = await fetchListings(A, { fresh: true, maxAgeMs: PREFETCH_FRESH_MS });

    assert.deepEqual(trace.slice(listingsBefore), [], 'the step back asks nothing on the way in');
    assert.deepEqual(back, ownRows, 'and gets the rows the desk it left had');
    for (const id of [A, B]) {
      assert.equal(asked('/api/marketplace-listings', id).length, 1, `${id} was read once, at its own mount`);
    }
    assert.equal(listingsKnown(A), true);
    assert.equal(peekCard(A, { lang: 'en' })?.card?.name, NAME, 'the page it left is still on the device');
    assert.ok(Array.isArray(readBookCache(A)));
    assert.equal(peekCardSales(A)?.slices?.[0]?.medianPkn, 240);
    assert.equal(peekNativeSales(A)?.sales?.[0]?.unitPricePkn, 240);
  } finally {
    restore();
  }
});
