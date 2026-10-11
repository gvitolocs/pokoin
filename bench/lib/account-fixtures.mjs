/**
 * Signed-in fixtures for the account-page parity check (parity.mjs --checks
 * account-in). No real account is used: a fake desk-session token cookie
 * (pokoin.auth.token, the cold-start path both UIs share) signs the page in,
 * and every request that carries that token is answered here. Requests that
 * would write (non-GET) are aborted, so nothing reaches production.
 */
export const FIXTURE_UID = 'parityfixtureuid0001';
export const FIXTURE_TOKEN = `parity-fixture-token-${'x'.repeat(24)}`;

const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

const listings = [
  { id: 'l1', cardId: '239324', cardName: 'Pikachu', setName: 'Base Set', collectorNumber: '58/102', condition: 'NM', language: 'EN', pricePkn: 120, quantityAvailable: 2, status: 'active', location: 'box1·2', sellerUid: FIXTURE_UID, createdAt: '2026-09-20T10:00:00Z' },
  { id: 'l2', cardId: '239325', cardName: 'Charizard', setName: 'Base Set', collectorNumber: '4/102', condition: 'LP', language: 'IT', pricePkn: 4200, quantityAvailable: 1, status: 'paused', location: 'box1·3', sellerUid: FIXTURE_UID, createdAt: '2026-09-25T10:00:00Z' },
  { id: 'l3', cardId: '239326', cardName: 'Mewtwo', setName: 'Base Set', collectorNumber: '10/102', condition: 'NM', language: 'EN', pricePkn: 900, quantityAvailable: 0, status: 'sold_out', sellerUid: FIXTURE_UID },
];

const routes = {
  '/api/marketplace-listings': () => ({ listings }),
  '/api/marketplace-collection-summary': () => ({ cardsOwned: 12, physicalOwned: 10, nftOwned: 2, items: 9 }),
  '/api/marketplace-portfolio-history': () => ({
    days: Array.from({ length: 40 }, (_, i) => ({ date: day(39 - i), currencyPkn: 15, cardsKnown: true, cardsValuePkn: 1000 + i * 10, cardsPriced: 5, cardsHeld: 12 })),
  }),
  '/api/cardtrader-assets': () => ({ oneDayReady: false, items: [], totals: {} }),
  '/api/cardtrader-sync': () => ({ status: { connected: false } }),
  '/api/cardtrader-zero': () => ({
    oneDayReady: false,
    cardtrader: { username: 'fixture_seller' },
    totals: { weekly: { units: 2, lines: 1, cents: 1200 }, pending: { units: 1, cents: 300 } },
    weekly: [{ orderId: 'o1', code: 'Z-1', paidAt: '2026-10-09T10:00:00Z', items: [{ itemId: 'i1', name: 'Pikachu', quantity: 2, condition: 'NM', language: 'EN', expansion: 'Base Set', collectorNumber: '58', location: 'box1·2', lineCents: 1200, currency: 'EUR' }] }],
    pending: { orderCount: 1, items: [{ orderId: 'o2', itemId: 'i2', name: 'Charizard', quantity: 1, lineCents: 300, currency: 'EUR' }] },
  }),
  '/api/powertools-connect': () => ({ status: { connected: false } }),
  '/api/marketplace-referral': () => ({
    code: 'parityfixture',
    stats: { invited: 2, pending: 1, activated: 1, earnedPkn: 20 },
    invited: [{ username: 'friend1', claimedAt: '2026-10-01T10:00:00Z', status: 'rewarded', rewardedAt: '2026-10-03T10:00:00Z', kind: 'sale', earnedPkn: 20 }],
  }),
  '/api/marketplace-associate': () => ({ error: 'Not an associate' }),
  '/api/marketplace-seller-settings': () => ({ shipFromCountry: 'IT', shipFromCountrySource: 'user', acceptsPkn: true }),
  '/api/stripe-connect-onboard': () => ({ stripeConnectStatus: 'not_started', ready: false }),
  '/api/poko-connect': () => ({ linked: false, telegram: { linked: false }, discord: { linked: false } }),
  '/api/search-recipient-emails': () => ({ username: 'parityfixture' }),
  '/api/marketplace-pricing-strategies': () => ({ strategies: [], pricerSettings: { defaultSource: 'cardtrader', autoMarketColumn: false } }),
  '/api/marketplace-collection': () => ({ items: [{ id: 'h1', cardId: '239324', cardName: 'Pikachu', setName: 'Base Set', condition: 'NM', language: 'EN', quantity: 3 }] }),
  '/api/chat': () => ({ conversations: [{ pairKey: 'p1', peerUid: 'peer1', peerUsername: 'friend1', preview: 'Hello', updatedAt: '2026-10-10T10:00:00Z', unread: 1 }] }),
  '/api/marketplace-listings-csv': () => 'Name,Set,Qty\nPikachu,Base Set,2\n',
  '/api/marketplace-price-check': () => ({ prices: {} }),
};

/** 403 for the associate desk (not on the roster), like the live API. */
const STATUS = { '/api/marketplace-associate': 403 };

export async function signInWithFixtures(context, base) {
  const url = new URL(base);
  await context.addCookies([{
    name: 'pokoin.auth.token',
    value: encodeURIComponent(JSON.stringify({ token: FIXTURE_TOKEN, uid: FIXTURE_UID, expiresAt: Date.now() + 3600000 })),
    domain: url.hostname,
    path: '/',
  }]);
  await context.addInitScript(([uid]) => {
    try {
      localStorage.setItem('pokoin.auth.session', JSON.stringify({ uid, signedIn: true, username: 'parityfixture' }));
    } catch (_) { /* storage blocked */ }
  }, [FIXTURE_UID]);
  // Firestore REST profile read and the Firestore SDK channel: an empty profile.
  await context.route('https://firestore.googleapis.com/**', (route) => {
    if (route.request().method() === 'GET' && /\/documents\/users\//.test(route.request().url())) {
      return route.fulfill({ json: { name: 'users', fields: { username: { stringValue: 'parityfixture' }, displayName: { stringValue: 'Parity Fixture' } } } });
    }
    if (/\/documents\/balances\//.test(route.request().url())) {
      return route.fulfill({ json: { name: 'balances', fields: { availablePkn: { integerValue: '42' } } } });
    }
    return route.abort();
  });
}

/** Answer an API call made with the fixture token; null = not ours. */
export function fixtureResponse(request) {
  const auth = request.headers().authorization || '';
  if (!auth.includes(FIXTURE_TOKEN)) return null;
  if (request.method() !== 'GET') return { abort: true };
  const path = new URL(request.url()).pathname;
  const make = routes[path];
  const body = make ? make() : {};
  return typeof body === 'string'
    ? { status: 200, contentType: 'text/csv', body }
    : { status: STATUS[path] || 200, json: body };
}
