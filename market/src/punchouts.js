export const APP_ORIGIN = 'https://app.pokoin.com';

export function appHref(path = '/') {
  const next = path.startsWith('/') ? path : `/${path}`;
  return `${APP_ORIGIN}${next}`;
}

export function authFrom(path) {
  return appHref(`/auth?from=${encodeURIComponent(path || '/marketplace')}`);
}

export const FLUTTER = {
  home: appHref('/'),
  forum: appHref('/forum'),
  signal: appHref('/marketplace/signal'),
  competitive: appHref('/marketplace/competitive'),
  wallet: appHref('/wallet'),
  cart: appHref('/cart'),
  profile: appHref('/profile'),
  inventory: appHref('/inventory'),
  scan: appHref('/scan'),
  docs: appHref('/docs'),
  cardscan: appHref('/cardscan'),
  health: appHref('/health'),
  buy: appHref('/buy'),
  earn: appHref('/earn'),
  about: appHref('/about'),
  contact: appHref('/contact'),
  privacy: appHref('/privacy'),
  whitepaper: appHref('/whitepaper'),
};
