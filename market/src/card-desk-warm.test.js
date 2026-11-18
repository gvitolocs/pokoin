import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { prefetchCardDesk } from './api.js';
import { readBookCache } from './buy-orders.js';
import { peekCardPriceHistory, resetCardPriceHistoryCacheForTests } from './price-history-cache.js';
import { warmCardPriceHistory } from './price-history.js';
import { peekCardSales, resetCardSalesCacheForTests } from './sold-sales-cache.js';

// PH-R034 P5: one warmer for the card the arrows lead to, so the desk it opens
// finds every panel already answered. This runs the real `prefetchCardDesk`
// (market/src/api.js) over a recording `fetch`, so "what does warming a neighbour
// put on the wire" is an observed list of requests and not a reading of the code.
const ROUTES = [
  '/api/marketplace-card-page',
  '/api/marketplace-listings',
  '/api/marketplace-card-sales',
  '/api/marketplace-version-set',
  '/api/marketplace-buy-orders',
  '/api/marketplace-list',
  '/api/marketplace-native-sales',
];

// Every cache in this stack is module-level, so a warm that the previous test
// already answered asks nothing and proves nothing: one id per test.
const FIRST_CARD = 813600;
let cardSeq = FIRST_CARD;
const nextId = () => String(cardSeq);

/** fetch stub: records every request in the order it went out. */
function stubFetch() {
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const route = ROUTES.concat('/api/marketplace-card-price-history').find((path) => href.includes(`${path}?`));
    asked.push({
      route,
      href,
      priority: init.priority,
      cache: init.cache,
      signal: Boolean(init.signal),
    });
    const params = new URL(href).searchParams;
    return new Response(JSON.stringify({
      cardId: params.get('cardId') || nextId(),
      card: { id: params.get('cardId') || nextId(), name: `Charizard ${params.get('cardId') || nextId()}` },
      neighbors: { prev: [], next: [] },
      listings: [],
      total: 0,
      slices: [{ condition: 'NM', pkn: 120 }],
      rows: [],
      series: { days: [] },
      printings: [],
      book: [],
      cardtrader: { status: 'available', days: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return asked;
}

/** A Map-backed localStorage, so "stored" is a value and not a hope. */
function useLocalStorage() {
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => items.set(String(key), String(value)),
    removeItem: (key) => items.delete(String(key)),
  };
  return items;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

test.beforeEach(() => {
  cardSeq += 1;
  resetCardSalesCacheForTests();
  resetCardPriceHistoryCacheForTests();
});

test('the neighbour warm asks the whole desk once, and busts nothing', async () => {
  const id = nextId();
  useLocalStorage();
  const asked = stubFetch();
  await prefetchCardDesk({ id, name: 'Charizard' }, {
    listings: true,
    sales: true,
    versions: true,
    book: true,
    names: true,
    native: true,
  });
  await settle();
  const routes = asked.map((row) => row.route);
  assert.deepEqual([...new Set(routes)].sort(), [...ROUTES].sort());
  assert.equal(new Set(routes).size, routes.length, 'no panel is asked twice');
  assert.ok(!asked.some((row) => row.href.includes('_=')), 'a warm never cache-busts');
  assert.ok(!asked.some((row) => row.href.includes('fresh=')), 'nor forces the book past the edge');
  // The name snapshot is the pool this page's name belongs to, so it is the one
  // read that has to wait for the page.
  assert.ok(routes.indexOf('/api/marketplace-card-page') < routes.indexOf('/api/marketplace-list'));
});

test('the warm asks them in the order the desk shows them', () => {
  // The wire order is not the order of issue — a stored read waits for the store
  // and the book waits for its module — and only the order of issue is what the
  // desk cares about: it is the order the panels fill, so it is also the order a
  // warm that a navigation cuts short stops at.
  const source = fs.readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const from = source.indexOf('export function prefetchCardDesk(card');
  const body = source.slice(from, source.indexOf('export function warmupCard', from));
  const issued = [
    'const page = fetchCard(',
    'if (listings) {',
    'fetchListings(id, { signal })',
    'if (sales) {',
    'fetchCardSales(id, { slices: true, signal })',
    'if (versions) {',
    'fetchVersionSet(id, { prefetch: true, signal })',
    'if (book) {',
    'fetchBuyBook(id, { signal })',
    'if (names && name) {',
    "fetchListSnapshot('name', nameListKey(name), { prefetch: true, signal })",
    'if (native) {',
    'fetchNativeSales(id, { signal })',
  ];
  let at = -1;
  for (const needle of issued) {
    const found = body.indexOf(needle);
    assert.ok(found > at, `${needle} is issued after the read before it`);
    at = found;
  }
});

test('the warm reads are the low-priority ones, and every one is abortable', async () => {
  const id = nextId();
  useLocalStorage();
  const asked = stubFetch();
  const controller = new AbortController();
  await prefetchCardDesk({ id }, {
    listings: true, sales: true, versions: true, book: true, names: true, native: true, signal: controller.signal,
  });
  await settle();
  // `prefetch: true` is what makes a local-storable read low priority
  // (`network()` in market/src/local-read.js). The two private reads carry no
  // priority: the browser cache is not what they are about, `no-store` is.
  assert.deepEqual(
    asked.filter((row) => row.priority === 'low').map((row) => row.route).sort(),
    ['/api/marketplace-card-page', '/api/marketplace-list', '/api/marketplace-version-set'].sort(),
  );
  assert.deepEqual(
    asked.filter((row) => row.cache === 'no-store').map((row) => row.route).sort(),
    ['/api/marketplace-buy-orders', '/api/marketplace-listings'].sort(),
  );
  assert.ok(asked.every((row) => row.signal), 'every warm a navigation can stop');
});

test('a warm is only worth what the desk can read back from it', async () => {
  const id = nextId();
  useLocalStorage();
  stubFetch();
  await prefetchCardDesk({ id, name: 'Charizard' }, { sales: true, book: true });
  await settle();
  // The sales and the book paint from this device's own copy, so a warm that is
  // merely fetched is a warm the next desk cannot see.
  assert.deepEqual(peekCardSales(id)?.slices, [{ condition: 'NM', pkn: 120 }]);
  assert.deepEqual(readBookCache(id), []);
});

test('a plain desk warm is the page and its scan, nothing else', async () => {
  const id = nextId();
  useLocalStorage();
  const asked = stubFetch();
  await prefetchCardDesk({ id });
  await settle();
  assert.deepEqual([...new Set(asked.map((row) => row.route))], ['/api/marketplace-card-page']);
});

test('the graph window is asked for Silver only, and stored for the desk', async () => {
  const id = nextId();
  const items = useLocalStorage();
  const asked = stubFetch();
  assert.equal(await warmCardPriceHistory(id, { silver: () => false }), null);
  assert.equal(asked.length, 0, 'a non-Silver warm asks nothing');
  assert.equal(items.size, 0, 'and stores nothing');

  const entry = await warmCardPriceHistory(id, { silver: () => true });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].route, '/api/marketplace-card-price-history');
  assert.ok(asked[0].href.includes('fields=graph'));
  assert.match(asked[0].href, /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/, 'the default window');
  assert.ok(!asked[0].href.includes('reverse='), 'the plain facet, which is the desk first frame');
  assert.ok(!asked[0].href.includes('_='), 'and no cache bust');
  assert.equal(entry.range, '3m');
  // The desk reads it back under exactly this key, so its graph does not wait.
  assert.deepEqual(peekCardPriceHistory(id, '3m'), entry);
});
