'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { INGEST_GAMES, normalizeIngestGame } = require('./_cardtrader_game_ingest');

const gameStore = new AsyncLocalStorage();

const GAMES = {
  pokemon: {
    id: 'pokemon',
    databaseUrlEnv: 'MARKETPLACE_DATABASE_URL',
    meili: true,
    usesPokemonJoins: true,
  },
  ...Object.fromEntries(
    Object.values(INGEST_GAMES).map((game) => [game.id, {
      id: game.id,
      databaseUrlEnv: game.databaseUrlEnv,
      database: game.database,
      meili: false,
      usesPokemonJoins: false,
      rawSchema: game.schema,
      hosts: game.hosts,
    }]),
  ),
};

function normalizeGame(value) {
  const ingest = normalizeIngestGame(value);
  if (ingest && ingest !== 'pokemon') {
    return ingest;
  }
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (!raw || raw === 'pokemon' || raw === 'poke' || raw === 'default') {
    return 'pokemon';
  }
  return GAMES[raw] ? raw : 'pokemon';
}

function gameConfig(game = currentGame()) {
  return GAMES[normalizeGame(game)] || GAMES.pokemon;
}

function currentGame() {
  return normalizeGame(gameStore.getStore() || 'pokemon');
}

function isPokemonGame(game = currentGame()) {
  return normalizeGame(game) === 'pokemon';
}

function parseGameFromUrl(url) {
  if (!url || typeof url.searchParams?.get !== 'function') {
    return 'pokemon';
  }
  return normalizeGame(
    url.searchParams.get('game')
      || url.searchParams.get('marketplaceGame')
      || '',
  );
}

/** Hostname / subdomain → marketplace game (satellite APIs). */
function gameIdFromHost(hostname = '') {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .split(':')[0];
  if (!host) {
    return 'pokemon';
  }
  for (const game of Object.values(INGEST_GAMES)) {
    for (const listed of game.hosts || []) {
      const listedHost = String(listed).toLowerCase();
      if (host === listedHost) {
        return game.id;
      }
      const prefix = listedHost.split('.')[0];
      if (prefix && host.startsWith(`${prefix}.`)) {
        return game.id;
      }
    }
  }
  return 'pokemon';
}

function firstHeaderValue(value) {
  return String(value || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .split(':')[0];
}

function hostCandidatesFromRequest(req) {
  const headers = req?.headers || {};
  const candidates = [
    headers['x-pokoin-host'],
    headers['x-forwarded-host'],
    headers['x-original-host'],
    headers.host,
  ];
  const origin = headers.origin || headers.referer;
  if (origin) {
    try {
      candidates.push(new URL(String(origin)).hostname);
    } catch (_) {
      /* ignore */
    }
  }
  return candidates.map(firstHeaderValue).filter(Boolean);
}

function parseGameFromHost(req) {
  for (const host of hostCandidatesFromRequest(req)) {
    const game = gameIdFromHost(host);
    if (game !== 'pokemon') {
      return game;
    }
  }
  return 'pokemon';
}

function parseGameFromRequest(req) {
  try {
    const host = firstHeaderValue(req?.headers?.host) || 'pokoin.com';
    const url = new URL(req.url || '/', `https://${host}`);
    const fromQuery = parseGameFromUrl(url);
    if (fromQuery !== 'pokemon') {
      return fromQuery;
    }
    const header = req?.headers?.['x-pokoin-game'] || req?.headers?.['x-marketplace-game'];
    if (header) {
      return normalizeGame(header);
    }
    return parseGameFromHost(req);
  } catch (_) {
    return 'pokemon';
  }
}

function runWithGame(game, fn) {
  return gameStore.run(normalizeGame(game), fn);
}

function valkeyKey(base) {
  const game = currentGame();
  if (game === 'pokemon') {
    return String(base || '');
  }
  return `game:${game}:${base}`;
}

function deriveDatabaseUrlFromMarketplace(pathname) {
  const base = process.env.MARKETPLACE_DATABASE_URL || '';
  if (!base) {
    return '';
  }
  try {
    const parsed = new URL(base);
    parsed.pathname = pathname;
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function databaseUrlForGame(game = currentGame()) {
  const config = gameConfig(game);
  if (config.id === 'pokemon') {
    return process.env.MARKETPLACE_DATABASE_URL || process.env.MARKETPLACE_PEER4_DATABASE_URL || '';
  }
  const explicit = process.env[config.databaseUrlEnv] || '';
  if (explicit) {
    return explicit;
  }
  if (config.database) {
    return deriveDatabaseUrlFromMarketplace(`/${config.database}`);
  }
  return '';
}

module.exports = {
  GAMES,
  normalizeGame,
  gameConfig,
  currentGame,
  isPokemonGame,
  gameIdFromHost,
  parseGameFromUrl,
  parseGameFromHost,
  parseGameFromRequest,
  runWithGame,
  valkeyKey,
  databaseUrlForGame,
};
