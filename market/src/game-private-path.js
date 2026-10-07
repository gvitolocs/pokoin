/**
 * Account, seller, and marketing routes that must not exist under a game
 * prefix. `/{game}/wallet` is the same SPA page as `/wallet` and was indexed
 * as a duplicate with no canonical. Marketplace and news stay prefixed.
 * Product stays prefixed: booster/graded/jumbo search follows the game.
 *
 * Edge 301s are static rules (one per game) so they fit the 100 dynamic
 * `_redirects` cap. Subpaths use one splat rule per segment, shared by every
 * game. Bare `/{game}` and `/{game}/careers|contact|privacy|sitemap` are not
 * edge-redirected (static-rule budget); the SPA still sends those to the
 * unprefixed path.
 */

export const GAME_PRIVATE_SEGMENTS = [
  'about',
  'admin',
  'ambassador',
  'ambassadorprogram',
  'associate',
  'auth',
  'bought',
  'buy',
  'cardscan',
  'cart',
  'checkout',
  'collection',
  'dashboard',
  'docs',
  'earn',
  'email-preferences',
  'exchange',
  'extension',
  'favorites',
  'flex',
  'forum',
  'health',
  'inventory',
  'invite',
  'join',
  'messages',
  'mypokoin',
  'nft',
  'orders',
  'profile',
  'protection',
  'sales',
  'scan',
  'scancard',
  'shipping',
  'stock',
  'swap',
  'tests',
  'wallet',
  'whitepaper',
];

/** Segments with child routes. One dynamic `/:game/{seg}/*` covers every game. */
export const GAME_PRIVATE_CHILD_SEGMENTS = [
  'dashboard',
  'extension',
  'forum',
  'inventory',
  'join',
  'messages',
  'mypokoin',
];

/** SPA-only leftovers: browsers leave the game prefix; Google still needs the edge 301. */
export const GAME_PRIVATE_CLIENT_SEGMENTS = [
  ...GAME_PRIVATE_SEGMENTS,
  'careers',
  'contact',
  'privacy',
  'sitemap',
];

const CLIENT = new Set(GAME_PRIVATE_CLIENT_SEGMENTS);

/** Router pathname (game basename already stripped): `/wallet`, `/messages/ada`. */
export function isGamePrivatePath(pathname = '') {
  const segment = String(pathname || '').split(/[?#]/)[0].split('/').filter(Boolean)[0] || '';
  return CLIENT.has(segment);
}
