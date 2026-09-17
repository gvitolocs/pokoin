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
