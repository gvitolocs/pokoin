/** Path prefix → marketplace game. Pokemon stays at pokoin.com with no prefix. */

const SATELLITE = {
  features: { competitive: false, promoCarousel: false },
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

function currentPath() {
  if (typeof window === 'undefined' || !window.location) {
    return '';
  }
  return String(window.location.pathname || '');
}

function gameIdFromPath(pathname = '') {
  const slug = String(pathname || '').split('/').filter(Boolean)[0] || '';
  return SLUG_TO_ID[slug] || '';
}

/** React Router basename. Empty on the Pokemon apex. */
export function gameBasename(pathname = currentPath()) {
  const slug = String(pathname || '').split('/').filter(Boolean)[0] || '';
  return SLUG_TO_ID[slug] ? `/${slug}` : '';
}

/** Full site path for a game's marketplace. Reloads so the basename changes. */
export function gamePublicPath(gameId) {
  const row = GAMES[gameId] || GAMES.pokemon;
  if (!row.slug) return '/marketplace';
  return `/${row.slug}/marketplace`;
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

/** Seller desk has no game subdomain, so it can honor the scan Game picker. */
export function sellerDeskUsesGameOverride(hostname, pathname = '') {
  const host = String(hostname || '').toLowerCase();
  const bare = String(pathname || '').replace(/\/$/, '') || '/';
  const sellerDesk = bare === '/dashboard' || bare.startsWith('/dashboard/');
  return host === 'dashboard.pokoin.com'
    || host === 'localhost'
    || host.endsWith('.localhost')
    || ((host === 'pokoin.com' || host === 'www.pokoin.com') && sellerDesk);
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

/** Where the header game picker sends the browser. Seller desks keep the handle. */
export function gameSiteHref(id, pathname = currentPath()) {
  const base = gamePublicPath(id || 'pokemon');
  const seller = sellerDeskRest(pathname);
  return `https://pokoin.com${base}${seller}`;
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

/** Append ?game= for non-Pokemon marketplace API calls. */
export function withGameQuery(path, hostname = hostName()) {
  const apiGame = apiGameParam(hostname);
  if (!apiGame) {
    return path;
  }
  const text = String(path || '');
  if (!text.startsWith('/api/marketplace') && !text.startsWith('/api/cardtrader-redirect') && !text.startsWith('/api/cardmarket-redirect')) {
    return text;
  }
  const hashIndex = text.indexOf('#');
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const join = withoutHash.includes('?') ? '&' : '?';
  if (/[?&]game=/.test(withoutHash)) {
    return text;
  }
  return `${withoutHash}${join}game=${encodeURIComponent(apiGame)}${hash}`;
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

export { GAMES };
