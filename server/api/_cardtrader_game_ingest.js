'use strict';

const crypto = require('node:crypto');
const { Client } = require('pg');

/**
 * Isolated CardTrader ingest targets. Pokemon is not here — public Pokemon
 * API stays on the Pi (`pokoin-oracle-api`). These games write to nezopt 15T.
 */
const INGEST_GAMES = {
  magic: {
    id: 'magic',
    slug: 'magic',
    displayName: 'Magic: the Gathering',
    cardtraderGameId: 1,
    database: 'pokoin_magic',
    databaseUrlEnv: 'MAGIC_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_magic',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'magic/',
    aliases: ['mtg', 'magic_the_gathering'],
    hosts: ['magic.pokoin.com'],
  },
  yugioh: {
    id: 'yugioh',
    slug: 'yugioh',
    displayName: 'Yu-Gi-Oh!',
    cardtraderGameId: 4,
    database: 'pokoin_yugioh',
    databaseUrlEnv: 'YUGIOH_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_yugioh',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'yugioh/',
    aliases: ['yu_gi_oh', 'yu-gi-oh', 'ygo'],
    hosts: ['yugioh.pokoin.com'],
  },
  flesh_and_blood: {
    id: 'flesh_and_blood',
    slug: 'flesh-and-blood',
    displayName: 'Flesh and Blood',
    cardtraderGameId: 6,
    database: 'pokoin_flesh_and_blood',
    databaseUrlEnv: 'FLESH_AND_BLOOD_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_flesh_and_blood',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'flesh-and-blood/',
    aliases: ['fab', 'flesh-and-blood'],
    hosts: ['fab.pokoin.com', 'fleshandblood.pokoin.com'],
  },
  digimon: {
    id: 'digimon',
    slug: 'digimon',
    displayName: 'Digimon',
    cardtraderGameId: 8,
    database: 'pokoin_digimon',
    databaseUrlEnv: 'DIGIMON_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_digimon',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'digimon/',
    aliases: [],
    hosts: ['digimon.pokoin.com'],
  },
  dragon_ball_super: {
    id: 'dragon_ball_super',
    slug: 'dragon-ball-super',
    displayName: 'Dragon Ball Super',
    cardtraderGameId: 9,
    database: 'pokoin_dragon_ball_super',
    databaseUrlEnv: 'DRAGON_BALL_SUPER_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_dragon_ball_super',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'dragon-ball-super/',
    aliases: ['dbs', 'dragonball', 'dragon-ball-super'],
    hosts: ['dbs.pokoin.com', 'dragonball.pokoin.com'],
  },
  vanguard: {
    id: 'vanguard',
    slug: 'vanguard',
    displayName: 'Cardfight!! Vanguard',
    cardtraderGameId: 10,
    database: 'pokoin_vanguard',
    databaseUrlEnv: 'VANGUARD_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_vanguard',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'vanguard/',
    aliases: ['cardfight', 'cfv'],
    hosts: ['vanguard.pokoin.com'],
  },
  one_piece: {
    id: 'one_piece',
    slug: 'one-piece',
    displayName: 'One Piece',
    cardtraderGameId: 15,
    database: 'pokoin_one_piece',
    databaseUrlEnv: 'ONE_PIECE_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_one_piece',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'one-piece/',
    aliases: ['onepiece', 'op'],
    hosts: ['onepiece.pokoin.com'],
  },
  lorcana: {
    id: 'lorcana',
    slug: 'lorcana',
    displayName: 'Disney Lorcana',
    cardtraderGameId: 18,
    database: 'pokoin_lorcana',
    databaseUrlEnv: 'LORCANA_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_lorcana',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'lorcana/',
    aliases: ['disney_lorcana'],
    hosts: ['lorcana.pokoin.com'],
  },
  star_wars: {
    id: 'star_wars',
    slug: 'star-wars',
    displayName: 'Star Wars Unlimited',
    cardtraderGameId: 20,
    database: 'pokoin_star_wars',
    databaseUrlEnv: 'STAR_WARS_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_star_wars',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'star-wars/',
    aliases: ['swu', 'starwars'],
    hosts: ['starwars.pokoin.com'],
  },
  union_arena: {
    id: 'union_arena',
    slug: 'union-arena',
    displayName: 'Union Arena',
    cardtraderGameId: 21,
    database: 'pokoin_union_arena',
    databaseUrlEnv: 'UNION_ARENA_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_union_arena',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'union-arena/',
    aliases: ['unionarena'],
    hosts: ['unionarena.pokoin.com'],
  },
  riftbound: {
    id: 'riftbound',
    slug: 'riftbound',
    displayName: 'Riftbound | League of Legends',
    cardtraderGameId: 22,
    database: 'pokoin_riftbound',
    databaseUrlEnv: 'RIFTBOUND_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_riftbound',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'riftbound/',
    aliases: ['rb', 'lol'],
    hosts: ['riftbound.pokoin.com'],
  },
  gundam: {
    id: 'gundam',
    slug: 'gundam',
    displayName: 'Gundam',
    cardtraderGameId: 23,
    database: 'pokoin_gundam',
    databaseUrlEnv: 'GUNDAM_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_gundam',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'gundam/',
    aliases: [],
    hosts: ['gundam.pokoin.com'],
  },
  sorcery: {
    id: 'sorcery',
    slug: 'sorcery',
    displayName: 'Sorcery: Contested Realm',
    cardtraderGameId: 24,
    database: 'pokoin_sorcery',
    databaseUrlEnv: 'SORCERY_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_sorcery',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'sorcery/',
    aliases: ['contested_realm'],
    hosts: ['sorcery.pokoin.com'],
  },
  palworld: {
    id: 'palworld',
    slug: 'palworld',
    displayName: 'Palworld',
    cardtraderGameId: 26,
    database: 'pokoin_palworld',
    databaseUrlEnv: 'PALWORLD_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_palworld',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'palworld/',
    aliases: [],
    hosts: ['palworld.pokoin.com'],
  },
  cyberpunk: {
    id: 'cyberpunk',
    slug: 'cyberpunk',
    displayName: 'Cyberpunk',
    cardtraderGameId: 27,
    database: 'pokoin_cyberpunk',
    databaseUrlEnv: 'CYBERPUNK_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_cyberpunk',
    table: 'cardtrader_blueprints',
    cdnKeyPrefix: 'cyberpunk/',
    aliases: ['cyberpunk_edgerunners', 'edgerunners'],
    hosts: ['cyberpunk.pokoin.com'],
  },
  weiss_schwarz: {
    id: 'weiss_schwarz',
    slug: 'weiss-schwarz',
    displayName: 'Weiss Schwarz',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_weiss_schwarz',
    databaseUrlEnv: 'WEISS_SCHWARZ_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_weiss_schwarz',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'weiss-schwarz/',
    aliases: ['weiss', 'weissschwarz', 'ws'],
    hosts: [],
  },
  final_fantasy: {
    id: 'final_fantasy',
    slug: 'final-fantasy',
    displayName: 'Final Fantasy TCG',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_final_fantasy',
    databaseUrlEnv: 'FINAL_FANTASY_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_final_fantasy',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'final-fantasy/',
    aliases: ['fftcg', 'final_fantasy_tcg'],
    hosts: [],
  },
  force_of_will: {
    id: 'force_of_will',
    slug: 'force-of-will',
    displayName: 'Force of Will',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_force_of_will',
    databaseUrlEnv: 'FORCE_OF_WILL_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_force_of_will',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'force-of-will/',
    aliases: ['fow'],
    hosts: [],
  },
  world_of_warcraft: {
    id: 'world_of_warcraft',
    slug: 'world-of-warcraft',
    displayName: 'World of Warcraft TCG',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_world_of_warcraft',
    databaseUrlEnv: 'WORLD_OF_WARCRAFT_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_world_of_warcraft',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'world-of-warcraft/',
    aliases: ['wow_tcg', 'wowtcg'],
    hosts: [],
  },
  battle_spirits_saga: {
    id: 'battle_spirits_saga',
    slug: 'battle-spirits-saga',
    displayName: 'Battle Spirits Saga',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_battle_spirits_saga',
    databaseUrlEnv: 'BATTLE_SPIRITS_SAGA_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_battle_spirits_saga',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'battle-spirits-saga/',
    aliases: ['battle_spirits', 'bss'],
    hosts: [],
  },
  star_wars_destiny: {
    id: 'star_wars_destiny',
    slug: 'star-wars-destiny',
    displayName: 'Star Wars Destiny',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_star_wars_destiny',
    databaseUrlEnv: 'STAR_WARS_DESTINY_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_star_wars_destiny',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'star-wars-destiny/',
    aliases: ['swd', 'destiny'],
    hosts: [],
  },
  dragon_born: {
    id: 'dragon_born',
    slug: 'dragon-born',
    displayName: 'Dragoborne',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_dragon_born',
    databaseUrlEnv: 'DRAGON_BORN_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_dragon_born',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'dragon-born/',
    aliases: ['dragoborne'],
    hosts: [],
  },
  my_little_pony: {
    id: 'my_little_pony',
    slug: 'my-little-pony',
    displayName: 'My Little Pony CCG',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_my_little_pony',
    databaseUrlEnv: 'MY_LITTLE_PONY_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_my_little_pony',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'my-little-pony/',
    aliases: ['mlp', 'mlp_ccg'],
    hosts: [],
  },
  the_spoils: {
    id: 'the_spoils',
    slug: 'the-spoils',
    displayName: 'The Spoils',
    // Cardmarket-only game: no CardTrader catalog (docs/CARDMARKET_GAMES.md).
    cardtraderGameId: null,
    source: 'cardmarket',
    database: 'pokoin_the_spoils',
    databaseUrlEnv: 'THE_SPOILS_MARKETPLACE_DATABASE_URL',
    schema: 'marketplace_the_spoils',
    table: 'cardmarket_products',
    cdnKeyPrefix: 'the-spoils/',
    aliases: ['spoils'],
    hosts: [],
  },
};

const POKEMON_ALIASES = new Set(['pokemon', 'poke', 'pokémon', 'default']);

function ingestGameList() {
  const order = (game) => (game.cardtraderGameId == null ? Number.MAX_SAFE_INTEGER : game.cardtraderGameId);
  return Object.values(INGEST_GAMES).sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}

function ingestAliasMap() {
  const map = new Map();
  for (const game of ingestGameList()) {
    map.set(game.id, game.id);
    map.set(game.slug.replace(/-/g, '_'), game.id);
    map.set(game.slug, game.id);
    for (const alias of game.aliases) {
      map.set(String(alias).toLowerCase().replace(/-/g, '_'), game.id);
      map.set(String(alias).toLowerCase(), game.id);
    }
  }
  return map;
}

const ALIAS_TO_ID = ingestAliasMap();

function compactGameToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isPokemonIngestGame(value) {
  const raw = String(value || '').trim().toLowerCase();
  const compact = compactGameToken(raw);
  return POKEMON_ALIASES.has(raw) || POKEMON_ALIASES.has(compact) || compact === 'pokemon';
}

function normalizeIngestGame(value) {
  const compact = compactGameToken(value);
  if (!compact) return '';
  if (isPokemonIngestGame(compact)) return 'pokemon';
  return ALIAS_TO_ID.get(compact) || ALIAS_TO_ID.get(String(value || '').trim().toLowerCase()) || '';
}

function ingestGameConfig(value) {
  const id = normalizeIngestGame(value);
  if (!id || id === 'pokemon') return null;
  return INGEST_GAMES[id] || null;
}

function ingestApiPath(game) {
  const config = typeof game === 'string' ? ingestGameConfig(game) : game;
  if (!config) return '';
  return `/api/ingest/${config.slug}`;
}

function ingestListenPort(game, env = process.env) {
  const config = typeof game === 'string' ? ingestGameConfig(game) : game;
  if (!config) {
    return Number(env.CARDTRADER_INGEST_PORT || env.PORT || 18082);
  }
  const perGame = env[`${config.id.toUpperCase()}_INGEST_PORT`];
  if (perGame) return Number(perGame);
  return 18100 + Number(config.cardtraderGameId);
}

function deriveDatabaseUrl(pathname, env = process.env) {
  const base = env.MARKETPLACE_DATABASE_URL || '';
  if (!base) return '';
  try {
    const parsed = new URL(base);
    parsed.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function stripSslMode(connectionString, env = process.env) {
  const text = String(connectionString || '');
  if (!text) return '';
  if (env.MARKETPLACE_DATABASE_SSL_VERIFY === '1') return text;
  return text
    .replace(/([?&])sslmode=[^&]+&?/i, (match, prefix) =>
      (prefix === '?' && match.endsWith('&') ? '?' : prefix === '?' ? '' : ''),
    )
    .replace(/[?&]$/, '');
}

function ingestDatabaseUrl(game, env = process.env) {
  const config = typeof game === 'string' ? ingestGameConfig(game) : game;
  if (!config) return '';
  const explicit = env[config.databaseUrlEnv] || '';
  const raw = explicit || deriveDatabaseUrl(`/${config.database}`, env);
  return stripSslMode(raw, env);
}

function scopedIngestGame(env = process.env) {
  return normalizeIngestGame(env.CARDTRADER_INGEST_GAME || '');
}

function assertIngestService(env = process.env) {
  const name = String(env.POKOIN_API_SERVICE_NAME || '');
  if (name === 'pokoin-oracle-api') {
    const error = new Error('Pokemon public API stays on the Pi. Game ingest is cardtrader-game-ingest-api on Oracle.');
    error.statusCode = 404;
    error.code = 'POKEMON_STAYS_ON_PI';
    throw error;
  }
}

function pokemonStaysOnPiError() {
  const error = new Error('Pokemon ingest stays on the Pi public API (api.pokoin.com). This ingest API writes non-Pokemon catalogs to nezopt 15T.');
  error.statusCode = 404;
  error.code = 'POKEMON_STAYS_ON_PI';
  return error;
}

function unknownIngestGameError(value) {
  const error = new Error(`Unknown ingest game "${value || ''}".`);
  error.statusCode = 404;
  error.code = 'UNKNOWN_INGEST_GAME';
  return error;
}

function requestHeader(req, name) {
  const headers = req.headers || {};
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : String(value || '');
  }
  return '';
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(req) {
  const header = requestHeader(req, 'authorization');
  return header.toLowerCase().startsWith('bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function configuredIngestSecrets(env = process.env) {
  return [
    env.CARDTRADER_INGEST_SECRET,
    env.CARDTRADER_DAILY_LISTINGS_SECRET,
    env.CARDTRADER_DAILY_REFRESH_SECRET,
    env.CRON_SECRET,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function authorizeIngestRequest(req, env = process.env) {
  const secrets = configuredIngestSecrets(env);
  if (secrets.length === 0) {
    const error = new Error('CardTrader ingest secret is not configured.');
    error.statusCode = 503;
    error.code = 'CARDTRADER_INGEST_SECRET_MISSING';
    throw error;
  }
  const supplied = String(requestHeader(req, 'x-cardtrader-ingest-secret') || '').trim()
    || bearerToken(req);
  if (!secrets.some((secret) => timingSafeEqualText(supplied, secret))) {
    const error = new Error('CardTrader ingest access denied.');
    error.statusCode = 401;
    error.code = 'CARDTRADER_INGEST_DENIED';
    throw error;
  }
  return { type: 'ingest_secret' };
}

function postgresSsl(env = process.env) {
  if (env.MARKETPLACE_DATABASE_SSL === '0') return false;
  return { rejectUnauthorized: env.MARKETPLACE_DATABASE_SSL_VERIFY === '1' };
}

function publicIngestGame(game, env = process.env) {
  const config = typeof game === 'string' ? ingestGameConfig(game) : game;
  if (!config) return null;
  return {
    id: config.id,
    slug: config.slug,
    displayName: config.displayName,
    cardtraderGameId: config.cardtraderGameId,
    database: config.database,
    databaseUrlEnv: config.databaseUrlEnv,
    schema: config.schema,
    table: config.table,
    cdnKeyPrefix: config.cdnKeyPrefix,
    apiPath: ingestApiPath(config),
    listenPort: ingestListenPort(config, env),
    writer: 'nezopt-15t',
    images: '15t-objects',
    pokemon: false,
  };
}

async function probeIngestDatabase(game, env = process.env) {
  const config = typeof game === 'string' ? ingestGameConfig(game) : game;
  const connectionString = ingestDatabaseUrl(config, env);
  if (!config || !connectionString) {
    return { ok: false, error: 'not_configured' };
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 4000,
    ssl: postgresSsl(env),
  });
  try {
    await client.connect();
    const ping = await client.query('SELECT 1 AS ok');
    let blueprints = null;
    try {
      const counted = await client.query(
        `SELECT count(*)::bigint AS n
         FROM ${config.schema}.${config.table}`,
      );
      blueprints = Number(counted.rows[0]?.n || 0);
    } catch (error) {
      if (error && error.code !== '42P01') {
        return { ok: true, ping: Number(ping.rows[0]?.ok) === 1, blueprints: null, schema: false };
      }
    }
    return {
      ok: Number(ping.rows[0]?.ok) === 1,
      ping: true,
      blueprints,
      schema: blueprints != null,
    };
  } catch (error) {
    const code = error && error.code ? String(error.code) : 'down';
    return { ok: false, error: code };
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
  }
}

function importerOptionsForGame(config, body = {}) {
  const expansionIds = []
    .concat(body.expansionIds || body.expansion_ids || [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const discoverOnly = body.discoverOnly === true || body.discover_only === true
    || (body.apply !== true && expansionIds.length === 0 && body.streamAll !== true);
  const rawLimit = body.limit;
  const limit = rawLimit === 'all' || rawLimit === 'none'
    ? Infinity
    : (Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : (discoverOnly ? Infinity : 500));
  return {
    apply: body.apply === true,
    game: config.id,
    cardtraderGameId: config.cardtraderGameId,
    databaseUrlEnv: config.databaseUrlEnv,
    schema: config.schema,
    table: config.table,
    streamAll: body.streamAll === true || body.stream_all === true,
    expansionIds,
    limit: Number.isFinite(limit) ? limit : Infinity,
    batchSize: Number(body.batchSize || body.batch_size || 500),
    concurrency: Number(body.concurrency || 4),
    imageConcurrency: Number(body.imageConcurrency || 4),
    imageChunkSize: Number(body.imageChunkSize || 50),
    images: false,
    backfillImages: false,
    refresh: body.refresh === true,
    syncSearch: false,
    discoverOnly,
    ensureSchema: body.ensureSchema === true || body.ensure_schema === true || body.apply === true,
    languages: 'en',
    supabaseTransport: 'rest',
  };
}

function assertBoundedApply(options, body = {}) {
  if (!options.apply) return;
  if (options.streamAll && String(body.confirm || '') !== 'stream-all') {
    const error = new Error('Refusing unbounded --stream-all. Pass confirm="stream-all" or bound expansionIds / limit.');
    error.statusCode = 400;
    error.code = 'INGEST_STREAM_ALL_CONFIRM';
    throw error;
  }
  if (!options.streamAll && options.expansionIds.length === 0) {
    const error = new Error('Apply requires expansionIds or streamAll with confirm="stream-all".');
    error.statusCode = 400;
    error.code = 'INGEST_APPLY_BOUNDED';
    throw error;
  }
}

module.exports = {
  INGEST_GAMES,
  ingestGameList,
  isPokemonIngestGame,
  normalizeIngestGame,
  ingestGameConfig,
  ingestApiPath,
  ingestListenPort,
  ingestDatabaseUrl,
  deriveDatabaseUrl,
  scopedIngestGame,
  assertIngestService,
  pokemonStaysOnPiError,
  unknownIngestGameError,
  authorizeIngestRequest,
  publicIngestGame,
  probeIngestDatabase,
  importerOptionsForGame,
  assertBoundedApply,
};
