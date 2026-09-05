/** Hostname → marketplace game. Pokemon stays default on pokoin.com. */

const GAMES = {
  pokemon: {
    id: 'pokemon',
    apiGame: 'pokemon',
    brand: 'Pokoin',
    title: 'Pokoin marketplace',
    homeHref: '/',
    features: { competitive: true, promoCarousel: true },
    promoBanners: null,
  },
  one_piece: {
    id: 'one_piece',
    apiGame: 'one_piece',
    brand: 'Pokoin One Piece',
    title: 'One Piece marketplace',
    homeHref: '/marketplace',
    features: { competitive: false, promoCarousel: false },
    promoBanners: [],
  },
  riftbound: {
    id: 'riftbound',
    apiGame: 'riftbound',
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

export function gameIdFromHost(hostname = hostName()) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'onepiece.pokoin.com' || host.startsWith('onepiece.')) {
    return 'one_piece';
  }
  if (host === 'riftbound.pokoin.com' || host.startsWith('riftbound.')) {
    return 'riftbound';
  }
  return 'pokemon';
}

export function game(hostname = hostName()) {
  return GAMES[gameIdFromHost(hostname)] || GAMES.pokemon;
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
