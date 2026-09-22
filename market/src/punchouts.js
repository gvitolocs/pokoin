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

/** Legacy seller-desk host. Bookmarks redirect to apex `/dashboard` (vercel.json). */
export const DASHBOARD_ORIGIN = 'https://dashboard.pokoin.com';

/** Canonical seller desk paths on the apex origin (SPA). */
export const DASHBOARD_HOME = '/dashboard';
export const DASHBOARD_SCAN = '/dashboard/scan';

/** Absolute legacy URLs for redirects / external docs only. */
export const DASHBOARD_ORIGIN_HOME = `${DASHBOARD_ORIGIN}/`;
export const DASHBOARD_ORIGIN_SCAN = `${DASHBOARD_ORIGIN}/scan`;

/** Public marketplace apex. */
export const MARKET_ORIGIN = 'https://pokoin.com';

function onDashboardHost(hostname) {
  const host = String(
    hostname
    || (typeof window !== 'undefined' ? window.location.hostname : ''),
  ).toLowerCase();
  return host === 'dashboard.pokoin.com';
}

/**
 * Path for in-app links. Relative on pokoin.com (SPA). Absolute to the apex
 * only while still on the legacy dashboard host (edge redirects prefer apex).
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
 * Hard-navigate only for cross-origin absolute URLs. Relative paths are for
 * React Router `<Link>` / `<NavLink>` — callers must not treat assign as SPA.
 */
export function goMarket(pathOrUrl, hostname) {
  const href = String(pathOrUrl || '').startsWith('http')
    ? String(pathOrUrl)
    : marketUrl(pathOrUrl, hostname);
  if (typeof window !== 'undefined' && /^https?:\/\//i.test(href)) {
    window.location.assign(href);
  }
  return href;
}

/** Seller-desk paths (apex + legacy dashboard host). */
export function isDashboardDeskPath(pathname = '') {
  const path = String(pathname || '').replace(/\/$/, '') || '/';
  return (
    path === '/'
    || path === '/scan'
    || path === '/inventory/scan'
    || path === '/dashboard'
    || path === '/dashboard/scan'
  );
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
  dashboard: route('/dashboard'),
  dashboardScan: route('/dashboard/scan'),
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
