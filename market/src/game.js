/** Hostname → marketplace game. Pokemon stays default on pokoin.com. */

const GAMES = {
  pokemon: {
    id: 'pokemon',
    apiGame: 'pokemon',
    name: 'Pokémon',
    brand: 'Pokoin',
    title: 'Pokoin marketplace',
    homeHref: '/',
    features: { competitive: true, promoCarousel: true },
    promoBanners: null,
  },
  one_piece: {
    id: 'one_piece',
    apiGame: 'one_piece',
    name: 'One Piece',
    brand: 'Pokoin One Piece',
    title: 'One Piece marketplace',
    homeHref: '/marketplace',
    features: { competitive: false, promoCarousel: false },
    promoBanners: [],
  },
  riftbound: {
    id: 'riftbound',
    apiGame: 'riftbound',
    name: 'Riftbound',
    brand: 'Pokoin Riftbound',
    title: 'Riftbound marketplace',
    homeHref: '/marketplace',
    features: { competitive: false, promoCarousel: false },
    promoBanners: [],
  },
};

function hostName() {
  if (typeof window === 'undefined' || !window.location) {
    return '';
  }
  return String(window.location.hostname || '').toLowerCase();
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

export function gameIdFromHost(hostname = hostName()) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'onepiece.pokoin.com' || host.startsWith('onepiece.')) {
    return 'one_piece';
  }
  if (host === 'riftbound.pokoin.com' || host.startsWith('riftbound.')) {
    return 'riftbound';
  }
  // dashboard.pokoin.com (and localhost) honor the scan-desk Game picker.
  if (host === 'dashboard.pokoin.com' || host === 'localhost' || host.endsWith('.localhost')) {
    const override = readScanGameOverride();
    if (override) return override;
  }
  return 'pokemon';
}

export function game(hostname = hostName()) {
  return GAMES[gameIdFromHost(hostname)] || GAMES.pokemon;
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
