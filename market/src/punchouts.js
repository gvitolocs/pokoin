/** Same-origin routes on pokoin.com. Never prefix https://app.pokoin.com. */

function route(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error(`pokoin.com route must be a relative path, got ${JSON.stringify(path)}`);
  }
  return path;
}

export function authFrom(path) {
  return route(`/auth?from=${encodeURIComponent(path || '/marketplace')}`);
}

/**
 * Seller desk on pokoin.com. Same origin as the marketplace, so Chrome can
 * soft-navigate. dashboard.pokoin.com only redirects here.
 */
export const DASHBOARD_HOME = '/dashboard';
export const DASHBOARD_SCAN = '/dashboard/scan';

/** Legacy host. Edge and the SPA send it to DASHBOARD_HOME. */
export const DASHBOARD_ORIGIN = 'https://dashboard.pokoin.com';

/** Public marketplace apex. Links that still load on the legacy host go here. */
export const MARKET_ORIGIN = 'https://pokoin.com';

function onDashboardHost(hostname) {
  const host = String(
    hostname
    || (typeof window !== 'undefined' ? window.location.hostname : ''),
  ).toLowerCase();
  return host === 'dashboard.pokoin.com';
}

/**
 * Path for in-app links. On the legacy dashboard host returns an absolute
 * https://pokoin.com/… URL so the browser leaves that origin.
 */
export function marketUrl(path = '/marketplace', hostname) {
  const raw = String(path || '/marketplace');
  const normalized = raw.startsWith('/') ? raw : `/${raw}`;
  if (onDashboardHost(hostname)) {
    return `${MARKET_ORIGIN}${normalized}`;
  }
  return normalized;
}

/**
 * Hard-navigate off the legacy dashboard host. On pokoin.com, use a router
 * link instead so the marketplace and /dashboard stay one SPA.
 */
export function goMarket(pathOrUrl, hostname) {
  const href = String(pathOrUrl || '').startsWith('http')
    ? String(pathOrUrl)
    : marketUrl(pathOrUrl, hostname);
  if (typeof window !== 'undefined') {
    window.location.assign(href);
  }
  return href;
}

/** Seller-desk routes inside the pokoin.com SPA. */
export function isDashboardDeskPath(pathname = '') {
  const path = String(pathname || '').replace(/\/$/, '') || '/';
  return path === '/dashboard' || path === '/dashboard/scan' || path === '/inventory/scan';
}

/**
 * Where a dashboard.pokoin.com URL belongs on pokoin.com.
 * `/` and `/scan` were the seller home and Scan Connect.
 */
export function legacyDashboardHref(pathname = '/', search = '') {
  const path = String(pathname || '/');
  const bare = path.replace(/\/$/, '') || '/';
  const q = search ? (String(search).startsWith('?') ? String(search) : `?${search}`) : '';
  if (bare === '/') return `${MARKET_ORIGIN}/dashboard${q}`;
  if (bare === '/scan') return `${MARKET_ORIGIN}/dashboard/scan${q}`;
  const absolutePath = path.startsWith('/') ? path : `/${path}`;
  return `${MARKET_ORIGIN}${absolutePath}${q}`;
}

export const APP = {
  home: route('/'),
  forum: route('/forum'),
  signal: route('/marketplace/signal'),
  competitive: route('/marketplace/competitive'),
  wallet: route('/wallet'),
  messages: route('/messages'),
  cart: route('/cart'),
  profile: route('/profile'),
  inventory: route('/inventory'),
  scan: route('/scan'),
  extensionAuthBridge: route('/extension/auth-bridge'),
  docs: route('/docs'),
  cardscan: route('/scan'),
  health: route('/health'),
  buy: route('/buy'),
  admin: route('/admin'),
  earn: route('/earn'),
  about: route('/about'),
  careers: route('/careers'),
  contact: route('/contact'),
  privacy: route('/privacy'),
  emailPreferences: route('/email-preferences'),
  protection: route('/protection'),
  whitepaper: route('/whitepaper'),
  nft: route('/nft'),
  collection: route('/collection'),
  checkout: route('/checkout'),
  orders: route('/orders'),
};
