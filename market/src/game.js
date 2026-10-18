/** Path prefix → marketplace game. Pokemon stays at pokoin.com with no prefix. */

const SATELLITE = {
  features: { competitive: false, promoCarousel: true },
  promoBanners: [],
  homeHref: '/marketplace',
};

const GAMES = {
  pokemon: {
    id: 'pokemon',
    apiGame: 'pokemon',
    slug: '',
    name: 'Pokémon',
    brand: 'Pokoin',
    title: 'Pokoin marketplace',
    homeHref: '/',
    features: { competitive: true, promoCarousel: true },
    promoBanners: null,
  },
  one_piece: {
    id: 'one_piece', apiGame: 'one_piece', slug: 'one-piece', name: 'One Piece', brand: 'Pokoin', title: 'One Piece marketplace', ...SATELLITE,
  },
  riftbound: {
    id: 'riftbound', apiGame: 'riftbound', slug: 'riftbound', name: 'Riftbound', brand: 'Pokoin', title: 'Riftbound marketplace', ...SATELLITE,
  },
  magic: {
    id: 'magic', apiGame: 'magic', slug: 'magic', name: 'Magic', brand: 'Pokoin', title: 'Magic marketplace', ...SATELLITE,
  },
  yugioh: {
    id: 'yugioh', apiGame: 'yugioh', slug: 'yugioh', name: 'Yu-Gi-Oh!', brand: 'Pokoin', title: 'Yu-Gi-Oh! marketplace', ...SATELLITE,
  },
  lorcana: {
    id: 'lorcana', apiGame: 'lorcana', slug: 'lorcana', name: 'Lorcana', brand: 'Pokoin', title: 'Lorcana marketplace', ...SATELLITE,
  },
  flesh_and_blood: {
    id: 'flesh_and_blood', apiGame: 'flesh_and_blood', slug: 'flesh-and-blood', name: 'Flesh and Blood', brand: 'Pokoin', title: 'Flesh and Blood marketplace', ...SATELLITE,
  },
  digimon: {
    id: 'digimon', apiGame: 'digimon', slug: 'digimon', name: 'Digimon', brand: 'Pokoin', title: 'Digimon marketplace', ...SATELLITE,
  },
  dragon_ball_super: {
    id: 'dragon_ball_super', apiGame: 'dragon_ball_super', slug: 'dragon-ball-super', name: 'Dragon Ball Super', brand: 'Pokoin', title: 'Dragon Ball Super marketplace', ...SATELLITE,
  },
  vanguard: {
    id: 'vanguard', apiGame: 'vanguard', slug: 'vanguard', name: 'Vanguard', brand: 'Pokoin', title: 'Vanguard marketplace', ...SATELLITE,
  },
  star_wars: {
    id: 'star_wars', apiGame: 'star_wars', slug: 'star-wars', name: 'Star Wars', brand: 'Pokoin', title: 'Star Wars marketplace', ...SATELLITE,
  },
  union_arena: {
    id: 'union_arena', apiGame: 'union_arena', slug: 'union-arena', name: 'Union Arena', brand: 'Pokoin', title: 'Union Arena marketplace', ...SATELLITE,
  },
  gundam: {
    id: 'gundam', apiGame: 'gundam', slug: 'gundam', name: 'Gundam', brand: 'Pokoin', title: 'Gundam marketplace', ...SATELLITE,
  },
  sorcery: {
    id: 'sorcery', apiGame: 'sorcery', slug: 'sorcery', name: 'Sorcery', brand: 'Pokoin', title: 'Sorcery marketplace', ...SATELLITE,
  },
  palworld: {
    id: 'palworld', apiGame: 'palworld', slug: 'palworld', name: 'Palworld', brand: 'Pokoin', title: 'Palworld marketplace', ...SATELLITE,
  },
  cyberpunk: {
    id: 'cyberpunk', apiGame: 'cyberpunk', slug: 'cyberpunk', name: 'Cyberpunk', brand: 'Pokoin', title: 'Cyberpunk marketplace', ...SATELLITE,
  },
  weiss_schwarz: {
    id: 'weiss_schwarz', apiGame: 'weiss_schwarz', slug: 'weiss-schwarz', name: 'Weiss Schwarz', brand: 'Pokoin', title: 'Weiss Schwarz marketplace', ...SATELLITE,
  },
  force_of_will: {
    id: 'force_of_will', apiGame: 'force_of_will', slug: 'force-of-will', name: 'Force of Will', brand: 'Pokoin', title: 'Force of Will marketplace', ...SATELLITE,
  },
  world_of_warcraft: {
    id: 'world_of_warcraft', apiGame: 'world_of_warcraft', slug: 'world-of-warcraft', name: 'World of Warcraft TCG', brand: 'Pokoin', title: 'World of Warcraft TCG marketplace', ...SATELLITE,
  },
  battle_spirits_saga: {
    id: 'battle_spirits_saga', apiGame: 'battle_spirits_saga', slug: 'battle-spirits-saga', name: 'Battle Spirits Saga', brand: 'Pokoin', title: 'Battle Spirits Saga marketplace', ...SATELLITE,
  },
  final_fantasy: {
    id: 'final_fantasy', apiGame: 'final_fantasy', slug: 'final-fantasy', name: 'Final Fantasy TCG', brand: 'Pokoin', title: 'Final Fantasy TCG marketplace', ...SATELLITE,
  },
  star_wars_destiny: {
    id: 'star_wars_destiny', apiGame: 'star_wars_destiny', slug: 'star-wars-destiny', name: 'Star Wars Destiny', brand: 'Pokoin', title: 'Star Wars Destiny marketplace', ...SATELLITE,
  },
  the_spoils: {
    id: 'the_spoils', apiGame: 'the_spoils', slug: 'the-spoils', name: 'The Spoils', brand: 'Pokoin', title: 'The Spoils marketplace', ...SATELLITE,
  },
  my_little_pony: {
    id: 'my_little_pony', apiGame: 'my_little_pony', slug: 'my-little-pony', name: 'My Little Pony CCG', brand: 'Pokoin', title: 'My Little Pony CCG marketplace', ...SATELLITE,
  },
  dragon_born: {
    id: 'dragon_born', apiGame: 'dragon_born', slug: 'dragon-born', name: 'Dragoborne', brand: 'Pokoin', title: 'Dragoborne marketplace', ...SATELLITE,
  },
};

const SLUG_TO_ID = Object.fromEntries(
  Object.values(GAMES).filter((game) => game.slug).map((game) => [game.slug, game.id]),
);

function hostName() {
  if (typeof window === 'undefined' || !window.location) {
    return '';
  }
  return String(window.location.hostname || '').toLowerCase();
}

/**
 * Optional pathname reader. Null uses `window.location.pathname` (React, node
 * tests, and any page that never opts in). The Solid app sets this to the
 * router location so `game()` and the helpers below track in-app navigations.
 */
let pathSource = null;

/** `fn` returns the current pathname. Pass null (or a non-function) to unset. */
export function setGamePathSource(fn) {
  pathSource = typeof fn === 'function' ? fn : null;
}

function currentPath() {
  if (pathSource) {
    try {
      const fromSource = pathSource();
      if (fromSource != null) return String(fromSource);
    } catch (_) {
      // A reader that throws falls through to the document URL.
    }
  }
  if (typeof window === 'undefined' || !window.location) {
    return '';
  }
  return String(window.location.pathname || '');
}

export function gameIdFromPath(pathname = '') {
  const slug = String(pathname || '').split('/').filter(Boolean)[0] || '';
  return SLUG_TO_ID[slug] || '';
}

/**
 * Path the router matches. A leading known game slug is removed
 * (`/one-piece/marketplace/x` → `/marketplace/x`); Pokémon and unknown first
 * segments stay as they are.
 */
export function stripGamePrefix(pathname = '') {
  const raw = String(pathname || '');
  const parts = raw.split('/');
  if (!SLUG_TO_ID[parts[1] || '']) return raw;
  const rest = parts.slice(2);
  return rest.length ? `/${rest.join('/')}` : '/';
}

/** True for `/marketplace` and `/<known-slug>/marketplace`, with or without a trailing slash. */
export function isMarketplaceHomePath(pathname = '') {
  const path = String(pathname || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (path === '/marketplace') return true;
  const parts = path.split('/').filter(Boolean);
  return parts.length === 2 && Boolean(SLUG_TO_ID[parts[0]]) && parts[1] === 'marketplace';
}

/**
 * Different game, and the target is not that game's marketplace home.
 * Those navigations stay a full document load. Same-game links and a
 * cross-game landing on the marketplace home stay in the app.
 */
function gameIds(fromPath, toPath) {
  const target = String(toPath || '').split(/[?#]/)[0];
  return {
    target,
    fromId: gameIdFromPath(fromPath) || 'pokemon',
    toId: gameIdFromPath(target) || 'pokemon',
  };
}

/** Another game's marketplace home: stay in the app, and do not re-prefix the path. */
export function isCrossGameHome(fromPath, toPath) {
  const { target, fromId, toId } = gameIds(fromPath, toPath);
  return fromId !== toId && isMarketplaceHomePath(target);
}

export function gameSwitchReloads(fromPath, toPath) {
  const { target, fromId, toId } = gameIds(fromPath, toPath);
  if (fromId === toId) return false;
  return !isMarketplaceHomePath(target);
}

/** React Router basename. Empty on the Pokemon apex. */
export function gameBasename(pathname = currentPath()) {
  const slug = String(pathname || '').split('/').filter(Boolean)[0] || '';
  return SLUG_TO_ID[slug] ? `/${slug}` : '';
}

/** Marketplace home path for a game. Pokémon stays unprefixed. */
export function gamePublicPath(gameId) {
  const row = GAMES[gameId] || GAMES.pokemon;
  if (!row.slug) return '/marketplace';
  return `/${row.slug}/marketplace`;
}

function gameRecord(gameId) {
  const raw = String(gameId || '').trim();
  if (!raw || raw === 'pokemon') return GAMES.pokemon;
  if (GAMES[raw]) return GAMES[raw];
  const id = SLUG_TO_ID[raw];
  return id ? GAMES[id] : null;
}

/** schema.org brand for a card page. Pokémon stays the TCG name already in snippets. */
export function tcgBrandName(gameId) {
  const row = gameRecord(gameId);
  if (!row || row.id === 'pokemon') return 'Pokémon TCG';
  return row.name;
}

/**
 * Public site path. Router paths stay unprefixed (React Router basename adds
 * the slug). Pokémon stays unprefixed. Already-prefixed paths are left alone.
 */
export function publicGamePath(path, gameId) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  const slug = gameRecord(gameId)?.slug || '';
  const apply = (pathname) => {
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
    if (!slug) return normalized;
    if (normalized === `/${slug}` || normalized.startsWith(`/${slug}/`)) return normalized;
    return `/${slug}${normalized}`;
  };
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      url.pathname = apply(url.pathname);
      return url.toString();
    } catch {
      return raw;
    }
  }
  const queryIndex = raw.indexOf('?');
  const hashIndex = raw.indexOf('#');
  let cut = raw.length;
  if (queryIndex >= 0) cut = Math.min(cut, queryIndex);
  if (hashIndex >= 0) cut = Math.min(cut, hashIndex);
  return `${apply(raw.slice(0, cut))}${raw.slice(cut)}`;
}

/** First path segments the router serves per game; account and site pages live on the apex. */
const GAME_SCOPED_SEGMENTS = new Set(['marketplace', 'product']);

/**
 * Href for a plain <a> on the current site. Router paths are unprefixed and the
 * router base only applies to navigate(): a raw `/marketplace/...` href on
 * /riftbound left the game (the click and a new tab both opened it as a Pokémon
 * page). Under a game basename, marketplace and product paths get the slug;
 * everything else (apex pages, other origins, mailto, #hash) is returned as is.
 */
export function gameHref(href, base = gameBasename()) {
  if (!base || typeof href !== 'string' || href[0] !== '/' || href[1] === '/') return href;
  if (href === base || href.startsWith(`${base}/`)) return href;
  const segment = href.split(/[/?#]/)[1] || '';
  return GAME_SCOPED_SEGMENTS.has(segment) ? `${base}${href}` : href;
}

const SCAN_GAME_KEY = 'pokoin.scanGame';

/** Optional desk override (dashboard host has no game subdomain). */
export function readScanGameOverride() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return '';
    const id = String(window.localStorage.getItem(SCAN_GAME_KEY) || '').trim();
    return GAMES[id] ? id : '';
  } catch (_) {
    return '';
  }
}

export function setScanGameOverride(gameId) {
  const id = String(gameId || '').trim();
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!id || id === 'pokemon') window.localStorage.removeItem(SCAN_GAME_KEY);
    else if (GAMES[id]) window.localStorage.setItem(SCAN_GAME_KEY, id);
  } catch (_) {
    // private mode
  }
}

/** Private stock desks keep their route and select the catalog through the Game picker. */
export function sellerDeskUsesGameOverride(hostname, pathname = '') {
  const host = String(hostname || '').toLowerCase();
  const bare = String(pathname || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
  const sellerDesk = ['/dashboard', '/mypokoin', '/inventory'].some(
    (root) => bare === root || bare.startsWith(`${root}/`),
  );
  return host === 'dashboard.pokoin.com'
    || host === 'localhost'
    || host.endsWith('.localhost')
    || ((host === 'pokoin.com' || host === 'www.pokoin.com' || host === '127.0.0.1') && sellerDesk);
}

export function gameIdFromHost(hostname = hostName(), pathname) {
  const host = String(hostname || '').toLowerCase();
  const path = pathname !== undefined ? String(pathname || '') : currentPath();
  const fromPath = gameIdFromPath(path);
  if (fromPath) return fromPath;
  if (host === 'onepiece.pokoin.com' || host.startsWith('onepiece.')) {
    return 'one_piece';
  }
  if (host === 'riftbound.pokoin.com' || host.startsWith('riftbound.')) {
    return 'riftbound';
  }
  if (sellerDeskUsesGameOverride(host, path)) {
    const override = readScanGameOverride();
    if (override) return override;
  }
  return 'pokemon';
}

export function game(hostname = hostName()) {
  return GAMES[gameIdFromHost(hostname)] || GAMES.pokemon;
}

/** Path half of `gameSiteHref` (no origin). Seller desks keep the handle. */
export function gameSitePath(id, pathname = currentPath()) {
  return `${gamePublicPath(id || 'pokemon')}${sellerDeskRest(pathname)}`;
}

/** Where the header game picker sends the browser. Seller desks keep the handle. */
export function gameSiteHref(id, pathname = currentPath()) {
  return `https://pokoin.com${gameSitePath(id, pathname)}`;
}

/**
 * Header preview of another game's marketplace home. Same-origin path on
 * pokoin.com and local dev (the in-app router can claim it); absolute on the
 * dashboard host and anywhere else.
 */
export function gamePreviewHref(id, hostname = hostName()) {
  const path = gamePublicPath(id);
  const host = String(hostname || '').toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
  const apex = host === 'pokoin.com' || host === 'www.pokoin.com';
  if (local || apex) return path;
  return `https://pokoin.com${path}`;
}

/** `/en/users/handle…` when the path is a public seller desk; else empty. */
function sellerDeskRest(pathname = '') {
  let path = String(pathname || '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] && SLUG_TO_ID[parts[0]]) {
    path = `/${parts.slice(1).join('/')}`;
  }
  const match = path.match(/^\/marketplace\/([^/]+)\/users\/([^/?#]+)(.*)$/);
  if (!match) return '';
  const [, lang, handle, tail] = match;
  return `/${lang}/users/${handle}${tail || ''}`;
}

/** Phone BattleScan selectCatalog args for the active game. */
export function scanPhoneCatalog(hostname = hostName()) {
  const id = gameIdFromHost(hostname);
  if (id === 'one_piece') return { family: 'one_piece', variant: 'singles' };
  if (id === 'riftbound') return { family: 'riftbound', variant: 'western' };
  return { family: 'pokemon', variant: 'generic' };
}

export function isPokemonGame(hostname = hostName()) {
  return gameIdFromHost(hostname) === 'pokemon';
}

export function apiGameParam(hostname = hostName()) {
  const id = game(hostname).apiGame;
  return id === 'pokemon' ? '' : id;
}

/** Normalized catalog id (`pokemon`, `one_piece`, …), or '' when `value` is blank or unknown. */
export function knownGameId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === 'pokemon' || raw === 'poke' || raw === 'default') return 'pokemon';
  if (GAMES[raw]) return GAMES[raw].id;
  return SLUG_TO_ID[raw] || '';
}

const CATALOG_API_PREFIXES = ['/api/marketplace', '/api/cardtrader-redirect', '/api/cardmarket-redirect', '/api/tcgplayer-redirect'];

function isCatalogApiPath(path) {
  const text = String(path || '');
  return CATALOG_API_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function appendApiGame(path, apiGame) {
  if (!apiGame) return path;
  const text = String(path || '');
  if (!isCatalogApiPath(text)) return text;
  const hashIndex = text.indexOf('#');
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  if (/[?&]game=/.test(withoutHash)) return text;
  const join = withoutHash.includes('?') ? '&' : '?';
  return `${withoutHash}${join}game=${encodeURIComponent(apiGame)}${hash}`;
}

/** Append ?game= for non-Pokemon marketplace API calls. */
export function withGameQuery(path, hostname = hostName()) {
  return appendApiGame(path, apiGameParam(hostname));
}

/**
 * Same as `withGameQuery`, but for an explicit catalog id. Pokémon stays
 * unscoped (no `?game=`), even when the open page is another TCG.
 */
export function withGameQueryFor(path, gameId) {
  const id = knownGameId(gameId);
  if (!id) return withGameQuery(path);
  const apiGame = id === 'pokemon' ? '' : (GAMES[id].apiGame || '');
  return appendApiGame(path, apiGame);
}

/** Headers for satellite marketplace API calls (defense when query is stripped). */
export function gameRequestHeaders(hostname = hostName()) {
  const apiGame = apiGameParam(hostname);
  if (!apiGame) {
    return {};
  }
  return {
    'x-pokoin-game': apiGame,
    'x-pokoin-host': String(hostname || hostName() || '').toLowerCase(),
  };
}

/**
 * `headers` unless `url` already names a non-Pokémon game. The API reads
 * `?game=` before the headers, and the custom headers make every new URL a
 * CORS preflight on satellites: an origin round trip (75-95 ms) that
 * Cloudflare never caches.
 */
export function gameHeadersForUrl(url, headers) {
  const query = String(url || '').split('#')[0].split('?')[1] || '';
  const params = new URLSearchParams(query);
  const named = String(params.get('game') || params.get('marketplaceGame') || '').trim().toLowerCase();
  return named && named !== 'pokemon' ? {} : headers;
}

/** `x-pokoin-game` for an explicit catalog. Pokémon sends no game header. */
export function gameRequestHeadersFor(gameId, hostname = hostName()) {
  const id = knownGameId(gameId);
  if (!id) return gameRequestHeaders(hostname);
  if (id === 'pokemon') return {};
  return {
    'x-pokoin-game': GAMES[id].apiGame || id,
    'x-pokoin-host': String(hostname || hostName() || '').toLowerCase(),
  };
}

/**
 * Catalog game locked by a request URL. A marketplace URL with no `game`
 * query is the Pokémon key (satellites always carry `?game=`). '' when `url`
 * is not a catalog route.
 */
export function catalogGameFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''), 'https://api.pokoin.com');
    if (!isCatalogApiPath(parsed.pathname)) return '';
    if (!parsed.searchParams.has('game')) return 'pokemon';
    return knownGameId(parsed.searchParams.get('game')) || 'pokemon';
  } catch {
    return '';
  }
}

/** `/card-images/` prefix for a catalog. Empty for Pokémon. Omitted id uses the page. */
export function catalogImagePrefix(gameId) {
  if (gameId == null || String(gameId).trim() === '') {
    const slug = game().slug || '';
    return slug ? `${slug}/` : '';
  }
  const id = knownGameId(gameId);
  const slug = id ? (GAMES[id].slug || '') : (game().slug || '');
  return slug ? `${slug}/` : '';
}

export function gameIconSrc(gameOrId) {
  const row = typeof gameOrId === 'string'
    ? (GAMES[gameOrId] || null)
    : (gameOrId || null);
  const slug = row?.slug || (row?.id === 'pokemon' ? 'pokemon' : '');
  if (!slug && row?.id !== 'pokemon') return '';
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}games/${slug || 'pokemon'}.svg`;
}

export { GAMES };
