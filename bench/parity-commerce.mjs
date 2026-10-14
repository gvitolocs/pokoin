#!/usr/bin/env node
/**
 * React vs Solid parity for the buying and money pages (cart, checkout,
 * orders, wallet, …):
 *
 *   node parity-commerce.mjs --a http://127.0.0.1:28641 --b http://127.0.0.1:28642 [--only cart,checkout-in]
 *
 * Each scenario loads the same URL on both builds in a fresh context and
 * compares headings, element counts, the final URL, console errors and failed
 * requests. Scenarios:
 *   - signed out: the real public API (read-only GETs).
 *   - signed in (`-in`): a stub Firebase user (no real account, no
 *     credentials) and every api.pokoin.com call intercepted. Account reads
 *     get fixtures; public GETs go to the real API without the fake bearer;
 *     every other write is answered locally and reported as BLOCKED — nothing
 *     reaches production (no payment, order or cart write).
 * Exit 1 when a scenario differs or a write was attempted.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const A = arg('a');
const B = arg('b');
if (!A || !B) {
  console.error('usage: node parity-commerce.mjs --a <react base> --b <solid base> [--only names]');
  process.exit(2);
}
const ONLY = arg('only', '').split(',').filter(Boolean);

const API_KEY = 'AIzaSyDlbKXeR0R3aAATZtCG6dhEPUw39DhXQpU';
const UID = 'parityBuyerUid0000000000001';
const EMAIL = 'parity-buyer@example.test';

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const NOW = Math.floor(Date.now() / 1000);
const FAKE_TOKEN = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
  iss: 'https://securetoken.google.com/pokoin', aud: 'pokoin', user_id: UID, sub: UID, email: EMAIL,
  iat: NOW, exp: NOW + 3600, auth_time: NOW, firebase: { sign_in_provider: 'password' },
})}.fixture`;

/** A cart row in the shape cartItemFromOffer writes (market/src/cart-rows.js). */
function cartRow(offer, card, extra = {}) {
  return {
    id: offer.id,
    listingId: offer.id,
    sellerUid: offer.sellerUid,
    cardId: card.id,
    name: card.name,
    image: offer.cardImageUrl,
    pricePkn: offer.pricePkn,
    addedPricePkn: offer.pricePkn,
    addedAt: Date.now() - 86400000,
    sellerAcceptsPkn: offer.sellerAcceptsPkn !== false,
    qty: 1,
    stock: offer.quantityAvailable || 1,
    selected: true,
    condition: offer.condition,
    language: offer.language,
    reverse: false,
    firstEdition: false,
    graded: false,
    gradingCompany: '',
    grade: '',
    signed: false,
    sealed: false,
    setName: offer.setName,
    collectorNumber: offer.collectorNumber,
    sellerName: offer.sellerName,
    sellerUsername: offer.sellerUsername || '',
    sellerCountry: offer.sellerCountry || '',
    nftAvailable: false,
    reserveAvailable: false,
    href: offer.canonicalPath || `/marketplace/en/cards/${card.id}`,
    card: { id: card.id, name: card.name },
    ...extra,
  };
}

async function liveCart() {
  const rows = [];
  for (const id of ['598056', '598052']) {
    const res = await fetch(`https://api.pokoin.com/api/marketplace-listings?cardId=${id}&nativeOnly=1&limit=5`, {
      headers: { origin: 'https://pokoin.com' },
    });
    const data = await res.json();
    const offer = data.listings?.[0];
    if (offer) rows.push(cartRow(offer, { id, name: offer.cardName }));
  }
  // A copy that is no longer listed: both UIs must untick it and say so.
  if (rows[0]) {
    rows.push(cartRow(
      { ...JSON.parse(JSON.stringify(rows[0])), id: 'parity-gone-listing', pricePkn: 999, cardImageUrl: rows[0].image },
      { id: rows[0].cardId, name: rows[0].name },
      { sellerUid: 'parityGoneSeller', sellerName: 'Gone Seller', sellerCountry: 'DK', condition: 'NM', language: 'EN' },
    ));
  }
  return rows;
}

const SALES = [
  {
    orderId: 'parity-order-1',
    source: 'pokoin',
    currency: 'EUR',
    paymentStatus: 'paid',
    fulfillmentStatus: 'pending',
    soldAt: '2026-10-01T10:00:00Z',
    gross: 1250,
    refunded: 0,
    refundable: 1250,
    shippingCents: 300,
    items: [{ listingId: 'l1', cardId: '598056', cardName: 'Medicham ex', condition: 'NM', language: 'IT', quantity: 1, unitPriceEURCents: 950 }],
    refunds: [],
  },
  {
    orderId: 'parity-ct-2',
    source: 'cardtrader',
    currency: 'EUR',
    paymentStatus: 'paid',
    channel: '1dr',
    ctOrderCode: 'CT-42',
    soldAt: '2026-09-20T10:00:00Z',
    gross: 500,
    refunded: 0,
    refundable: 0,
    items: [{ listingId: 'l2', cardId: '598052', cardName: 'Card two', condition: 'EX', language: 'EN', quantity: 2, unitPriceEURCents: 250 }],
  },
];

/** Account fixtures, by path (and method). */
function accountFixture(url, method, body) {
  const path = url.pathname;
  const q = url.searchParams;
  if (path === '/api/account-addresses' && method === 'GET') {
    return { addresses: [{ id: 'addr-1', fullName: 'Parity Buyer', addressLine1: 'Testvej 1', postalCode: '2100', city: 'Copenhagen', countryCode: 'DK', isDefault: true }] };
  }
  if (path === '/api/marketplace-seller-settings' && q.has('sellers')) return { pknRefused: [] };
  if (path === '/api/marketplace-seller-settings' && method === 'GET') return { shipFromCountry: 'DK', acceptsPkn: true };
  if (path === '/api/marketplace-checkout-quote' && method === 'POST') {
    const items = JSON.parse(body || '{}').items || [];
    const pkn = items.reduce((sum, row) => sum + (Number(row.pricePkn) || 0) * (Number(row.qty) || 1), 0);
    const itemsSubtotalCents = Math.round(pkn / 2);
    return {
      itemsSubtotalCents,
      shippingTotalCents: 450,
      insuranceCents: 0,
      grandTotalCents: itemsSubtotalCents + 450,
      shipments: [{ fromCountry: 'IT', toCountry: 'DK' }],
      sellerOrigins: {},
    };
  }
  if (path === '/api/marketplace-orders' && q.get('action') === 'sold-history') return { sales: SALES };
  if (path === '/api/marketplace-cart-sync' && method === 'GET') return null; // filled per scenario
  if (path === '/api/cardtrader-sync' && method === 'GET') return { status: { metadata: {} }, sync: { summary: {} } };
  if (path === '/api/search-recipient-emails') return { username: 'paritybuyer' };
  // Shell reads with the stub token (chat dock, recently viewed): empty, like a new account.
  if (path === '/api/chat' && method === 'GET') return { threads: [], conversations: [], unread: 0 };
  if (path === '/api/marketplace-recents' && method === 'GET') return { ids: [], cards: [] };
  return undefined;
}

const browser = await chromium.launch();

async function withPage(base, scenario, fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const blocked = [];
  const failed = [];
  if (scenario.cart) {
    await context.addInitScript((rows) => {
      if (!sessionStorage.getItem('parity.seeded')) {
        localStorage.setItem('pokoin.cartItems', JSON.stringify(rows));
        sessionStorage.setItem('parity.seeded', '1');
      }
    }, scenario.cart);
  }
  if (scenario.signedIn) {
    const user = {
      uid: UID, email: EMAIL, emailVerified: true, isAnonymous: false, providerData: [],
      stsTokenManager: { refreshToken: 'fixture-refresh', accessToken: FAKE_TOKEN, expirationTime: Date.now() + 3600 * 1000 },
      createdAt: '0', lastLoginAt: '0', apiKey: API_KEY, appName: '[DEFAULT]',
    };
    await context.addInitScript(({ user, uid, key }) => {
      localStorage.setItem(`firebase:authUser:${key}:[DEFAULT]`, JSON.stringify(user));
      localStorage.setItem('pokoin.auth.session', JSON.stringify({ uid, signedIn: true, availablePkn: 0 }));
    }, { user, uid: UID, key: API_KEY });
    await context.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
      json: { users: [{ localId: UID, email: EMAIL, emailVerified: true, providerUserInfo: [], createdAt: '0', lastLoginAt: '0' }] },
    }));
    await context.route('https://securetoken.googleapis.com/**', (route) => route.fulfill({ status: 400, json: { error: { message: 'fixture' } } }));
    // Firestore (orders, profile, wallet activity): no fixture backend — answered empty/closed on both UIs.
    await context.route('https://firestore.googleapis.com/**', (route) => {
      const url = route.request().url();
      if (url.includes(':runQuery')) return route.fulfill({ json: [] });
      if (url.includes('/documents/')) return route.fulfill({ json: { name: 'x', fields: {} } });
      return route.abort();
    });
  }
  // Every API call goes as pokoin.com does; signed in, account calls are fixtures and writes never leave.
  await context.route('https://api.pokoin.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (process.env.PARITY_TRACE && url.pathname.includes(process.env.PARITY_TRACE)) {
      console.log(`      trace ${base} ${method} ${url.pathname}${url.search} auth=${Boolean(request.headers().authorization)}`);
    }
    try {
      if (scenario.signedIn) {
        if (url.pathname === '/api/marketplace-cart-sync') {
          if (method !== 'GET') {
            blocked.push(`${method} ${url.pathname} (fixture account cart, answered locally)`);
            return route.fulfill({ json: { ok: true, rev: 2 } });
          }
          return route.fulfill({ json: { items: scenario.cart || [], saved: [], gift: false, rev: 1 } });
        }
        const fixture = accountFixture(url, method, request.postData());
        if (fixture !== undefined && fixture !== null) return route.fulfill({ json: fixture });
        if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
          blocked.push(`${method} ${url.pathname}${url.search}`);
          return route.fulfill({ status: 403, json: { error: 'parity: write blocked' } });
        }
        const headers = { ...request.headers(), origin: 'https://pokoin.com' };
        delete headers.authorization;
        const response = await route.fetch({ headers });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
      }
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        blocked.push(`${method} ${url.pathname}${url.search}`);
        return route.fulfill({ status: 403, json: { error: 'parity: write blocked' } });
      }
      const response = await route.fetch({ headers: { ...request.headers(), origin: 'https://pokoin.com' } });
      return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    } catch (_) {
      /* closed with the request in flight */
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 160)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Signed in, Firestore is cut off on purpose (no fixture backend): its retries are expected noise.
    if (scenario.signedIn && (/@firebase\/firestore/.test(text) || /net::ERR_FAILED/.test(text))) return;
    errors.push(`console: ${text.slice(0, 160)}`);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() >= 400 && !url.includes('firestore.googleapis.com') && !url.includes('securetoken')) {
      failed.push(`${res.status()} ${url.replace(/\?.*/, '').slice(0, 120)}`);
    }
  });
  try {
    return { ...(await fn(page, base)), errors, failed, blocked };
  } finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
}

async function settle(page, read, { quietMs = 2000, maxMs = 20000 } = {}) {
  let last = await read();
  let since = Date.now();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(150);
    const next = await read();
    if (JSON.stringify(next) !== JSON.stringify(last)) {
      last = next;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) break;
  }
  return last;
}

const COUNTED = [
  '.bk-row', '.bk-group', '.bk-row.is-gone', '.bk-messages li', '.bk-summary', '.bk-pcard', '.bk-r-item', '.bk-saved',
  '.bk-ship-pick label', '.bk-ship-parcels li', '.thread', '.order-row', '.sale-row', '.metric', '.pkg-card',
  '.wallet-action', '.wallet-source', '.wallet-card', '.exchange-grid .wallet-card', '.flex-table tbody tr',
  '.flex-stores li', '.flex-steps li', '.protection-pillars article', '.protection-flow li', '.desk-panel',
  '.empty-desk', '.bag-row', '.checkout-pay-option', '.fee-lines > div', '.stock-nav a', 'select option',
];

function snapshot(page) {
  return page.evaluate((selectors) => {
    const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const counts = {};
    for (const sel of selectors) {
      const n = document.querySelectorAll(sel).length;
      if (n) counts[sel] = n;
    }
    const main = document.querySelector('.page') || document.body;
    return {
      path: location.pathname + location.search,
      title: document.title,
      h1: [...main.querySelectorAll('h1')].map(text),
      h2: [...main.querySelectorAll('h2')].map(text).slice(0, 20),
      counts,
      selects: [...document.querySelectorAll('.page select')].map((el) => `${el.closest('label')?.querySelector('span')?.textContent || el.getAttribute('aria-label') || '?'}:${el.options.length}:${el.value}`),
      notMigrated: /is not in the Solid UI yet/.test(document.body.textContent || ''),
    };
  }, COUNTED);
}

async function run(base, scenario) {
  return withPage(base, scenario, async (page) => {
    await page.goto(`${base}${scenario.path}`, { waitUntil: 'domcontentloaded' });
    const snap = await settle(page, () => snapshot(page));
    if (scenario.after) {
      await scenario.after(page);
      return { snap, after: await settle(page, () => snapshot(page)) };
    }
    return { snap };
  });
}

const cart = await liveCart();
const SCENARIOS = [
  { name: 'cart-empty', path: '/cart' },
  { name: 'cart', path: '/cart', cart },
  {
    name: 'cart-undo',
    path: '/cart',
    cart,
    after: async (page) => {
      await page.locator('.bk-row .bk-link', { hasText: 'Delete' }).first().click();
      await page.waitForTimeout(400);
      await page.locator('.bk-removed .bk-link', { hasText: 'Undo' }).click();
    },
  },
  {
    name: 'cart-save-later',
    path: '/cart',
    cart,
    after: async (page) => {
      await page.locator('.bk-row .bk-link', { hasText: 'Save for later' }).first().click();
    },
  },
  { name: 'cart-in', path: '/cart', cart, signedIn: true },
  {
    // Card desk → cart handoff: the shop row's cart button (cartItemFromOffer +
    // addCartItem; the Best Deal button uses the same path), then the header's
    // cart link — an in-app navigation into the cart page.
    name: 'card-shop-to-cart',
    path: '/marketplace/en/cards/598056',
    after: async (page) => {
      await page.locator('button.shop-icon.is-cart').first().click({ timeout: 15000 });
      await page.waitForTimeout(300);
      await page.locator('a[href$="/cart"]').first().click();
      await page.waitForURL(/\/cart$/, { timeout: 15000 });
    },
  },
  { name: 'shipping', path: '/shipping', cart },
  { name: 'shipping-empty', path: '/shipping' },
  { name: 'checkout-out', path: '/checkout', cart },
  { name: 'checkout-in', path: '/checkout', cart, signedIn: true },
  {
    name: 'checkout-in-pkn',
    path: '/checkout',
    cart,
    signedIn: true,
    after: async (page) => {
      const pkn = page.locator('input[name="payMethod"]').nth(1);
      if (await pkn.isEnabled()) await pkn.check();
    },
  },
  { name: 'checkout-in-empty', path: '/checkout', signedIn: true },
  { name: 'orders-out', path: '/orders' },
  { name: 'orders-in', path: '/orders', signedIn: true },
  { name: 'bought-out', path: '/bought' },
  { name: 'bought-in', path: '/bought', signedIn: true },
  { name: 'sales-out', path: '/sales' },
  { name: 'sales-in', path: '/sales', signedIn: true },
  {
    name: 'sales-in-refund',
    path: '/sales',
    signedIn: true,
    after: async (page) => {
      await page.locator('.sale-row .btn', { hasText: 'Refund' }).first().click();
    },
  },
  { name: 'buy', path: '/buy' },
  { name: 'buy-in', path: '/buy', signedIn: true },
  { name: 'wallet', path: '/wallet' },
  { name: 'wallet-in', path: '/wallet', signedIn: true },
  {
    name: 'wallet-send-sheet',
    path: '/wallet',
    after: async (page) => {
      await page.locator('.wallet-action', { hasText: 'Send' }).click();
    },
  },
  { name: 'exchange', path: '/exchange' },
  { name: 'swap-redirect', path: '/swap' },
  { name: 'nft-redirect', path: '/nft' },
  { name: 'flex', path: '/flex' },
  { name: 'protection', path: '/protection' },
  { name: 'signal', path: '/marketplace/signal' },
].filter((row) => !ONLY.length || ONLY.includes(row.name));

function compare(a, b) {
  const diffs = [];
  const keys = ['path', 'title', 'h1', 'h2', 'selects'];
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diffs.push(`${key}: ${JSON.stringify(a[key])} ≠ ${JSON.stringify(b[key])}`);
  }
  const all = new Set([...Object.keys(a.counts), ...Object.keys(b.counts)]);
  for (const sel of all) {
    if ((a.counts[sel] || 0) !== (b.counts[sel] || 0)) diffs.push(`${sel}: ${a.counts[sel] || 0} ≠ ${b.counts[sel] || 0}`);
  }
  return diffs;
}

let bad = 0;
const table = [];
for (const scenario of SCENARIOS) {
  let react = await run(A, scenario);
  let solid = await run(B, scenario);
  const pick = (r) => r.after || r.snap;
  let diffs = compare(pick(react), pick(solid));
  if (diffs.length) {
    // Live API data can move between two loads: retry once.
    react = await run(A, scenario);
    solid = await run(B, scenario);
    diffs = compare(pick(react), pick(solid));
  }
  const s = pick(solid);
  const writes = [...react.blocked, ...solid.blocked];
  // The page redirected to a URL another port group owns (sign-in, MyPokoin): the standalone
  // Solid preview stops there; in production the boot switch hands that URL to its UI.
  const handoff = s.notMigrated && (s.path.startsWith('/auth') || s.path.startsWith('/mypokoin'));
  if (handoff) diffs = [];
  const reactCrashed = react.errors.some((row) => /Minified React error|render failed/.test(row));
  const ok = !diffs.length && (!s.notMigrated || handoff) && !solid.errors.length;
  const crashOnly = !ok && reactCrashed && !solid.errors.length;
  if ((!ok && !crashOnly) || writes.some((row) => !row.includes('fixture account cart'))) bad += 1;
  table.push({
    scenario: scenario.name,
    url: scenario.path,
    h1: s.h1.join(' | '),
    rows: Object.entries(s.counts).filter(([k]) => !k.startsWith('select')).map(([k, v]) => `${k}=${v}`).join(' '),
    reactErrors: react.errors.length,
    solidErrors: solid.errors.length,
    reactFailed: react.failed.length,
    solidFailed: solid.failed.length,
    finalPath: s.path,
    result: ok ? (handoff ? 'same (handoff)' : 'same') : (reactCrashed && !solid.errors.length ? 'React crashes' : 'DIFF'),
  });
  console.log(`${ok ? (handoff ? 'same (handoff)' : 'same') : (reactCrashed && !solid.errors.length ? 'REACT-CRASH' : 'DIFF')}  ${scenario.name}  ${scenario.path} → ${s.path}`);
  for (const line of diffs) console.log(`      ${line}`);
  for (const line of solid.errors) console.log(`      solid error: ${line}`);
  for (const line of react.errors) console.log(`      react error: ${line}`);
  for (const line of solid.failed) console.log(`      solid failed: ${line}`);
  for (const line of react.failed) console.log(`      react failed: ${line}`);
  for (const line of writes) console.log(`      write: ${line}`);
}
await browser.close();
console.log('\nJSON', JSON.stringify(table));
process.exit(bad ? 1 : 0);
