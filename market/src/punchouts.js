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

/** Seller desk on the dashboard host (Scan Connect). */
export const DASHBOARD_ORIGIN = 'https://dashboard.pokoin.com';
export const DASHBOARD_SCAN = `${DASHBOARD_ORIGIN}/scan`;

/** Public marketplace apex. Dashboard links that leave the seller desk go here. */
export const MARKET_ORIGIN = 'https://pokoin.com';

function onDashboardHost(hostname) {
  const host = String(
    hostname
    || (typeof window !== 'undefined' ? window.location.hostname : ''),
  ).toLowerCase();
  return host === 'dashboard.pokoin.com';
}

/**
 * Path for in-app links. On dashboard.pokoin.com returns an absolute
 * https://pokoin.com/… URL so the browser leaves the seller desk.
 */
export function marketUrl(path = '/marketplace', hostname) {
  const raw = String(path || '/marketplace');
  const normalized = raw.startsWith('/') ? raw : `/${raw}`;
  if (onDashboardHost(hostname)) {
    return `${MARKET_ORIGIN}${normalized}`;
  }
  return normalized;
}

/** Paths that stay on the dashboard host (Scan Connect desk). */
export function isDashboardDeskPath(pathname = '') {
  const path = String(pathname || '').replace(/\/$/, '') || '/';
  return path === '/scan' || path === '/inventory/scan';
}

export const APP = {
  home: route('/'),
  forum: route('/forum'),
  signal: route('/marketplace/signal'),
  competitive: route('/marketplace/competitive'),
  wallet: route('/wallet'),
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
  contact: route('/contact'),
  privacy: route('/privacy'),
  emailPreferences: route('/email-preferences'),
  protection: route('/protection'),
  whitepaper: route('/whitepaper'),
  nft: route('/nft'),
  checkout: route('/checkout'),
  orders: route('/orders'),
};
